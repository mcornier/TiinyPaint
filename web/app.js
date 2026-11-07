'use strict';

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'tiinypaint.settings';
const REFS_KEY = 'tiinypaint.refs';
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
// Sans aucun aperçu, rien ne signale la fin de l'encodage. Mesuré à 512x512, le modèle déjà chargé :
// environ 4 s avant la première étape en texte seul, 17 s avec une référence.
const EMBED_ESTIMATE_MS = { text: 4000, images: 15000 };

// Pour un LLM généraliste : les enhancers Qwen ont leur propre prompt système officiel.
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
  rewrittenPrompt: null,
  abort: null,
  busy: false,
  previewEvery: 4,
  randomSeed: true,
  ratio: '1:1',
  stage: null,
  settings: {},
  editing: false,
  editorDirty: false,
};

let editor = null;
const pickers = new Map();
let openPickerSelect = null;
let sessionHistory = null;

/* ---------- Réglages persistés (clé API comprise, dans ce navigateur seulement) ---------- */

const PERSISTED_INPUTS = ['prompt', 'negative', 'side', 'width', 'height', 'steps', 'guidance', 'seed', 'scheduler', 'temperature', 'topP', 'topK', 'method', 'scope'];

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
  s.ratio = state.ratio;
  s.randomSeed = state.randomSeed;
  s.originalPrompt = state.originalPrompt;
  s.rewrittenPrompt = state.rewrittenPrompt;
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
  if (s.ratio !== undefined) state.ratio = s.ratio;
  if (s.randomSeed !== undefined) state.randomSeed = s.randomSeed;
  if (typeof s.originalPrompt === 'string') {
    state.originalPrompt = s.originalPrompt;
    state.rewrittenPrompt = s.rewrittenPrompt ?? null;
  }
  if (s.linearSchedule !== undefined) $('earlyPreview').checked = s.linearSchedule;
  if (s.previewEvery !== undefined) state.previewEvery = s.previewEvery;
}

/* ---------- Icônes ---------- */

// Ajoute l'icône de `data-icon`, et place le texte traduit dans un <span> pour que la traduction ne l'efface pas.
function decorateIcons() {
  for (const el of document.querySelectorAll('[data-icon]')) {
    el.insertAdjacentHTML('afterbegin', iconSvg(el.dataset.icon));
    if (el.dataset.i18n) {
      const span = document.createElement('span');
      span.dataset.i18n = el.dataset.i18n;
      delete el.dataset.i18n;
      el.append(span);
    }
  }
}

function setIconLabel(el, icon, label) {
  el.innerHTML = iconSvg(icon);
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span);
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
  const ratio = parseRatio(state.ratio);
  if (!ratio) return;
  const [w, h] = sizeForRatio(ratio, +$('side').value);
  $('width').value = w;
  $('height').value = h;
}

function renderRatios() {
  for (const b of $('ratios').children) {
    b.setAttribute('aria-pressed', String(b.dataset.ratio === state.ratio));
    b.disabled = state.busy;
  }
}

// Canvas transparent aux dimensions choisies, ou à celles de l'image affichée.
function refreshFrame() {
  const item = currentItem();
  const w = item ? item.width : +$('width').value;
  const h = item ? item.height : +$('height').value;
  if (!(w > 0 && h > 0)) return;
  $('frame').style.setProperty('--ar', w / h);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  const mpx = ((w * h) / 1e6).toLocaleString(currentLang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Les tailles arrondies à 32 donnent des fractions illisibles : on affiche le format choisi s'il y en a un.
  const ratio = !item && parseRatio(state.ratio) ? state.ratio : `${w / g}:${h / g}`;
  $('frameInfo').textContent = `${w} × ${h} · ${ratio} · ${mpx} Mpx`;
}

/* ---------- Aperçus ---------- */

// Liste des étapes à décoder. La dernière est exclue : l'événement final fournit déjà l'image.
function previewSteps(steps, every) {
  if (!every) return [];
  const list = [];
  for (let s = every; s < steps; s += every) list.push(s);
  return list;
}

// Dès qu'il y a des aperçus, on demande aussi l'étape 1 : c'est le seul signal de la fin de l'encodage.
// Cette image, encore du bruit, n'est pas affichée.
function streamSteps(steps, every) {
  const list = previewSteps(steps, every);
  if (every && steps > 1 && list[0] !== 1) list.unshift(1);
  return list;
}

function refreshPreviewControls() {
  $('previewMode').value = String(state.previewEvery);
  const steps = +$('steps').value || 0;
  const count = previewSteps(steps, state.previewEvery).length;
  const mpx = ((+$('width').value || 0) * (+$('height').value || 0)) / 1e6;
  let hint;
  if (!state.previewEvery) hint = t('previewNone');
  else if (!count) hint = t('previewTooFew');
  else hint = t('previewCount', { n: count, t: formatDuration(count * mpx * PREVIEW_SECONDS_PER_MPX) });
  $('previewPill').title = `${t('previewLabel')} : ${hint}`;
  $('earlyHint').textContent = t($('earlyPreview').checked ? 'earlyHintOn' : 'earlyHintOff');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Graphe ---------- */

const STAGES = ['input', 'pe', 'embed', 'model', 'output'];

function stageClass(name) {
  if (state.stage === 'done') return 'done';
  const at = STAGES.indexOf(state.stage);
  const index = STAGES.indexOf(name);
  if (at === -1) return '';
  if (index === at) return 'active';
  return index < at ? 'done' : '';
}

function renderStage() {
  // Le bouton Améliorer peut lancer l'enhancer même si le graphe n'en utilise aucun pour le rendu.
  const skipPe = state.stage !== 'pe' && ($('enhancer').value === 'none' || !$('enhancer').value);
  // L'enhancer est hors de la chaîne de rendu : il n'est actif que pendant Améliorer.
  const pe = skipPe ? 'skip' : (state.stage === 'pe' ? 'active' : '');
  // L'encodage du prompt se passe dans le bloc modèle : il s'allume avant que la boucle d'étapes ne démarre.
  const encoding = state.stage === 'embed';
  const model = encoding ? 'active' : stageClass('model');
  const toModel = encoding ? 'active' : (stageClass('model') ? 'done' : '');
  const toContext = stageClass('output');
  const classes = {
    nodePe: pe, linkPe: pe,
    linkPrompt: toModel, wirePrompt: toModel,
    nodeModel: model, loop: stageClass('model'),
    wire4: toContext, nodeOutput: toContext, wireContext: toContext, linkContext: toContext,
  };
  for (const [id, cls] of Object.entries(classes)) {
    $(id).classList.remove('active', 'done', 'skip');
    if (cls) $(id).classList.add(cls);
  }
  const branch = $('previewBranch');
  const off = !state.previewEvery;
  branch.classList.toggle('preview-off', off);
  branch.classList.toggle('preview-active', !off && stageClass('model') === 'active');
  branch.classList.toggle('preview-done', !off && stageClass('model') === 'done');
}

function setStage(stage) {
  state.stage = stage;
  renderStage();
}

function setExpanded(button, body, open) {
  body.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.innerHTML = iconSvg(open ? 'minus' : 'plus');
}

function renderSeed() {
  const label = t(state.randomSeed ? 'seedRandom' : 'seedFixed');
  $('seedBtn').title = label;
  $('seedBtn').setAttribute('aria-label', label);
  $('seed').hidden = state.randomSeed;
  $('seedAuto').hidden = !state.randomSeed;
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
  syncPicker(select);
}

// Les enhancers sont faits pour Qwen-Image : ils ne sont proposés que pour ces modèles, s'ils sont installés.
function renderEnhancerOptions() {
  const items = [['none', t('noEnhancer')]];
  if ($('imageModel').value.includes('Qwen-Image')) {
    if (modelById(PE_I2I)) items.push(['i2i', modelById(PE_I2I).display_name]);
    if (modelById(PE_T2I)) items.push(['t2i', modelById(PE_T2I).display_name]);
  }
  for (const m of state.models) {
    if (isChatModel(m) && !isPromptEnhancer(m)) items.push([m.id, m.display_name]);
  }
  fillSelect($('enhancer'), items, $('enhancer').value || state.settings.enhancer);
}

/* ---------- Listes déroulantes ---------- */

const ENHANCER_MODELS = { i2i: PE_I2I, t2i: PE_T2I };

// Une liste native reste la source de vérité : le menu ne fait que la présenter dans le style de la page.
function pickerItems(select) {
  return [...select.options].map((option) => {
    const item = { value: option.value, label: option.textContent, group: null, model: null };
    if (select.id === 'imageModel') {
      item.model = modelById(option.value);
    } else if (select.id === 'enhancer' && option.value !== 'none') {
      item.group = ENHANCER_MODELS[option.value] ? 'PE' : 'LLM';
      item.model = modelById(ENHANCER_MODELS[option.value] || option.value);
    }
    return item;
  });
}

function syncPicker(select) {
  const button = pickers.get(select);
  if (!button) return;
  const item = pickerItems(select).find((i) => i.value === select.value);
  button.querySelector('.picker-label').textContent = item?.label || '';
  button.title = item?.label || '';
  if (select.id === 'language') button.querySelector('.picker-flag').innerHTML = flagSvg(select.value);
  button.classList.toggle('unloaded', !!item?.model && !state.running.includes(item.model.id));
  button.disabled = select.disabled || !select.options.length;
  const name = select.getAttribute('aria-label') || select.closest('label')?.querySelector('[data-i18n]')?.textContent;
  button.setAttribute('aria-label', name ? `${name} : ${item?.label || ''}` : item?.label || '');
}

function refreshPickers() {
  refreshEnhanceButton();
  for (const select of pickers.keys()) syncPicker(select);
  if (openPickerSelect) renderPickerMenu();
}

function closePicker(focus = false) {
  if (!openPickerSelect) return;
  const button = pickers.get(openPickerSelect);
  button.setAttribute('aria-expanded', 'false');
  $('pickerMenu').hidden = true;
  openPickerSelect = null;
  if (focus) button.focus();
}

function renderPickerMenu() {
  const select = openPickerSelect;
  const menu = $('pickerMenu');
  const rows = [];
  let group = null;
  for (const item of pickerItems(select)) {
    if (item.group && item.group !== group) {
      group = item.group;
      const heading = document.createElement('p');
      heading.className = 'picker-group';
      heading.textContent = group;
      rows.push(heading);
    }
    const running = item.model && state.running.includes(item.model.id);
    const row = document.createElement('div');
    row.className = `picker-row${item.value === select.value ? ' selected' : ''}${item.model && !running ? ' unloaded' : ''}`;
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'picker-option';
    choice.setAttribute('aria-current', String(item.value === select.value));
    choice.innerHTML = item.value === select.value ? iconSvg('check') : '<span class="picker-check"></span>';
    if (item.model) {
      const dot = document.createElement('span');
      dot.className = `dot${running ? ' on' : ''}`;
      choice.append(dot);
    }
    if (select.id === 'language') choice.insertAdjacentHTML('beforeend', flagSvg(item.value));
    const label = document.createElement('span');
    label.className = 'picker-name';
    label.textContent = item.label;
    choice.append(label);
    choice.addEventListener('click', () => {
      select.value = item.value;
      closePicker(true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncPicker(select);
    });
    row.append(choice);
    if (item.model) {
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn small';
      load.textContent = t(running ? 'unload' : 'load');
      load.disabled = state.busy;
      const { model } = item;
      load.addEventListener('click', () => withLock(() => (running ? unloadModel(model) : ensureLoaded(model.id))));
      row.append(load);
    }
    rows.push(row);
  }
  menu.replaceChildren(...rows);
  placePickerMenu();
}

// Le menu est au niveau du document : le flou du graphe et son défilement ne doivent pas le contraindre.
function placePickerMenu() {
  const menu = $('pickerMenu');
  const rect = pickers.get(openPickerSelect).getBoundingClientRect();
  const hasModels = openPickerSelect.id === 'enhancer' || openPickerSelect.id === 'imageModel';
  menu.style.minWidth = `${Math.max(rect.width, hasModels ? 340 : 0)}px`;
  menu.style.maxHeight = `${Math.max(rect.top, window.innerHeight - rect.bottom) - 16}px`;
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const below = window.innerHeight - rect.bottom >= height + 8;
  menu.style.top = `${below ? rect.bottom + 4 : rect.top - height - 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
}

function openPicker(select) {
  closePicker();
  toggleDevicePanel(false);
  openPickerSelect = select;
  pickers.get(select).setAttribute('aria-expanded', 'true');
  $('pickerMenu').hidden = false;
  renderPickerMenu();
  ($('pickerMenu').querySelector('.selected .picker-option') || $('pickerMenu').querySelector('.picker-option'))?.focus();
}

function enhancePickers() {
  for (const select of document.querySelectorAll('select')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker ${select.className}`.trim();
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const flag = select.id === 'language' ? '<span class="picker-flag"></span>' : '';
    button.innerHTML = `${flag}<span class="picker-label"></span>${iconSvg('chevron-down')}`;
    button.addEventListener('click', () => {
      if (openPickerSelect === select) closePicker();
      else openPicker(select);
    });
    select.after(button);
    select.hidden = true;
    pickers.set(select, button);
    syncPicker(select);
  }
  // composedPath, car un clic sur Charger redessine la liste : la cible n'est déjà plus dans le document.
  document.addEventListener('click', (event) => {
    const inside = event.composedPath().some((el) => el.classList?.contains('picker') || el.classList?.contains('picker-menu'));
    if (openPickerSelect && !inside) closePicker();
  });
  $('pickerMenu').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = [...$('pickerMenu').querySelectorAll('.picker-option')];
    const index = options.indexOf(document.activeElement);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    options[(next + options.length) % options.length]?.focus();
  });
  window.addEventListener('resize', () => closePicker());
}

// Le bon enhancer dépend de la présence d'images. Le choix reste libre ensuite.
function followImagesWithEnhancer() {
  const select = $('enhancer');
  if (!ENHANCER_MODELS[select.value]) return;
  const wanted = state.refs.length || state.editing ? 'i2i' : 't2i';
  if ([...select.options].some((o) => o.value === wanted)) select.value = wanted;
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
  renderEnhancerOptions();
}

function renderModelList() {
  const shown = state.models
    .filter((m) => isImageModel(m) || isChatModel(m))
    .sort((a, b) => Number(state.running.includes(b.id)) - Number(state.running.includes(a.id)));
  $('modelList').replaceChildren(...shown.map((m) => {
    const running = state.running.includes(m.id);
    const row = document.createElement('div');
    row.className = 'model';
    const dot = document.createElement('span');
    dot.className = `dot${running ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = m.display_name;
    const usage = document.createElement('span');
    usage.className = 'model-usage';
    usage.textContent = m.npu_usage ? t('npuPercent', { n: m.npu_usage }) : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small';
    button.textContent = running ? t('unload') : t('load');
    button.disabled = state.busy;
    button.addEventListener('click', () => withLock(() => (running ? unloadModel(m) : ensureLoaded(m.id))));
    row.append(dot, name, usage, button);
    return row;
  }));
  refreshPickers();
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
    setStatus(t('unloading', { m: name }));
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
  setStatus(t('loading', { m: label }));
  await state.client.launch(id);
  await state.client.waitRunning(id, { signal });
  await refreshRunning();
}

/* ---------- Images du contexte et références ---------- */

const currentItem = () => state.history.find((h) => h.id === state.currentId);
const isGenerated = (item) => item.kind !== 'import';

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

// Ajoute des fichiers au contexte. Les cocher en fait des références.
async function importImages(blobs) {
  let last = null;
  for (const blob of blobs) {
    if (!blob.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const item = { id: crypto.randomUUID(), kind: 'import', url, blob, width: img.naturalWidth, height: img.naturalHeight, createdAt: Date.now() };
      state.history.unshift(item);
      storeItem(item);
      last = item;
    } catch (err) {
      URL.revokeObjectURL(url);
      setStatus(err.message, { error: true });
    }
  }
  if (last) {
    renderGallery();
    renderSourceOptions();
  }
}

function saveRefSelection() {
  try {
    sessionStorage.setItem(REFS_KEY, JSON.stringify(state.refs.map((r) => r.id)));
  } catch { /* la sélection ne survivra pas au rechargement */ }
}

async function toggleRef(item) {
  if (state.busy) return;
  const index = state.refs.findIndex((r) => r.id === item.id);
  if (index !== -1) {
    state.refs.splice(index, 1);
  } else {
    if (state.refs.length >= MAX_IMAGES) {
      setStatus(t('maxRefs', { n: MAX_IMAGES }), { error: true });
      return;
    }
    try {
      state.refs.push({ id: item.id, ...(await fileToRef(item.blob)) });
    } catch (err) {
      setStatus(err.message, { error: true });
      return;
    }
  }
  saveRefSelection();
  followImagesWithEnhancer();
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
    open.title = t('removeRef', { n: index + 1 });
    const img = document.createElement('img');
    img.src = ref.dataUrl;
    img.alt = t('refAlt', { n: index + 1 });
    open.append(img);
    open.addEventListener('click', () => {
      const item = state.history.find((h) => h.id === ref.id);
      if (item) toggleRef(item);
    });
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'ref-tag';
    const label = `<image${refTagNumber(index)}>`;
    tag.textContent = label;
    tag.title = t('insertTag');
    tag.addEventListener('click', () => insertInPrompt(label));
    wrap.append(open, tag);
    return wrap;
  }));
  $('noRefs').hidden = state.refs.length > 0;
  $('refCount').textContent = t('inReference', { n: state.refs.length });
  renderGallery();
  renderSourceOptions();
  updateMode();
}

function insertInPrompt(text) {
  const area = $('prompt');
  const start = area.selectionStart ?? area.value.length;
  area.setRangeText(text, start, area.selectionEnd ?? start, 'end');
  area.focus();
}

function renderGallery() {
  $('gallery').replaceChildren(...state.history.map((item) => {
    const selected = state.refs.some((r) => r.id === item.id);
    const thumb = document.createElement('div');
    thumb.className = `thumb${selected ? ' selected' : ''}${item.id === state.currentId ? ' shown' : ''}`;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'thumb-open';
    open.title = isGenerated(item)
      ? t('historyTitle', { w: item.width, h: item.height, s: item.seed })
      : `${item.width}×${item.height}`;
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = isGenerated(item) ? t('renderAlt', { s: item.seed }) : t('imported');
    open.append(img);
    open.addEventListener('click', async () => {
      if (state.editing) {
        // Dans l'éditeur, une vignette devient la source de restauration.
        $('source').value = `h:${item.id}`;
        await applySourceSelection();
        setTool('restore');
      } else if (!state.busy) {
        selectHistory(item.id);
      }
    });
    if (isGenerated(item)) open.addEventListener('dblclick', () => restoreHistoryParams(item));

    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'thumb-tick';
    tick.title = t('addAsRef');
    tick.setAttribute('aria-label', t('addAsRef'));
    tick.setAttribute('aria-pressed', String(selected));
    if (selected) tick.innerHTML = iconSvg('check');
    tick.addEventListener('click', () => toggleRef(item));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thumb-remove';
    remove.innerHTML = iconSvg('x');
    remove.title = t('removeImage');
    remove.setAttribute('aria-label', t('removeImage'));
    remove.disabled = state.busy || state.editing;
    remove.addEventListener('click', () => removeImage(item));

    const kind = document.createElement('span');
    kind.className = 'thumb-kind';
    kind.textContent = t(isGenerated(item) ? 'generatedTag' : 'imported');

    thumb.append(open, tick, remove, kind);
    return thumb;
  }));
}

function updateMode() {
  const masked = state.editing && editor.hasMask();
  const editing = state.editing || state.refs.length > 0;
  const generateLabel = $('generateBtn').querySelector('span');
  if (generateLabel) generateLabel.textContent = t(masked ? 'generateLocal' : 'generate');

  const model = modelById($('imageModel').value);
  const modeHint = $('modeHint');
  if (editing && model && !canEdit(model)) {
    modeHint.textContent = t('noEditSupport', { m: model.display_name });
    modeHint.classList.add('warn');
  } else {
    modeHint.textContent = masked ? t('hintLocal') : '';
    modeHint.classList.remove('warn');
  }

  const pe = $('enhancer').value;
  const peHints = { i2i: editing ? 'hintI2I' : 'hintI2INoImage', t2i: editing ? 'hintT2IWithImages' : 'hintT2I' };
  $('peHint').textContent = peHints[pe] ? t(peHints[pe]) : '';

  const guidance = +$('guidance').value;
  $('negativeHint').textContent = t(guidance <= 1 ? 'negOff' : 'negOn');
  $('negativeHint').classList.toggle('warn', guidance <= 1 && !!$('negative').value.trim());
  const error = sizeError(+$('width').value, +$('height').value);
  $('sizeHint').textContent = error;
  $('sizeHint').classList.toggle('warn', !!error);
  refreshEnhanceButton();
  refreshPreviewControls();
  refreshFrame();
  renderStage();
  refreshPickers();
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
  $('frameBar').hidden = true;
  $('frame').hidden = true;
  editor.load(image);
  setTool(editor.tool);
  followImagesWithEnhancer();
  renderRefs();
  refreshEditorButtons();
  updateDownload();
}

function closeEditor() {
  state.editing = false;
  $('editBar').hidden = true;
  $('editCanvas').hidden = true;
  $('frameBar').hidden = false;
  $('frame').hidden = false;
  const item = currentItem();
  if (item) showImage(item.url);
  followImagesWithEnhancer();
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
  const total = state.history.length;
  state.history.forEach((item, i) => {
    items.push([`h:${item.id}`, t(isGenerated(item) ? 'sourceHistory' : 'sourceImport', { n: total - i })]);
  });
  fillSelect(select, items, wanted);
}

async function applySourceSelection() {
  const value = $('source').value;
  if (value === 'origin') {
    editor.setSource(null);
  } else if (value.startsWith('h:')) {
    const item = state.history.find((h) => `h:${h.id}` === value);
    if (item) editor.setSource(await loadImage(item.url));
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

// Réglages de l'exemple officiel Qwen (prompt_rewrite/pe_core.py).
function enhancerPlan(choice, images) {
  const sampling = {
    temperature: +$('temperature').value,
    top_p: +$('topP').value,
    top_k: +$('topK').value,
  };
  if (!ENHANCER_MODELS[choice]) {
    const model = modelById(choice);
    return {
      model: choice,
      system: GENERIC_SYSTEM_PROMPT,
      sampling,
      sendImages: images.length > 0 && !!model?.input?.includes('Image'),
      max_tokens: 4000,
      extra: model?.thinking?.toggleable ? { chat_template_kwargs: { enable_thinking: false } } : {},
    };
  }
  if (choice === 't2i') {
    return { model: PE_T2I, system: window.TP_PROMPTS.t2i, sampling, sendImages: false, max_tokens: 16256, extra: { presence_penalty: 1.5 } };
  }
  if (images.length) {
    return { model: PE_I2I, system: window.TP_PROMPTS.i2i, sampling, sendImages: true, max_tokens: 24000, extra: {} };
  }
  // Le prompt système de PE-I2I suppose toujours une image : on s'en passe sans image.
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
  if (state.editing) return;
  let ratio = null;
  const follow = /^<image(\d+)>$/.exec(result.ratio_follow);
  if (follow && state.refs[+follow[1] - 1]) {
    const ref = state.refs[+follow[1] - 1];
    ratio = ref.width / ref.height;
  } else if (parseRatio(result.wh_ratio)) {
    ratio = parseRatio(result.wh_ratio);
  }
  if (!ratio) return;
  const [w, h] = sizeForRatio(ratio, +$('side').value);
  $('width').value = w;
  $('height').value = h;
  const preset = [...$('ratios').children].find((b) => Math.abs(parseRatio(b.dataset.ratio) - ratio) < 0.01);
  state.ratio = preset ? preset.dataset.ratio : 'custom';
  renderRatios();
  refreshFrame();
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

// Le bouton Améliorer utilise le modèle choisi dans le graphe. Sans modèle, il reste cliquable pour montrer où le choisir.
function manualEnhancer() {
  const chosen = $('enhancer').value;
  return chosen && chosen !== 'none' ? chosen : null;
}

const modelName = (id) => modelById(id)?.display_name || id;
const enhancerModelId = (choice) => ENHANCER_MODELS[choice] || choice;

// Aucun chargement n'est forcé. Ce qui manque est renvoyé sous la forme { node, message } pour le signaler.
function enhancerBlocker() {
  const choice = manualEnhancer();
  if (!choice) return { node: 'nodePe', message: t('chooseEnhancer') };
  const id = enhancerModelId(choice);
  return state.running.includes(id) ? null : { node: 'nodePe', message: t('loadModelFirst', { m: modelName(id) }) };
}

function generateBlocker() {
  const id = $('imageModel').value;
  return state.running.includes(id) ? null : { node: 'nodeModel', message: t('loadModelFirst', { m: modelName(id) }) };
}

function refreshActionButton(button, blocker, disabled) {
  button.disabled = disabled;
  button.classList.toggle('unavailable', !!blocker);
  button.setAttribute('aria-disabled', String(!!blocker));
  button.title = blocker ? blocker.message : '';
}

function refreshEnhanceButton() {
  refreshActionButton($('enhanceBtn'), enhancerBlocker(), state.busy || !connectionLabel);
  refreshActionButton($('generateBtn'), generateBlocker(), !connectionLabel);
}

function flashNode({ node: id, message }) {
  const node = $(id);
  node.classList.remove('flash');
  // Force un nouveau calcul de style pour relancer l'animation si elle est déjà en cours.
  void node.offsetWidth;
  node.classList.add('flash');
  setStatus(message, { error: true });
}

function renderRewriteState() {
  const rewritten = state.originalPrompt !== null;
  $('revertBtn').hidden = !rewritten;
}

function forgetRewrite() {
  state.originalPrompt = null;
  state.rewrittenPrompt = null;
  renderRewriteState();
}

// Lance seulement l'enhancer. Le résultat prend la place du prompt, pour être relu et retouché avant le rendu.
async function enhanceOnly() {
  const blocker = enhancerBlocker();
  if (blocker) {
    flashNode(blocker);
    return;
  }
  const current = $('prompt').value.trim();
  // Une réécriture non retouchée repart de l'original : on ne réécrit pas une réécriture.
  const instruction = state.originalPrompt !== null && current === state.rewrittenPrompt ? state.originalPrompt : current;
  const choice = manualEnhancer();
  if (!instruction) {
    setStatus(t('writePromptFirst'), { error: true });
    return;
  }
  const controller = beginTask();
  setStage('pe');
  try {
    const result = await runEnhancer(instruction, controller.signal, choice);
    state.originalPrompt = instruction;
    state.rewrittenPrompt = result.prompt;
    $('prompt').value = result.prompt;
    renderRewriteState();
    applyEnhancedRatio(result);
    setStatus(t('enhanced'));
    saveSettings();
  } catch (err) {
    reportError(err, 'enhanceStopped');
  } finally {
    setStage(null);
    endTask();
    updateMode();
  }
}

async function runEnhancer(instruction, signal, choice) {
  const { images, note } = enhancerImages();
  const plan = enhancerPlan(choice, images);
  $('thinkingBox').hidden = false;
  $('thinking').textContent = '';
  $('thinkingSummary').textContent = t('thinking');
  await ensureLoaded(plan.model, signal);
  const label = modelById(plan.model)?.display_name || plan.model;
  const started = Date.now();
  setStatus(t('thinkingStatus', { m: label, t: formatDuration(0) }));
  const text = instruction + note;
  const content = plan.sendImages
    ? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : text;
  const messages = [...(plan.system ? [{ role: 'system', content: plan.system }] : []), { role: 'user', content }];
  const output = await state.client.streamChat(
    { model: plan.model, messages, max_tokens: plan.max_tokens, ...plan.sampling, ...plan.extra },
    {
      signal,
      onDelta: ({ content: answer, reasoning }) => {
        const box = $('thinking');
        const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
        box.textContent = reasoning + (answer ? `\n\n${answer}` : '');
        if (atEnd) box.scrollTop = box.scrollHeight;
        const elapsed = formatDuration((Date.now() - started) / 1000);
        setStatus(t(answer ? 'writingStatus' : 'thinkingStatus', { m: label, t: elapsed }));
      },
    },
  );
  const result = parseEnhanced(output.content);
  if (!result) throw new TiinyError(t(output.finish === 'length' ? 'truncated' : 'emptyReply'), 0);
  $('thinkingSummary').textContent = t('thinkingDone', { t: formatDuration((Date.now() - started) / 1000) });
  return result;
}

/* ---------- Génération ---------- */

function baseBody(prompt) {
  const steps = +$('steps').value;
  if (state.randomSeed) $('seed').value = Math.floor(Math.random() * 2147483647);
  const model = $('imageModel').value;
  const body = {
    model,
    prompt,
    // La route en flux ignore `size` : il faut bien width et height.
    width: +$('width').value,
    height: +$('height').value,
    steps,
    guidance_scale: +$('guidance').value,
    seed: +$('seed').value,
    stream_return_steps: streamSteps(steps, state.previewEvery),
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
function buildRequest(prompt) {
  const body = baseBody(prompt);
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
  $('output').src = src;
  $('output').hidden = false;
}

function setAmbient(url) {
  const ambient = $('ambient');
  ambient.classList.toggle('has-image', !!url);
  ambient.style.background = url ? `center / cover no-repeat url("${url}")` : '';
}

// Revient au canvas transparent, aux dimensions choisies.
function showEmptyCanvas() {
  state.currentId = null;
  $('output').hidden = true;
  $('output').removeAttribute('src');
  setAmbient(null);
  updateDownload();
  renderGallery();
  refreshFrame();
}

function endPreview() {
  $('frame').classList.remove('previewing');
  $('previewBadge').hidden = true;
  $('steps').hidden = false;
  $('stepNow').hidden = true;
}

async function generate() {
  const blocker = generateBlocker();
  if (blocker) {
    flashNode(blocker);
    return;
  }
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
    showEmptyCanvas();
  }
  const controller = beginTask();
  const previewEvery = state.previewEvery;
  if (state.editing) editor.disabled = true;
  setStage('input');
  const startedAt = { value: 0 };
  let lastStep = 0;
  let lastStepAt = 0;
  let stepSeconds = 0;
  let timer = null;
  let embedTimer = null;
  let body = null;
  let plan = null;

  const showStepCount = () => {
    $('stepNow').textContent = `${lastStep || '–'} / ${body.steps}`;
  };

  const tick = () => {
    const elapsed = (Date.now() - startedAt.value) / 1000;
    let text = t('elapsed', { t: formatDuration(elapsed) });
    if (lastStep) text = `${t('stepOf', { s: lastStep, n: body.steps })} · ${text}`;
    if (stepSeconds) {
      const left = (body.steps - lastStep) * stepSeconds - (Date.now() - lastStepAt) / 1000;
      text += ` · ${t('remaining', { t: formatDuration(left) })}`;
    }
    setStatus(text);
  };

  const showPreview = async (src, step) => {
    if (plan) {
      editor.setPreview(await loadImage(src), plan.region);
      return;
    }
    showImage(src);
    $('frame').classList.add('previewing');
    $('previewStep').textContent = t('previewStep', { s: step });
    $('previewBadge').hidden = false;
  };

  const attempt = () => state.client.streamImage(body, {
    signal: controller.signal,
    onStart: () => {
      setStage('embed');
      clearTimeout(embedTimer);
      if (!previewEvery) {
        embedTimer = setTimeout(() => setStage('model'), body.images?.length ? EMBED_ESTIMATE_MS.images : EMBED_ESTIMATE_MS.text);
      }
    },
    onPreview: (event) => {
      clearTimeout(embedTimer);
      setStage('model');
      if (event.step !== 1 || previewEvery === 1) showPreview(event.image, event.step);
      const now = Date.now();
      if (lastStep && event.step > lastStep) stepSeconds = (now - lastStepAt) / 1000 / (event.step - lastStep);
      lastStep = event.step;
      lastStepAt = now;
      showStepCount();
      tick();
    },
  });

  try {
    ({ body, plan } = buildRequest(rawPrompt));
    if ((body.images?.length || 0) > MAX_IMAGES) throw new TiinyError(t('tooManyImages'), 0);
    $('steps').hidden = true;
    $('stepNow').hidden = false;
    showStepCount();
    setStage('embed');
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
      setStatus(t('retrying'));
      await new Promise((resolve) => setTimeout(resolve, 10000));
      result = await attempt();
    }
    clearTimeout(embedTimer);
    setStage('output');
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
    endPreview();
    addToHistory(blob, { ...body, prompt: rawPrompt, width, height }, elapsed);
    setStage('done');
    setStatus(t('done', { t: formatDuration(elapsed), w: width, h: height, s: body.seed }));
  } catch (err) {
    clearTimeout(embedTimer);
    setStage(null);
    if (plan) editor.clearPreview();
    if (err.name === 'AbortError' && lastStep) {
      setStatus(t('stoppedAt', { s: lastStep, n: body.steps }));
    } else {
      reportError(err, 'renderStopped');
    }
  } finally {
    clearInterval(timer);
    endPreview();
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
  storeItem(item);
}

function storeItem(item) {
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
  let selected = [];
  try {
    selected = JSON.parse(sessionStorage.getItem(REFS_KEY)) || [];
  } catch { /* pas de sélection à restaurer */ }
  for (const id of selected) {
    const item = state.history.find((h) => h.id === id);
    if (!item) continue;
    try {
      state.refs.push({ id, ...(await fileToRef(item.blob)) });
    } catch { /* image illisible : elle n'est simplement plus sélectionnée */ }
  }
  if (state.history.length) selectHistory(state.history[0].id);
  renderRefs();
}

function forgetItem(item) {
  URL.revokeObjectURL(item.url);
  state.history = state.history.filter((h) => h.id !== item.id);
  state.refs = state.refs.filter((r) => r.id !== item.id);
  sessionHistory?.remove(item.id).catch(warnHistoryNotSaved);
}

function afterRemoval() {
  saveRefSelection();
  followImagesWithEnhancer();
  if (state.currentId && !currentItem()) showEmptyCanvas();
  renderRefs();
  updateDownload();
}

function removeImage(item) {
  if (isGenerated(item) && !window.confirm(t('confirmRemoveImage'))) return;
  forgetItem(item);
  afterRemoval();
}

function clearHistory() {
  const generated = state.history.filter(isGenerated);
  if (!window.confirm(t('confirmClearHistory', { n: generated.length }))) return;
  generated.forEach(forgetItem);
  afterRemoval();
}

function selectHistory(id) {
  const item = state.history.find((h) => h.id === id);
  if (!item) return;
  state.currentId = id;
  if (!state.editing) {
    showImage(item.url);
    setAmbient(item.url);
    refreshFrame();
  }
  updateDownload();
  renderGallery();
}

function updateDownload() {
  const item = currentItem();
  const link = $('downloadBtn');
  const enabled = !!item;
  link.classList.toggle('disabled', !enabled);
  if (enabled) {
    link.href = item.url;
    link.download = `tiinypaint-${item.seed ?? item.id.slice(0, 8)}.png`;
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }
  $('editBtn').disabled = !enabled || state.busy || state.editing;
  $('clearViewBtn').disabled = !enabled || state.busy;
  $('clearHistoryBtn').disabled = !state.history.some(isGenerated) || state.busy || state.editing;
}

function restoreHistoryParams(item) {
  forgetRewrite();
  $('prompt').value = item.prompt;
  $('negative').value = item.negative;
  if (!state.editing) {
    $('width').value = item.width;
    $('height').value = item.height;
    state.ratio = 'custom';
    renderRatios();
  }
  $('steps').value = item.steps;
  $('guidance').value = item.guidance;
  $('seed').value = item.seed;
  state.randomSeed = false;
  renderSeed();
  $('scheduler').value = item.scheduler;
  $('earlyPreview').checked = item.linear;
  if (modelById(item.model)) {
    $('imageModel').value = item.model;
    renderEnhancerOptions();
  }
  updateMode();
  saveSettings();
}

/* ---------- États de l'interface ---------- */

function setStatus(text, { error = false } = {}) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error-text', error);
}

function reportError(err, abortedKey) {
  if (err.name === 'AbortError') setStatus(t(abortedKey));
  else setStatus(err.message || String(err), { error: true });
}

function setBusy(busy) {
  state.busy = busy;
  $('generateBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  for (const id of ['imageModel', 'enhancer', 'width', 'height', 'side', 'steps', 'seed', 'seedBtn', 'connBtn', 'previewMode']) $(id).disabled = busy;
  renderRatios();
  refreshEnhanceButton();
  $('revertBtn').disabled = busy;
  updateDownload();
  renderModelList();
  renderGallery();
}

function beginTask() {
  saveSettings();
  setBusy(true);
  state.abort = new AbortController();
  return state.abort;
}

function endTask() {
  state.abort = null;
  setBusy(false);
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

function renderConnButton() {
  if (state.client) setIconLabel($('connBtn'), 'unlink', t('disconnect'));
  else setIconLabel($('connBtn'), 'link', t('connect'));
}

function setConnection(on, text) {
  connectionLabel = on ? text : null;
  $('connDot').classList.toggle('on', on);
  $('connText').textContent = text;
  $('deviceBtn').disabled = !state.client;
  if (!state.client) toggleDevicePanel(false);
  renderConnButton();
  refreshEnhanceButton();
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

// La clé reste enregistrée dans ce navigateur pour faciliter la reconnexion, mais la page ne se reconnecte plus seule.
function disconnect() {
  state.client = null;
  state.models = [];
  state.running = [];
  state.settings.autoConnect = false;
  saveSettings();
  renderModelSelects();
  renderModelList();
  for (const id of ['npuBar', 'memBar']) $(id).style.width = '0';
  $('npuText').textContent = '–';
  $('memText').textContent = '–';
  setConnection(false, t('notConnected'));
  updateMode();
  setStatus(t('ready'));
}

async function pollDevice() {
  if (!state.client) return;
  const client = state.client;
  try {
    const npu = await client.npuStatus();
    if (client !== state.client) return;
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
    if (client === state.client) setConnection(false, err.message);
  }
}

function openSettings() {
  $('baseUrl').value = state.settings.baseUrl || '';
  $('apiKey').value = state.settings.apiKey || '';
  $('settingsError').textContent = '';
  $('settings').showModal();
}

function toggleDevicePanel(open) {
  $('devicePanel').hidden = !open;
  $('deviceBtn').setAttribute('aria-expanded', String(open));
}

/* ---------- Langue ---------- */

function setLanguage(lang) {
  const idle = !state.busy && $('status').textContent === t('ready');
  applyI18n(lang);
  $('language').value = currentLang;
  closePicker();
  if (state.client) renderModelSelects();
  else renderEnhancerOptions();
  renderModelList();
  renderRefs();
  renderSeed();
  if (state.editing) setTool(editor.tool);
  if (!state.client || !connectionLabel) $('connText').textContent = t('notConnected');
  renderConnButton();
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

// Changer la taille demandée n'a de sens que sur le canvas vide : l'image affichée a ses propres dimensions.
function onSizeChanged() {
  if (!state.editing && state.currentId) showEmptyCanvas();
  updateMode();
}

function bindEvents() {
  $('connBtn').addEventListener('click', () => {
    if (state.client) disconnect();
    else openSettings();
  });
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
      state.settings.autoConnect = true;
      saveSettings();
      $('settings').close();
    } catch (err) {
      $('settingsError').textContent = err.message;
    }
  });

  $('deviceBtn').addEventListener('click', () => toggleDevicePanel($('devicePanel').hidden));
  document.addEventListener('click', (event) => {
    if (!event.composedPath().some((el) => el.classList?.contains('device'))) toggleDevicePanel(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      toggleDevicePanel(false);
      closePicker(true);
    }
  });

  $('language').replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => new Option(name, code)));
  $('language').addEventListener('change', () => setLanguage($('language').value));

  $('generateBtn').addEventListener('click', generate);
  $('stopBtn').addEventListener('click', () => state.abort?.abort());
  $('enhanceBtn').addEventListener('click', enhanceOnly);
  $('graph').addEventListener('animationend', (event) => {
    if (event.animationName === 'flash-orange') event.target.classList.remove('flash');
  });
  $('revertBtn').addEventListener('click', () => {
    $('prompt').value = state.originalPrompt;
    forgetRewrite();
    saveSettings();
  });
  $('prompt').addEventListener('input', () => {
    if (!$('prompt').value.trim()) forgetRewrite();
  });
  $('editBtn').addEventListener('click', async () => {
    const item = currentItem();
    if (item) openEditor(await loadImage(item.url));
  });
  $('clearViewBtn').addEventListener('click', showEmptyCanvas);
  $('clearHistoryBtn').addEventListener('click', clearHistory);

  $('peToggle').addEventListener('click', () => {
    const open = $('peBody').hidden;
    setExpanded($('peToggle'), $('peBody'), open);
    $('nodePe').classList.toggle('open', open);
  });
  $('modelToggle').addEventListener('click', () => setExpanded($('modelToggle'), $('modelBody'), $('modelBody').hidden));
  $('seedBtn').addEventListener('click', () => {
    state.randomSeed = !state.randomSeed;
    renderSeed();
    saveSettings();
  });

  $('previewMode').addEventListener('change', () => {
    state.previewEvery = +$('previewMode').value;
    refreshPreviewControls();
    renderStage();
    saveSettings();
  });
  $('earlyPreview').addEventListener('change', () => { refreshPreviewControls(); saveSettings(); });

  $('ratios').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    state.ratio = button.dataset.ratio;
    applyRatioAndSide();
    renderRatios();
    onSizeChanged();
  });
  $('side').addEventListener('change', () => { applyRatioAndSide(); onSizeChanged(); });
  for (const id of ['width', 'height']) {
    $(id).addEventListener('input', () => {
      state.ratio = 'custom';
      renderRatios();
      onSizeChanged();
    });
  }
  for (const id of ['steps', 'guidance', 'negative']) $(id).addEventListener('input', updateMode);
  $('enhancer').addEventListener('change', updateMode);
  $('imageModel').addEventListener('change', () => {
    const model = modelById($('imageModel').value);
    if (model?.steps) $('steps').value = model.steps;
    if (model?.guidance_scale) $('guidance').value = model.guidance_scale;
    state.settings.imageModelChoice = $('imageModel').value;
    renderEnhancerOptions();
    saveSettings();
    updateMode();
  });

  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (event) => {
    await importImages([...event.target.files]);
    event.target.value = '';
  });
  const zone = $('contextPanel');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    importImages([...event.dataTransfer.files]);
  });
  document.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (images.length) importImages(images);
  });
  window.addEventListener('beforeunload', saveSettings);
}

async function start() {
  loadSettings();
  applySettings();
  decorateIcons();
  bindEvents();
  bindEditor();
  applyI18n(state.settings.language || detectLanguage());
  $('language').value = currentLang;
  enhancePickers();
  if (!state.settings.width || !state.settings.height) applyRatioAndSide();
  setExpanded($('peToggle'), $('peBody'), false);
  setExpanded($('modelToggle'), $('modelBody'), false);
  renderRatios();
  renderSeed();
  renderRewriteState();
  renderEnhancerOptions();
  renderRefs();
  setStatus(t('ready'));
  setConnection(false, t('notConnected'));
  await restoreSessionHistory();
  const { baseUrl, apiKey, autoConnect } = state.settings;
  if (baseUrl && apiKey && autoConnect !== false) {
    try {
      await connect(baseUrl, apiKey);
    } catch (err) {
      setConnection(false, err.message);
      openSettings();
    }
  } else if (!baseUrl || !apiKey) {
    openSettings();
  }
  setInterval(pollDevice, 3000);
  pollDevice();
}

start();
