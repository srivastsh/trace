import { SNIFF_SOURCE, conversationId, observedEndpoint, identifyResponse, projectResponse, createTurnReader } from './context-data.js';

if (!window.__modusNetworkObserver) {
  window.__modusNetworkObserver = true;
  observePageTraffic();
}

function observePageTraffic() {
  const origin = location.origin;
  const maxJsonBytes = 16 * 1024 * 1024;
  const maxUnknownBytes = 512 * 1024;
  const maxFrameChars = 1024 * 1024;
  const recent = new Map();
  let sequence = 0;
  let revision = 0;
  let trafficCount = 0;

  function emit(request, phase, data, id = request.endpoint.id ?? null) {
    const event = {
      source: SNIFF_SOURCE, kind: request.endpoint.kind, id, phase, data,
      request: request.sequence, revision: ++revision, at: Date.now(),
      startedAt: request.startedAt, originId: request.chat,
    };
    const key = event.kind === 'turn' ? `turn:${event.request}` : `${event.kind}:${id ?? ''}`;
    const prior = recent.get(key);
    if (!prior || event.kind === 'traffic' || event.request >= prior.request) {
      recent.delete(key);
      recent.set(key, event);
      if (recent.size > 40) recent.delete(recent.keys().next().value);
    }
    window.postMessage(event, origin);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== origin || event.data?.source !== SNIFF_SOURCE || event.data?.phase !== 'ready') return;
    for (const item of recent.values()) window.postMessage(item, origin);
  });

  function begin(endpoint) {
    const request = { endpoint, sequence: ++sequence, startedAt: Date.now(), chat: conversationId(location.pathname) };
    if (endpoint.kind === 'turn') emit(request, 'start', null, request.chat);
    return request;
  }

  function recordTraffic(request) {
    emit({ ...request, endpoint: { kind: 'traffic' } }, 'data', { count: ++trafficCount });
  }

  function publishJson(request, json) {
    if (request.endpoint.kind === 'turn') {
      const turn = createTurnReader()(json);
      emit(request, 'end', turn?.facts ?? null, turn?.id ?? request.chat);
      return;
    }
    const matched = identifyResponse(request.endpoint, json);
    if (!matched) return;
    const data = projectResponse(matched.endpoint, matched.data);
    if (data) emit({ ...request, endpoint: matched.endpoint }, 'data', data);
  }

  function createFramePublisher(request) {
    const readTurn = createTurnReader();
    let current = null;
    const expected = request.endpoint.kind === 'turn';
    const turnRequest = expected ? request : { ...request, endpoint: { kind: 'turn' } };

    return {
      accept(frame) {
        const json = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!json || json === '[DONE]') return;
        try {
          const event = readTurn(JSON.parse(json));
          if (!event) return;
          current = event;
          if (expected || (event.id && event.facts?.replyId && event.facts.model)) {
            emit(turnRequest, event.finished ? 'end' : 'data', event.facts, event.id ?? request.chat);
          }
        } catch { /* skip malformed event frames */ }
      },
      close() {
        if (expected || current?.facts?.replyId && current.id) {
          emit(turnRequest, 'end', current?.facts ?? null, current?.id ?? request.chat);
        }
      },
    };
  }

  async function readJson(response, request) {
    const declaredSize = Number(response.headers.get('content-length'));
    const limit = request.endpoint.kind === 'unclassified' ? maxUnknownBytes : maxJsonBytes;
    if (!response.body || declaredSize > limit) return;
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let json = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) return;
        json += decoder.decode(value, { stream: true });
      }
      publishJson(request, JSON.parse(json + decoder.decode()));
    } finally {
      // A clone is one branch of a tee. Cancellation can wait for the page's
      // branch to finish, so leave the page's response lifetime independent.
      reader.cancel().catch(() => {});
    }
  }

  async function readEventStream(response, request) {
    if (!response.body) return;
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    const publisher = createFramePublisher(request);
    let buffer = '';
    let skipping = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n|\r\r/);
        buffer = frames.pop();
        for (const frame of frames) {
          if (!skipping && frame.length <= maxFrameChars) publisher.accept(frame);
          skipping = false;
        }
        if (done) {
          if (!skipping && buffer.length <= maxFrameChars) publisher.accept(buffer);
          publisher.close();
          break;
        }
        if (buffer.length > maxFrameChars) {
          buffer = buffer.slice(-3);
          skipping = true;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  function missedTurn(request) {
    if (request.endpoint.kind === 'turn') emit(request, 'error', null, request.chat);
  }

  async function observeResponse(response, request) {
    const actual = observedEndpoint(response.url, request.method, origin);
    if (!actual || (request.endpoint.id && actual.id !== request.endpoint.id)) { missedTurn(request); return; }
    recordTraffic(request);
    if (!response.ok) { missedTurn(request); return; }
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    const matched = { ...request, endpoint: actual };
    if (type.includes('text/event-stream')) await readEventStream(response, matched);
    else if (type.includes('json')) await readJson(response, matched);
    else missedTurn(request);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const result = Reflect.apply(originalFetch, this, args);
      try {
        const [input, options] = args;
        const method = String(options?.method ?? input?.method ?? 'GET').toUpperCase();
        const endpoint = observedEndpoint(input?.url ?? input, method, origin);
        if (endpoint) {
          const request = { ...begin(endpoint), method };
          result.then(response => observeResponse(response, request)).catch(() => missedTurn(request));
        }
      } catch { /* observation does not affect the page's request */ }
      return result;
    };
  }

  const prototype = window.XMLHttpRequest?.prototype;
  if (prototype) {
    const requests = new WeakMap();
    const open = prototype.open;
    const send = prototype.send;
    prototype.open = function (...args) {
      const result = Reflect.apply(open, this, args);
      const method = String(args[0]).toUpperCase();
      const endpoint = observedEndpoint(args[1], method, origin);
      requests.set(this, { method, endpoint });
      return result;
    };
    prototype.send = function (...args) {
      const target = requests.get(this);
      if (!target?.endpoint) return Reflect.apply(send, this, args);
      const request = begin(target.endpoint);
      this.addEventListener('loadend', () => {
        try {
          const actual = observedEndpoint(this.responseURL, target.method, origin);
          if (!actual || (target.endpoint.id && actual.id !== target.endpoint.id)) { missedTurn(request); return; }
          recordTraffic(request);
          if (this.status < 200 || this.status >= 300) { missedTurn(request); return; }
          const matched = { ...request, endpoint: actual };
          if (this.responseType === 'json') publishJson(matched, this.response);
          else if (!this.responseType || this.responseType === 'text') {
            const body = this.responseText;
            const limit = actual.kind === 'unclassified' ? maxUnknownBytes : maxJsonBytes;
            if (body.length > limit) return;
            if (this.getResponseHeader('content-type')?.includes('text/event-stream')) {
              const publisher = createFramePublisher(matched);
              for (const frame of body.split(/\r?\n\r?\n|\r\r/)) {
                if (frame.length <= maxFrameChars) publisher.accept(frame);
              }
              publisher.close();
            } else publishJson(matched, JSON.parse(body));
          }
        } catch { /* no readable response */ }
      }, { once: true });
      return Reflect.apply(send, this, args);
    };
  }
}
