import type { CapturedMessage, Projection } from '../contracts';
import { proveBranch } from './backup';
import { bumpRevision, clean, expire, onlyVisible, visible, type ArchiveTx } from './database';
import type {
  CaptureSegment, Collection, Conversation, Message, MessageRevision, RevisionReference, SavedItem,
} from './types';
import { fail, validateNoteFields } from './validation';

export const unknownCoverage = { state: 'unknown', reason: 'The captured text does not establish full branch coverage.' } as const;

export async function lookup(tx: ArchiveTx, collectionId: string, providerId: string) {
  const alias = await tx.objectStore('aliases').get([collectionId, providerId]);
  if (alias && !(await visible(tx, alias))) fail('A restore is still importing this conversation.');
  return alias;
}

export async function promote(
  tx: ArchiveTx, collectionId: string, providerId: string, aliasFrom: string,
): Promise<string | undefined> {
  const old = await lookup(tx, collectionId, aliasFrom);
  const canonical = await lookup(tx, collectionId, providerId);
  if (old) await ensureUnlocked(tx, old.conversationId);
  if (canonical) await ensureUnlocked(tx, canonical.conversationId);
  const id = old?.conversationId ?? canonical?.conversationId;
  const exclusions = tx.objectStore('exclusions');
  const excluded = await Promise.all([exclusions.get([collectionId, aliasFrom]), exclusions.get([collectionId, providerId])]);
  if (excluded.some(Boolean)) await applyExclusions(tx, collectionId, [aliasFrom, providerId], true);
  if (!id) return undefined;
  if (canonical && canonical.conversationId !== id) {
    const source = canonical.conversationId;
    const allAliases = await tx.objectStore('aliases').index('conversation').getAll(source);
    for (const alias of allAliases) await tx.objectStore('aliases').put({ ...alias, conversationId: id });
    const revisions = tx.objectStore('revisions');
    const existingByMessage = new Map<string, MessageRevision[]>();
    for (const row of await revisions.index('conversation').getAll(id)) {
      const variants = existingByMessage.get(row.messageId) ?? [];
      variants.push(row);
      existingByMessage.set(row.messageId, variants);
    }
    const movedIds = new Map<string, string>();
    for (const row of await revisions.index('conversation').getAll(source)) {
      const variants = existingByMessage.get(row.messageId) ?? [];
      if (variants.some((variant) => variant.role !== row.role)) fail('The proposed aliases have conflicting message roles.');
      const same = variants.find((variant) => sameRevision(variant, row) && sameRevision(row, variant));
      movedIds.set(row.id, same?.id ?? row.id);
      if (same) await revisions.delete(row.id);
      else await revisions.put({ ...row, conversationId: id });
    }
    const segments = tx.objectStore('segments');
    for (const item of await segments.index('conversation').getAll(source)) {
      const refs = item.revisions.map((ref) => ({ ...ref, revisionId: movedIds.get(ref.revisionId) ?? ref.revisionId }));
      await segments.put({ ...item, conversationId: id, revisions: refs });
    }
    const saved = tx.objectStore('saved');
    for (const item of await saved.index('conversation').getAll(source)) {
      await saved.put({ ...item, conversationId: id, revisionId: movedIds.get(item.revisionId) ?? item.revisionId });
    }
    const receipts = tx.objectStore('receipts');
    for (const item of await receipts.index('conversation').getAll(source)) {
      await receipts.put({ ...item, conversationId: id });
    }
    const messages = tx.objectStore('messages');
    for (const item of await messages.index('conversation').getAll(source)) {
      const existing = await messages.get([id, item.id]);
      const [prior, incoming] = await Promise.all([
        existing ? tx.objectStore('revisions').get(existing.currentRevisionId) : undefined,
        tx.objectStore('revisions').get(movedIds.get(item.currentRevisionId) ?? item.currentRevisionId),
      ]);
      if (!prior || (incoming && (incoming.observedAt > prior.observedAt
        || (incoming.final && !prior.final)))) {
        await messages.put({ ...item, conversationId: id, currentRevisionId: movedIds.get(item.currentRevisionId) ?? item.currentRevisionId });
      }
      await messages.delete([source, item.id]);
    }
    for (const draft of await tx.objectStore('drafts').getAll()) {
      if (draft.evidence.some((entry) => entry.conversationId === source)) {
        draft.evidence = draft.evidence.map((entry) => entry.conversationId === source ? {
          ...entry, conversationId: id, revisionId: entry.revisionId ? movedIds.get(entry.revisionId) ?? entry.revisionId : undefined,
        } : entry);
        await tx.objectStore('drafts').put(draft);
      }
    }
    const archive = tx.objectStore('conversations');
    const [before, merged] = await Promise.all([archive.get(id), archive.get(source)]);
    if (merged) {
      const previous = before && before.lastObservedAt > merged.lastObservedAt ? before : merged;
      await archive.put({ ...previous, id, firstObservedAt: Math.min(before?.firstObservedAt ?? Infinity, merged.firstObservedAt) });
    }
    await archive.delete(source);
    await bumpRevision(tx, [source, id]);
  }
  await tx.objectStore('aliases').put({ collectionId, providerId, conversationId: id });
  await tx.objectStore('aliases').put({ collectionId, providerId: aliasFrom, conversationId: id });
  return id;
}

function captureIds(projection: Projection, sourceKey: string): Projection {
  const names = new Map(projection.messages.filter((row) => row.provisional)
    .map((row) => [row.id, 'provisional:' + sourceKey + ':' + row.id]));
  return {
    ...projection,
    leafId: projection.leafId === undefined ? undefined : names.get(projection.leafId) ?? projection.leafId,
    messages: projection.messages.map((row) => ({
      ...row,
      id: names.get(row.id) ?? row.id,
      parentId: typeof row.parentId === 'string' ? names.get(row.parentId) ?? row.parentId : row.parentId,
    })),
  };
}

export function sameRevision(before: MessageRevision, after: MessageRevision): boolean {
  return before.role === after.role && before.text === after.text && before.final === after.final
    && before.provisional === after.provisional && before.parentId === after.parentId
    && (!after.activity || JSON.stringify(before.activity) === JSON.stringify(after.activity));
}

async function upsertMessage(
  tx: ArchiveTx, conversationId: string, input: CapturedMessage, projection: Projection,
): Promise<MessageRevision> {
  const store = tx.objectStore('messages');
  const revisions = tx.objectStore('revisions');
  const message = await store.get([conversationId, input.id]);
  const current = message && await revisions.get(message.currentRevisionId);
  if (current && current.role !== input.role) fail('Conflicting roles for a Trace message.');
  if (input.parentId === input.id) fail('Invalid self-parenting message.');
  const next: MessageRevision = {
    id: crypto.randomUUID(), conversationId, messageId: input.id, role: input.role,
    text: input.text, provisional: input.provisional, parentId: input.parentId ?? (input.parentId === null ? null : current?.parentId),
    source: projection.source, adapterVersion: projection.adapterVersion, observedAt: input.observedAt,
    final: input.final, activity: input.activity,
  };
  if (current && sameRevision(current, next)) return clean(current);
  await revisions.add(next);
  if (!current || (next.final && !current.final) || (next.final === current.final && next.observedAt >= current.observedAt)) {
    const update: Message = {
      conversationId, id: input.id, parentId: next.parentId, provisional: next.provisional, role: input.role, currentRevisionId: next.id,
    };
    await store.put(update);
  }
  return next;
}

async function historyChain(
  tx: ArchiveTx, conversationId: string, leafId: string, observed: MessageRevision[],
): Promise<MessageRevision[]> {
  const incoming = new Map(observed.map((row) => [row.messageId, row]));
  const seen = new Set<string>();
  const chain: MessageRevision[] = [];
  let next: string | null | undefined = leafId;
  while (next && !seen.has(next) && chain.length < 50_000) {
    seen.add(next);
    let revision = incoming.get(next);
    if (!revision) {
      const message = await tx.objectStore('messages').get([conversationId, next]);
      const stored = message && await tx.objectStore('revisions').get(message.currentRevisionId);
      if (stored && await visible(tx, stored)) revision = clean(stored);
    }
    if (!revision) break;
    chain.push(revision);
    next = revision.parentId;
  }
  return chain.reverse();
}

function segmentSignature(segment: CaptureSegment): string {
  return JSON.stringify([segment.source, segment.leafId, segment.coverage, segment.revisions]);
}

function newCaptureSegment(
  conversationId: string, projection: Projection, observed: MessageRevision[], chain: MessageRevision[], selected: boolean,
): CaptureSegment {
  const sourceHasExactChain = projection.source === 'history'
    && proveBranch(chain, projection.leafId)
    && projection.messages.every((row, index) => row.final && !row.provisional
      && row.parentId === (index === 0 ? null : projection.messages[index - 1]?.id))
    && chain.length === observed.length
    && chain.every((row, index) => row.id === observed[index]?.id);
  let coverage = projection.coverage;
  if (selected) {
    coverage = { state: 'partial', reason: 'Selected messages from the observed branch or segment.' };
  } else if (coverage.state === 'complete' && !sourceHasExactChain) {
    coverage = { state: 'partial', reason: 'The observed revisions do not prove a finalized branch from its root.' };
  }
  if (coverage.state === 'unknown' && projection.source === 'history' && !sourceHasExactChain) {
    coverage = { state: 'partial', reason: 'Only part of the branch was observed.' };
  }
  const revisions = (chain.length ? chain : observed)
    .map((row): RevisionReference => ({ messageId: row.messageId, revisionId: row.id }));
  return {
    id: crypto.randomUUID(), conversationId, selectionId: projection.selectionId, source: projection.source,
    leafId: selected ? undefined : projection.leafId, revisions, coverage,
    observedAt: projection.observedAt, adapterVersion: projection.adapterVersion,
  };
}

export interface CaptureResult {
  conversationId: string;
  segmentId: string | null;
  savedIds: string[];
  duplicate: boolean;
}

export interface BookmarkOptions {
  title?: string;
  label?: string;
  note?: string;
  tags?: string[];
}

export function makeSaved(
  conversation: Conversation, message: MessageRevision, options: BookmarkOptions, now: number,
): SavedItem {
  return {
    id: crypto.randomUUID(), conversationId: conversation.id, collectionId: conversation.collectionId,
    revisionId: message.id, messageId: message.messageId, role: message.role, text: message.text,
    title: conversation.title, sourceUrl: conversation.sourceUrl, coverage: conversation.coverage,
    activity: message.activity, ...validateNoteFields(options), capturedAt: message.observedAt, createdAt: now, updatedAt: now,
  };
}

export async function applyExclusions(tx: ArchiveTx, collectionId: string, providerIds: string[], excluded: boolean): Promise<void> {
  const store = tx.objectStore('exclusions');
  const ids = new Set(providerIds);
  const groups = new Set<string>();
  for (const id of ids) {
    const result = await store.get([collectionId, id]);
    if (result?.groupId) groups.add(result.groupId);
  }
  for (const groupId of groups) {
    for (const alias of await store.index('group').getAll(groupId)) {
      if (alias.collectionId === collectionId) ids.add(alias.providerId);
    }
  }
  const groupId = ids.size > 1 ? groups.values().next().value ?? crypto.randomUUID() : undefined;
  for (const providerId of ids) {
    if (excluded) await store.put({ collectionId, providerId, groupId });
    else await store.delete([collectionId, providerId]);
  }
}

export async function ensureUnlocked(tx: ArchiveTx, id: string): Promise<void> {
  if (await tx.objectStore('importLocks').get(id)) fail('A restore is still importing this conversation.');
}

export async function persistProjection(
  tx: ArchiveTx,
  collection: Collection,
  projectionInput: Projection,
  sourceKey: string,
  receiptKey: string,
  now: number,
  selectedMessageIds?: string[],
  bookmark?: BookmarkOptions,
): Promise<{ result: CaptureResult; archiveRevision?: number }> {
  const receipts = tx.objectStore('receipts');
  const prior = await receipts.get(receiptKey);
  if (prior) return { result: { conversationId: prior.conversationId, segmentId: prior.segmentId, savedIds: prior.savedIds, duplicate: true } };
  const requested = selectedMessageIds && new Set(selectedMessageIds);
  if (requested?.size && (!projectionInput.messages.some((row) => requested.has(row.id))
    || projectionInput.messages.filter((row) => requested.has(row.id)).length !== requested.size)) {
    fail('The reviewed selection changed.');
  }
  if (requested && !requested.size) fail('Select at least one message.');
  if (!projectionInput.messages.length) fail('No supported messages were observed.');
  const projection = captureIds({
    ...projectionInput,
    messages: requested ? projectionInput.messages.filter((row) => requested.has(row.id)) : projectionInput.messages,
  }, sourceKey);

  const alias = await lookup(tx, collection.id, projection.providerId);
  const aliasFrom = projection.aliasFrom && projection.aliasFrom !== projection.providerId ? projection.aliasFrom : undefined;
  const existingId = aliasFrom ? await promote(tx, collection.id, projection.providerId, aliasFrom) : alias?.conversationId;
  const conversationId = existingId ?? crypto.randomUUID();
  if (existingId) await ensureUnlocked(tx, conversationId);
  const archive = tx.objectStore('conversations');
  let previous = await archive.get(conversationId);
  if (previous && expire(previous, collection, now)) {
    await removeTranscript(tx, conversationId);
    previous = undefined;
  }
  await tx.objectStore('aliases').put({ collectionId: collection.id, providerId: projection.providerId, conversationId });
  if (aliasFrom) await tx.objectStore('aliases').put({ collectionId: collection.id, providerId: aliasFrom, conversationId });

  const observed: MessageRevision[] = [];
  for (const message of projection.messages) observed.push(await upsertMessage(tx, conversationId, message, projection));
  const chain = !requested && projection.source === 'history' && projection.leafId
    ? await historyChain(tx, conversationId, projection.leafId, observed) : [];
  const segment = newCaptureSegment(conversationId, projection, observed, chain, !!requested);
  const segments = tx.objectStore('segments');
  const candidateSegments = await segments.index('conversation').getAll(conversationId);
  const oldSegments = await onlyVisible(tx, candidateSegments);
  const sameOrigin = new Set(candidateSegments.filter((row) => row.localOrigin === sourceKey).map((row) => row.id));
  const priorSegment = oldSegments.find((row) => sameOrigin.has(row.id)
    && row.selectionId === segment.selectionId && segmentSignature(row) === segmentSignature(segment));
  const retainedSegment = priorSegment ?? segment;
  if (!priorSegment) await segments.add({ ...segment, localOrigin: sourceKey });

  const selectedIds = new Set(retainedSegment.revisions.map((row) => row.revisionId));
  for (const row of observed) {
    if (selectedIds.has(row.id) || oldSegments.some((entry) => entry.revisions.some((ref) => ref.revisionId === row.id))) continue;
    const standalone: CaptureSegment = {
      id: crypto.randomUUID(), conversationId, source: projection.source, selectionId: projection.selectionId,
      coverage: { state: 'unknown', reason: 'This observed revision could not be placed on the selected branch.' },
      observedAt: projection.observedAt, adapterVersion: projection.adapterVersion,
      revisions: [{ messageId: row.messageId, revisionId: row.id }],
    };
    await segments.add({ ...standalone, localOrigin: sourceKey });
  }

  const currentSegment = oldSegments.find((row) => row.id === previous?.segmentId);
  const updateHint = !previous || (projection.observedAt >= previous.lastObservedAt
    && (currentSegment?.coverage.state !== 'complete' || retainedSegment.coverage.state === 'complete'
      || currentSegment.leafId !== retainedSegment.leafId));
  const canonicalAlias = previous && previous.providerId !== projection.providerId && !aliasFrom ? previous : undefined;
  const conversation: Conversation = {
    id: conversationId, collectionId: collection.id,
    providerId: canonicalAlias ? canonicalAlias.providerId : projection.providerId,
    title: projection.title || previous?.title || 'Untitled conversation',
    sourceUrl: canonicalAlias ? canonicalAlias.sourceUrl : projection.sourceUrl || previous?.sourceUrl || '',
    firstObservedAt: Math.min(previous?.firstObservedAt ?? now, Math.min(projection.observedAt, now)),
    lastObservedAt: Math.max(previous?.lastObservedAt ?? 0, Math.min(projection.observedAt, now)),
    segmentId: updateHint ? retainedSegment.id : previous?.segmentId ?? null,
    coverage: updateHint ? retainedSegment.coverage : previous?.coverage ?? unknownCoverage,
  };
  await archive.put(conversation);
  const savedIds: string[] = [];
  if (bookmark) {
    for (const message of observed) {
      const item = makeSaved({ ...conversation, coverage: retainedSegment.coverage }, message, bookmark, now);
      await tx.objectStore('saved').add(item);
      savedIds.push(item.id);
    }
  }
  const result = { conversationId, segmentId: retainedSegment.id, savedIds, duplicate: false };
  await receipts.put({ key: receiptKey, conversationId, segmentId: retainedSegment.id, savedIds, observedAt: now });
  return { result, archiveRevision: await bumpRevision(tx, [conversationId]) };
}

export async function removeTranscript(tx: ArchiveTx, id: string): Promise<void> {
  for (const name of ['revisions', 'segments', 'messages', 'receipts'] as const) {
    const store = tx.objectStore(name);
    for (const key of await store.index('conversation').getAllKeys(id)) await store.delete(key);
  }
  await tx.objectStore('conversations').delete(id);
}
