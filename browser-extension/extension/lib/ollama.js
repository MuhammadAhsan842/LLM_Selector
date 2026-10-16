import { ACTION_SCHEMA, parseAction, validateEndpoint } from './protocol.js';

export async function* ndjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1000000) throw new Error('Model response was too large.');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
      if (buffer.length > 1000000) throw new Error('Model response was too large.');
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function modelError(error) {
  if (error?.name === 'AbortError') return error;
  if (error instanceof TypeError) return new Error('Cannot reach Ollama. Check that it is running and allows this extension’s origin.');
  return error;
}

export async function listModels(settings, signal) {
  try {
    const response = await fetch(`${validateEndpoint(settings.endpoint)}/api/tags`, {
      signal: signal || AbortSignal.timeout(8000), credentials: 'omit', redirect: 'error',
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const data = await response.json();
    return (data.models || []).map(model => model.name);
  } catch (error) { throw modelError(error); }
}

export async function nextAction(settings, messages, signal, onProgress = () => {}) {
  const timeout = AbortSignal.timeout(180000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(`${validateEndpoint(settings.endpoint)}/api/chat`, {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, messages, stream: true, think: false,
          format: ACTION_SCHEMA, keep_alive: '5m',
          options: { temperature: 0, num_ctx: settings.context, num_predict: 768, repeat_penalty: 1.1 } }),
      });
      if (![429,502,503,504].includes(response.status) || attempt === 1) break;
      const rawDelay = Number(response.headers.get('Retry-After'));
      const waitMs = Number.isFinite(rawDelay) && rawDelay > 0 ? Math.min(rawDelay * 1000, 3000) : 500;
      await response.body?.cancel();
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(combined.reason); };
        const timer = setTimeout(() => { combined.removeEventListener('abort', abort); resolve(); }, waitMs);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      });
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch {}
      throw new Error(`Ollama HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    let content = '';
    let completed = false;
    for await (const chunk of ndjson(response.body)) {
      if (chunk.error) throw new Error(chunk.error);
      content += chunk.message?.content || '';
      if (content.length > 16000) throw new Error('The model returned too much text.');
      onProgress();
      if (chunk.done) {
        completed = true;
        if (chunk.done_reason === 'length') throw new Error('The model reached its response limit. Try a simpler task.');
      }
    }
    if (!completed) throw new Error('Ollama stopped before completing its response.');
    return parseAction(content);
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error('The local model took over three minutes. Try a shorter task.');
    throw modelError(error);
  }
}
