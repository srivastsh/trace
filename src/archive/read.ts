import { clean, expire, onlyVisible, revisionMeta, visible, type ArchiveRead } from './database';
import type { CaptureSegment, Collection, Conversation, ConversationView, MessageRevision, SavedItem, SearchDocument } from './types';

export async function getCollection(tx: ArchiveRead, id: string): Promise<Collection | undefined> {
  const item = await tx.objectStore('collections').get(id);
  return item && await visible(tx, item) ? clean(item) : undefined;
}

export async function collectionRows(tx: ArchiveRead): Promise<Collection[]> {
  return onlyVisible(tx, await tx.objectStore('collections').getAll());
}

export async function conversationRows(tx: ArchiveRead, now: number, collectionId?: string): Promise<Conversation[]> {
  const collections = new Map((await collectionRows(tx)).map((entry) => [entry.id, entry]));
  const store = tx.objectStore('conversations');
  const rows = collectionId === undefined ? await store.getAll() : await store.index('collection').getAll(collectionId);
  const live = await onlyVisible(tx, rows);
  return live.filter((row) => {
    const collection = collections.get(row.collectionId);
    return collection && !expire(row, collection, now);
  }).sort((a, b) => b.lastObservedAt - a.lastObservedAt);
}

export async function savedRows(tx: ArchiveRead, collectionId?: string): Promise<SavedItem[]> {
  const store = tx.objectStore('saved');
  return onlyVisible(tx, collectionId === undefined ? await store.getAll() : await store.index('collection').getAll(collectionId));
}

export async function conversationView(
  tx: ArchiveRead, id: string, now: number, segmentId?: string,
): Promise<ConversationView | undefined> {
  const store = tx.objectStore('conversations');
  const [row, saved] = await Promise.all([
    store.get(id),
    tx.objectStore('saved').index('conversation').getAll(id).then((items) => onlyVisible(tx, items)),
  ]);
  const current = row && await visible(tx, row) ? clean(row) : undefined;
  const collectionId = current?.collectionId ?? saved.at(0)?.collectionId;
  if (!collectionId) return undefined;
  const collection = await getCollection(tx, collectionId);
  if (!collection) return undefined;
  const expired = !current || expire(current, collection, now);
  const seed = saved.at(0);
  if (expired && !seed) return undefined;
  const conversation = current ?? {
    id, collectionId, providerId: '', title: seed!.title, sourceUrl: seed!.sourceUrl,
    firstObservedAt: seed!.capturedAt, lastObservedAt: seed!.capturedAt, segmentId: null, coverage: seed!.coverage,
  };
  const segments = expired ? [] : await onlyVisible(tx, await tx.objectStore('segments').index('conversation').getAll(id));
  segments.sort((a, b) => b.observedAt - a.observedAt);
  const selection = segmentId ?? conversation.segmentId;
  const segment = segments.find((entry) => entry.id === selection) ?? (segmentId === undefined ? segments.at(0) : undefined) ?? null;
  const messages: MessageRevision[] = [];
  if (segment) {
    const store = tx.objectStore('revisions');
    const revisions = await Promise.all(segment.revisions.map((ref) => store.get(ref.revisionId)));
    const loaded = await onlyVisible(tx, revisions.filter((row) => row !== undefined));
    messages.push(...loaded.filter((row) => row.conversationId === id));
  }
  return { conversation, collection, segments, segment, messages, saved, expired };
}

function fromSaved(item: SavedItem): SearchDocument {
  return {
    id: 's:' + item.id, conversationId: item.conversationId, collectionId: item.collectionId,
    title: item.title, text: item.text, tags: item.tags, note: item.note, role: item.role,
    reportedModel: item.activity?.model?.value ?? null, capturedAt: item.capturedAt,
    updatedAt: item.updatedAt, saved: true, coverage: item.coverage, revisionId: item.revisionId, savedId: item.id,
  };
}

interface Context {
  conversation: Conversation;
  segmentByRevision: Map<string, CaptureSegment>;
}

async function searchContext(tx: ArchiveRead, id: string, now: number): Promise<Context | undefined> {
  const conversation = await tx.objectStore('conversations').get(id);
  if (!conversation || !(await visible(tx, conversation))) return undefined;
  const collection = await getCollection(tx, conversation.collectionId);
  if (!collection || expire(conversation, collection, now)) return undefined;
  const segments = await onlyVisible(tx, await tx.objectStore('segments').index('conversation').getAll(id));
  segments.sort((a, b) => Number(b.id === conversation.segmentId) - Number(a.id === conversation.segmentId) || b.observedAt - a.observedAt);
  const segmentByRevision = new Map<string, CaptureSegment>();
  for (const segment of segments) {
    for (const ref of segment.revisions) {
      if (!segmentByRevision.has(ref.revisionId)) segmentByRevision.set(ref.revisionId, segment);
    }
  }
  return { conversation, segmentByRevision };
}

function fromRevision(revision: MessageRevision, context: Context): SearchDocument {
  const { conversation } = context;
  const segment = context.segmentByRevision.get(revision.id);
  return {
    id: 'r:' + revision.id, conversationId: conversation.id, collectionId: conversation.collectionId,
    title: conversation.title, text: revision.text, tags: [], note: '', role: revision.role,
    reportedModel: revision.activity?.model?.value ?? null, capturedAt: revision.observedAt,
    updatedAt: conversation.lastObservedAt, saved: false,
    coverage: segment?.coverage ?? { state: 'unknown', reason: 'No selected segment contains this revision.' },
    segmentId: segment?.id, revisionId: revision.id,
  };
}

export async function searchPageRows(tx: ArchiveRead, now: number, after: string | undefined, limit: number) {
  const archiveRevision = (await revisionMeta(tx)).number;
  const documents: SearchDocument[] = [];
  const cache = new Map<string, Promise<Context | undefined>>();
  let cursorToken: string | null = null;
  let scanned = 0;
  const scanLimit = Math.max(limit * 2, 32);
  if (!after?.startsWith('s:')) {
    const store = tx.objectStore('revisions');
    let cursor = await store.openCursor(after?.startsWith('r:') ? IDBKeyRange.lowerBound(after.slice(2), true) : undefined);
    while (cursor) {
      const row = cursor.value;
      if (await visible(tx, row)) {
        let context = cache.get(row.conversationId);
        if (!context) {
          context = searchContext(tx, row.conversationId, now);
          cache.set(row.conversationId, context);
        }
        const match = await context;
        if (match) documents.push(fromRevision(row, match));
      }
      cursorToken = 'r:' + cursor.primaryKey;
      scanned++;
      if (documents.length >= limit || scanned >= scanLimit) return { archiveRevision, next: cursorToken, documents };
      cursor = await cursor.continue();
    }
  }
  const store = tx.objectStore('saved');
  let cursor = await store.openCursor(after?.startsWith('s:') ? IDBKeyRange.lowerBound(after.slice(2), true) : undefined);
  while (cursor) {
    if (await visible(tx, cursor.value)) documents.push(fromSaved(cursor.value));
    cursorToken = 's:' + cursor.primaryKey;
    scanned++;
    if (documents.length >= limit || scanned >= scanLimit) return { archiveRevision, next: cursorToken, documents };
    cursor = await cursor.continue();
  }
  return { archiveRevision, next: null, documents };
}

export async function hydrateRows(tx: ArchiveRead, now: number, ids: string[], collectionId?: string) {
  const archiveRevision = (await revisionMeta(tx)).number;
  const cache = new Map<string, Promise<Context | undefined>>();
  const documents: SearchDocument[] = [];
  for (const id of ids) {
    if (id.startsWith('s:')) {
      const item = await tx.objectStore('saved').get(id.slice(2));
      if (item && (collectionId === undefined || item.collectionId === collectionId) && await visible(tx, item)) {
        documents.push(fromSaved(item));
      }
    } else if (id.startsWith('r:')) {
      const item = await tx.objectStore('revisions').get(id.slice(2));
      if (!item || !(await visible(tx, item))) continue;
      let context = cache.get(item.conversationId);
      if (!context) {
        context = searchContext(tx, item.conversationId, now);
        cache.set(item.conversationId, context);
      }
      const current = await context;
      if (current && (collectionId === undefined || current.conversation.collectionId === collectionId)) {
        documents.push(fromRevision(item, current));
      }
    }
  }
  return { archiveRevision, documents };
}

export async function searchByConversation(tx: ArchiveRead, now: number, ids: string[], collectionId?: string) {
  const archiveRevision = (await revisionMeta(tx)).number;
  const documents: SearchDocument[] = [];
  for (const id of ids) {
    const context = await searchContext(tx, id, now);
    if (context && (collectionId === undefined || context.conversation.collectionId === collectionId)) {
      for (const revision of await onlyVisible(tx, await tx.objectStore('revisions').index('conversation').getAll(id))) {
        documents.push(fromRevision(revision, context));
      }
    }
    for (const item of await onlyVisible(tx, await tx.objectStore('saved').index('conversation').getAll(id))) {
      if (collectionId === undefined || item.collectionId === collectionId) documents.push(fromSaved(item));
    }
  }
  return { archiveRevision, documents };
}
