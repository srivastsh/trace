import type { IDBPDatabase } from 'idb';
import type { CaptureStatus, DocTarget, Projection } from '../contracts';
import { previewEnvelope, validateDraft, validateEnvelope } from './backup';
import {
  announce, archiveStores, bumpRevision, clean, connectArchive, DEFAULT_SETTINGS, expire,
  onlyVisible, revisionMeta, settings, visible, type ArchiveDB, type ArchiveRead, type ArchiveTx, type CommitFence,
} from './database';
import { applyExclusions, ensureUnlocked, makeSaved, persistProjection, removeTranscript, type BookmarkOptions, type CaptureResult } from './merge';
import {
  collectionRows, conversationRows, conversationView, getCollection, hydrateRows,
  savedRows, searchByConversation, searchPageRows,
} from './read';
import type {
  ArchiveSettings, Collection, DocumentFence, HandoffDraft, ImportJob, Retention, SavedItem, SaveAuthorization,
} from './types';
import { bool, boundedString, fail, fields, integer, object, pick, retention, token, validateNoteFields, validateProjection } from './validation';
import { addImport, backupRows, listImports, removeRestore, resumeRestore } from './restore';

export const archiveOperations = [
  'getSettings', 'setSettings', 'listCollections', 'createCollection', 'updateCollection',
  'listConversations', 'getConversation', 'lookupConversation', 'searchPage', 'hydrateSearch',
  'searchChanges', 'searchConversations', 'getArchiveRevision', 'listSaved', 'saveMessage',
  'updateSaved', 'deleteSaved', 'listDrafts', 'saveDraft', 'deleteDraft', 'deleteConversation',
  'setConversationExcluded', 'storageStatus', 'clearAll', 'cleanup', 'makeBackup',
  'previewImport', 'startImport', 'resumeImport', 'listJobs', 'removeImport',
] as const;

export interface CaptureTarget extends DocTarget {
  generation: number;
  collectionId: string;
}

type CaptureStatusTarget = DocTarget & { collectionId?: string | null };
type CollectionChange = Partial<Pick<Collection, 'label' | 'retention' | 'autoExcluded' | 'autoConsent'>>;
type GeneralSettings = Partial<Omit<ArchiveSettings, 'generation'>>;

const provisionalProvider = /^local:[a-f0-9-]{36}$/iu;

function collectionLabel(raw: unknown): string {
  const label = boundedString(raw, 128).trim();
  return label || fail('Enter a collection name.');
}

async function digest(domain: string, value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain + '\0' + value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function shaDocument(target: DocTarget) {
  integer(target.tabId);
  integer(target.epoch);
  return digest('document', token(target.documentId));
}

function checkedAlias(projection: Projection): string | undefined {
  if (projection.aliasFrom === undefined) return undefined;
  if (!provisionalProvider.test(projection.aliasFrom) || provisionalProvider.test(projection.providerId)
    || !projection.sourceUrl.replace(/\/$/u, '').endsWith('/c/' + projection.providerId)) {
    fail('Unverified temporary conversation alias.');
  }
  return projection.aliasFrom;
}

async function hashes(target: CaptureStatusTarget, providerId?: string, selectionId?: string, aliasFrom?: string) {
  const [documentHash, collectionHash, providerHash, selectionHash, aliasHash] = await Promise.all([
    shaDocument(target),
    target.collectionId ? digest('collection', token(target.collectionId)) : undefined,
    providerId ? digest('provider', JSON.stringify([target.documentId, token(providerId)])) : undefined,
    selectionId ? digest('selection', JSON.stringify([target.documentId, token(selectionId)])) : undefined,
    aliasFrom ? digest('provider', JSON.stringify([target.documentId, token(aliasFrom)])) : undefined,
  ]);
  return { documentHash, collectionHash, providerHash, selectionHash, aliasHash };
}

function matchingDocument(fence: CommitFence | undefined, target: DocTarget, documentHash: string): boolean {
  return fence?.epoch === target.epoch && fence.documentHash === documentHash;
}

function sourceProvider(sourceUrl: string): string | undefined {
  return sourceUrl.match(/\/c\/([A-Za-z0-9_-]+)\/?$/u)?.[1];
}

export class ArchiveRepository {
  constructor(private readonly db: IDBPDatabase<ArchiveDB>, private readonly clock = Date.now) {}

  close(): void {
    this.db.close();
  }

  private async read<T>(run: (tx: ArchiveRead) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(archiveStores, 'readonly');
    const state = tx.done.catch(() => undefined);
    try {
      return await run(tx);
    } finally {
      await state;
    }
  }

  private async write<T>(run: (tx: ArchiveTx) => Promise<{ value: T; archiveRevision?: number }>): Promise<T> {
    const tx = this.db.transaction(archiveStores, 'readwrite');
    const completed = tx.done;
    void completed.catch(() => undefined);
    try {
      const result = await run(tx);
      await completed;
      if (result.archiveRevision !== undefined) announce(result.archiveRevision);
      return result.value;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // An IndexedDB request can abort the transaction before its rejection is handled.
      }
      await completed.catch(() => undefined);
      throw error;
    }
  }

  getSettings(): Promise<ArchiveSettings> {
    return this.read(settings);
  }

  setSettings(patch: GeneralSettings): Promise<ArchiveSettings> {
    object(patch);
    return this.write(async (tx) => {
      const previous = await settings(tx);
      const autoCapture = patch.autoCapture === undefined ? previous.autoCapture : bool(patch.autoCapture);
      const contextAlert = patch.contextAlert === undefined ? previous.contextAlert : bool(patch.contextAlert);
      const welcomeComplete = patch.welcomeComplete === undefined ? previous.welcomeComplete : bool(patch.welcomeComplete);
      const value = {
        autoCapture, contextAlert, welcomeComplete,
        generation: previous.generation + Number(autoCapture !== previous.autoCapture),
      };
      await tx.objectStore('meta').put({ key: 'settings', value });
      return { value };
    });
  }

  listCollections(): Promise<Collection[]> {
    return this.read(collectionRows);
  }

  createCollection(input: { label: string; mode?: 'manual' | 'observed'; scopeKey?: string; retention?: Retention }): Promise<Collection> {
    object(input);
    const mode = input.mode === undefined ? 'manual' : pick(input.mode, ['manual', 'observed']);
    const scopeKey = mode === 'observed' && input.scopeKey !== undefined ? token(input.scopeKey) : undefined;
    const label = collectionLabel(input.label);
    const days = input.retention === undefined ? 90 : retention(input.retention);
    return this.write(async (tx) => {
      const store = tx.objectStore('collections');
      if (scopeKey && await store.index('scope').get(scopeKey)) fail('That observed account already has a collection.');
      const value: Collection = {
        id: crypto.randomUUID(), label, mode, scopeKey, retention: days, autoConsent: false,
        autoExcluded: false, createdAt: this.clock(),
      };
      await store.add(value);
      return { value, archiveRevision: await bumpRevision(tx) };
    });
  }

  updateCollection(id: string, patch: CollectionChange): Promise<Collection> {
    token(id);
    object(patch);
    return this.write(async (tx) => {
      const previous = await getCollection(tx, id) ?? fail('Collection unavailable.');
      const value = {
        ...previous,
        label: patch.label === undefined ? previous.label : collectionLabel(patch.label),
        retention: patch.retention === undefined ? previous.retention : retention(patch.retention),
        autoExcluded: patch.autoExcluded === undefined ? previous.autoExcluded : bool(patch.autoExcluded),
        autoConsent: patch.autoConsent === undefined ? previous.autoConsent : bool(patch.autoConsent),
      };
      if (previous.autoExcluded !== value.autoExcluded || previous.autoConsent !== value.autoConsent) {
        const active = await settings(tx);
        await tx.objectStore('meta').put({ key: 'settings', value: { ...active, generation: active.generation + 1 } });
      }
      await tx.objectStore('collections').put(value);
      return { value, archiveRevision: await bumpRevision(tx, [], previous.retention !== value.retention) };
    });
  }

  resolveObservedCollection(scopeKey: string): Promise<Collection | undefined> {
    token(scopeKey);
    return this.read(async (tx) => {
      const row = await tx.objectStore('collections').index('scope').get(scopeKey);
      return row && await visible(tx, row) ? clean(row) : undefined;
    });
  }

  async bindObservedCollection(id: string, scopeKey: string): Promise<Collection> {
    token(id);
    token(scopeKey);
    const collectionHash = await digest('collection', id);
    return this.write(async (tx) => {
      const value = await getCollection(tx, id) ?? fail('Collection unavailable.');
      if (value.scopeKey === scopeKey) return { value };
      if (value.scopeKey) fail('This collection is already bound to a different observed account.');
      if (await tx.objectStore('collections').index('scope').get(scopeKey)) fail('That observed account already has a collection.');
      const [archives, aliases, excerpts, drafts] = await Promise.all([
        tx.objectStore('conversations').index('collection').count(id),
        tx.objectStore('aliases').count(IDBKeyRange.bound([id], [id, []])),
        tx.objectStore('saved').index('collection').count(id),
        tx.objectStore('drafts').index('collection').count(id),
      ]);
      if (archives || aliases || excerpts || drafts) fail('Choose an empty collection for an observed account.');
      const next: Collection = { ...value, mode: 'observed', scopeKey, autoConsent: false };
      await tx.objectStore('collections').put(next);
      const active = await settings(tx);
      await tx.objectStore('meta').put({ key: 'settings', value: { ...active, generation: active.generation + 1 } });
      const fences = tx.objectStore('fences');
      for (const fence of await fences.getAll()) {
        if (fence.collectionHash === collectionHash) await fences.delete(fence.tabId);
      }
      return { value: next, archiveRevision: await bumpRevision(tx) };
    });
  }

  async setBinding(binding: DocumentFence): Promise<void> {
    const fingerprint = await hashes(binding, binding.providerId, binding.selectionId);
    await this.write(async (tx) => {
      if (binding.collectionId) {
        const collection = await getCollection(tx, binding.collectionId) ?? fail('Collection unavailable.');
        if (collection.mode === 'observed' && (!collection.scopeKey || binding.scopeKey !== collection.scopeKey)) {
          fail('Observed account binding does not match this collection.');
        }
      }
      const store = tx.objectStore('fences');
      const existing = await store.get(binding.tabId);
      if (existing?.documentHash === fingerprint.documentHash && existing.epoch > binding.epoch) {
        fail('This conversation view has changed.');
      }
      await store.put({
        tabId: binding.tabId, epoch: binding.epoch, ordinary: binding.ordinary === true,
        documentHash: fingerprint.documentHash, collectionHash: fingerprint.collectionHash,
        providerHash: fingerprint.providerHash, selectionHash: fingerprint.selectionHash,
      });
      return { value: undefined };
    });
  }

  async removeBinding(documentId: string, epoch: number, tabId?: number): Promise<void> {
    const documentHash = await digest('document', token(documentId));
    integer(epoch);
    await this.write(async (tx) => {
      const store = tx.objectStore('fences');
      const candidate = tabId === undefined ? await store.getAll() : [await store.get(tabId)];
      for (const fence of candidate) {
        if (fence?.documentHash === documentHash && fence.epoch <= epoch) await store.delete(fence.tabId);
      }
      return { value: undefined };
    });
  }

  removeTabBinding(tabId: number): Promise<void> {
    return this.write(async (tx) => {
      await tx.objectStore('fences').delete(integer(tabId));
      return { value: undefined };
    });
  }

  resetFences(): Promise<void> {
    return this.write(async (tx) => {
      await tx.objectStore('fences').clear();
      return { value: undefined };
    });
  }

  async getCaptureStatus(target: CaptureStatusTarget, providerId?: string): Promise<CaptureStatus> {
    const fingerprint = await hashes(target, providerId);
    return this.read(async (tx) => {
      const [active, fence, collection, exclusion] = await Promise.all([
        settings(tx),
        tx.objectStore('fences').get(target.tabId),
        target.collectionId ? getCollection(tx, target.collectionId) : undefined,
        target.collectionId && providerId ? tx.objectStore('exclusions').get([target.collectionId, providerId]) : undefined,
      ]);
      const bound = !!collection && matchingDocument(fence, target, fingerprint.documentHash)
        && !!fence?.collectionHash && fence.collectionHash === fingerprint.collectionHash;
      const paused = !!exclusion || !!(collection && (collection.autoExcluded || !collection.autoConsent))
        || !!(fence?.providerHash && fingerprint.providerHash !== fence.providerHash)
        || !fence?.ordinary;
      return { enabled: active.autoCapture && bound && !paused, generation: active.generation, bound, paused };
    });
  }

  async capture(input: Projection, target: CaptureTarget): Promise<CaptureResult> {
    const projection = validateProjection(input, false);
    const aliasFrom = checkedAlias(projection);
    const fingerprint = await hashes(target, projection.providerId, undefined, aliasFrom);
    integer(target.generation);
    try {
      const result = await this.write(async (tx) => {
        const [active, fence, collection] = await Promise.all([
          settings(tx), tx.objectStore('fences').get(target.tabId), getCollection(tx, target.collectionId),
        ]);
        if (!active.autoCapture || active.generation !== target.generation || !collection?.autoConsent || collection.autoExcluded
          || !fence?.ordinary || !matchingDocument(fence, target, fingerprint.documentHash)
          || fence.collectionHash !== fingerprint.collectionHash
          || !fence.providerHash
          || (fence.providerHash !== fingerprint.providerHash && fence.providerHash !== fingerprint.aliasHash)) {
          fail('Automatic saving is paused or the conversation view changed.');
        }
        const exclusions = tx.objectStore('exclusions');
        const [excluded, oldExcluded] = await Promise.all([
          exclusions.get([collection.id, projection.providerId]),
          aliasFrom ? exclusions.get([collection.id, aliasFrom]) : undefined,
        ]);
        if (excluded || oldExcluded) {
          if (aliasFrom) await applyExclusions(tx, collection.id, [projection.providerId, aliasFrom], true);
          return { value: null };
        }
        const receipt = JSON.stringify(['auto', fingerprint.documentHash, target.epoch, target.generation, projection.batchId]);
        const saved = await persistProjection(tx, collection, projection, fingerprint.documentHash.slice(0, 32) + ':' + target.epoch, receipt, this.clock());
        return { value: saved.result, archiveRevision: saved.archiveRevision };
      });
      return result ?? fail('Automatic saving is paused for this chat.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        await this.setSettings({ autoCapture: false }).catch(() => undefined);
        fail('Local storage is full. Automatic saving is paused.');
      }
      throw error;
    }
  }

  async saveCapture(input: Projection, auth: SaveAuthorization, selection?: string[], bookmark?: BookmarkOptions): Promise<CaptureResult> {
    const projection = validateProjection(input, true);
    const aliasFrom = checkedAlias(projection);
    const fingerprint = await hashes(auth, projection.providerId, projection.selectionId, aliasFrom);
    integer(auth.generation);
    integer(auth.expiresAt);
    const intentId = token(auth.intentId);
    const selected = selection && fields(selection, 8_192, token);
    const options = bookmark === undefined ? undefined : validateNoteFields(bookmark);
    return this.write(async (tx) => {
      const [active, fence, collection] = await Promise.all([
        settings(tx), tx.objectStore('fences').get(auth.tabId), getCollection(tx, auth.collectionId),
      ]);
      const now = this.clock();
      if (!fence?.providerHash || !fence.selectionHash || !matchingDocument(fence, auth, fingerprint.documentHash) || !collection
        || active.generation !== auth.generation || auth.expiresAt <= now || auth.expiresAt > now + 15 * 60_000
        || (fence.providerHash !== fingerprint.providerHash && fence.providerHash !== fingerprint.aliasHash)
        || fence.selectionHash !== fingerprint.selectionHash) {
        fail('This save review expired or the conversation view changed.');
      }
      const receipt = JSON.stringify(['explicit', intentId]);
      const saved = await persistProjection(tx, collection, projection, fingerprint.documentHash.slice(0, 32) + ':' + auth.epoch, receipt, now, selected, options);
      return { value: saved.result, archiveRevision: saved.archiveRevision };
    });
  }

  listConversations(collectionId?: string) {
    return this.read((tx) => conversationRows(tx, this.clock(), collectionId ?? undefined));
  }

  getConversation(id: string, segmentId?: string) {
    return this.read((tx) => conversationView(tx, token(id), this.clock(), segmentId ?? undefined));
  }

  lookupConversation(collectionId: string, providerId: string): Promise<import('./types').Conversation | undefined> {
    return this.read(async (tx) => {
      const alias = await tx.objectStore('aliases').get([token(collectionId), token(providerId)]);
      if (!alias || !(await visible(tx, alias))) return undefined;
      const row = await tx.objectStore('conversations').get(alias.conversationId);
      const collection = await getCollection(tx, collectionId);
      return row && collection && await visible(tx, row) && !expire(row, collection, this.clock()) ? clean(row) : undefined;
    });
  }

  getArchiveRevision(): Promise<number> {
    return this.read(async (tx) => (await revisionMeta(tx)).number);
  }

  searchPage(after?: string | null, limit = 150) {
    return this.read((tx) => searchPageRows(tx, this.clock(), after ?? undefined, Math.max(1, integer(limit, 500))));
  }

  hydrateSearch(ids: string[], collectionId?: string) {
    const keys = fields(ids, 500, token);
    return this.read((tx) => hydrateRows(tx, this.clock(), keys, collectionId));
  }

  searchConversations(ids: string[], collectionId?: string) {
    const keys = fields(ids, 1_024, token);
    return this.read((tx) => searchByConversation(tx, this.clock(), keys, collectionId));
  }

  searchChanges(since: number) {
    integer(since);
    return this.read(async (tx) => {
      const meta = await revisionMeta(tx);
      const changed = meta.changes.filter((row) => row.revision > since);
      const reset = since > meta.number || (changed.length > 0 && changed[0].revision > since + 1) || changed.some((row) => row.reset);
      return { archiveRevision: meta.number, reset,
        conversationIds: reset ? [] : [...new Set(changed.flatMap((row) => row.ids))] };
    });
  }

  listSaved(collectionId?: string): Promise<SavedItem[]> {
    return this.read(async (tx) => (await savedRows(tx, collectionId ?? undefined)).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  saveMessage(options: { conversationId: string; revisionId: string } & BookmarkOptions): Promise<SavedItem> {
    object(options);
    const notes = validateNoteFields(options);
    return this.write(async (tx) => {
      const id = token(options.conversationId);
      const [view, revision] = await Promise.all([
        conversationView(tx, id, this.clock()),
        tx.objectStore('revisions').get(token(options.revisionId)),
      ]);
      if (!view || view.expired || !revision || revision.conversationId !== id || !(await visible(tx, revision))) {
        fail('This source revision is no longer available.');
      }
      const source = view.segments.find((segment) => segment.revisions.some((ref) => ref.revisionId === revision.id));
      const value = makeSaved({ ...view.conversation, coverage: source?.coverage ?? view.conversation.coverage }, revision, notes, this.clock());
      await tx.objectStore('saved').add(value);
      return { value, archiveRevision: await bumpRevision(tx, [id]) };
    });
  }

  updateSaved(id: string, patch: BookmarkOptions): Promise<SavedItem> {
    object(patch);
    return this.write(async (tx) => {
      const store = tx.objectStore('saved');
      const item = await store.get(token(id));
      if (!item || !(await visible(tx, item))) fail('Saved excerpt unavailable.');
      const note = validateNoteFields({
        label: patch.label ?? item.label, tags: patch.tags ?? item.tags, note: patch.note ?? item.note,
      });
      const value = { ...clean(item), ...note, updatedAt: Math.max(item.createdAt, this.clock()) };
      await store.put(value);
      return { value, archiveRevision: await bumpRevision(tx, [item.conversationId]) };
    });
  }

  deleteSaved(id: string): Promise<void> {
    return this.write(async (tx) => {
      const store = tx.objectStore('saved');
      const item = await store.get(token(id));
      if (!item || !(await visible(tx, item))) return { value: undefined };
      await store.delete(id);
      return { value: undefined, archiveRevision: await bumpRevision(tx, [item.conversationId]) };
    });
  }

  listDrafts(collectionId?: string): Promise<HandoffDraft[]> {
    return this.read(async (tx) => {
      const store = tx.objectStore('drafts');
      const rows = await onlyVisible(tx, collectionId == null ? await store.getAll() : await store.index('collection').getAll(collectionId));
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  saveDraft(draft: unknown): Promise<HandoffDraft> {
    const value = validateDraft(draft);
    return this.write(async (tx) => {
      if (!(await getCollection(tx, value.collectionId))) fail('Collection unavailable.');
      const store = tx.objectStore('drafts');
      const old = await store.get(value.id);
      if (old && (!(await visible(tx, old)) || old.collectionId !== value.collectionId)) fail('Handoff is unavailable in this collection.');
      for (const entry of value.evidence) {
        const providerId = sourceProvider(entry.sourceUrl);
        const alias = providerId && await tx.objectStore('aliases').get([value.collectionId, providerId]);
        if (!entry.conversationId && alias && await visible(tx, alias)) entry.conversationId = alias.conversationId;
        if (entry.conversationId) {
          const known = await tx.objectStore('conversations').get(entry.conversationId);
          if (!known) {
            const saved = await tx.objectStore('saved').index('conversation').getKey(entry.conversationId);
            const sourced = await tx.objectStore('aliases').index('conversation').getKey(entry.conversationId);
            if (!saved && !sourced) {
              entry.text = '';
              entry.activity = undefined;
              entry.unavailable = true;
            }
          }
        }
      }
      await store.put(value);
      return { value, archiveRevision: await bumpRevision(tx) };
    });
  }

  deleteDraft(id: string): Promise<void> {
    return this.write(async (tx) => {
      const store = tx.objectStore('drafts');
      const item = await store.get(token(id));
      if (!item || !(await visible(tx, item))) return { value: undefined };
      await store.delete(id);
      return { value: undefined, archiveRevision: await bumpRevision(tx) };
    });
  }

  isProviderExcluded(collectionId: string, providerId: string): Promise<boolean> {
    return this.read(async (tx) => !!(await tx.objectStore('exclusions').get([token(collectionId), token(providerId)])));
  }

  setProviderExcluded(collectionId: string, providerId: string, excluded: boolean): Promise<void> {
    token(collectionId);
    token(providerId);
    bool(excluded);
    return this.write(async (tx) => {
      if (!(await getCollection(tx, collectionId))) fail('Collection unavailable.');
      const aliases = tx.objectStore('aliases');
      const entry = await aliases.get([collectionId, providerId]);
      const related = entry ? await aliases.index('conversation').getAll(entry.conversationId) : [];
      await this.applyExclusion(tx, collectionId, [providerId, ...related.map((row) => row.providerId)], excluded);
      return { value: undefined };
    });
  }

  setConversationExcluded(id: string, excluded: boolean): Promise<void> {
    token(id);
    bool(excluded);
    return this.write(async (tx) => {
      const aliases = await tx.objectStore('aliases').index('conversation').getAll(id);
      if (!aliases.length) fail('Conversation unavailable.');
      await this.applyExclusion(tx, aliases[0].collectionId, aliases.map((alias) => alias.providerId), excluded);
      return { value: undefined };
    });
  }

  private async applyExclusion(tx: ArchiveTx, collectionId: string, ids: string[], excluded: boolean) {
    await applyExclusions(tx, collectionId, ids, excluded);
    const active = await settings(tx);
    await tx.objectStore('meta').put({ key: 'settings', value: { ...active, generation: active.generation + 1 } });
  }

  deleteConversation(id: string): Promise<void> {
    token(id);
    return this.write(async (tx) => {
      await ensureUnlocked(tx, id);
      const aliases = await tx.objectStore('aliases').index('conversation').getAll(id);
      const savedStore = tx.objectStore('saved');
      const savedItems = await savedStore.index('conversation').getAll(id);
      const conv = await tx.objectStore('conversations').get(id);
      const collectionId = conv?.collectionId ?? aliases[0]?.collectionId ?? savedItems[0]?.collectionId;
      if (!collectionId) return { value: undefined };
      const ids = new Set(aliases.map((alias) => alias.providerId));
      for (const saved of savedItems) {
        const id = sourceProvider(saved.sourceUrl);
        if (id) ids.add(id);
        await savedStore.delete(saved.id);
      }
      await this.applyExclusion(tx, collectionId, [...ids], true);
      const aliasStore = tx.objectStore('aliases');
      for (const alias of aliases) await aliasStore.delete([collectionId, alias.providerId]);
      await removeTranscript(tx, id);
      const drafts = tx.objectStore('drafts');
      for (const draft of await drafts.getAll()) {
        let dirty = false;
        draft.evidence = draft.evidence.map((entry) => {
          if (entry.conversationId === id || (!entry.conversationId && draft.collectionId === collectionId
            && ids.has(sourceProvider(entry.sourceUrl) ?? ''))) {
            dirty = true;
            return { ...entry, text: '', activity: undefined, unavailable: true };
          }
          return entry;
        });
        if (dirty) await drafts.put(draft);
      }
      return { value: undefined, archiveRevision: await bumpRevision(tx, [id]) };
    });
  }

  async storageStatus() {
    const summary = await this.read(async (tx) => {
      const [conversations, saved, drafts, all] = await Promise.all([
        conversationRows(tx, this.clock()), savedRows(tx),
        tx.objectStore('drafts').getAll().then((items) => onlyVisible(tx, items)),
        tx.objectStore('conversations').getAll().then((items) => onlyVisible(tx, items)),
      ]);
      return { conversations: conversations.length, saved: saved.length, drafts: drafts.length, pendingCleanup: all.length - conversations.length };
    });
    const bin = typeof navigator === 'undefined' ? undefined : await navigator.storage?.estimate().catch(() => undefined);
    return { ...summary, bytes: bin?.usage, quota: bin?.quota };
  }

  cleanup(): Promise<number> {
    return this.write(async (tx) => {
      const now = this.clock();
      const collections = new Map((await collectionRows(tx)).map((entry) => [entry.id, entry]));
      const all = await onlyVisible(tx, await tx.objectStore('conversations').getAll());
      const expired = all.filter((row) => {
        const collection = collections.get(row.collectionId);
        return collection && expire(row, collection, now);
      });
      const drafts = expired.length ? await onlyVisible(tx, await tx.objectStore('drafts').getAll()) : [];
      const referenceIds = new Set(drafts.flatMap((draft) => draft.evidence.flatMap((entry) => entry.conversationId ? [entry.conversationId] : [])));
      const ids: string[] = [];
      const aliases = tx.objectStore('aliases');
      for (const row of expired) {
        if (await tx.objectStore('importLocks').get(row.id)) continue;
        await removeTranscript(tx, row.id);
        if (!referenceIds.has(row.id) && !(await tx.objectStore('saved').index('conversation').getKey(row.id))) {
          for (const key of await aliases.index('conversation').getAllKeys(row.id)) await aliases.delete(key);
        }
        ids.push(row.id);
        if (ids.length >= 24) break;
      }
      const receipts = tx.objectStore('receipts');
      const outdated = await receipts.index('time').getAllKeys(IDBKeyRange.upperBound(now - 7 * 86_400_000), 128);
      for (const key of outdated) await receipts.delete(key);
      return { value: ids.length, archiveRevision: ids.length ? await bumpRevision(tx, ids) : undefined };
    });
  }

  clearAll(): Promise<void> {
    return this.write(async (tx) => {
      const previous = await settings(tx);
      for (const table of archiveStores) {
        if (table !== 'meta') await tx.objectStore(table).clear();
      }
      await tx.objectStore('meta').put({ key: 'settings', value: { ...DEFAULT_SETTINGS, generation: previous.generation + 1 } });
      return { value: undefined, archiveRevision: await bumpRevision(tx, [], true) };
    });
  }

  makeBackup(collectionIds?: string[]) {
    return this.read((tx) => backupRows(tx, this.clock(), collectionIds));
  }

  async previewImport(input: unknown) {
    return previewEnvelope(validateEnvelope(input));
  }

  startImport(input: unknown, destinationCollectionId?: string): Promise<ImportJob> {
    const envelope = validateEnvelope(input);
    return this.write(async (tx) => ({ value: await addImport(tx, envelope, this.clock(), destinationCollectionId ?? undefined) }));
  }

  resumeImport(id: string): Promise<ImportJob> {
    const jobId = token(id);
    return this.write(async (tx) => await resumeRestore(tx, jobId, this.clock())).catch(async (error: unknown) => {
      return this.write(async (tx) => {
        const store = tx.objectStore('jobs');
        const row = await store.get(jobId);
        if (!row || row.state === 'complete') throw error;
        row.state = 'failed';
        row.error = error instanceof Error ? error.message : 'Restore could not continue.';
        await store.put(row);
        return { value: await listImports(tx).then((items) => items.find((item) => item.id === row.id)!) };
      });
    });
  }

  listJobs(): Promise<ImportJob[]> {
    return this.read(listImports);
  }

  removeImport(id: string): Promise<void> {
    return this.write(async (tx) => await removeRestore(tx, token(id)));
  }
}

export async function openArchive(name?: string, clock?: () => number): Promise<ArchiveRepository> {
  return new ArchiveRepository(await connectArchive(name), clock);
}
