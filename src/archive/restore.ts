import {
  bumpRevision, importedStores, onlyVisible, settings, visible, type ArchiveRead, type ArchiveTx,
  type ImportUnit, type StoredJob,
} from './database';
import { sameRevision } from './merge';
import { collectionRows, conversationRows, getCollection, savedRows } from './read';
import type {
  BackupCollection, BackupConversation, CaptureSegment, HandoffDraft, HandoffEvidence, ImportJob, Message, MessageRevision, SavedItem, TraceEnvelope,
} from './types';
import { fail, token } from './validation';

function publicJob(job: StoredJob): ImportJob {
  return { id: job.id, state: job.state, processed: job.processed, total: job.total, createdAt: job.createdAt, error: job.error };
}

export async function listImports(tx: ArchiveRead): Promise<ImportJob[]> {
  return (await tx.objectStore('jobs').getAll()).sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
}

export async function backupRows(tx: ArchiveRead, now: number, input?: string[]): Promise<TraceEnvelope> {
  const selected = input && new Set(input.map(token));
  const collections = (await collectionRows(tx)).filter((entry) => !selected || selected.has(entry.id))
    .map(({ id, label, retention }) => ({ id, label, retention }));
  const chosen = new Set(collections.map(({ id }) => id));
  const rows = (await conversationRows(tx, now)).filter((entry) => chosen.has(entry.collectionId));
  const conversations: BackupConversation[] = [];
  for (const conversation of rows) {
    const [aliases, segments, revisions] = await Promise.all([
      tx.objectStore('aliases').index('conversation').getAll(conversation.id).then((records) => onlyVisible(tx, records)),
      tx.objectStore('segments').index('conversation').getAll(conversation.id).then((records) => onlyVisible(tx, records)),
      tx.objectStore('revisions').index('conversation').getAll(conversation.id).then((records) => onlyVisible(tx, records)),
    ]);
    conversations.push({ conversation, aliases: [...new Set([conversation.providerId, ...aliases.map((alias) => alias.providerId)])], segments, revisions });
  }
  const saved = (await savedRows(tx)).filter((entry) => chosen.has(entry.collectionId));
  const drafts = (await onlyVisible(tx, await tx.objectStore('drafts').getAll())).filter((entry) => chosen.has(entry.collectionId));
  return {
    format: 'trace', version: 1, kind: 'backup', exportedAt: now, collections, conversations, saved, drafts,
    preferences: { contextAlert: (await settings(tx)).contextAlert },
  };
}

function conversationUnits(source: BackupConversation): ImportUnit[] {
  const { conversation, aliases, revisions, segments } = source;
  const units: ImportUnit[] = [{ kind: 'prepare', record: { conversation, aliases } }];
  let records: MessageRevision[] = [];
  let characters = 0;
  for (const revision of revisions) {
    records.push(revision);
    characters += revision.text.length;
    if (records.length === 96 || characters >= 384 * 1024) {
      units.push({ kind: 'revisions', conversationId: conversation.id, records });
      records = [];
      characters = 0;
    }
  }
  if (records.length) units.push({ kind: 'revisions', conversationId: conversation.id, records });
  for (let i = 0; i < segments.length; i += 8) {
    units.push({ kind: 'segments', conversationId: conversation.id, records: segments.slice(i, i + 8) });
  }
  units.push({ kind: 'finish', conversationId: conversation.id, segmentId: conversation.segmentId });
  return units;
}

export async function addImport(tx: ArchiveTx, envelope: TraceEnvelope, now: number, destinationId?: string): Promise<ImportJob> {
  if (destinationId !== undefined && !(await getCollection(tx, token(destinationId)))) fail('Destination collection unavailable.');
  const jobs = tx.objectStore('jobs');
  if ((await jobs.getAll()).some((job) => job.state !== 'complete')) {
    fail('Finish or remove the incomplete restore before starting another.');
  }
  const units: ImportUnit[] = [
    ...envelope.collections.map((record): ImportUnit => ({ kind: 'collection', record })),
    ...envelope.conversations.flatMap(conversationUnits),
    ...envelope.saved.map((record): ImportUnit => ({ kind: 'saved', record })),
    ...envelope.drafts.map((record): ImportUnit => ({ kind: 'draft', record })),
  ];
  const job: StoredJob = {
    id: crypto.randomUUID(), state: 'pending', processed: 0, total: units.length, createdAt: now,
    destinationId, contextAlert: envelope.preferences?.contextAlert,
  };
  await jobs.add(job);
  const payloads = tx.objectStore('importPayloads');
  await Promise.all(units.map((unit, index) => payloads.add(unit, [job.id, index])));
  return publicJob(job);
}

function readMap(tx: ArchiveTx, job: StoredJob, kind: string, source: string) {
  return tx.objectStore('importMap').get([job.id, kind, source]);
}

function mapId(tx: ArchiveTx, job: StoredJob, kind: string, source: string, local: string) {
  return tx.objectStore('importMap').put(local, [job.id, kind, source]);
}

async function mapCollection(tx: ArchiveTx, job: StoredJob, source: BackupCollection): Promise<void> {
  if (job.destinationId) {
    if (!(await getCollection(tx, job.destinationId))) fail('Destination collection unavailable.');
    await mapId(tx, job, 'collection', source.id, job.destinationId);
    return;
  }
  const id = source.id.startsWith('restored:') ? source.id : 'restored:' + source.id;
  const store = tx.objectStore('collections');
  if (!(await store.get(id))) {
    await store.add({ id, label: source.label, retention: source.retention, mode: 'manual', autoExcluded: false,
      autoConsent: false, createdAt: job.createdAt, jobId: job.id });
  }
  await mapId(tx, job, 'collection', source.id, id);
}

async function lockConversation(tx: ArchiveTx, job: StoredJob, conversationId: string): Promise<void> {
  const locks = tx.objectStore('importLocks');
  const old = await locks.get(conversationId);
  if (old && old.jobId !== job.id) fail('Another restore is already using this conversation.');
  if (!old) await locks.add({ conversationId, jobId: job.id });
}

async function prepareConversation(tx: ArchiveTx, job: StoredJob, input: Pick<BackupConversation, 'conversation' | 'aliases'>): Promise<void> {
  const source = input.conversation;
  const collectionId = await readMap(tx, job, 'collection', source.collectionId) ?? fail('Missing import collection.');
  const providerUrl = source.sourceUrl.match(/\/c\/([A-Za-z0-9_-]+)\/?$/u)?.[1];
  const stable = providerUrl === source.providerId && !source.providerId.startsWith('local:');
  const providerId = stable ? source.providerId : 'local:' + crypto.randomUUID();
  const importedAliases = stable ? input.aliases.filter((alias) => !alias.startsWith('local:')) : [providerId];
  const aliases = tx.objectStore('aliases');
  const priorAliases = (await Promise.all(importedAliases.map((alias) => aliases.get([collectionId, alias]))))
    .filter((item) => item !== undefined);
  const priorIds = new Set(priorAliases.map((alias) => alias.conversationId));
  if (priorIds.size > 1) fail('Imported aliases refer to different saved conversations.');
  const id = priorAliases.at(0)?.conversationId ?? crypto.randomUUID();
  await lockConversation(tx, job, id);
  await mapId(tx, job, 'conversation', source.id, id);
  const store = tx.objectStore('conversations');
  if (!(await store.get(id))) {
    await store.add({ ...source, id, collectionId, providerId, segmentId: null, jobId: job.id });
  }
  for (const alias of importedAliases) {
    if (!priorAliases.some((entry) => entry.providerId === alias)) {
      await aliases.add({ collectionId, providerId: alias, conversationId: id, jobId: job.id });
    }
  }
}

async function importRevisions(tx: ArchiveTx, job: StoredJob, sourceId: string, records: MessageRevision[]): Promise<void> {
  const id = await readMap(tx, job, 'conversation', sourceId) ?? fail('Missing import conversation.');
  const store = tx.objectStore('revisions');
  const messages = tx.objectStore('messages');
  for (const original of records) {
    const variants = await store.index('message').getAll([id, original.messageId]);
    const usable = [];
    for (const row of variants) {
      if (row.jobId === job.id || await visible(tx, row)) usable.push(row);
    }
    if (usable.some((row) => row.role !== original.role)) fail('A restored message conflicts with the existing message role.');
    const next: MessageRevision = { ...original, conversationId: id };
    const same = usable.find((row) => sameRevision(row, next));
    if (same) {
      await mapId(tx, job, 'revision', original.id, same.id);
      continue;
    }
    if (await store.get(next.id)) next.id = crypto.randomUUID();
    await store.add({ ...next, jobId: job.id });
    await mapId(tx, job, 'revision', original.id, next.id);
    const message = await messages.get([id, next.messageId]);
    const staged = message?.jobId === job.id && await store.get(message.currentRevisionId);
    if (!message || (staged && ((next.final && !staged.final)
      || (next.final === staged.final && next.observedAt >= staged.observedAt)))) {
      const item: Message = {
        conversationId: id, id: next.messageId, parentId: next.parentId, role: next.role,
        provisional: next.provisional, currentRevisionId: next.id,
      };
      await messages.put({ ...item, jobId: job.id });
    }
  }
}

async function importSegments(tx: ArchiveTx, job: StoredJob, sourceId: string, records: CaptureSegment[]): Promise<void> {
  const id = await readMap(tx, job, 'conversation', sourceId) ?? fail('Missing import conversation.');
  const store = tx.objectStore('segments');
  for (const original of records) {
    const refs = await Promise.all(original.revisions.map(async (ref) => ({
      ...ref, revisionId: await readMap(tx, job, 'revision', ref.revisionId) ?? fail('Missing imported revision.'),
    })));
    const oldSegments = await store.index('selection').getAll([id, original.selectionId]);
    const signature = JSON.stringify(refs);
    const same = oldSegments.find((segment) => segment.source === original.source
      && segment.leafId === original.leafId && segment.coverage.state === original.coverage.state
      && JSON.stringify(segment.revisions) === signature);
    const target = same?.id ?? (await store.get(original.id) ? crypto.randomUUID() : original.id);
    await mapId(tx, job, 'segment', original.id, target);
    if (!same) await store.add({ ...original, revisions: refs, id: target, conversationId: id, jobId: job.id });
  }
}

async function finishConversation(tx: ArchiveTx, job: StoredJob, sourceId: string, selection: string | null): Promise<void> {
  const id = await readMap(tx, job, 'conversation', sourceId) ?? fail('Missing import conversation.');
  const store = tx.objectStore('conversations');
  const prior = await store.get(id) ?? fail('Missing import conversation.');
  if (prior.jobId === job.id) {
    const segmentId = selection ? await readMap(tx, job, 'segment', selection) ?? fail('Missing imported selection.') : null;
    await store.put({ ...prior, segmentId });
  }
}

async function importSaved(tx: ArchiveTx, job: StoredJob, source: SavedItem): Promise<void> {
  const collectionId = await readMap(tx, job, 'collection', source.collectionId) ?? fail('Missing import collection.');
  let conversationId = await readMap(tx, job, 'conversation', source.conversationId);
  const provider = source.sourceUrl.match(/\/c\/([A-Za-z0-9_-]+)\/?$/u)?.[1];
  const existingAlias = provider ? await tx.objectStore('aliases').get([collectionId, provider]) : undefined;
  conversationId ??= existingAlias?.conversationId;
  if (!conversationId) {
    const sameId = await tx.objectStore('saved').get(source.id);
    conversationId = sameId?.collectionId === collectionId && sameId.sourceUrl === source.sourceUrl ? sameId.conversationId : crypto.randomUUID();
  }
  await lockConversation(tx, job, conversationId);
  await mapId(tx, job, 'conversation', source.conversationId, conversationId);
  const revisionId = await readMap(tx, job, 'revision', source.revisionId) ?? source.revisionId;
  const original = { ...source, conversationId, collectionId, revisionId };
  const store = tx.objectStore('saved');
  const taken = await store.get(source.id);
  const nearby = await store.index('conversation').getAll(conversationId);
  if (nearby.some((row) => row.revisionId === revisionId && row.text === original.text && row.note === original.note
    && JSON.stringify(row.tags) === JSON.stringify(original.tags) && (row.label === original.label || row.label === importedLabel(original.label)))) return;
  const id = taken ? crypto.randomUUID() : source.id;
  await store.add({ ...original, id, label: taken ? importedLabel(original.label) : original.label, jobId: job.id });
}

function importedLabel(label: string): string {
  return label.slice(0, 240) + (label ? ' (imported)' : 'Imported copy');
}

async function importDraft(tx: ArchiveTx, job: StoredJob, source: HandoffDraft): Promise<void> {
  const collectionId = await readMap(tx, job, 'collection', source.collectionId) ?? fail('Missing import collection.');
  const evidence: HandoffEvidence[] = [];
  for (const item of source.evidence) {
    const conversationId = item.conversationId ? await readMap(tx, job, 'conversation', item.conversationId) : undefined;
    const revisionId = item.revisionId ? await readMap(tx, job, 'revision', item.revisionId) ?? item.revisionId : undefined;
    evidence.push({ ...item, conversationId, revisionId });
  }
  const store = tx.objectStore('drafts');
  const taken = await store.get(source.id);
  const rows = await store.index('collection').getAll(collectionId);
  if (rows.some((row) => (row.title === source.title || row.title === importedLabel(source.title))
    && row.budget === source.budget && row.template === source.template && JSON.stringify(row.notes) === JSON.stringify(source.notes)
    && JSON.stringify(row.evidence) === JSON.stringify(evidence))) return;
  const id = taken ? crypto.randomUUID() : source.id;
  await store.add({ ...source, evidence, collectionId, id, title: taken ? importedLabel(source.title) : source.title, jobId: job.id });
}

async function discardWorkingState(tx: ArchiveTx, id: string): Promise<void> {
  await tx.objectStore('importPayloads').delete(IDBKeyRange.bound([id], [id, []]));
  await tx.objectStore('importMap').delete(IDBKeyRange.bound([id], [id, []]));
  const locks = tx.objectStore('importLocks');
  for (const key of await locks.index('job').getAllKeys(id)) await locks.delete(key);
}

export async function resumeRestore(tx: ArchiveTx, id: string, now: number): Promise<{ value: ImportJob; archiveRevision?: number }> {
  const jobs = tx.objectStore('jobs');
  const job = await jobs.get(id) ?? fail('Restore job unavailable.');
  if (job.state === 'complete') return { value: publicJob(job) };
  const payloads = tx.objectStore('importPayloads');
  const start = job.processed;
  job.state = 'pending';
  job.error = undefined;
  for (let i = start; i < Math.min(job.total, start + 8); i++) {
    const unit = await payloads.get([id, i]) ?? fail('Missing restore checkpoint.');
    switch (unit.kind) {
      case 'collection': await mapCollection(tx, job, unit.record); break;
      case 'conversation':
        await prepareConversation(tx, job, unit.record);
        await importRevisions(tx, job, unit.record.conversation.id, unit.record.revisions);
        await importSegments(tx, job, unit.record.conversation.id, unit.record.segments);
        await finishConversation(tx, job, unit.record.conversation.id, unit.record.conversation.segmentId);
        break;
      case 'prepare': await prepareConversation(tx, job, unit.record); break;
      case 'revisions': await importRevisions(tx, job, unit.conversationId, unit.records); break;
      case 'segments': await importSegments(tx, job, unit.conversationId, unit.records); break;
      case 'finish': await finishConversation(tx, job, unit.conversationId, unit.segmentId); break;
      case 'saved': await importSaved(tx, job, unit.record); break;
      case 'draft': await importDraft(tx, job, unit.record); break;
    }
    await payloads.delete([id, i]);
    job.processed++;
    if (unit.kind === 'revisions' && unit.records.length >= 96) break;
  }
  let archiveRevision: number | undefined;
  if (job.processed === job.total) {
    job.state = 'complete';
    if (job.contextAlert !== undefined) {
      const active = await settings(tx);
      await tx.objectStore('meta').put({ key: 'settings', value: { ...active, contextAlert: job.contextAlert } });
    }
    await discardWorkingState(tx, id);
    archiveRevision = await bumpRevision(tx, [], true);
  }
  await jobs.put(job);
  void now;
  return { value: publicJob(job), archiveRevision };
}

export async function removeRestore(tx: ArchiveTx, id: string): Promise<{ value: void; archiveRevision?: number }> {
  const jobs = tx.objectStore('jobs');
  const job = await jobs.get(id);
  if (!job) return { value: undefined };
  if (job.state === 'complete') fail('Only incomplete restores can be removed.');
  for (const name of importedStores) {
    const store = tx.objectStore(name);
    for (const key of await store.index('job').getAllKeys(id)) await store.delete(key);
  }
  await discardWorkingState(tx, id);
  await jobs.delete(id);
  return { value: undefined };
}
