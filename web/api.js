// Client minimal de l'API Tiiny. Voir docs/API_TIINY.md pour le détail des routes.
'use strict';

class TiinyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function errorMessage(data, fallback) {
  const e = data && (data.error ?? data.detail ?? data.message);
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  return e.message || JSON.stringify(e);
}

// Lit un flux SSE et appelle onEvent(nomEvenement, dataTexte) pour chaque bloc complet.
async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, data.join('\n'));
    }
  }
}

class TiinyClient {
  constructor(base, key) {
    this.base = base.replace(/\/+$/, '');
    this.key = key;
  }

  async _fetch(path, options = {}) {
    let response;
    try {
      response = await fetch(this.base + path, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new TiinyError(t('errUnreachable', { base: this.base }), 0);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* réponse non JSON */ }
      let message = errorMessage(data, text.slice(0, 300) || `HTTP ${response.status}`);
      if (response.status === 401) message = t('errKey');
      if (response.status === 502) message = t('errLocked');
      throw new TiinyError(message, response.status);
    }
    return response;
  }

  async _json(path, options) {
    return (await this._fetch(path, options)).json();
  }

  deviceInfo() { return this._json('/api/v1/sys/device_info'); }
  npuStatus() { return this._json('/api/v1/npu/status'); }
  async models() { return (await this._json('/api/v1/models/')).data; }
  running() { return this._json('/api/v1/models/running'); }
  unloadCandidate(id) { return this._json(`/api/v1/models/${encodeURIComponent(id)}/unload_candidate`); }

  launch(id) {
    return this._json(`/api/v1/models/${encodeURIComponent(id)}/launch`, {
      method: 'POST',
      body: JSON.stringify({ model_id: id }),
    });
  }

  stop(id) {
    return this._json(`/api/v1/models/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' });
  }

  // Attend que le modèle soit servi. Le chargement est asynchrone côté Tiiny.
  async waitRunning(id, { timeoutMs = 90000, signal } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const state = await this.running();
      if (state.running.includes(id)) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new TiinyError(t('errNoStart', { m: id }), 0);
  }

  // Génération avec événements : start, preview, completed, end, error.
  async streamImage(body, { signal, onPreview, onStart }) {
    const response = await this._fetch('/v1/image/generate/stream', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
    let result = null;
    await readSse(response, (event, raw) => {
      const data = JSON.parse(raw);
      if (event === 'start') onStart?.(data);
      else if (event === 'preview') onPreview?.(data);
      else if (event === 'completed') result = data;
      else if (event === 'error' || data.status === 'error') {
        throw new TiinyError(errorMessage(data, t('errGen')), data.upstream?.status ?? 0);
      }
    });
    if (!result) throw new TiinyError(t('errNoImage'), 0);
    return result;
  }

  // Chat en flux : onDelta reçoit séparément la réflexion et la réponse.
  async streamChat(body, { signal, onDelta }) {
    const response = await this._fetch('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    let content = '';
    let reasoning = '';
    let finish = null;
    await readSse(response, (_event, raw) => {
      if (raw === '[DONE]') return;
      const data = JSON.parse(raw);
      if (data.error) throw new TiinyError(errorMessage(data, t('errLlm')), 0);
      // Le dernier bloc peut porter `usage` avec une liste `choices` vide.
      const choice = data.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.content) content += delta.content;
      onDelta?.({ content, reasoning });
    });
    return { content, reasoning, finish };
  }
}
