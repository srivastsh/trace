import { projectResponse, createTurnReader } from './parser';
import {
  BATCH_LIMIT, BRIDGE, byteLength, conversationRoute, count, id, JSON_LIMIT, observedEndpoint, ORIGINS, record,
  STREAM_LIMIT, STREAM_TIME_LIMIT, type Control, type Endpoint, type Envelope, type Observation,
} from './protocol';
import { createSseReader, ObservationBound } from './sse';

interface RequestObservation {
  endpoint: Endpoint;
  request: number;
  route: string;
  channel?: string;
  epoch?: number;
  generation?: number;
  canonicalId?: string;
  controller: AbortController;
}

export interface NetworkLimits {
  json: number;
  stream: number;
  time: number;
  concurrent: number;
}
const defaultLimits: NetworkLimits = { json: JSON_LIMIT, stream: STREAM_LIMIT, time: STREAM_TIME_LIMIT, concurrent: 4 };

function sameEndpoint(left: Endpoint, right: Endpoint) {
  return left.kind === right.kind && (left.kind !== 'history' || right.kind === 'history' && left.id === right.id);
}

function requestInfo(args: Parameters<typeof fetch>, origin: string): { endpoint: Endpoint; method: string } | undefined {
  const [input, options] = args;
  // URL, method and origin are sufficient. Never touch body or credentials.
  const url = typeof input === 'string' || input instanceof URL ? input : input instanceof Request ? input.url : undefined;
  if (url === undefined) return;
  const method = (options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const endpoint = observedEndpoint(url, method, origin);
  return endpoint && { endpoint, method };
}

export function installNetworkObserver(page: Window & typeof globalThis, limits: NetworkLimits = defaultLimits) {
  const origin = page.location.origin;
  if (!ORIGINS.has(origin) || page.top !== page) return () => {};
  const active = new Set<RequestObservation>();
  const awaiting = new Map<RequestObservation, number>();
  const pending = new Map<string, Omit<Envelope, 'epoch' | 'channel' | 'sequence'>>();
  const currentRoute = () => conversationRoute(new URL(page.location.href))?.key;
  let control: Control | undefined;
  let lastChannel: string | undefined;
  let sequence = 0;
  let requestSequence = 0;
  let stopped = false;

  function promotedRoute(request: RequestObservation, next?: string) {
    if (!next || request.endpoint.kind !== 'turn' || !request.canonicalId || /\/(?:c|uc)\//.test(request.route)) return false;
    const before = conversationRoute(new URL(request.route, origin));
    const after = conversationRoute(new URL(next, origin));
    return after?.providerId === request.canonicalId && before?.temporary === after.temporary;
  }

  function isCurrent(request: RequestObservation) {
    const here = currentRoute();
    return here === request.route || promotedRoute(request, here);
  }

  function releaseAwaiting(request: RequestObservation) {
    const timer = awaiting.get(request);
    if (!timer) return false;
    page.clearTimeout(timer);
    awaiting.delete(request);
    return true;
  }

  function post(message: Omit<Envelope, 'epoch' | 'channel' | 'sequence'>, binding: Control) {
    page.postMessage({ ...message, channel: binding.channel, epoch: binding.epoch, sequence: ++sequence } satisfies Envelope, origin);
  }

  function emit(request: RequestObservation, phase: Envelope['phase'], observation: Observation = {}) {
    const here = currentRoute();
    const promoting = promotedRoute(request, here);
    if (stopped || (!promoting && here !== request.route) || request.controller.signal.aborted) return;
    if (!promoting && request.channel && (request.channel !== control?.channel || request.epoch !== control.epoch)) return;
    const observedAt = Date.now();
    const envelope: Omit<Envelope, 'epoch' | 'channel' | 'sequence'> = {
      source: BRIDGE, type: 'observation', request: request.request, route: promoting ? here! : request.route,
      endpoint: request.endpoint.kind, phase, observedAt, observation,
      ...(observation.history && { generation: request.generation }),
    };
    if (byteLength(JSON.stringify(envelope)) > BATCH_LIMIT - 512) {
      envelope.observation = { issue: 'bounded' };
      delete envelope.generation;
    }
    if (control?.route === envelope.route) post(envelope, control);
    else if ((!request.channel || promoting) && !observation.history) {
      // Cache only a small set of metadata facts for startup races. Keep a
      // turn start independently so a late history response cannot replace it.
      const key = request.endpoint.kind + (phase === 'start' ? ':start' : '');
      pending.delete(key);
      pending.set(key, envelope);
      if (pending.size > 6) pending.delete(pending.keys().next().value!);
    }
  }

  function onMessage(event: MessageEvent) {
    if (event.source !== page || event.origin !== origin) return;
    const candidate = record(event.data);
    if (candidate?.source === BRIDGE && candidate.type === 'dispose' && lastChannel && candidate.channel === lastChannel) {
      teardown();
      return;
    }
    if (candidate?.source !== BRIDGE || candidate.type !== 'control' || !id(candidate.channel) ||
      !count(candidate.epoch) || candidate.route !== currentRoute() ||
      (candidate.generation !== undefined && !count(candidate.generation))) return;
    if (typeof candidate.route !== 'string') return;
    const next: Control = {
      source: BRIDGE, type: 'control', channel: candidate.channel as string, epoch: candidate.epoch, route: candidate.route,
      ...(candidate.generation !== undefined && { generation: candidate.generation }),
    };
    if (control?.channel === next.channel && control.epoch > next.epoch) return;
    for (const request of active) {
      if (promotedRoute(request, next.route) && (!request.channel || request.channel === next.channel && next.epoch === request.epoch! + 1)) {
        request.route = next.route;
        request.channel = next.channel;
        request.epoch = next.epoch;
        continue;
      }
      const changedScope = next.route !== request.route ||
        (request.channel && (request.channel !== next.channel || request.epoch !== next.epoch));
      const revoked = request.generation !== undefined && request.generation !== next.generation;
      if (changedScope || revoked) request.controller.abort();
    }
    control = next;
    lastChannel = next.channel;
    for (const item of pending.values()) {
      if (item.route === next.route && Date.now() - item.observedAt <= 10_000) post(item, next);
    }
    pending.clear();
  }

  function begin(endpoint: Endpoint): RequestObservation | undefined {
    const route = currentRoute();
    if (!route || stopped) return;
    const binding = control?.route === route ? control : undefined;
    const request = {
      endpoint, request: ++requestSequence, route, channel: binding?.channel, epoch: binding?.epoch,
      generation: endpoint.kind === 'history' ? binding?.generation : undefined,
      controller: new AbortController(),
    };
    if (endpoint.kind === 'turn') emit(request, 'start');
    return request;
  }

  async function readResponse(response: Response, request: RequestObservation, method: string) {
    const actual = observedEndpoint(response.url, method, origin);
    if (!actual || !sameEndpoint(request.endpoint, actual) || response.redirected || !response.ok) {
      emit(request, 'error', actual?.kind === 'account' && (response.status === 401 || response.status === 403)
        ? { identity: null, issue: 'unsupported' } : { issue: 'unsupported' });
      return;
    }
    if (request.controller.signal.aborted || currentRoute() !== request.route ||
      (request.channel && (request.channel !== control?.channel || request.epoch !== control.epoch))) return;
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const isStream = mime === 'text/event-stream' && actual.kind === 'turn';
    const isJson = mime === 'application/json' || mime?.endsWith('+json');
    const declaredLength = Number(response.headers.get('content-length'));
    const byteLimit = isStream ? limits.stream : limits.json;
    if ((!isStream && !isJson) || !response.body) { emit(request, 'error', { issue: 'unsupported' }); return; }
    if (declaredLength > byteLimit || active.size >= limits.concurrent) { emit(request, 'error', { issue: 'bounded' }); return; }
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    active.add(request);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    request.controller.signal.addEventListener('abort', cancel, { once: true });
    const timeout = page.setTimeout(() => {
      emit(request, 'error', { issue: 'bounded' });
      request.controller.abort();
    }, limits.time);
    let flushTimer = 0;
    try {
      let bytes = 0;
      if (isStream) {
        const turn = createTurnReader();
        let done = false;
        let latest: Observation | undefined;
        let buffered: Observation | undefined;
        let lastPublication = 0;
        const flush = () => {
          page.clearTimeout(flushTimer);
          flushTimer = 0;
          if (!buffered) return;
          emit(request, 'data', buffered);
          buffered = undefined;
          lastPublication = Date.now();
        };
        const framer = createSseReader(data => {
          if (done) return;
          if (data.trim() === '[DONE]') { done = true; return; }
          let value: unknown;
          try { value = JSON.parse(data); } catch { return; }
          const observation = turn.accept(value, Date.now());
          if (observation) {
            const newlyIdentified = observation.conversationId && !request.canonicalId;
            if (newlyIdentified) request.canonicalId = observation.conversationId;
            latest = observation;
            buffered = { ...buffered, ...observation, reply: observation.reply };
            const wait = 100 - (Date.now() - lastPublication);
            if (newlyIdentified || wait <= 0) flush();
            else if (!flushTimer) flushTimer = page.setTimeout(flush, wait);
          }
        });
        while (!done) {
          const chunk = await reader.read();
          if (request.controller.signal.aborted || !isCurrent(request)) return;
          if (chunk.done) { framer.finish(); break; }
          bytes += chunk.value.byteLength;
          if (bytes > byteLimit) throw new ObservationBound();
          framer.push(chunk.value);
        }
        if (!turn.valid()) emit(request, 'error', { issue: 'unsupported', reply: { comparable: false } });
        else {
          flush();
          if (done || turn.finished()) emit(request, 'finish', { reply: latest?.reply, conversationId: latest?.conversationId });
          else emit(request, 'error', { issue: 'interrupted' });
        }
      } else {
        const decoder = new TextDecoder();
        const parts: string[] = [];
        while (true) {
          const chunk = await reader.read();
          if (request.controller.signal.aborted || !isCurrent(request)) return;
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > byteLimit || parts.length >= 65_536) throw new ObservationBound();
          parts.push(decoder.decode(chunk.value, { stream: true }));
        }
        const mayCapture = actual.kind === 'history' && request.generation !== undefined &&
          request.generation === control?.generation && request.epoch === control?.epoch;
        const payload = projectResponse(actual, JSON.parse(parts.join('') + decoder.decode()), Date.now(), mayCapture);
        emit(request, payload ? actual.kind === 'turn' ? 'finish' : 'data' : 'error', payload ?? { issue: 'unsupported' });
      }
    } catch (error) {
      emit(request, 'error', { issue: error instanceof ObservationBound ? 'bounded' : 'interrupted' });
    } finally {
      page.clearTimeout(timeout);
      page.clearTimeout(flushTimer);
      active.delete(request);
      request.controller.signal.removeEventListener('abort', cancel);
      // A tee branch can wait on its sibling. Never await cancellation.
      cancel();
    }
  }

  const originalFetch = page.fetch;
  const wrappedFetch: typeof fetch = function(this: unknown, ...args: Parameters<typeof fetch>) {
    const result = Reflect.apply(originalFetch, this, args) as ReturnType<typeof fetch>;
    try {
      const target = requestInfo(args, origin);
      const request = target && begin(target.endpoint);
      if (target && request) {
        if (awaiting.size >= limits.concurrent * 2) emit(request, 'error', { issue: 'bounded' });
        else {
          awaiting.set(request, page.setTimeout(() => {
            releaseAwaiting(request);
            emit(request, 'error', { issue: 'bounded' });
            request.controller.abort();
          }, limits.time));
          void result.then(response => {
            if (releaseAwaiting(request)) return readResponse(response, request, target.method);
          }, () => {
            if (releaseAwaiting(request)) emit(request, 'error', { issue: 'interrupted' });
          }).catch(() => emit(request, 'error', { issue: 'interrupted' }));
        }
      }
    } catch { /* The host promise and error behavior remain untouched. */ }
    return result;
  };

  // XHR has already accumulated a text response in the browser by loadend.
  // Skip other response types, or any text whose declared/actual size cannot
  // fit the same budgets as fetch. Leave the original result and events intact.
  const xhr = page.XMLHttpRequest?.prototype;
  const originalOpen = xhr?.open;
  const originalSend = xhr?.send;
  const xhrTargets = new WeakMap<XMLHttpRequest, { endpoint: Endpoint; method: string }>();
  const xhrListeners = new Map<XMLHttpRequest, { listener: EventListener; timer: number; request: RequestObservation }>();
  function detachXhr(target: XMLHttpRequest) {
    const pending = xhrListeners.get(target);
    if (!pending) return;
    page.clearTimeout(pending.timer);
    target.removeEventListener('loadend', pending.listener);
    xhrListeners.delete(target);
  }

  function wrappedOpen(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    detachXhr(this);
    xhrTargets.delete(this);
    const result = Reflect.apply(originalOpen!, this, args);
    try {
      const method = args[0].toUpperCase();
      const endpoint = observedEndpoint(args[1], method, origin);
      if (endpoint) xhrTargets.set(this, { endpoint, method });
    } catch { /* Host open already completed. */ }
    return result;
  }

  function wrappedSend(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    const target = xhrTargets.get(this);
    const request = target && xhrListeners.size < limits.concurrent && begin(target.endpoint);
    if (!target || !request) return Reflect.apply(originalSend!, this, args);
    const listener = () => {
      detachXhr(this);
      if (!isCurrent(request)) return;
      try {
        const endpoint = observedEndpoint(this.responseURL, target.method, origin);
        if (!endpoint || !sameEndpoint(request.endpoint, endpoint) || this.status < 200 || this.status >= 300) {
          emit(request, 'error', request.endpoint.kind === 'account' && (this.status === 401 || this.status === 403)
            ? { identity: null, issue: 'unsupported' } : { issue: 'unsupported' });
          return;
        }
        const mime = this.getResponseHeader('content-type')?.split(';')[0].trim().toLowerCase();
        const length = this.getResponseHeader('content-length');
        const encoding = this.getResponseHeader('content-encoding');
        if (this.responseType !== '' && this.responseType !== 'text' || (mime !== 'application/json' && !mime?.endsWith('+json')) ||
          !length || !/^\d{1,9}$/.test(length) || encoding && encoding !== 'identity') {
          emit(request, 'error', { issue: 'unsupported' });
          return;
        }
        if (Number(length) > limits.json) throw new ObservationBound();
        const body = this.responseText;
        if (body.length > limits.json || byteLength(body) > limits.json) throw new ObservationBound();
        const mayCapture = endpoint.kind === 'history' && request.generation !== undefined && request.generation === control?.generation &&
          request.epoch === control?.epoch;
        const payload = projectResponse(endpoint, JSON.parse(body), Date.now(), mayCapture);
        emit(request, payload ? endpoint.kind === 'turn' ? 'finish' : 'data' : 'error', payload ?? { issue: 'unsupported' });
      } catch (error) { emit(request, 'error', { issue: error instanceof ObservationBound ? 'bounded' : 'interrupted' }); }
    };
    this.addEventListener('loadend', listener, { once: true });
    const timer = page.setTimeout(() => { detachXhr(this); emit(request, 'error', { issue: 'bounded' }); }, limits.time);
    xhrListeners.set(this, { listener, timer, request });
    try { return Reflect.apply(originalSend!, this, args); }
    catch (error) { detachXhr(this); emit(request, 'error', { issue: 'interrupted' }); throw error; }
  }

  function navigate() {
    const route = currentRoute();
    for (const request of active) if (request.route !== route && !promotedRoute(request, route)) request.controller.abort();
    for (const request of awaiting.keys()) if (request.route !== route) releaseAwaiting(request);
    for (const [target, pending] of xhrListeners) if (pending.request.route !== route) detachXhr(target);
    if (control?.route !== route) control = undefined;
    for (const [key, value] of pending) if (value.route !== route) pending.delete(key);
  }

  function onPageHide(event: PageTransitionEvent) {
    if (event.persisted) for (const request of active) request.controller.abort();
    else teardown();
  }

  function teardown() {
    stopped = true;
    pending.clear();
    for (const request of active) request.controller.abort();
    for (const request of awaiting.keys()) releaseAwaiting(request);
    for (const target of xhrListeners.keys()) detachXhr(target);
    page.removeEventListener('message', onMessage);
    page.removeEventListener('popstate', navigate);
    page.removeEventListener('pagehide', onPageHide);
    page.navigation?.removeEventListener('currententrychange', navigate);
    if (page.fetch === wrappedFetch) page.fetch = originalFetch;
    if (xhr?.open === wrappedOpen) xhr.open = originalOpen!;
    if (xhr?.send === wrappedSend) xhr.send = originalSend!;
  }

  page.addEventListener('message', onMessage);
  page.addEventListener('popstate', navigate);
  page.addEventListener('pagehide', onPageHide);
  page.navigation?.addEventListener('currententrychange', navigate);
  page.fetch = wrappedFetch;
  if (xhr) {
    xhr.open = wrappedOpen as typeof xhr.open;
    xhr.send = wrappedSend;
  }
  page.postMessage({ source: BRIDGE, type: 'ready' }, origin);
  return teardown;
}
