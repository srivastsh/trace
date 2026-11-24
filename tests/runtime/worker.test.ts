import 'fake-indexeddb/auto';
import { beforeAll, it, expect, vi } from 'vitest';
import type { ActionContext, Projection } from '../../src/contracts';

const extension = 'abcdefghijklmnopabcdefghijklmnop';
const base = 'chrome-extension://' + extension;
let nextTab = 99;
const listener = new Map<string, (...args: any[]) => unknown>();
const endpoint = (name: string) => ({
  addListener: (fn: (...values: any[]) => unknown) => listener.set(name, fn),
});
function area() {
  const data = new Map<string, any>();
  return {
    setAccessLevel: vi.fn(async () => {}),
    set: async (entries: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    get: async (key?: string | null) =>
      key ? { [key]: structuredClone(data.get(key)) } : Object.fromEntries(data),
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    clear: async () => {
      data.clear();
    },
  };
}
const scope = { providerId: 'chat-a', selectionId: 'segment-a', epoch: 1, temporary: 'ordinary' };
let active: ActionContext = { ...scope };
const instance = 'instance-1',
  source = {
    id: extension,
    url: 'https://chatgpt.com/c/chat-a',
    origin: 'https://chatgpt.com',
    documentId: 'browser-document',
    frameId: 0,
    tab: { id: 4, incognito: false },
  };
const asPage = (tab: number, url = 'library.html') => ({
  id: extension,
  frameId: 0,
  documentId: 'library-doc-' + tab,
  tab: { id: tab },
  origin: base,
  url: base + '/' + url,
});
const payload: Projection = {
  providerId: scope.providerId,
  selectionId: scope.selectionId,
  observedAt: Date.now(),
  adapterVersion: 'test',
  batchId: 'batch-1',
  sourceUrl: source.url,
  title: 'Synthetic fixture',
  coverage: { state: 'unknown', reason: 'Rendered segment' },
  source: 'dom',
  messages: [
    {
      id: 'm1',
      provisional: false,
      final: true,
      role: 'user',
      observedAt: Date.now(),
      text: 'first synthetic line',
    },
    {
      id: 'm2',
      provisional: false,
      final: true,
      role: 'assistant',
      observedAt: Date.now(),
      text: 'second synthetic line',
    },
  ],
};
const ui = asPage(6);
const local = area(),
  session = area();
const opened: string[] = [];
const requireRpc = (op: string, args: unknown, sender: object) =>
  new Promise<any>((resolve, reject) => {
    if (
      !listener.get('message')?.({ v: 1, op, args }, sender, (res: any) =>
        res.ok ? resolve(res.data) : reject(Error(res.error)),
      )
    )
      reject(Error('Unsupported sender'));
  });
beforeAll(async () => {
  vi.stubGlobal('chrome', {
    runtime: {
      id: extension,
      getURL: (s: string) => base + '/' + s,
      onMessage: endpoint('message'),
      onInstalled: endpoint('installed'),
      onStartup: endpoint('startup'),
      sendMessage: async () => {},
    },
    storage: { session, local },
    tabs: {
      onRemoved: endpoint('close'),
      sendMessage: async (_tab: number, m: { op: string }) =>
        m.op === 'trace-who' ? { instance, context: active } : true,
      create: async ({ url }: { url: string }) => {
        opened.push(url);
        return { id: ++nextTab };
      },
      query: async () => [{ id: 4 }],
    },
    commands: { onCommand: endpoint('command') },
    alarms: { onAlarm: endpoint('alarm') },
  });
  await import('../../src/runtime/background');
});
it('isolates sender roles, stages one reviewed selection with capture off, and fences stale work and clear', async () => {
  await requireRpc('scope', { scope, href: source.url, instance, sequence: 1 }, source);
  const args = { instance, context: scope, projection: payload, generation: 1 };
  const settings = await requireRpc('getSettings', [], ui);
  expect(settings.autoCapture).toBe(false);
  await expect(requireRpc('capture', args, source)).rejects.toThrow();
  await expect(requireRpc('clearAll', [], source)).rejects.toThrow();
  await expect(requireRpc('makeBackup', [], asPage(8, 'popup.html'))).rejects.toThrow();
  await expect(requireRpc('getSettings', [], { ...ui, frameId: 2 })).rejects.toThrow();
  const dest = await requireRpc('createCollection', [{ label: 'One time' }], ui);
  await requireRpc('stage', { ...args, action: 'save' }, source);
  const id = opened.at(-1)!.split('/').at(-1)!;
  const review = asPage(nextTab);
  await expect(requireRpc('readStage', { id }, asPage(nextTab + 1))).rejects.toThrow();
  expect((await requireRpc('readStage', { id }, review)).projection.messages).toHaveLength(2);
  await expect(requireRpc('readStage', { id }, review)).rejects.toThrow();
  await expect(
    requireRpc('saveStage', { id, collectionId: dest.id, selectedMessageIds: ['not-reviewed'] }, review),
  ).rejects.toThrow();
  await requireRpc(
    'saveStage',
    { id, collectionId: dest.id, selectedMessageIds: ['m2'], savedItem: { note: 'Private local note' } },
    review,
  );
  expect((await requireRpc('listSaved', [dest.id], ui)).map((r: any) => r.note)).toEqual([
    'Private local note',
  ]);
  expect((await requireRpc('getSettings', [], ui)).autoCapture).toBe(false);
  await expect(requireRpc('saveStage', { id, collectionId: dest.id }, review)).rejects.toThrow();
  await requireRpc('stage', { ...args, action: 'save' }, source);
  const oldId = opened.at(-1)!.split('/').at(-1)!;
  active = { ...scope, providerId: 'chat-b', epoch: 2 };
  await expect(requireRpc('readStage', { id: oldId }, asPage(nextTab))).rejects.toThrow();
  await expect(requireRpc('capture', args, source)).rejects.toThrow();
  await requireRpc('clearAll', [], ui);
  expect(await requireRpc('listSaved', [], ui)).toEqual([]);
  expect((await requireRpc('getSettings', [], ui)).autoCapture).toBe(false);
});
it('requires a user confirmation on unknown chat state and drops it on navigation; known temporary always stays paused', async () => {
  const unknown = { ...scope, epoch: 3, temporary: 'unknown' };
  active = unknown;
  await requireRpc('scope', { scope: unknown, href: source.url, instance, sequence: 3 }, source);
  await requireRpc('open', { action: 'settings', context: unknown, instance }, source);
  const editor = asPage(nextTab),
    collection = await requireRpc('createCollection', [{ label: 'Confirmed document' }], editor);
  await requireRpc('bindTarget', { collectionId: collection.id }, editor);
  await requireRpc('updateCollection', [collection.id, { autoConsent: true }], editor);
  await requireRpc('setSettings', [{ autoCapture: true }], editor);
  const auto = async (current = unknown) => requireRpc('status', { context: current, instance }, source);
  expect((await auto()).status.enabled).toBe(false);
  await expect(requireRpc('confirmOrdinary', { confirmed: true }, source)).rejects.toThrow();
  await requireRpc('confirmOrdinary', { confirmed: true }, editor);
  const { status } = await auto();
  expect(status.enabled).toBe(true);
  await requireRpc(
    'capture',
    { generation: status.generation, context: unknown, projection: payload, instance },
    source,
  );
  const temporary = { ...unknown, epoch: 4, temporary: 'temporary' };
  active = temporary;
  await requireRpc('scope', { scope: temporary, href: source.url, instance, sequence: 4 }, source);
  expect((await auto(temporary)).status.enabled).toBe(false);
  await expect(requireRpc('confirmOrdinary', { confirmed: true }, editor)).rejects.toThrow();
  await expect(
    requireRpc(
      'capture',
      { generation: status.generation, context: unknown, projection: payload, instance },
      source,
    ),
  ).rejects.toThrow();
  await requireRpc('clearAll', [], editor);
});
