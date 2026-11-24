import { describe, expect, it } from 'vitest';
import { BRIDGE, type Envelope } from '../../src/observe/protocol';
import { installNetworkObserver } from '../../src/observe/network';
import { createSseReader, ObservationBound } from '../../src/observe/sse';

const origin = 'https://chatgpt.com';
const endpoint = '/backend-api/f/conversation';
const encoder = new TextEncoder();
const defaults = { json: 16 * 1024, stream: 16 * 1024, time: 1000, concurrent: 2 };

class FixtureWindow extends EventTarget {
  readonly top = this;
  location = new URL(origin + '/c/demo');
  fetch: typeof fetch;
  XMLHttpRequest?: typeof FixtureXhr;
  setTimeout = globalThis.setTimeout;
  clearTimeout = globalThis.clearTimeout;
  messages: Envelope[] = [];
  constructor(fetch: typeof globalThis.fetch) {
    super();
    this.fetch = fetch;
  }
  postMessage(message: Envelope, target: string) {
    if (message.type !== 'observation') return;
    expect(target).toBe(origin);
    this.messages.push(message);
  }
  enable(epoch = 1) {
    const event = Object.assign(new Event('message'), {
      source: this, origin,
      data: { source: BRIDGE, type: 'control', channel: 'test-channel', epoch, route: this.location.pathname },
    });
    this.dispatchEvent(event);
  }
  observe(limits = defaults) {
    const stop = installNetworkObserver(this as unknown as Window & typeof globalThis, limits);
    this.enable();
    return stop;
  }
}

class FixtureXhr extends EventTarget {
  responseURL = origin + '/backend-api/models';
  responseType = '';
  status = 200;
  request?: string;
  sent?: unknown;
  reads = 0;
  compressed = false;
  declared = true;
  readonly body = '{"default_model_slug":"fixture-model"}';
  open(method: string, url: string) { this.request = method + ' ' + url; }
  send(body?: unknown) { this.sent = body; }
  get responseText() { this.reads++; return this.body; }
  getResponseHeader(name: string) {
    if (name === 'content-type') return 'application/json';
    if (name === 'content-length' && this.declared) return String(this.body.length);
    if (name === 'content-encoding' && this.compressed) return 'gzip';
    return null;
  }
}

function response(body: BodyInit, path = endpoint, contentType = 'text/event-stream') {
  const result = new Response(body, { headers: { 'Content-Type': contentType } });
  Object.defineProperty(result, 'url', { value: origin + path });
  return result;
}

function bytesStream(bytes: Uint8Array, split = 1) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, offset += split));
      else controller.close();
    },
  });
}

function nextPhase(page: FixtureWindow, phase: Envelope['phase']) {
  return new Promise<Envelope>((resolve, reject) => {
    const until = Date.now() + 1500;
    function tick() {
      const result = page.messages.find(message => message.phase === phase);
      if (result) resolve(result);
      else if (Date.now() >= until) reject(new Error('Observation phase not received: ' + phase));
      else setTimeout(tick, 5);
    }
    tick();
  });
}

describe('response observation', () => {
  it('passes fetch receiver, arguments, promise and response through unchanged', async () => {
    const body = 'data: {"message":{"id":"answer","author":{"role":"assistant"},"metadata":{"model_slug":"demo"}}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const original = response(bytesStream(encoder.encode(body)));
    const originalPromise = Promise.resolve(original);
    const reply = Object.freeze({ method: 'POST', body: 'caller payload' });
    let receiver: unknown;
    let args: unknown[] = [];
    const source = function(this: unknown, ...call: unknown[]) { receiver = this; args = call; return originalPromise; };
    const page = new FixtureWindow(source);
    const stop = page.observe();
    try {
      const nativeReceiver = {};
      const host = page.fetch.call(nativeReceiver, endpoint, reply);
      expect(receiver).toBe(nativeReceiver);
      expect(args).toEqual([endpoint, reply]);
      expect(host).toBe(originalPromise);
      expect(await host).toBe(original);
      const [text, end] = await Promise.all([original.text(), nextPhase(page, 'finish')]);
      expect(text).toBe(body);
      expect(end.observation.reply?.model?.value).toBe('demo');
      expect(JSON.stringify(page.messages)).not.toContain('caller payload');
    } finally { stop(); }
    expect(page.fetch).toBe(source);
  });

  it('preserves rejected/aborted host requests and never touches unsupported responses', async () => {
    const abort = new DOMException('User cancelled', 'AbortError');
    const failure = Promise.reject<Response>(abort);
    const page = new FixtureWindow(() => failure);
    const stop = page.observe();
    try {
      const host = page.fetch(endpoint, { method: 'POST' });
      expect(host).toBe(failure);
      await expect(host).rejects.toBe(abort);
      expect((await nextPhase(page, 'error')).observation.issue).toBe('interrupted');
    } finally { stop(); }

    const uninterceptable = response('private', '/backend-api/auth/session');
    const promised = Promise.resolve(uninterceptable);
    uninterceptable.clone = () => { throw new Error('Unsupported responses must never be cloned'); };
    const unsupported = new FixtureWindow(() => promised);
    const remove = unsupported.observe();
    try {
      expect(unsupported.fetch('/backend-api/auth/session')).toBe(promised);
      expect(await uninterceptable.text()).toBe('private');
      expect(unsupported.messages).toEqual([]);
    } finally { remove(); }
  });

  it('cancels the observer branch when a long stream exceeds its byte budget', async () => {
    const hostText = 'data: ' + 'é'.repeat(512 * 1024);
    const original = response(bytesStream(encoder.encode(hostText), 4096));
    const page = new FixtureWindow(() => Promise.resolve(original));
    const stop = page.observe(defaults);
    try {
      const result = await page.fetch(endpoint, { method: 'POST' });
      const [text, failure] = await Promise.all([result.text(), nextPhase(page, 'error')]);
      expect(text).toBe(hostText);
      expect(failure.observation.issue).toBe('bounded');
      expect(page.messages).toHaveLength(2);
    } finally { stop(); }
  });

  it('fences an in-flight observation on navigation and never overwrites a later fetch wrapper at teardown', async () => {
    let resolve!: (value: Response) => void;
    const deferred = new Promise<Response>(done => { resolve = done; });
    const page = new FixtureWindow(() => deferred);
    const stop = page.observe();
    const host = page.fetch(endpoint, { method: 'POST' });
    page.location = new URL(origin + '/c/next');
    page.dispatchEvent(new Event('popstate'));
    page.enable(2);
    const original = response('data: [DONE]\n\n');
    resolve(original);
    expect(await (await host).text()).toBe('data: [DONE]\n\n');
    expect(page.messages.map(message => message.phase)).toEqual(['start']);
    const later = () => deferred;
    page.fetch = later;
    stop();
    expect(page.fetch).toBe(later);
  });

  it('continues a root stream into its explicitly observed canonical conversation only', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const original = response(new ReadableStream<Uint8Array>({ start: controller => { stream = controller; } }));
    const page = new FixtureWindow(() => Promise.resolve(original));
    page.location = new URL(origin + '/');
    const stop = page.observe();
    try {
      const host = page.fetch(endpoint, { method: 'POST' });
      const received = (await host).text();
      const first = 'data: {"conversation_id":"canon","message":{"id":"answer","author":{"role":"assistant"}}}\n\n';
      stream.enqueue(encoder.encode(first));
      expect((await nextPhase(page, 'data')).observation.conversationId).toBe('canon');
      page.location = new URL(origin + '/c/canon');
      page.dispatchEvent(new Event('popstate'));
      page.enable(2);
      stream.enqueue(encoder.encode('data: {"p":"/message/metadata/model_slug","o":"replace","v":"final-model"}\n\ndata: [DONE]\n\n'));
      stream.close();
      const finish = await nextPhase(page, 'finish');
      expect(finish).toMatchObject({ route: '/c/canon', epoch: 2, observation: { reply: { model: { value: 'final-model' } } } });
      expect(await received).toContain(first);
    } finally { stop(); }
  });

  it('leaves XHR behavior intact and releases stale, timed-out, and unbounded observations', async () => {
    const page = new FixtureWindow(() => Promise.reject());
    page.XMLHttpRequest = FixtureXhr;
    const nativeOpen = FixtureXhr.prototype.open;
    const nativeSend = FixtureXhr.prototype.send;
    const stop = page.observe({ ...defaults, time: 30 });
    try {
      function send() {
        const xhr = new FixtureXhr();
        xhr.open('GET', '/backend-api/models');
        xhr.send('local body');
        expect(xhr.request).toBe('GET /backend-api/models');
        expect(xhr.sent).toBe('local body');
        return xhr;
      }
      const normal = send();
      let hostLoadEnd = 0;
      normal.addEventListener('loadend', () => { hostLoadEnd++; });
      normal.dispatchEvent(new Event('loadend'));
      expect(hostLoadEnd).toBe(1);
      expect(normal.reads).toBe(1);
      expect((await nextPhase(page, 'data')).observation.accountDefault?.value).toBe('fixture-model');
      const noLength = send();
      noLength.declared = false;
      noLength.dispatchEvent(new Event('loadend'));
      expect(noLength.reads).toBe(0);
      const compressed = send();
      compressed.compressed = true;
      compressed.dispatchEvent(new Event('loadend'));
      expect(compressed.reads).toBe(0);

      const navigating = send();
      page.location = new URL(origin + '/c/next');
      page.dispatchEvent(new Event('popstate'));
      page.enable(2);
      navigating.dispatchEvent(new Event('loadend'));
      expect(navigating.reads).toBe(0);

      const delayed = send();
      await new Promise(resolve => setTimeout(resolve, 50));
      delayed.dispatchEvent(new Event('loadend'));
      expect(delayed.reads).toBe(0);
      expect(page.messages.at(-1)?.observation.issue).toBe('bounded');
    } finally { stop(); }
    expect(FixtureXhr.prototype.open).toBe(nativeOpen);
    expect(FixtureXhr.prototype.send).toBe(nativeSend);
  });
});

describe('SSE framing', () => {
  it('decodes split UTF-8, mixed line endings, comments and multiline data without losing fields', () => {
    const events: string[] = [];
    const parser = createSseReader(event => { events.push(event); });
    const payload = ': comment\r\ndata: {"car":\r\ndata: "ルーフ🚗"}\r\n\r\ndata: [DONE]\n\n';
    for (const byte of encoder.encode(payload)) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(events).toEqual(['{"car":\n"ルーフ🚗"}', '[DONE]']);
    expect(JSON.parse(events[0])).toEqual({ car: 'ルーフ🚗' });
  });

  it('stops on an oversized UTF-8 frame after accounting for actual bytes', () => {
    const parser = createSseReader(() => { throw new Error('frame must be rejected before delivery'); }, 30);
    expect(() => parser.push(encoder.encode('data: ' + 'é'.repeat(13) + '\n\n'))).toThrow(ObservationBound);
  });
});
