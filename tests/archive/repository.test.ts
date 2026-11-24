import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivitySnapshot, CapturedMessage, Projection } from '../../src/contracts';
import { makeConversationExport, validateEnvelope } from '../../src/archive/backup';
import { openArchive, type ArchiveRepository } from '../../src/archive/repository';
import type { Collection, HandoffDraft, ImportJob } from '../../src/archive/types';

const origin = 'https://chatgpt.com';
const provisionalProvider = 'local:6ed5f7c1-e2b0-47ae-ae6a-f8939657a525';
const documentA = { tabId: 1, documentId: 'doc-one', epoch: 1 };
const documentB = { tabId: 2, documentId: 'doc-two', epoch: 1 };

let repo: ArchiveRepository;
let dbName: string;
let collection: Collection;
let time: number;
let count: number;

beforeEach(async () => {
  time = 1_800_000_000_000;
  count = 0;
  dbName = 'test-' + crypto.randomUUID();
  repo = await openArchive(dbName, () => time);
  collection = await repo.createCollection({ label: 'Project', retention: 90 });
});

afterEach(() => {
  repo.close();
});

function revision(id: string, text: string, parentId?: string | null, role: 'user' | 'assistant' = 'assistant', final = true): CapturedMessage {
  return { id, text, parentId, role, final, provisional: false, observedAt: time };
}

function captureInput(messages: CapturedMessage[] = [revision('root', 'Which route?', null, 'user'), revision('leaf', 'Route 14', 'root')], patch: Partial<Projection> = {}): Projection {
  const providerId = patch.providerId ?? 'chat-one';
  return {
    providerId, sourceUrl: providerId.startsWith('local:') ? origin + '/' : origin + '/c/' + providerId,
    title: 'Transit display', source: 'history', leafId: messages.at(-1)?.id,
    messages, selectionId: 'selected-one', adapterVersion: 'fixture-v1',
    coverage: { state: 'complete', reason: 'Server-provided active branch.' },
    observedAt: time, batchId: 'batch-' + count++, ...patch,
  };
}

async function bind(input = captureInput(), document = documentA, id = collection.id, ordinary = true) {
  await repo.setBinding({ ...document, collectionId: id, providerId: input.providerId, selectionId: input.selectionId, ordinary });
}

async function allow(input = captureInput(), document = documentA, id = collection.id) {
  await repo.updateCollection(id, { autoConsent: true });
  const settings = await repo.setSettings({ autoCapture: true });
  await bind(input, document, id);
  return { ...document, generation: settings.generation, collectionId: id };
}

async function authorize(input: Projection, destination = collection.id) {
  await repo.setBinding({ ...documentA, collectionId: null, providerId: input.providerId,
    selectionId: input.selectionId, ordinary: false });
  return { ...documentA, generation: (await repo.getSettings()).generation, collectionId: destination,
    intentId: 'intent-' + count++, expiresAt: time + 5_000 };
}

function draft(id: string, items: HandoffDraft['evidence']): HandoffDraft {
  return { id, collectionId: collection.id, title: 'Continue display', template: 'codex', budget: 20_000,
    notes: { goal: 'Ship the display', currentState: '', decisions: '', constraints: '', references: '', openQuestions: '', nextSteps: '' },
    evidence: items, createdAt: time, updatedAt: time };
}

async function complete(job: ImportJob) {
  while (job.state === 'pending') job = await repo.resumeImport(job.id);
  expect(job.state, job.error).toBe('complete');
  return job;
}

describe('archive capture', () => {
  it('requires automatic consent, an ordinary page, a current binding and the current generation', async () => {
    const input = captureInput();
    await bind(input);
    const disabled = { ...documentA, generation: 1, collectionId: collection.id };
    expect(await repo.getSettings()).toMatchObject({ autoCapture: false, welcomeComplete: false });
    await expect(repo.capture(input, disabled)).rejects.toThrow(/paused/u);
    const target = await allow(input);
    await bind(input, documentA, collection.id, false);
    await expect(repo.capture(input, target)).rejects.toThrow(/paused/u);
    await bind(input);
    await expect(repo.capture(input, { ...target, epoch: 0 })).rejects.toThrow(/changed/u);
    await expect(repo.capture(captureInput(undefined, { providerId: 'unbound-chat' }), target)).rejects.toThrow(/changed/u);
    await repo.setSettings({ autoCapture: false });
    expect(await repo.listConversations()).toEqual([]);
    await expect(repo.capture(input, target)).rejects.toThrow(/paused/u);
    await repo.setSettings({ autoCapture: true });
    await expect(repo.capture(input, target)).rejects.toThrow(/paused/u);
  });

  it('fences a queued automatic write if consent is revoked before it enters the transaction', async () => {
    const input = captureInput();
    const target = await allow(input);
    const queued = repo.capture(input, target);
    const check = expect(queued).rejects.toThrow(/paused/u);
    await repo.setSettings({ autoCapture: false });
    await check;
    expect(await repo.listConversations()).toEqual([]);
  });

  it('retains the last committed branch and pauses capture after an IndexedDB quota failure', async () => {
    const first = captureInput();
    const target = await allow(first);
    const committed = await repo.capture(first, target);
    const before = await repo.getArchiveRevision();
    const native = IDBObjectStore.prototype.add;
    const write = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'revisions' && (args[0] as { text?: string })?.text === 'Over capacity') {
        throw new DOMException('Quota reached', 'QuotaExceededError');
      }
      return native.apply(this, args);
    });
    try {
      time++;
      const second = captureInput([revision('earlier-staged', 'Must roll back', null, 'user'),
        revision('failed-leaf', 'Over capacity', 'earlier-staged')]);
      await expect(repo.capture(second, target)).rejects.toThrow(/storage is full/u);
    } finally {
      write.mockRestore();
    }
    expect(await repo.getArchiveRevision()).toBe(before);
    expect((await repo.getSettings()).autoCapture).toBe(false);
    expect((await repo.getConversation(committed.conversationId))?.messages.map((row) => row.text))
      .toEqual(['Which route?', 'Route 14']);
    expect((await repo.searchPage()).documents).toHaveLength(2);
  });

  it('preserves separate edited and regenerated branches, repeated text, and duplicate batch idempotency', async () => {
    const first = captureInput([revision('root', 'Two equal lines', null, 'user'), revision('branch-a', 'Same', 'root'),
      revision('leaf-a', 'Same', 'branch-a')]);
    const targetA = await allow(first);
    const a = await repo.capture(first, targetA);
    const duplicate = await repo.capture(first, targetA);
    expect(duplicate).toMatchObject({ conversationId: a.conversationId, segmentId: a.segmentId, duplicate: true });
    time++;
    const second = captureInput([revision('root', 'Edit question', null, 'user'), revision('branch-b', 'Regeneration', 'root')],
      { selectionId: 'selected-b' });
    await bind(second, documentB);
    const b = await repo.capture(second, { ...targetA, ...documentB });
    expect(b.conversationId).toBe(a.conversationId);
    expect(b.segmentId).not.toBe(a.segmentId);
    expect((await repo.getConversation(a.conversationId, a.segmentId!))?.messages.map((item) => item.text))
      .toEqual(['Two equal lines', 'Same', 'Same']);
    expect((await repo.getConversation(a.conversationId, b.segmentId!))?.messages.map((item) => item.text))
      .toEqual(['Edit question', 'Regeneration']);
    expect((await repo.getConversation(a.conversationId, a.segmentId!))?.segment?.coverage.state).toBe('complete');
  });

  it('retains disjoint DOM captures, keeps provisional IDs document-scoped, and downgrades unsupported completeness', async () => {
    const first = captureInput([{ ...revision('dom-1', 'Rendered item'), provisional: true }], { source: 'dom' });
    const targetA = await allow(first);
    const a = await repo.capture(first, targetA);
    const second = captureInput([{ ...revision('dom-1', 'Rendered item'), provisional: true }], { source: 'dom' });
    await bind(second, documentB);
    const b = await repo.capture(second, { ...targetA, ...documentB });
    expect(b.conversationId).toBe(a.conversationId);
    const current = await repo.getConversation(b.conversationId, b.segmentId!);
    expect(current?.segments).toHaveLength(2);
    expect(current?.segment?.coverage.state).toBe('partial');
    expect((await repo.searchPage()).documents.map((row) => row.text)).toEqual(['Rendered item', 'Rendered item']);
  });

  it('awaits explicit temporary alias evidence and preserves the local identity after promotion', async () => {
    const draftInput = captureInput(undefined, { providerId: provisionalProvider });
    const target = await allow(draftInput);
    const draft = await repo.capture(draftInput, target);
    const canonicalInput = captureInput();
    await bind(canonicalInput);
    const canon = await repo.capture(canonicalInput, target);
    expect(canon.conversationId).not.toBe(draft.conversationId);
    const repaired = await repo.capture(captureInput(undefined, { aliasFrom: provisionalProvider }), target);
    expect(repaired.conversationId).toBe(draft.conversationId);
    expect((await repo.listConversations()).map((row) => row.id)).toEqual([draft.conversationId]);
    expect((await repo.lookupConversation(collection.id, 'chat-one'))?.sourceUrl).toBe(origin + '/c/chat-one');
    expect((await repo.lookupConversation(collection.id, provisionalProvider))?.id).toBe(draft.conversationId);
  });

  it('isolates duplicate provider IDs in different collections and clears durable fences on fresh startup', async () => {
    const input = captureInput();
    const target = await allow(input);
    const a = await repo.capture(input, target);
    const isolated = await repo.createCollection({ label: 'Another profile collection' });
    const other = await allow(input, documentB, isolated.id);
    const b = await repo.capture(input, other);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect((await repo.listConversations(collection.id)).map((row) => row.id)).toEqual([a.conversationId]);
    await repo.resetFences();
    await expect(repo.capture(input, other)).rejects.toThrow(/paused/u);
  });

  it('requires a current explicit intent, leaves consent and exclusions unchanged, and strips account telemetry', async () => {
    const activity: ActivitySnapshot = { state: 'reported', comparable: false, quotas: [], adapterVersion: 'fixture-v1',
      model: { value: 'fixture-model', sourceField: 'model', sourceKind: 'server-reported', observedAt: time,
        adapterVersion: 'fixture-v1', endpoint: 'history', status: 'reported' } };
    activity.accountDefault = { ...activity.model!, value: 'account-default' };
    activity.quotas = [{ feature: 'test-feature', scope: 'private', observedAt: time }];
    const input = captureInput([revision('root', 'Leave this unsaved', null, 'user'),
      { ...revision('leaf', 'Keep this excerpt', 'root'), activity }]);
    await repo.setProviderExcluded(collection.id, input.providerId, true);
    const auth = await authorize(input);
    await expect(repo.saveCapture(input, { ...auth, expiresAt: time })).rejects.toThrow(/expired/u);
    await expect(repo.saveCapture({ ...input, selectionId: 'other-branch' }, auth)).rejects.toThrow(/changed/u);
    const result = await repo.saveCapture(input, auth, ['leaf'], { note: 'Private note' });
    expect(result.savedIds).toHaveLength(1);
    expect((await repo.getConversation(result.conversationId))?.messages.map((row) => row.text)).toEqual(['Keep this excerpt']);
    const [item] = await repo.listSaved();
    expect(item.activity).toMatchObject({ quotas: [], model: { value: 'fixture-model' } });
    expect(item.activity?.accountDefault).toBeUndefined();
    expect(item.note).toBe('Private note');
    expect((await repo.getSettings()).autoCapture).toBe(false);
    expect(await repo.isProviderExcluded(collection.id, input.providerId)).toBe(true);
    expect((await repo.saveCapture(input, auth, ['leaf'], { note: 'Retry' })).duplicate).toBe(true);
  });
});

describe('retention, purge, and backup', () => {
  it('physically removes expired transcript-only graphs and aliases', async () => {
    const input = captureInput();
    const auth = await authorize(input);
    const old = await repo.saveCapture(input, auth);
    time += 91 * 86_400_000;
    expect(await repo.cleanup()).toBe(1);
    expect(await repo.storageStatus()).toMatchObject({ conversations: 0, pendingCleanup: 0 });
    expect(await repo.isProviderExcluded(collection.id, input.providerId)).toBe(false);
    const newInput = captureInput();
    const current = await repo.saveCapture(newInput, await authorize(newInput));
    expect(current.conversationId).not.toBe(old.conversationId);
  });

  it('retains only grouped exclusion markers when deleting a promoted chat', async () => {
    const input = captureInput(undefined, { providerId: provisionalProvider });
    const initial = await repo.saveCapture(input, await authorize(input));
    const promoted = captureInput(undefined, { aliasFrom: provisionalProvider });
    expect((await repo.saveCapture(promoted, await authorize(promoted))).conversationId).toBe(initial.conversationId);
    await repo.deleteConversation(initial.conversationId);
    expect(await repo.lookupConversation(collection.id, provisionalProvider)).toBeUndefined();
    expect(await repo.isProviderExcluded(collection.id, provisionalProvider)).toBe(true);
    expect(await repo.isProviderExcluded(collection.id, promoted.providerId)).toBe(true);
    await repo.setProviderExcluded(collection.id, promoted.providerId, false);
    expect(await repo.isProviderExcluded(collection.id, provisionalProvider)).toBe(false);
    expect(await repo.isProviderExcluded(collection.id, promoted.providerId)).toBe(false);
  });
  it('filters expired transcripts before cleanup, retains explicit excerpts, and scrubs deleted handoff evidence', async () => {
    const input = captureInput();
    const auth = await authorize(input);
    const result = await repo.saveCapture(input, auth);
    const view = (await repo.getConversation(result.conversationId))!;
    await repo.saveMessage({ conversationId: result.conversationId, revisionId: view.messages[1].id, note: 'Stay after expiry' });
    await repo.saveDraft(draft('draft-one', [
      { conversationId: result.conversationId, revisionId: view.messages[1].id, title: view.conversation.title,
        sourceUrl: input.sourceUrl, role: 'assistant', text: 'Route 14', coverage: view.conversation.coverage },
      { title: 'Other source', sourceUrl: origin + '/c/another', role: 'user', text: 'Keep',
        coverage: { state: 'unknown', reason: 'Selected' } },
    ]));
    time += 90 * 86_400_000;
    expect(await repo.listConversations()).toEqual([]);
    expect(await repo.storageStatus()).toMatchObject({ pendingCleanup: 1 });
    expect((await repo.searchPage()).documents.map((item) => item.saved)).toEqual([true]);
    expect(await repo.cleanup()).toBe(1);
    expect((await repo.getConversation(result.conversationId))?.expired).toBe(true);
    const indexId = (await repo.searchPage()).documents[0].id;
    await repo.deleteConversation(result.conversationId);
    expect((await repo.hydrateSearch([indexId])).documents).toEqual([]);
    expect(await repo.listSaved()).toEqual([]);
    expect(await repo.getConversation(result.conversationId)).toBeUndefined();
    const [after] = await repo.listDrafts();
    expect(after.notes.goal).toBe('Ship the display');
    expect(after.evidence.map(({ text, unavailable }) => ({ text, unavailable })))
      .toEqual([{ text: '', unavailable: true }, { text: 'Keep', unavailable: undefined }]);
    expect(await repo.isProviderExcluded(collection.id, input.providerId)).toBe(true);
  });

  it('rejects malformed files before writes and keeps permissions out of portable backup', async () => {
    const input = captureInput();
    const target = await allow(input);
    await repo.capture(input, target);
    const backup = await repo.makeBackup();
    expect(JSON.stringify(backup)).not.toMatch(/(?:autoConsent|generation|doc-one|scopeKey)/u);
    await expect(repo.previewImport({ ...backup, version: 999 })).rejects.toThrow(/version/u);
    expect(() => repo.startImport({ ...backup, conversations: [{ ...backup.conversations[0], revisions: [] }] }))
      .toThrow(/Missing segment revision/u);
    expect(await repo.listJobs()).toEqual([]);
    expect(await repo.listConversations()).toHaveLength(1);
    expect(await repo.previewImport(backup)).toMatchObject({ kind: 'backup', conversations: 1, revisions: 2 });
  });

  it('restores stable identities idempotently, preserves conflicts, and never grants consent to restored collections', async () => {
    const input = captureInput();
    const auth = await authorize(input);
    const result = await repo.saveCapture(input, auth);
    const view = (await repo.getConversation(result.conversationId))!;
    const saved = await repo.saveMessage({ conversationId: result.conversationId, revisionId: view.messages[1].id, note: 'Source note' });
    const backup = await repo.makeBackup();
    await repo.updateSaved(saved.id, { note: 'Edited locally' });
    await complete(await repo.startImport(backup, collection.id));
    await complete(await repo.startImport(backup, collection.id));
    const items = await repo.listSaved();
    expect(items.map((item) => item.note).sort()).toEqual(['Edited locally', 'Source note']);
    expect(items.find((item) => item.note === 'Source note')?.label).toMatch(/Imported/u);
    await complete(await repo.startImport(backup));
    expect((await repo.listCollections()).find((row) => row.id !== collection.id)).toMatchObject({
      mode: 'manual', autoConsent: false, autoExcluded: false,
    });
    expect(await repo.listConversations()).toHaveLength(2);
  });

  it('hides interrupted restore records and removes only job-created records', async () => {
    const input = captureInput();
    const auth = await authorize(input);
    const result = await repo.saveCapture(input, auth);
    const view = (await repo.getConversation(result.conversationId))!;
    const template = await repo.saveMessage({ conversationId: result.conversationId, revisionId: view.messages[1].id });
    const backup = await repo.makeBackup();
    backup.saved = Array.from({ length: 17 }, (_, i) => ({ ...template, id: 'saved-' + i, note: 'Imported ' + i }));
    const started = await repo.startImport(backup, collection.id);
    const partial = await repo.resumeImport(started.id);
    expect(partial.state).toBe('pending');
    expect(partial.processed).toBeGreaterThan(0);
    expect(await repo.listSaved()).toHaveLength(1);
    await repo.removeImport(started.id);
    expect(await repo.listJobs()).toEqual([]);
    expect(await repo.listSaved()).toEqual([template]);
    expect((await repo.getConversation(result.conversationId))?.messages).toHaveLength(2);
  });

  it('resumes a checkpoint on a fresh database connection without publishing incomplete records', async () => {
    const startedAt = time;
    const input = captureInput();
    const auth = await authorize(input);
    const source = await repo.saveCapture(input, auth);
    const view = (await repo.getConversation(source.conversationId))!;
    const template = await repo.saveMessage({ conversationId: source.conversationId, revisionId: view.messages[1].id });
    const contents = await repo.makeBackup();
    contents.saved = Array.from({ length: 18 }, (_, i) => ({ ...template, id: 'checkpoint-' + i, note: 'note ' + i }));

    const started = await repo.startImport(contents);
    const interrupted = await repo.resumeImport(started.id);
    expect(interrupted).toMatchObject({ state: 'pending', createdAt: startedAt });
    repo.close();

    repo = await openArchive(dbName, () => time);
    expect(await repo.listCollections()).toHaveLength(1);
    expect(await repo.listSaved()).toHaveLength(1);
    expect((await repo.listJobs()).find((entry) => entry.id === started.id)?.processed).toBe(interrupted.processed);
    await complete(await repo.resumeImport(started.id));
    expect(await repo.listCollections()).toHaveLength(2);
    expect(await repo.listSaved()).toHaveLength(19);
  });

  it('checkpoints a single large branch in revision chunks and validates its finished reader selection', async () => {
    const graph = Array.from({ length: 205 }, (_, index) => revision('item-' + index, 'Message ' + index,
      index ? 'item-' + (index - 1) : null, index % 2 ? 'assistant' : 'user'));
    const input = captureInput(graph);
    const result = await repo.saveCapture(input, await authorize(input));
    const contents = await repo.makeBackup();
    expect(JSON.stringify(contents)).not.toMatch(/(?:localOrigin|doc-one)/u);
    const job = await repo.startImport(contents);
    const step = await repo.resumeImport(job.id);
    expect(step.state).toBe('pending');
    expect(await repo.listConversations()).toHaveLength(1);
    await complete(step);
    const copy = (await repo.listConversations()).find((item) => item.id !== result.conversationId)!;
    expect((await repo.getConversation(copy.id))?.messages).toHaveLength(205);
    expect((await repo.getConversation(copy.id))?.segment?.coverage.state).toBe('complete');
  });

  it('exports one selection with coverage distinct from complete source coverage', async () => {
    const input = captureInput();
    const auth = await authorize(input);
    const result = await repo.saveCapture(input, auth);
    const view = (await repo.getConversation(result.conversationId))!;
    const envelope = makeConversationExport([view], [view.messages[1].id]);
    expect(validateEnvelope(envelope).conversations[0]).toMatchObject({
      selection: 'excerpts', sourceCoverage: { state: 'complete' },
      conversation: { coverage: { state: 'partial' } }, revisions: [{ text: 'Route 14' }],
    });
    expect(envelope.saved).toEqual([]);
  });

  it('clear fences existing commits, resets settings, and changes the archive revision', async () => {
    const input = captureInput();
    const target = await allow(input);
    await repo.capture(input, target);
    const before = await repo.getArchiveRevision();
    await repo.clearAll();
    expect(await repo.listConversations()).toEqual([]);
    expect(await repo.listCollections()).toEqual([]);
    expect(await repo.getSettings()).toMatchObject({ autoCapture: false, welcomeComplete: false });
    expect(await repo.searchChanges(before)).toMatchObject({ reset: true });
    await expect(repo.capture(input, target)).rejects.toThrow(/paused/u);
  });
});
