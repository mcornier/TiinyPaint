'use strict';

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'tiinypaint.settings';
const DEFAULT_IMAGE_MODEL = 'Qwen/Qwen-Image-2.1';
const PE_I2I = 'Qwen/Qwen-Image-2.1-PE-I2I';
const PE_T2I = 'Qwen/Qwen-Image-2.1-PE-T2I';
const MAX_IMAGES = 10;
const MAX_REF_SIDE = 2048;
// Mesuré à 1024x1024, 8 étapes : 42 s sans aperçu, 63 s avec 8 aperçus (soit ~2,5 s par Mpx décodé).
const PREVIEW_SECONDS_PER_MPX = 2.5;
// Planning linéaire (sans décalage) : mesuré, le sujet est lisible vers 60 % au lieu de 70-80 %.
// Net à 40 étapes, mais image finale floue et dédoublée à 8 : réservé aux rendus longs.
const LINEAR_SCHEDULE = { use_dynamic_shifting: false, shift: 1.0 };
const LINEAR_MIN_STEPS = 30;

const GENERIC_SYSTEM_PROMPT = `You rewrite image requests into prompts for the Qwen-Image 2.1 diffusion model.
If images are attached, this is an edit: state exactly what changes and what stays unchanged, and refer to each image as <image1>, <image2>, in order.
Otherwise describe the finished image in one long, concrete English paragraph: subject, setting, composition, lighting, style. Keep text meant to appear in the image in its own language, in double quotes. Invent nothing that contradicts the request.
Return one strictly valid JSON object and nothing else: {"rewritten_prompt": "...", "wh_ratio": "W:H or empty", "ratio_follow": "<imageN> or empty"}.`;

const state = {
  client: null,
  models: [],
  running: [],
  refs: [],
  history: [],
  currentId: null,
  originalPrompt: null,
  abort: null,
  busy: false,
  previewEvery: 4,
  settings: {},
  editing: false,
  editorDirty: false,
};

let editor = null;
let sessionHistory = null;

/* ---------- Réglages persistés (clé API comprise, dans ce navigateur seulement) ---------- */

const PERSISTED_INPUTS = ['prompt', 'negative', 'ratio', 'side', 'width', 'height', 'steps', 'guidance', 'seed', 'scheduler', 'temperature', 'topP', 'topK', 'method', 'scope'];

function loadSettings() {
  try {
    state.settings = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    state.settings = {};
  }
}

function saveSettings() {
  const s = state.settings;
  for (const id of PERSISTED_INPUTS) s[id] = $(id).value;
  s.randomSeed = $('randomSeed').checked;
  s.linearSchedule = $('earlyPreview').checked;
  s.previewEvery = state.previewEvery;
  // Ancienne clé : elle mémorisait aussi le choix automatique, pas seulement celui de l'utilisateur.
  delete s.imageModel;
  s.enhancer = $('enhancer').value || s.enhancer;
  s.language = currentLang;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* stockage indisponible : les réglages ne survivent pas à la session */ }
}

function applySettings() {
  const s = state.settings;
  for (const id of PERSISTED_INPUTS) if (s[id] !== undefined) $(id).value = s[id];
  if (s.randomSeed !== undefined) $('randomSeed').checked = s.randomSeed;
  if (s.linearSchedule !== undefined) $('earlyPreview').checked = s.linearSchedule;
  if (s.previewEvery !== undefined) state.previewEvery = s.previewEvery;
}

/* ---------- Tailles ---------- */

const ceilTo32 = (n) => Math.ceil(n / 32) * 32;

function sizeError(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return t('needSize');
  if (w % 32 || h % 32) return t('size32');
  if (ceilTo32((w / 16) * (h / 16)) > 16896) return t('sizeMax');
  return '';
}

function sizeForRatio(ratio, side) {
  const area = side * side;
  let w = Math.max(32, Math.round(Math.sqrt(area * ratio) / 32) * 32);
  let h = Math.max(32, Math.round(Math.sqrt(area / ratio) / 32) * 32);
  while (sizeError(w, h)) {
    w -= 32;
    h = Math.max(32, Math.round(w / ratio / 32) * 32);
  }
  return [w, h];
}

function parseRatio(text) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text || '');
  return m && +m[2] ? +m[1] / +m[2] : null;
}

function applyRatioAndSide() {
  const ratio = parseRatio($('ratio').value);
  if (!ratio) return;
  const [w, h] = sizeForRatio(ratio, +$('side').value);
  $('width').value = w;
  $('height').value = h;
}

/* ---------- Aperçus ---------- */

// Liste des étapes à décoder. La dernière est exclue : l'événement final fournit déjà l'image.
function previewSteps(steps, every) {
  if (!every) return [];
  const list = [];
  for (let s = every; s < steps; s += every) list.push(s);
  return list;
}

function refreshPreviewControls() {
  for (const b of $('previewMode').children) {
    b.setAttribute('aria-checked', String(+b.dataset.value === state.previewEvery));
  }
  const steps = +$('steps').value || 0;
  const count = previewSteps(steps, state.previewEvery).length;
  const mpx = ((+$('width').value || 0) * (+$('height').value || 0)) / 1e6;
  if (!state.previewEvery) {
    $('previewHint').textContent = t('previewNone');
  } else if (!count) {
    $('previewHint').textContent = t('previewTooFew');
  } else {
    $('previewHint').textContent = t('previewCount', { n: count, t: formatDuration(count * mpx * PREVIEW_SECONDS_PER_MPX) });
  }
  $('earlyHint').textContent = t($('earlyPreview').checked ? 'earlyHintOn' : 'earlyHintOff');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Modèles ---------- */

const modelById = (id) => state.models.find((m) => m.id === id);
const isImageModel = (m) => m.type === 'Text-to-Image';
const isPromptEnhancer = (m) => m.supported?.includes('Prompt Enhance');
const isChatModel = (m) => isPromptEnhancer(m) || m.type === 'Image-Text-to-Text' || m.type === 'Text Generation';
const canEdit = (m) => m?.supported?.includes('Image Editing');

function fillSelect(select, items, wanted) {
  select.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
  if (items.some(([value]) => value === wanted)) select.value = wanted;
}

function renderModelSelects() {
  // Le premier de la liste est le défaut : le modèle officiel, jamais une variante non censurée
  // si un autre modèle est disponible, même si celle-ci est déjà chargée.
  const score = (m) => {
    if (m.id === DEFAULT_IMAGE_MODEL) return 0;
    if (/uncensored/i.test(m.id)) return 3;
    return state.running.includes(m.id) ? 1 : 2;
  };
  const images = state.models.filter(isImageModel).sort((a, b) => score(a) - score(b));
  const wantedImage = $('imageModel').value || state.settings.imageModelChoice;
  fillSelect($('imageModel'), images.map((m) => [m.id, m.display_name]), wantedImage);

  const enhancers = state.models.filter((m) => isChatModel(m) && !isPromptEnhancer(m));
  fillSelect(
    $('enhancer'),
    [['auto', t('autoEnhancer')], ...enhancers.map((m) => [m.id, m.display_name])],
    $('enhancer').value || state.settings.enhancer || 'auto',
  );
}

function renderModelList() {
  const shown = state.models
    .filter((m) => isImageModel(m) || isChatModel(m))
    .sort((a, b) => Number(state.running.includes(b.id)) - Number(state.running.includes(a.id)));
  $('modelList').replaceChildren(...shown.map((m) => {
    const running = state.running.includes(m.id);
    const row = document.createElement('div');
    row.className = 'model';
    const name = document.createElement('div');
    name.className = 'model-name';
    name.textContent = m.display_name;
    const meta = document.createElement('div');
    meta.className = 'model-meta';
    const pill = document.createElement('span');
    pill.className = `pill${running ? ' running' : ''}`;
    pill.textContent = running ? t('loaded') : (m.npu_usage ? t('npuPercent', { n: m.npu_usage }) : t('available'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = running ? t('unload') : t('load');
    button.disabled = state.busy;
    button.addEventListener('click', () => withLock(() => (running ? unloadModel(m) : ensureLoaded(m.id))));
    meta.append(pill, button);
    row.append(name, meta);
    return row;
  }));
}

async function refreshModels() {
  const [models, running] = await Promise.all([state.client.models(), state.client.running()]);
  // La route renvoie aussi les modèles en cours de téléchargement : ils ne sont pas utilisables.
  state.models = models.filter((m) => m.status === 'running' || m.status === 'downloaded' || running.running.includes(m.id));
  state.running = running.running;
  renderModelSelects();
  renderModelList();
  updateMode();
}

async function refreshRunning() {
  const running = (await state.client.running()).running;
  if (running.join() !== state.running.join()) {
    state.running = running;
    renderModelList();
  }
}

async function unloadModel(model) {
  setStatus(t('unloading', { m: model.display_name }));
  await state.client.stop(model.id);
  await refreshModels();
}

// `unload_candidate` ne suffit pas : certains modèles déclarent 0 % de NPU et le budget est alors faux.
// Un chargement accepté sans place réelle ne démarre jamais, sans erreur. On vérifie donc la mémoire réelle,
// et on propose de décharger en priorité les LLM, plus faciles à recharger qu'un modèle image.
async function freeRealMemory(id, label) {
  const percent = modelById(id)?.npu_usage;
  if (!percent) return;
  for (;;) {
    const device = (await state.client.npuStatus()).devices?.[0];
    if (!device?.mem_total_mb) return;
    const needed = (percent / 100) * device.mem_total_mb;
    if (device.mem_total_mb - device.mem_used_mb >= needed) return;
    await refreshRunning();
    const others = state.running.filter((m) => m !== id);
    if (!others.length) return;
    others.sort((a, b) => Number(isImageModel(modelById(a) || {})) - Number(isImageModel(modelById(b) || {})));
    const victim = others[0];
    const name = modelById(victim)?.display_name || victim;
    if (!window.confirm(t('confirmUnload', { m: label, list: name }))) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    setStatus(t('unloading', { m: name }), { busy: true });
    await state.client.stop(victim);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Charge un modèle si besoin, en demandant confirmation s'il faut en décharger d'autres.
async function ensureLoaded(id, signal) {
  await refreshRunning();
  if (state.running.includes(id)) return;
  const label = modelById(id)?.display_name || id;
  const check = await state.client.unloadCandidate(id);
  if (check.unload_required) {
    const victims = check.model_id || [];
    const list = victims.map((v) => modelById(v)?.display_name || v).join(', ');
    if (!window.confirm(t('confirmUnload', { m: label, list }))) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    for (const victim of victims) {
      setStatus(t('unloading', { m: modelById(victim)?.display_name || victim }));
      await state.client.stop(victim);
    }
  }
  await freeRealMemory(id, label);
  setStatus(t('loading', { m: label }), { busy: true });
  await state.client.launch(id);
  await state.client.waitRunning(id, { signal });
  await refreshRunning();
}

/* ---------- Références ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('unreadable')));
    img.src = url;
  });
}

// Réduit au besoin et renvoie un data URI PNG, ce qui conserve le canal alpha.
async function fileToRef(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_REF_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = makeCanvas(Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function addRefs(blobs) {
  for (const blob of blobs) {
    if (state.refs.length >= MAX_IMAGES) {
      setStatus(t('maxRefs', { n: MAX_IMAGES }), { error: true });
      break;
    }
    if (!blob.type.startsWith('image/')) continue;
    try {
      state.refs.push(await fileToRef(blob));
    } catch (err) {
      setStatus(err.message, { error: true });
    }
  }
  renderRefs();
}

// En mode éditeur, l'image éditée est <image1> : les références sont décalées d'un rang.
const refTagNumber = (index) => index + 1 + (state.editing ? 1 : 0);

function renderRefs() {
  $('refs').replaceChildren(...state.refs.map((ref, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'ref';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ref-open';
    open.title = t('editImage');
    const img = document.createElement('img');
    img.src = ref.dataUrl;
    img.alt = t('refAlt', { n: index + 1 });
    open.append(img);
    open.addEventListener('click', async () => openEditor(await loadImage(ref.dataUrl)));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ref-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('removeRef', { n: index + 1 }));
    remove.addEventListener('click', () => {
      state.refs.splice(index, 1);
      renderRefs();
      renderSourceOptions();
    });
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'ref-tag';
    const label = `<image${refTagNumber(index)}>`;
    tag.textContent = label;
    tag.title = t('insertTag');
    tag.addEventListener('click', () => insertInPrompt(label));
    wrap.append(open, remove, tag);
    return wrap;
  }));
  renderSourceOptions();
  updateMode();
}

function insertInPrompt(text) {
  const area = $('prompt');
  const start = area.selectionStart ?? area.value.length;
  area.setRangeText(text, start, area.selectionEnd ?? start, 'end');
  area.focus();
}

function updateMode() {
  const masked = state.editing && editor.hasMask();
  const editing = state.editing || state.refs.length > 0;
  const badge = $('modeBadge');
  badge.textContent = t(masked ? 'modeLocal' : editing ? 'modeEdit' : 'modeCreate');
  badge.classList.toggle('edit', editing);
  $('generateBtn').textContent = t(masked ? 'generateLocal' : 'generate');

  const model = modelById($('imageModel').value);
  const hint = $('enhanceHint');
  if (masked) {
    hint.textContent = t('hintLocal');
  } else if ($('enhancer').value === 'auto') {
    hint.textContent = t(editing ? 'hintI2I' : modelById(PE_T2I) ? 'hintT2I' : 'hintFallback');
  } else {
    hint.textContent = '';
  }
  if (editing && model && !canEdit(model)) {
    hint.textContent = t('noEditSupport', { m: model.display_name });
    hint.classList.add('warn');
  } else {
    hint.classList.remove('warn');
  }
  const guidance = +$('guidance').value;
  $('negativeHint').textContent = t(guidance <= 1 ? 'negOff' : 'negOn');
  $('negativeHint').classList.toggle('warn', guidance <= 1 && !!$('negative').value.trim());
  const error = sizeError(+$('width').value, +$('height').value);
  $('sizeHint').textContent = error;
  $('sizeHint').classList.toggle('warn', !!error);
  refreshPreviewControls();
}

/* ---------- Éditeur ---------- */

const TOOL_OPTIONS = {
  mask: ['brush', 'mask'],
  erase: ['brush', 'mask'],
  lasso: ['mask'],
  rect: ['mask'],
  restore: ['brush', 'restore', 'mask-feather'],
  stamp: ['brush'],
  crop: ['crop'],
};

function setTool(tool) {
  editor.tool = tool;
  if (tool !== 'crop') editor.crop = null;
  for (const b of $('tools').children) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  const groups = TOOL_OPTIONS[tool] || [];
  for (const el of document.querySelectorAll('.options [data-for]')) el.hidden = !groups.includes(el.dataset.for);
  $('toolHint').textContent = `${t(`tool${tool[0].toUpperCase()}${tool.slice(1)}Hint`)} ${t('editorHint', { w: editor.width, h: editor.height })}`;
  editor.redraw();
}

function openEditor(image) {
  state.editing = true;
  state.editorDirty = false;
  $('editBar').hidden = false;
  $('editCanvas').hidden = false;
  $('output').hidden = true;
  $('placeholder').hidden = true;
  editor.load(image);
  setTool(editor.tool);
  renderRefs();
  refreshEditorButtons();
  updateDownload();
}

function closeEditor() {
  state.editing = false;
  $('editBar').hidden = true;
  $('editCanvas').hidden = true;
  const item = state.history.find((h) => h.id === state.currentId);
  if (item) showImage(item.url);
  else $('placeholder').hidden = false;
  renderRefs();
  updateDownload();
}

function refreshEditorButtons() {
  $('undoBtn').disabled = !editor.undoStack.length;
  $('redoBtn').disabled = !editor.redoStack.length;
  $('applyCropBtn').disabled = false;
}

function renderSourceOptions() {
  const select = $('source');
  const wanted = select.value;
  const items = [['origin', t('sourceOrigin')]];
  state.history.forEach((item, i) => items.push([`h:${item.id}`, t('sourceHistory', { n: state.history.length - i })]));
  state.refs.forEach((_, i) => items.push([`r:${i}`, t('sourceRef', { n: i + 1 })]));
  fillSelect(select, items, wanted);
}

async function applySourceSelection() {
  const value = $('source').value;
  if (value === 'origin') {
    editor.setSource(null);
  } else if (value.startsWith('h:')) {
    const item = state.history.find((h) => `h:${h.id}` === value);
    if (item) editor.setSource(await loadImage(item.url));
  } else if (value.startsWith('r:')) {
    const ref = state.refs[+value.slice(2)];
    if (ref) editor.setSource(await loadImage(ref.dataUrl));
  }
}

// Consigne envoyée au modèle autour du prompt de l'utilisateur, selon l'usage du masque.
function wrapLocalPrompt(rawPrompt, keepContent, maskTag) {
  const prompt = /[.!?]$/.test(rawPrompt) ? rawPrompt : `${rawPrompt}.`;
  if (keepContent) {
    return `In <image1>, apply this edit only in the area shown white in the mask ${maskTag}: ${prompt} Everything outside the white area must stay exactly as in <image1>.`;
  }
  return `In <image1>, repaint the solid magenta area: ${prompt} The result must blend naturally with its surroundings, and no magenta may remain. Everything outside the magenta area stays exactly unchanged.`;
}

/* ---------- Amélioration du prompt ---------- */

function enhancerPlan(images) {
  const choice = $('enhancer').value;
  const hasImages = images.length > 0;
  const sampling = {
    temperature: +$('temperature').value,
    top_p: +$('topP').value,
    top_k: +$('topK').value,
  };
  if (choice !== 'auto') {
    const model = modelById(choice);
    return {
      model: choice,
      system: GENERIC_SYSTEM_PROMPT,
      sampling,
      sendImages: hasImages && model?.input?.includes('Image'),
      max_tokens: 4000,
      extra: model?.thinking?.toggleable ? { chat_template_kwargs: { enable_thinking: false } } : {},
    };
  }
  // Réglages de l'exemple officiel Qwen (prompt_rewrite/pe_core.py).
  if (hasImages) {
    return { model: PE_I2I, system: window.TP_PROMPTS.i2i, sampling, sendImages: true, max_tokens: 24000, extra: {} };
  }
  if (modelById(PE_T2I)) {
    return {
      model: PE_T2I,
      system: window.TP_PROMPTS.t2i,
      sampling,
      sendImages: false,
      max_tokens: 16256,
      extra: { presence_penalty: 1.5 },
    };
  }
  // Le prompt système de PE-I2I suppose toujours une image : on s'en passe en création.
  return { model: PE_I2I, system: null, sampling, sendImages: false, max_tokens: 16256, extra: {} };
}

function parseEnhanced(raw) {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1));
      if (typeof data.rewritten_prompt === 'string' && data.rewritten_prompt.trim()) {
        return {
          prompt: data.rewritten_prompt.trim(),
          wh_ratio: data.wh_ratio || '',
          ratio_follow: data.ratio_follow || '',
        };
      }
    } catch { /* pas du JSON : traité comme du texte ci-dessous */ }
  }
  const plain = text.replace(/^"([\s\S]*)"$/, '$1').trim();
  return plain ? { prompt: plain, wh_ratio: '', ratio_follow: '' } : null;
}

function applyEnhancedRatio(result) {
  // L'éditeur fixe lui-même le cadre : le format proposé ne s'applique qu'hors éditeur.
  if (state.editing) return '';
  let ratio = null;
  let source = '';
  const follow = /^<image(\d+)>$/.exec(result.ratio_follow);
  if (follow && state.refs[+follow[1] - 1]) {
    const ref = state.refs[+follow[1] - 1];
    ratio = ref.width / ref.height;
    source = result.ratio_follow;
  } else if (parseRatio(result.wh_ratio)) {
    ratio = parseRatio(result.wh_ratio);
    source = result.wh_ratio;
  }
  if (!ratio) return '';
  const [w, h] = sizeForRatio(ratio, +$('side').value);
  $('width').value = w;
  $('height').value = h;
  const preset = [...$('ratio').options].find((o) => Math.abs((parseRatio(o.value) || 0) - ratio) < 0.01);
  $('ratio').value = preset ? preset.value : 'custom';
  return t('formatApplied', { s: source, w, h });
}

// Images que voit le LLM : le document (avec la zone marquée s'il y a un masque), puis les références.
function enhancerImages() {
  const refs = state.refs.map((r) => r.dataUrl);
  if (!state.editing) return { images: refs, note: '' };
  const local = editor.prepareLocal({ side: 1024, wholeImage: true, keepContent: true, sizeFor: sizeForRatio });
  if (local) return { images: [local.marked, ...refs], note: ' (Only the area tinted magenta in <image1> is to be edited.)' };
  const [w, h] = sizeForRatio(editor.width / editor.height, 1024);
  const canvas = makeCanvas(w, h);
  canvas.getContext('2d').drawImage(editor.base, 0, 0, w, h);
  return { images: [canvas.toDataURL('image/png'), ...refs], note: '' };
}

async function enhancePrompt() {
  const instruction = $('prompt').value.trim();
  if (!instruction) {
    setStatus(t('writePromptFirst'), { error: true });
    return;
  }
  const { images, note } = enhancerImages();
  const plan = enhancerPlan(images);
  const controller = beginTask();
  $('thinkingBox').hidden = false;
  $('thinking').textContent = '';
  $('thinkingSummary').textContent = t('thinking');
  try {
    await ensureLoaded(plan.model, controller.signal);
    const label = modelById(plan.model)?.display_name || plan.model;
    const started = Date.now();
    setStatus(t('thinkingStatus', { m: label, t: formatDuration(0) }), { busy: true });
    const text = instruction + note;
    const content = plan.sendImages
      ? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : text;
    const messages = [...(plan.system ? [{ role: 'system', content: plan.system }] : []), { role: 'user', content }];
    const output = await state.client.streamChat(
      { model: plan.model, messages, max_tokens: plan.max_tokens, ...plan.sampling, ...plan.extra },
      {
        signal: controller.signal,
        onDelta: ({ content: answer, reasoning }) => {
          const box = $('thinking');
          const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
          box.textContent = reasoning + (answer ? `\n\n${answer}` : '');
          if (atEnd) box.scrollTop = box.scrollHeight;
          const elapsed = formatDuration((Date.now() - started) / 1000);
          setStatus(t(answer ? 'writingStatus' : 'thinkingStatus', { m: label, t: elapsed }), { busy: true });
        },
      },
    );
    const result = parseEnhanced(output.content);
    if (!result) throw new TiinyError(t(output.finish === 'length' ? 'truncated' : 'emptyReply'), 0);
    state.originalPrompt = instruction;
    $('prompt').value = result.prompt;
    $('revertBtn').hidden = false;
    $('thinkingSummary').textContent = t('thinkingDone', { t: formatDuration((Date.now() - started) / 1000) });
    setStatus(t('enhanced') + applyEnhancedRatio(result));
    updateMode();
    saveSettings();
  } catch (err) {
    reportError(err, 'enhanceStopped');
  } finally {
    endTask();
  }
}

/* ---------- Génération ---------- */

function baseBody() {
  const steps = +$('steps').value;
  if ($('randomSeed').checked) $('seed').value = Math.floor(Math.random() * 2147483647);
  const model = $('imageModel').value;
  const body = {
    model,
    prompt: $('prompt').value.trim(),
    // La route en flux ignore `size` : il faut bien width et height.
    width: +$('width').value,
    height: +$('height').value,
    steps,
    guidance_scale: +$('guidance').value,
    seed: +$('seed').value,
    stream_return_steps: previewSteps(steps, state.previewEvery),
    app_id: 'tiinypaint',
  };
  const negative = $('negative').value.trim();
  if (negative) body.negative_prompt = negative;
  const type = $('scheduler').value;
  const linear = $('earlyPreview').checked && model.includes('Qwen-Image') && steps >= LINEAR_MIN_STEPS;
  if (type || linear) {
    body.scheduler = {
      type: type || 'euler',
      ...(linear ? { params: LINEAR_SCHEDULE } : {}),
    };
  }
  return body;
}

// Construit la requête. `plan` indique comment réintégrer le résultat dans l'éditeur.
function buildRequest() {
  const body = baseBody();
  const refs = state.refs.map((r) => r.dataUrl);
  if (!state.editing) {
    if (refs.length) body.images = refs;
    return { body, plan: null };
  }
  const side = +$('side').value;
  const keepContent = $('method').value === 'keep';
  const local = editor.prepareLocal({
    side,
    wholeImage: $('scope').value === 'full',
    keepContent,
    sizeFor: sizeForRatio,
  });
  if (local) {
    const images = [local.image, ...refs];
    if (local.maskImage) images.push(local.maskImage);
    body.images = images;
    body.width = local.width;
    body.height = local.height;
    body.prompt = wrapLocalPrompt(body.prompt, keepContent, `<image${images.length}>`);
    return { body, plan: { local: true, region: { ...local.region, masked: true } } };
  }
  const [w, h] = sizeForRatio(editor.width / editor.height, side);
  const canvas = makeCanvas(w, h);
  canvas.getContext('2d').drawImage(editor.base, 0, 0, w, h);
  body.images = [canvas.toDataURL('image/png'), ...refs];
  body.width = w;
  body.height = h;
  return { body, plan: { local: false, region: { x: 0, y: 0, w: editor.width, h: editor.height, masked: false } } };
}

function showImage(src) {
  const output = $('output');
  output.src = src;
  output.hidden = false;
  $('placeholder').hidden = true;
}

function setProgress(ratio) {
  const bar = $('progressBar');
  bar.classList.remove('busy');
  bar.style.width = `${Math.round(ratio * 100)}%`;
}

async function generate() {
  const rawPrompt = $('prompt').value.trim();
  if (!rawPrompt) {
    setStatus(t('writePromptFirst'), { error: true });
    return;
  }
  if (!state.editing) {
    const sizeProblem = sizeError(+$('width').value, +$('height').value);
    if (sizeProblem) {
      setStatus(sizeProblem, { error: true });
      return;
    }
  }
  const { body, plan } = buildRequest();
  if ((body.images?.length || 0) > MAX_IMAGES) {
    setStatus(t('tooManyImages'), { error: true });
    return;
  }
  const controller = beginTask();
  if (state.editing) editor.disabled = true;
  const startedAt = { value: 0 };
  let lastStep = 0;
  let lastStepAt = 0;
  let stepSeconds = 0;
  let timer = null;

  const tick = () => {
    const elapsed = (Date.now() - startedAt.value) / 1000;
    let text = t('elapsed', { t: formatDuration(elapsed) });
    if (lastStep) text = `${t('stepOf', { s: lastStep, n: body.steps })} · ${text}`;
    if (stepSeconds) {
      const left = (body.steps - lastStep) * stepSeconds - (Date.now() - lastStepAt) / 1000;
      text += ` · ${t('remaining', { t: formatDuration(left) })}`;
    }
    setStatus(text, { busy: !lastStep });
  };

  const showPreview = async (src) => {
    if (plan) editor.setPreview(await loadImage(src), plan.region);
    else showImage(src);
  };

  const attempt = () => state.client.streamImage(body, {
    signal: controller.signal,
    onPreview: (event) => {
      showPreview(event.image);
      const now = Date.now();
      if (lastStep && event.step > lastStep) stepSeconds = (now - lastStepAt) / 1000 / (event.step - lastStep);
      lastStep = event.step;
      lastStepAt = now;
      setProgress(event.progress);
      tick();
    },
  });

  try {
    await ensureLoaded(body.model, controller.signal);
    startedAt.value = Date.now();
    timer = setInterval(tick, 1000);
    tick();
    let result;
    try {
      result = await attempt();
    } catch (err) {
      // Un modèle tout juste chargé peut répondre « xh2a backend fail » : on réessaie une fois.
      if (err.name === 'AbortError' || lastStep || !/backend fail/i.test(err.message)) throw err;
      setStatus(t('retrying'), { busy: true });
      await new Promise((resolve) => setTimeout(resolve, 10000));
      result = await attempt();
    }
    const elapsed = result.metadata?.elapsed_ms ? result.metadata.elapsed_ms / 1000 : (Date.now() - startedAt.value) / 1000;
    let blob;
    let width = body.width;
    let height = body.height;
    if (plan) {
      const image = await loadImage(result.image);
      if (plan.local) editor.commitLocal(image, plan.region);
      else editor.commitWhole(image);
      blob = await editor.toBlob();
      width = editor.width;
      height = editor.height;
    } else {
      blob = await (await fetch(result.image)).blob();
    }
    addToHistory(blob, { ...body, prompt: rawPrompt, width, height }, elapsed);
    setProgress(1);
    setStatus(t('done', { t: formatDuration(elapsed), w: width, h: height, s: body.seed }));
  } catch (err) {
    if (plan) editor.clearPreview();
    if (err.name === 'AbortError' && lastStep) {
      setStatus(t('stoppedAt', { s: lastStep, n: body.steps }));
    } else {
      reportError(err, 'renderStopped');
    }
  } finally {
    clearInterval(timer);
    if (state.editing) editor.disabled = false;
    endTask();
    updateMode();
  }
}

function addToHistory(blob, body, elapsed) {
  const item = {
    id: crypto.randomUUID(),
    url: URL.createObjectURL(blob),
    blob,
    prompt: body.prompt,
    width: body.width,
    height: body.height,
    steps: body.steps,
    guidance: body.guidance_scale,
    seed: body.seed,
    scheduler: body.scheduler?.type || '',
    linear: !!body.scheduler?.params,
    negative: body.negative_prompt || '',
    model: body.model,
    elapsed,
    createdAt: Date.now(),
  };
  state.history.unshift(item);
  selectHistory(item.id);
  renderSourceOptions();
  const { url, ...record } = item;
  sessionHistory?.add(record).catch(warnHistoryNotSaved);
}

function warnHistoryNotSaved() {
  setStatus(t('historyNotSaved'), { error: true });
}

async function restoreSessionHistory() {
  try {
    sessionHistory = new SessionHistory();
    const items = await sessionHistory.load();
    state.history = items.map((item) => ({ ...item, url: URL.createObjectURL(item.blob) }));
  } catch {
    sessionHistory = null;
    return;
  }
  if (state.history.length) {
    selectHistory(state.history[0].id);
    renderSourceOptions();
  }
}

async function clearHistory() {
  if (!window.confirm(t('confirmClearHistory', { n: state.history.length }))) return;
  for (const item of state.history) URL.revokeObjectURL(item.url);
  state.history = [];
  state.currentId = null;
  $('output').hidden = true;
  $('output').removeAttribute('src');
  $('placeholder').hidden = false;
  updateDownload();
  renderHistory();
  renderSourceOptions();
  try {
    await sessionHistory?.clear();
  } catch {
    warnHistoryNotSaved();
  }
}

function selectHistory(id) {
  const item = state.history.find((h) => h.id === id);
  if (!item) return;
  state.currentId = id;
  if (!state.editing) showImage(item.url);
  updateDownload();
  renderHistory();
}

function updateDownload() {
  const item = state.history.find((h) => h.id === state.currentId);
  const link = $('downloadBtn');
  const enabled = !!item;
  link.classList.toggle('disabled', !enabled);
  if (enabled) {
    link.href = item.url;
    link.download = `tiinypaint-${item.seed}.png`;
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }
  $('editBtn').disabled = !enabled || state.busy || state.editing;
  $('useAsRefBtn').disabled = !enabled || state.busy;
  $('clearHistoryBtn').disabled = !state.history.length || state.busy || state.editing;
}

function restoreHistoryParams(item) {
  $('prompt').value = item.prompt;
  $('negative').value = item.negative;
  if (!state.editing) {
    $('width').value = item.width;
    $('height').value = item.height;
    $('ratio').value = 'custom';
  }
  $('steps').value = item.steps;
  $('guidance').value = item.guidance;
  $('seed').value = item.seed;
  $('randomSeed').checked = false;
  $('scheduler').value = item.scheduler;
  $('earlyPreview').checked = item.linear;
  if (modelById(item.model)) $('imageModel').value = item.model;
  updateMode();
  saveSettings();
}

function renderHistory() {
  $('history').replaceChildren(...state.history.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = t('historyTitle', { w: item.width, h: item.height, s: item.seed });
    button.setAttribute('aria-current', String(item.id === state.currentId));
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = t('renderAlt', { s: item.seed });
    button.append(img);
    button.addEventListener('click', async () => {
      if (state.editing) {
        // Dans l'éditeur, une vignette devient la source de restauration.
        $('source').value = `h:${item.id}`;
        await applySourceSelection();
        setTool('restore');
      } else {
        selectHistory(item.id);
      }
    });
    button.addEventListener('dblclick', () => restoreHistoryParams(item));
    return button;
  }));
}

/* ---------- États de l'interface ---------- */

function setStatus(text, { error = false, busy = false } = {}) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error-text', error);
  const bar = $('progressBar');
  if (busy) {
    bar.style.width = '';
    bar.classList.add('busy');
  } else {
    bar.classList.remove('busy');
  }
}

function reportError(err, abortedKey) {
  if (err.name === 'AbortError') setStatus(t(abortedKey));
  else setStatus(err.message || String(err), { error: true });
}

function setBusy(busy) {
  state.busy = busy;
  $('generateBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  $('enhanceBtn').disabled = busy;
  updateDownload();
  renderModelList();
}

function beginTask() {
  saveSettings();
  setBusy(true);
  $('progressBar').style.width = '0';
  state.abort = new AbortController();
  return state.abort;
}

function endTask() {
  state.abort = null;
  setBusy(false);
  $('progressBar').classList.remove('busy');
  refreshRunning().catch(() => {});
}

async function withLock(task) {
  if (state.busy) return;
  setBusy(true);
  try {
    await task();
    setStatus(t('ready'));
  } catch (err) {
    reportError(err, 'cancelled');
  } finally {
    setBusy(false);
    refreshRunning().catch(() => {});
  }
}

/* ---------- Connexion ---------- */

let connectionLabel = null;

function setConnection(on, text) {
  connectionLabel = on ? text : null;
  $('connDot').classList.toggle('on', on);
  $('connText').textContent = text;
  $('generateBtn').disabled = !on;
  $('enhanceBtn').disabled = !on || state.busy;
}

async function connect(base, key) {
  const client = new TiinyClient(base, key);
  const info = await client.deviceInfo();
  state.client = client;
  await refreshModels();
  if (!$('width').value || !$('height').value) applyRatioAndSide();
  updateMode();
  const link = base.includes('172.') ? 'USB' : base.replace(/^https?:\/\//, '');
  setConnection(true, `${info.device_name} · ${link} · TiinyOS ${info.tiiny_os}`);
}

async function pollDevice() {
  if (!state.client) return;
  try {
    const npu = await state.client.npuStatus();
    const device = npu.devices?.[0];
    if (device) {
      const memory = device.mem_total_mb ? (device.mem_used_mb / device.mem_total_mb) * 100 : 0;
      $('npuBar').style.width = `${device.util_percent}%`;
      $('npuText').textContent = `${Math.round(device.util_percent)} %`;
      $('memBar').style.width = `${memory}%`;
      $('memText').textContent = `${(device.mem_used_mb / 1024).toFixed(1)}/${Math.round(device.mem_total_mb / 1024)} Go`;
    }
    if (!state.busy) await refreshRunning();
    if (!connectionLabel) setConnection(true, t('reconnected'));
  } catch (err) {
    setConnection(false, err.message);
  }
}

function openSettings() {
  $('baseUrl').value = state.settings.baseUrl || '';
  $('apiKey').value = state.settings.apiKey || '';
  $('settingsError').textContent = '';
  $('settings').showModal();
}

/* ---------- Langue ---------- */

function setLanguage(lang) {
  const idle = !state.busy && $('status').textContent === t('ready');
  applyI18n(lang);
  $('language').value = currentLang;
  if (state.client) renderModelSelects();
  renderModelList();
  renderRefs();
  renderHistory();
  renderSourceOptions();
  if (state.editing) setTool(editor.tool);
  if (!connectionLabel) $('connText').textContent = t('notConnected');
  if (idle || !$('status').textContent) setStatus(t('ready'));
  saveSettings();
}

/* ---------- Démarrage ---------- */

function bindEditor() {
  editor = new Editor($('editCanvas'), {
    onChange: () => {
      refreshEditorButtons();
      if (state.editing) updateMode();
    },
  });
  editor.onMessage = (key) => setStatus(t(key), { error: true });

  $('tools').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) setTool(button.dataset.tool);
  });
  const slider = (id, outputId, apply) => {
    const update = () => {
      $(outputId).textContent = $(id).value;
      apply(+$(id).value);
    };
    $(id).addEventListener('input', update);
    update();
  };
  slider('brushSize', 'brushValue', (v) => { editor.brush = v; });
  slider('feather', 'featherValue', (v) => { editor.feather = v; });
  $('showMask').addEventListener('change', () => {
    editor.showMask = $('showMask').checked;
    editor.redraw();
  });
  $('undoBtn').addEventListener('click', () => editor.undo());
  $('redoBtn').addEventListener('click', () => editor.redo());
  $('zoomResetBtn').addEventListener('click', () => {
    editor.resetZoom();
    editor.redraw();
  });
  $('closeEditorBtn').addEventListener('click', closeEditor);
  $('invertBtn').addEventListener('click', () => editor.invertMask());
  $('clearMaskBtn').addEventListener('click', () => editor.clearMask());
  $('source').addEventListener('change', applySourceSelection);
  $('copySourceBtn').addEventListener('click', async () => {
    await applySourceSelection();
    if (!editor.copySourceIntoMask()) setStatus(t('needMaskOrPrompt'), { error: true });
  });
  $('cropRatio').addEventListener('change', () => {
    editor.cropRatio = parseRatio($('cropRatio').value);
    editor.crop = null;
    editor.redraw();
  });
  $('applyCropBtn').addEventListener('click', () => {
    if (editor.applyCrop()) setTool('crop');
    else setStatus(t('cropTooSmall'), { error: true });
  });
  document.querySelectorAll('[data-extend]').forEach((button) => {
    button.addEventListener('click', () => {
      editor.extend(button.dataset.extend);
      $('method').value = 'fill';
      setTool('mask');
    });
  });
  $('rotateBtn').addEventListener('click', () => { editor.rotate(); setTool('crop'); });
  $('flipBtn').addEventListener('click', () => { editor.flip(); setTool('crop'); });
  document.addEventListener('keydown', (event) => {
    if (!state.editing || !(event.ctrlKey || event.metaKey) || /INPUT|TEXTAREA/.test(event.target.tagName)) return;
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      editor.redo();
    }
  });
}

function bindEvents() {
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsCancel').addEventListener('click', () => $('settings').close());
  $('settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const base = $('baseUrl').value.trim();
    const key = $('apiKey').value.trim();
    $('settingsError').textContent = '';
    try {
      await connect(base, key);
      state.settings.baseUrl = base;
      state.settings.apiKey = key;
      saveSettings();
      $('settings').close();
    } catch (err) {
      $('settingsError').textContent = err.message;
    }
  });

  $('language').replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => new Option(name, code)));
  $('language').addEventListener('change', () => setLanguage($('language').value));

  $('generateBtn').addEventListener('click', generate);
  $('stopBtn').addEventListener('click', () => state.abort?.abort());
  $('enhanceBtn').addEventListener('click', enhancePrompt);
  $('revertBtn').addEventListener('click', () => {
    if (state.originalPrompt !== null) $('prompt').value = state.originalPrompt;
    state.originalPrompt = null;
    $('revertBtn').hidden = true;
  });
  $('editBtn').addEventListener('click', async () => {
    const item = state.history.find((h) => h.id === state.currentId);
    if (item) openEditor(await loadImage(item.url));
  });
  $('clearHistoryBtn').addEventListener('click', clearHistory);
  $('useAsRefBtn').addEventListener('click', async () => {
    const item = state.history.find((h) => h.id === state.currentId);
    if (item) await addRefs([item.blob]);
  });

  $('previewMode').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    state.previewEvery = +button.dataset.value;
    refreshPreviewControls();
    saveSettings();
  });
  $('earlyPreview').addEventListener('change', () => { refreshPreviewControls(); saveSettings(); });

  $('ratio').addEventListener('change', () => { applyRatioAndSide(); updateMode(); });
  $('side').addEventListener('change', () => { applyRatioAndSide(); updateMode(); });
  for (const id of ['width', 'height']) {
    $(id).addEventListener('input', () => { $('ratio').value = 'custom'; updateMode(); });
  }
  for (const id of ['steps', 'guidance', 'negative']) $(id).addEventListener('input', updateMode);
  $('enhancer').addEventListener('change', updateMode);
  $('imageModel').addEventListener('change', () => {
    const model = modelById($('imageModel').value);
    if (model?.steps) $('steps').value = model.steps;
    if (model?.guidance_scale) $('guidance').value = model.guidance_scale;
    state.settings.imageModelChoice = $('imageModel').value;
    saveSettings();
    updateMode();
  });
  $('randomSeed').addEventListener('change', saveSettings);

  const zone = $('dropzone');
  zone.addEventListener('click', () => $('fileInput').click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('fileInput').click();
    }
  });
  $('fileInput').addEventListener('click', (event) => event.stopPropagation());
  $('fileInput').addEventListener('change', async (event) => {
    await addRefs([...event.target.files]);
    event.target.value = '';
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    addRefs([...event.dataTransfer.files]);
  });
  document.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (images.length) addRefs(images);
  });
  window.addEventListener('beforeunload', saveSettings);
}

async function start() {
  loadSettings();
  applySettings();
  bindEvents();
  bindEditor();
  applyI18n(state.settings.language || detectLanguage());
  $('language').value = currentLang;
  if (!state.settings.width || !state.settings.height) applyRatioAndSide();
  refreshPreviewControls();
  setStatus(t('ready'));
  setConnection(false, t('notConnected'));
  await restoreSessionHistory();
  if (state.settings.baseUrl && state.settings.apiKey) {
    try {
      await connect(state.settings.baseUrl, state.settings.apiKey);
    } catch (err) {
      setConnection(false, err.message);
      openSettings();
    }
  } else {
    openSettings();
  }
  setInterval(pollDevice, 3000);
  pollDevice();
}

start();
