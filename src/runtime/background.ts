import { openArchive } from '../archive/repository';
import type { ArchiveRepository } from '../archive/repository';
import type { Collection, DocumentFence } from '../archive/types';
import type { ActionContext, Projection, Stage } from '../contracts';
import { PRODUCT } from '../product';
import {
  activityOk,
  bounded,
  byteSize,
  context,
  id,
  MAX_BATCH_BYTES,
  MAX_STAGE_BYTES,
  minimalProjection,
  projectionOk,
  providerMatches,
  record,
  same,
  STAGE_TTL,
  trustedSender,
} from './policy';

interface LiveDoc extends ActionContext {
  tabId: number;
  documentId: string;
  instance: string;
  sequence: number;
  temporary: 'ordinary' | 'temporary' | 'unknown';
  scopeKey?: string;
  collectionId: string | null;
  blocked?: boolean;
  aliasCandidate?: string;
  manualOrdinary?: boolean;
}
interface StoredStage extends Stage {
  target: Pick<LiveDoc, 'tabId' | 'documentId' | 'instance' | 'epoch' | 'selectionId' | 'providerId'>;
  ownerTab?: number;
  consumer?: string;
  read?: boolean;
  boundCollectionId: string | null;
}
type Sender = chrome.runtime.MessageSender;
const session = chrome.storage.session;
const local = chrome.storage.local;
const db = openArchive();
const archiveReads = new Set([
  'getSettings',
  'listCollections',
  'listConversations',
  'getConversation',
  'getArchiveRevision',
  'listSaved',
  'listDrafts',
  'storageStatus',
  'makeBackup',
  'previewImport',
  'listJobs',
  'searchPage',
  'lookupConversation',
]);
const archiveWrites = new Set([
  'setSettings',
  'createCollection',
  'updateCollection',
  'saveMessage',
  'updateSaved',
  'deleteSaved',
  'saveDraft',
  'deleteDraft',
  'deleteConversation',
  'setConversationExcluded',
  'clearAll',
  'cleanup',
  'startImport',
  'resumeImport',
  'removeImport',
]);
const sessionKey = (tabId: number) => 'doc:' + tabId;
const denied = () => new Error('This selection is no longer available. Reopen Trace in the source chat.');
async function get<T>(key: string): Promise<T | undefined> {
  return (await session.get(key))[key] as T | undefined;
}
let serial = Promise.resolve();
let revokeSequence = 0;
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const promise = serial.then(fn, fn);
  serial = promise.then(
    () => {},
    () => {},
  );
  return promise;
}
const setup = Promise.all([
  local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
async function diagnostics(code: string) {
  if (
    ![
      'adapter-degraded',
      'observer-cap',
      'stream-interrupted',
      'storage-full',
      'cleanup-failed',
      'receiver-unavailable',
    ].includes(code)
  )
    return;
  const prior = (await local.get('diagnostics')).diagnostics;
  const rows: Array<{ code: string; at: number; count: number; adapter: string }> = Array.isArray(prior)
    ? prior
    : [];
  const last = rows.at(-1);
  if (last?.code === code && Date.now() - last.at < 60000) last.count = Math.min(10000, last.count + 1);
  else rows.push({ code, at: Date.now(), count: 1, adapter: 'chatgpt-web/1' });
  await local.set({ diagnostics: rows.slice(-200) });
}
async function hashScope(identity: unknown) {
  if (!record(identity) || !id(identity.accountId) || !id(identity.workspaceId)) return undefined;
  let { salt } = await local.get('salt');
  if (typeof salt !== 'string') {
    salt = crypto.randomUUID();
    await local.set({ salt });
  }
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([salt, identity.accountId, identity.workspaceId])),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
const identity = (d: LiveDoc) => ({ tabId: d.tabId, documentId: d.documentId, epoch: d.epoch });
function target(d: LiveDoc) {
  return { ...identity(d), instance: d.instance, providerId: d.providerId, selectionId: d.selectionId };
}
function fence(d: LiveDoc): DocumentFence {
  return {
    ...identity(d),
    providerId: d.providerId,
    selectionId: d.selectionId,
    ordinary: d.temporary === 'ordinary' || (d.temporary === 'unknown' && d.manualOrdinary === true),
    collectionId: d.collectionId,
    scopeKey: d.scopeKey,
  };
}
async function doc(tab: number | undefined) {
  return tab === undefined ? undefined : get<LiveDoc>(sessionKey(tab));
}
async function ping(
  d: Pick<LiveDoc, 'tabId' | 'documentId' | 'instance' | 'epoch' | 'selectionId' | 'providerId'>,
) {
  try {
    const response = await chrome.tabs.sendMessage(d.tabId, { v: 1, op: 'trace-who' }, { frameId: 0 });
    if (
      response?.instance !== d.instance ||
      !same(response.context, d) ||
      ('temporary' in d && response.context?.temporary !== d.temporary)
    )
      throw denied();
  } catch {
    throw denied();
  }
}
async function source(s: Sender, a: Record<string, unknown>, live = false) {
  const d = await doc(s.tab?.id);
  if (
    !d ||
    d.documentId !== s.documentId ||
    d.instance !== a.instance ||
    !context(a.context) ||
    !same(d, a.context)
  )
    throw denied();
  if (live) await ping(d);
  return d;
}
async function announceScope(repo: ArchiveRepository, s: Sender, a: Record<string, unknown>) {
  const t = s.tab!.id!,
    key = sessionKey(t);
  const prev = await doc(t);
  if (!id(a.instance) || !Number.isSafeInteger(a.sequence) || Number(a.sequence) < 1) throw denied();
  if (
    prev !== undefined &&
    prev.documentId === s.documentId &&
    (prev.instance !== a.instance || prev.sequence >= Number(a.sequence))
  )
    throw denied();
  const current = await chrome.tabs
    .sendMessage(t, { v: 1, op: 'trace-who' }, { frameId: 0 })
    .catch(() => null);
  if (current?.instance !== a.instance) throw denied();
  const x = a.scope;
  if (
    !context(x) ||
    !record(x) ||
    !same(x, current.context) ||
    !providerMatches(a.href, x.providerId) ||
    !['ordinary', 'temporary', 'unknown'].includes(String(x.temporary))
  ) {
    if (prev) await repo.removeBinding(prev.documentId, prev.epoch, prev.tabId);
    await session.remove(key);
    return;
  }
  const scopeKey = await hashScope(x.identity);
  if (
    prev !== undefined &&
    prev.documentId === s.documentId &&
    (x.epoch < prev.epoch ||
      (x.epoch === prev.epoch &&
        (prev.providerId !== x.providerId || prev.scopeKey !== scopeKey) &&
        prev.scopeKey !== undefined))
  )
    throw denied();
  if (prev && (prev.documentId !== s.documentId || prev.epoch !== x.epoch))
    await repo.removeBinding(prev.documentId, prev.epoch, t);
  const sameIdentity = prev !== undefined && prev.documentId === s.documentId && prev.scopeKey === scopeKey;
  let collectionId = sameIdentity ? prev.collectionId : null;
  const blocked =
    prev !== undefined &&
    prev.documentId === s.documentId &&
    (!!prev.blocked || (!sameIdentity && !!prev.scopeKey));
  if (!blocked && scopeKey && (!sameIdentity || !collectionId)) {
    // Reading observed identity is ephemeral until the owner binds the scope.
    const collections = await repo.listCollections();
    collectionId = collections.find((c: Collection) => c.scopeKey === scopeKey && c.autoConsent)?.id ?? null;
  }
  const d: LiveDoc = {
    epoch: x.epoch,
    selectionId: x.selectionId,
    providerId: x.providerId,
    temporary: x.temporary as LiveDoc['temporary'],
    manualOrdinary:
      x.temporary === 'unknown' &&
      sameIdentity &&
      prev.epoch === x.epoch &&
      prev.providerId === x.providerId &&
      prev.manualOrdinary === true,
    aliasCandidate:
      sameIdentity && prev.providerId.startsWith('local:') && !x.providerId.startsWith('local:')
        ? prev.providerId
        : sameIdentity && prev.providerId === x.providerId
          ? prev.aliasCandidate
          : undefined,
    tabId: t,
    documentId: s.documentId!,
    instance: a.instance,
    sequence: Number(a.sequence),
    collectionId,
    scopeKey,
    blocked,
  };
  await repo.setBinding(fence(d));
  await session.set({ [key]: d });
}
async function stageList() {
  const stages = (await get<Record<string, StoredStage>>('stages')) ?? {};
  for (const [key, s] of Object.entries(stages)) if (s.expiresAt <= Date.now()) delete stages[key];
  return stages;
}
async function openPage(route: string, d?: LiveDoc, stage?: StoredStage) {
  const url = chrome.runtime.getURL('library.html#' + route);
  if (!stage && route === 'library') {
    const known = await get<number>('libraryTab');
    if (known !== undefined) {
      const prior = await chrome.tabs.get(known).catch(() => null);
      if (prior?.url === url) {
        await session.set({ ['target:' + known]: d ? target(d) : null });
        await chrome.tabs.update(known, { active: true });
        await chrome.windows.update(prior.windowId, { focused: true });
        return known;
      }
    }
  }
  const tab = await chrome.tabs.create({ url });
  if (tab.id === undefined) throw Error('Could not open the extension page.');
  await session.set({
    ['target:' + tab.id]: d ? target(d) : null,
    ...(route === 'library' && { libraryTab: tab.id }),
  });
  return tab.id;
}
async function makeStage(d: LiveDoc, a: Record<string, unknown>) {
  if (
    !['save', 'save-message', 'export', 'handoff'].includes(String(a.action)) ||
    !projectionOk(a.projection, d, MAX_STAGE_BYTES)
  )
    throw Error('Selection unavailable or too large. Select fewer messages.');
  if (a.projection.aliasFrom && a.projection.aliasFrom !== d.aliasCandidate) throw denied();
  if (
    a.messageId !== undefined &&
    (!id(a.messageId) || a.projection.messages.length !== 1 || a.projection.messages[0].id !== a.messageId)
  )
    throw denied();
  if (a.action === 'save-message' && !a.messageId) throw denied();
  const at = Date.now();
  const s: StoredStage = {
    id: crypto.randomUUID(),
    action: a.action as Stage['action'],
    projection: minimalProjection(a.projection),
    createdAt: at,
    expiresAt: at + STAGE_TTL,
    target: target(d),
    boundCollectionId: d.collectionId,
    ...(a.messageId ? { messageId: String(a.messageId) } : {}),
  };
  const stages = await stageList();
  stages[s.id] = s;
  if (byteSize(stages) > MAX_STAGE_BYTES)
    throw Error('The temporary selections exceed 2 MiB. Close existing reviews or select fewer messages.');
  const tab = await openPage('stage/' + s.id, d, s);
  s.ownerTab = tab;
  await session.set({ stages });
  return { opened: true };
}
async function getStage(s: Sender, args: Record<string, unknown>) {
  const stages = await stageList(),
    stage = id(args.id) ? stages[args.id] : undefined;
  if (!stage || stage.ownerTab !== s.tab?.id || (stage.consumer && stage.consumer !== s.documentId))
    throw Error('This review expired. Open it again from the source chat.');
  const current = await doc(stage.target.tabId);
  if (
    !current ||
    current.documentId !== stage.target.documentId ||
    !same(current, stage.target) ||
    current.collectionId !== stage.boundCollectionId
  )
    throw denied();
  await ping(stage.target);
  return { stages, stage, current };
}
async function currentTarget(s: Sender) {
  const ref = await get<StoredStage['target']>('target:' + s.tab?.id);
  if (!ref) return null;
  const d = await doc(ref.tabId);
  if (!d || d.documentId !== ref.documentId || !same(d, ref)) return null;
  try {
    await ping(d);
  } catch {
    return null;
  }
  return d;
}
async function notifyDocs(reset = false) {
  const state = await session.get(null);
  const tasks = Object.entries(state)
    .filter(([k]) => k.startsWith('doc:'))
    .map(([, d]) =>
      chrome.tabs
        .sendMessage(
          (d as LiveDoc).tabId,
          { v: 1, op: 'trace-policy' },
          { documentId: (d as LiveDoc).documentId },
        )
        .catch(() => {}),
    );
  tasks.push(
    chrome.runtime
      .sendMessage({ v: 1, event: reset ? 'archive-cleared' : 'archive-changed' })
      .catch(() => {}),
  );
  await Promise.all(tasks);
}
async function popupTarget() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const d = await doc(tab?.id);
  if (!d || tab?.incognito) return null;
  await ping(d);
  return d;
}
async function route(op: string, input: unknown, s: Sender, enqueuedAt: number) {
  await setup;
  const area = trustedSender(s);
  if (!area) throw Error('Unsupported sender.');
  const repo = await db;
  const a = record(input) ? input : {};
  if (area === 'content') {
    if (op === 'scope') return announceScope(repo, s, a);
    if (op === 'diagnostic') return diagnostics(String(a.code));
    if (op === 'open' && (a.action === 'library' || a.action === 'settings')) {
      const d = context(a.context) ? await source(s, a, true) : undefined;
      await openPage(a.action, d);
      return true;
    }
    const d = await source(s, a);
    if (op === 'status') {
      const status = await repo.getCaptureStatus(
        { ...identity(d), collectionId: d.collectionId },
        d.providerId,
      );
      status.paused = !!d.collectionId && (await repo.isProviderExcluded(d.collectionId, d.providerId));
      return {
        status,
        confirmedOrdinary: d.manualOrdinary === true,
        alertEnabled: (await repo.getSettings()).contextAlert,
      };
    }
    if (op === 'capture') {
      if (enqueuedAt !== revokeSequence) throw denied();
      await ping(d);
      if (enqueuedAt !== revokeSequence) throw denied();
      if (
        (d.temporary !== 'ordinary' && !(d.temporary === 'unknown' && d.manualOrdinary)) ||
        !projectionOk(a.projection, d, MAX_BATCH_BYTES) ||
        !Number.isSafeInteger(a.generation)
      )
        throw denied();
      if (a.projection.aliasFrom && a.projection.aliasFrom !== d.aliasCandidate) throw denied();
      return repo.capture(minimalProjection(a.projection), {
        ...identity(d),
        collectionId: d.collectionId!,
        generation: Number(a.generation),
      });
    }
    if (op === 'stage') {
      await ping(d);
      return makeStage(d, a);
    }
    if (op === 'togglePause' && d.collectionId) {
      await ping(d);
      const excluded = await repo.isProviderExcluded(d.collectionId, d.providerId);
      await repo.setProviderExcluded(d.collectionId, d.providerId, !excluded);
      await notifyDocs();
      return true;
    }
    throw Error('Unsupported action.');
  }
  if (area === 'popup') {
    if (op === 'popupContext') {
      const d = await popupTarget().catch(() => null);
      if (!d) return {};
      const p = await chrome.tabs.sendMessage(
        d.tabId,
        { v: 1, op: 'trace-popup' },
        { documentId: d.documentId },
      );
      if (p?.instance !== d.instance || !same(d, p.context) || !activityOk(p.activity)) return {};
      return {
        context: { epoch: d.epoch, providerId: d.providerId, selectionId: d.selectionId },
        activity: p.activity,
        documentId: d.documentId,
        tabId: d.tabId,
        theme: p.theme === 'dark' ? 'dark' : 'light',
        alertEnabled: !!p.alertEnabled,
      };
    }
    if (op === 'popupAction') {
      if (a.action === 'library' || a.action === 'settings') {
        await openPage(a.action, (await popupTarget().catch(() => null)) ?? undefined);
        return true;
      }
      const d = await popupTarget();
      if (
        !d ||
        !context(a.context) ||
        !same(d, a.context) ||
        d.tabId !== a.tabId ||
        d.documentId !== a.documentId
      )
        throw denied();
      if (a.action === 'pause' && d.collectionId) {
        const excluded = await repo.isProviderExcluded(d.collectionId, d.providerId);
        await repo.setProviderExcluded(d.collectionId, d.providerId, !excluded);
        await notifyDocs();
        return true;
      }
      if (!['save', 'export', 'handoff'].includes(String(a.action))) throw denied();
      const p = await chrome.tabs.sendMessage(
        d.tabId,
        { v: 1, op: 'trace-snapshot', instance: d.instance, context: a.context },
        { documentId: d.documentId },
      );
      if (p?.instance !== d.instance || !same(p.context, d)) throw denied();
      return makeStage(d, { ...a, projection: p.projection });
    }
    throw Error('Unsupported popup action.');
  }
  if (op === 'readStage' || op === 'saveStage') {
    const { stages, stage, current } = await getStage(s, a);
    if (op === 'readStage') {
      if (stage.read) throw Error('This temporary selection has already been opened.');
      stage.consumer = s.documentId;
      stage.read = true;
      if (stage.action === 'export' || stage.action === 'handoff') delete stages[stage.id];
      await session.set({ stages });
      const {
        target: _target,
        ownerTab: _tab,
        consumer: _consumer,
        read: _read,
        boundCollectionId: _cid,
        ...review
      } = stage;
      return review;
    }
    if (
      !stage.read ||
      stage.consumer !== s.documentId ||
      !['save', 'save-message'].includes(stage.action) ||
      !id(a.collectionId)
    )
      throw denied();
    const collection = (await repo.listCollections()).find((c: Collection) => c.id === a.collectionId);
    if (!collection || (collection.scopeKey && current.scopeKey !== collection.scopeKey))
      throw Error('Choose a destination collection that matches this source.');
    if (
      a.selectedMessageIds !== undefined &&
      (!Array.isArray(a.selectedMessageIds) ||
        !a.selectedMessageIds.length ||
        !a.selectedMessageIds.every((i) => id(i) && stage.projection.messages.some((m) => m.id === i)))
    )
      throw denied();
    const selection = a.selectedMessageIds as string[] | undefined;
    if (
      stage.action === 'save-message' &&
      (!stage.messageId || (selection && (selection.length !== 1 || selection[0] !== stage.messageId)))
    )
      throw denied();
    let bookmark: { label?: string; tags?: string[]; note?: string } | undefined;
    if (a.savedItem !== undefined) {
      if (!record(a.savedItem) || !selection?.length) throw denied();
      const { label, tags, note } = a.savedItem;
      if (
        (label !== undefined && (typeof label !== 'string' || label.length > 256)) ||
        (note !== undefined && (typeof note !== 'string' || note.length > 16384)) ||
        (tags !== undefined &&
          (!Array.isArray(tags) || tags.length > 32 || !tags.every((t) => bounded(t, 128))))
      )
        throw Error('Invalid note or tags.');
      bookmark = {
        label: label as string | undefined,
        note: note as string | undefined,
        tags: tags as string[] | undefined,
      };
    }
    if (stage.action === 'save-message' && !bookmark) bookmark = {};
    const result = await repo.saveCapture(
      stage.projection,
      {
        ...identity(current),
        collectionId: collection.id,
        expiresAt: stage.expiresAt,
        intentId: stage.id,
        generation: (await repo.getSettings()).generation,
      },
      selection ?? (stage.messageId ? [stage.messageId] : undefined),
      bookmark,
    );
    delete stages[stage.id];
    await session.set({ stages });
    await notifyDocs();
    return result;
  }
  if (
    op === 'getTarget' ||
    op === 'bindTarget' ||
    op === 'resumeTarget' ||
    op === 'setTargetPause' ||
    op === 'confirmOrdinary'
  ) {
    const d = await currentTarget(s);
    if (op === 'getTarget') {
      if (!d) return null;
      const status = await repo.getCaptureStatus(
        { ...identity(d), collectionId: d.collectionId },
        d.providerId,
      );
      return {
        ...identity(d),
        providerId: d.providerId,
        temporary: d.temporary,
        identityObserved: !!d.scopeKey,
        boundCollectionId: d.collectionId,
        paused: status.paused,
        manualOrdinary: d.manualOrdinary === true,
      };
    }
    if (!d) throw Error('Open Settings from the source conversation to choose a collection.');
    if (op === 'bindTarget') {
      const collection = (await repo.listCollections()).find((c: Collection) => c.id === a.collectionId);
      if (!collection || (collection.scopeKey && collection.scopeKey !== d.scopeKey))
        throw Error('Choose a collection for the current account and workspace.');
      if (d.scopeKey && !collection.scopeKey && a.observed === true)
        await repo.bindObservedCollection(collection.id, d.scopeKey);
      d.collectionId = collection.id;
      d.blocked = false;
      await repo.setBinding(fence(d));
      await session.set({ [sessionKey(d.tabId)]: d });
    } else if (op === 'confirmOrdinary') {
      if (d.temporary !== 'unknown' || !d.collectionId || typeof a.confirmed !== 'boolean') throw denied();
      d.manualOrdinary = a.confirmed;
      await repo.setBinding(fence(d));
      await session.set({ [sessionKey(d.tabId)]: d });
    } else {
      if (!d.collectionId || (op === 'setTargetPause' && typeof a.paused !== 'boolean')) throw denied();
      await repo.setProviderExcluded(
        d.collectionId,
        d.providerId,
        op === 'setTargetPause' && a.paused === true,
      );
    }
    await notifyDocs();
    return true;
  }
  if (op === 'diagnostics') return (await local.get('diagnostics')).diagnostics ?? [];
  if (op === 'clearDiagnostics') {
    await local.remove('diagnostics');
    return true;
  }
  if (op === 'getTheme') {
    const d = await currentTarget(s);
    if (!d) return null;
    const theme = await chrome.tabs
      .sendMessage(d.tabId, { v: 1, op: 'trace-theme' }, { documentId: d.documentId })
      .catch(() => null);
    if (!theme || typeof theme.dark !== 'boolean') return null;
    return {
      dark: theme.dark,
      ...(typeof theme.fontFamily === 'string' &&
        /^[\w\s,"'-]{1,180}$/.test(theme.fontFamily) && { fontFamily: theme.fontFamily }),
    };
  }
  if (!archiveReads.has(op) && !archiveWrites.has(op)) throw Error('Unsupported library operation.');
  const args = input === undefined ? [] : input;
  if (!Array.isArray(args) || args.length > 5) throw Error('Invalid archive operation.');
  if (op === 'clearAll') {
    const snapshot = await session.get(null);
    await repo.setSettings({ autoCapture: false });
    await notifyDocs(true);
    await session.clear();
    await local.clear();
    await repo.clearAll();
    for (const [key, d] of Object.entries(snapshot))
      if (key.startsWith('doc:')) {
        void chrome.tabs
          .sendMessage(
            (d as LiveDoc).tabId,
            { v: 1, op: 'trace-reconnect' },
            { documentId: (d as LiveDoc).documentId },
          )
          .catch(() => {});
      }
    await chrome.runtime.sendMessage({ v: 1, event: 'archive-cleared' }).catch(() => {});
    return true;
  }
  const method = (repo as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[op];
  if (typeof method !== 'function') throw Error('Unsupported archive operation.');
  const deleting = op === 'deleteConversation' && id(args[0]) ? await repo.getConversation(args[0]) : null;
  const result = await method.apply(repo, args);
  if (archiveWrites.has(op) && op !== 'cleanup') {
    if (
      op === 'deleteConversation' ||
      op === 'setSettings' ||
      op === 'updateCollection' ||
      op === 'removeImport'
    ) {
      // Close stale reviews and invalidate cached snippets on destructive writes.
      if (op === 'deleteConversation') {
        const providerId = deleting?.conversation.providerId;
        const stages = await stageList();
        for (const [key, stage] of Object.entries(stages))
          if (providerId && stage.projection.providerId === providerId) delete stages[key];
        await session.set({ stages });
        await chrome.runtime
          .sendMessage({
            v: 1,
            event: 'archive-chat-deleted',
            conversationId: args[0],
            providerId,
            sourceUrl: deleting?.conversation.sourceUrl,
          })
          .catch(() => {});
      } else if (op === 'removeImport') {
        await session.remove('stages');
        await chrome.runtime.sendMessage({ v: 1, event: 'archive-import-removed' }).catch(() => {});
      }
    }
    await notifyDocs();
  }
  return result;
}
chrome.runtime.onMessage.addListener((message, s, respond) => {
  if (!record(message) || message.v !== 1 || !bounded(message.op, 64) || !trustedSender(s)) return false;
  const op = message.op;
  // Revoke queued automatic work at receipt. An unfinished IDB write either
  // committed first or observes the updated generation in its own transaction.
  const arg = Array.isArray(message.args) ? message.args[0] : undefined;
  const revoke =
    trustedSender(s) === 'library' &&
    (op === 'clearAll' || (op === 'setSettings' && record(arg) && arg.autoCapture === false));
  if (revoke) revokeSequence++;
  const sequence = revokeSequence;
  const fence = revoke ? db.then((repo) => repo.setSettings({ autoCapture: false })) : Promise.resolve();
  // Attach a rejection handler immediately if an earlier operation is still active.
  void fence.catch(() => {});
  exclusive(async () => {
    await fence;
    return route(op, message.args, s, sequence);
  }).then(
    (data) => respond({ ok: true, data }),
    async (e) => {
      if (
        (e instanceof DOMException && e.name === 'QuotaExceededError') ||
        (e instanceof Error && e.message === 'Local storage is full. Automatic saving is paused.')
      ) {
        await exclusive(async () => {
          const repo = await db;
          await repo.setSettings({ autoCapture: false });
          await diagnostics('storage-full');
          await notifyDocs();
        }).catch(() => {});
      }
      respond({
        ok: false,
        error:
          e instanceof Error && !(e instanceof DOMException)
            ? e.message.slice(0, 220)
            : 'The operation could not complete. Existing data was kept.',
      });
    },
  );
  return true;
});
async function cleanupJobs() {
  const repo = await db;
  const stages = await stageList();
  await session.set({ stages });
  await repo.cleanup();
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'retention') void exclusive(cleanupJobs).catch(() => diagnostics('cleanup-failed'));
});
async function schedule() {
  if (!(await chrome.alarms.get('retention')))
    await chrome.alarms.create('retention', { periodInMinutes: 15 });
}
chrome.runtime.onInstalled.addListener((details) => {
  void exclusive(async () => {
    await setup;
    await schedule();
    await cleanupJobs();
    if (details.reason === 'install' && !(await (await db).getSettings()).welcomeComplete)
      await openPage('welcome');
  });
});
chrome.runtime.onStartup.addListener(() => {
  void exclusive(async () => {
    await setup;
    await schedule();
    await (await db).resetFences();
    await cleanupJobs();
  });
});
chrome.tabs.onRemoved.addListener((t) => {
  void exclusive(async () => {
    const d = await doc(t);
    if (d) await (await db).removeBinding(d.documentId, d.epoch, t);
    const stages = await stageList();
    for (const [id, s] of Object.entries(stages))
      if (s.ownerTab === t || s.target.tabId === t) delete stages[id];
    await session.set({ stages });
    await session.remove([sessionKey(t), 'target:' + t]);
  });
});
chrome.commands.onCommand.addListener((command) => {
  void exclusive(async () => {
    const d = await popupTarget().catch(() => null);
    if (command === 'open-library') {
      await openPage('library', d ?? undefined);
      return;
    }
    if (command === 'show-activity' && d)
      await chrome.tabs.sendMessage(
        d.tabId,
        { v: 1, op: 'trace-activity', instance: d.instance, context: d },
        { documentId: d.documentId },
      );
  });
});
