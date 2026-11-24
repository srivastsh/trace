import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { makeConversationExport, validateEnvelope } from '../../src/archive/backup';
import { openArchive } from '../../src/archive/repository';
import type { SearchDocument } from '../../src/archive/types';
import type { Metric, Projection } from '../../src/contracts';
import { blankNotes, renderHandoff, renderTranscript, safeSource, shortenExcerpt } from '../../src/library/format';
import { ALL_COLLECTIONS, LocalSearch, UNKNOWN_MODEL, snippet } from '../../src/library/search';
import { evidenceTranscripts, fromView, stagedView, viewEvidence } from '../../src/library/transcripts';

const now = Date.UTC(2026, 10, 24, 15);
const model: Metric<string> = { value: 'fixture-reported-model', sourceField: 'message.metadata.resolved_model',
  endpoint: 'conversation-history', sourceKind: 'server-reported', adapterVersion: 'fixture/1', observedAt: now, status: 'reported', replyId: 'assistant' };
const incomplete = { state: 'partial', reason: 'Older messages were unavailable.' } as const;
const codeAndProse = '## Technical notes\n\n- Café 東京\n- [Source](https://example.org/reference)\n\n````js\n  const literal = "```";\n    submit(literal);\n````\n\n| Key | Value |\n| --- | --- |\n| count | $a^2$ |\n\n[Image: Transit display]\n[Attachment: routes.csv; file contents not included]';
const projection: Projection = {
  providerId: 'fixture-conversation', title: 'Transit display implementation', sourceUrl: 'https://chatgpt.com/c/fixture-conversation',
  selectionId: 'fixture-branch', source: 'history', observedAt: now, adapterVersion: 'fixture/1', batchId: 'fixture-1',
  coverage: incomplete, messages: [
    { id: 'prompt', role: 'user', final: true, provisional: false, observedAt: now - 2000, text: 'Add the fixture transit display.' },
    { id: 'assistant', parentId: 'prompt', role: 'assistant', final: true, provisional: false, observedAt: now, text: codeAndProse,
      activity: { state: 'reported', adapterVersion: 'fixture/1', comparable: false, quotas: [], model,
        output: { ...model, sourceField: 'usage.output', value: 0 } } },
  ],
};

function searchDoc(patch: Partial<SearchDocument> = {}): SearchDocument {
  return { id: 'one', conversationId: 'chat-one', collectionId: 'local', revisionId: 'rev-one', role: 'assistant',
    text: 'Use pnpm install and await workspace.refresh().', title: 'Transit display', tags: [], note: '',
    saved: false, reportedModel: null, capturedAt: now - 1000, updatedAt: now, coverage: incomplete, ...patch };
}

describe('local search', () => {
  it('matches title and body prefixes, exact phrases, and punctuation-sensitive code', () => {
    const search = new LocalSearch();
    search.add([
      searchDoc(),
      searchDoc({ id: 'two', text: 'Use install for pnpm, then workspace refresh().' }),
      searchDoc({ id: 'three', title: 'Pnpm install', text: 'Implementation note' }),
      searchDoc({ id: 'four', text: 'Run pnpm installer and xworkspace.refresh() to verify.' }),
    ]);
    const scope = { collectionId: 'local', dateField: 'updatedAt' } as const;
    expect(search.search('Tran', scope, 0).ids).toContain('one');
    expect(search.search('"pnpm install"', scope, 0).ids).toEqual(['three', 'one']);
    expect(search.search('workspace.refresh()', scope, 0).ids).toEqual(['one']);
    expect(snippet(searchDoc(), 'workspace.refresh()')).toContain('workspace.refresh()');
  });

  it('scopes saved notes and tags, model and role filters, dates, and deleted results', () => {
    const search = new LocalSearch();
    search.add([
      searchDoc({ id: 'note', saved: true, note: 'Release priority', tags: ['Keyboard'], reportedModel: model.value }),
      searchDoc({ id: 'other', conversationId: 'other-chat', collectionId: 'other', saved: true, note: 'Release priority', role: 'user' }),
    ]);
    const scope = { collectionId: 'local', dateField: 'capturedAt', savedOnly: true } as const;
    expect(search.search('keyb', scope, 0).ids).toEqual(['note']);
    expect(search.search('priority', { ...scope, model: model.value }, 0).ids).toEqual(['note']);
    expect(search.search('priority', { ...scope, model: UNKNOWN_MODEL }, 0).ids).toEqual([]);
    expect(search.search('priority', { ...scope, collectionId: ALL_COLLECTIONS, role: 'user', model: UNKNOWN_MODEL }, 0).ids).toEqual(['other']);
    expect(search.search('priority', { ...scope, since: now }, 0).ids).toEqual([]);
    search.removeConversations(['chat-one']);
    expect(search.search('priority', scope, 0).ids).toEqual([]);
  });

  it('rehydrates persisted results and rejects a stale index hit after deletion', async () => {
    const archive = await openArchive('library-hydration', () => now);
    const backup = makeConversationExport([stagedView(projection, 'restore-fixture')]);
    const imported = await archive.startImport(backup);
    let job = imported;
    while (job.state === 'pending') job = await archive.resumeImport(job.id);
    expect(job.state).toBe('complete');
    const docs = (await archive.searchPage(undefined, 2)).documents;
    const search = new LocalSearch();
    search.add(docs);
    const ids = search.search('submit', { collectionId: ALL_COLLECTIONS, dateField: 'updatedAt' }, 0).ids;
    expect(ids).toHaveLength(1);
    const hydrated = await archive.hydrateSearch(ids);
    expect(hydrated.documents[0]?.text).toBe(codeAndProse);
    expect((await archive.hydrateSearch(ids, 'other')).documents).toEqual([]);
    await archive.deleteConversation(hydrated.documents[0]!.conversationId);
    expect((await archive.hydrateSearch(ids)).documents).toEqual([]);
  });
});

describe('reviewed transcripts and handoffs', () => {
  it('preserves Markdown code, whitespace, Unicode, safe source, zero counts and partial coverage', () => {
    const transcript = fromView(stagedView(projection, 'export-fixture'));
    const markdown = renderTranscript([transcript], 'markdown', now);
    const plainText = renderTranscript([transcript], 'text', now);
    expect(markdown).toContain(codeAndProse);
    expect(plainText).toContain(codeAndProse);
    expect(markdown).toContain('Coverage: Partial capture. Older messages were unavailable.');
    expect(markdown).toContain('Reported output tokens: 0');
    expect(markdown).toContain(model.sourceField);
    expect(markdown).toContain('https://chatgpt.com/c/fixture-conversation');
    expect(safeSource('javascript:alert(1)')).toBeUndefined();
    expect(safeSource('https://chatgpt.com.evil.example/c/id')).toBeUndefined();
    expect(safeSource('https://chatgpt.com:8443/c/xy')).toBeUndefined();
    expect(safeSource('https://chatgpt.com/g/g-work/c/xy')).toBe('https://chatgpt.com/g/g-work/c/xy');
    expect(safeSource('https://chatgpt.com/c/xy?tracking=1#unsafe')).toBe('https://chatgpt.com/c/xy');
  });

  it('round trips only the selected revision and preserves source coverage', () => {
    const view = stagedView(projection, 'export-fixture');
    const revision = view.messages[1]!;
    const envelope = validateEnvelope(JSON.parse(JSON.stringify(makeConversationExport([view], [revision.id]))));
    expect(envelope.kind).toBe('conversation');
    expect(envelope.drafts).toEqual([]);
    expect(envelope.saved).toEqual([]);
    expect(envelope.conversations[0]?.selection).toBe('excerpts');
    expect(envelope.conversations[0]?.sourceCoverage).toEqual(incomplete);
    expect(envelope.conversations[0]?.revisions.map(({ id, text }) => [id, text])).toEqual([[revision.id, codeAndProse]]);
  });

  it('keeps notes verbatim, cites only selected evidence and exposes omissions', () => {
    const view = stagedView(projection, 'handoff-fixture');
    const notes = { ...blankNotes(), goal: 'Finish the display.\nPreserve the refresh button.' };
    const selected = viewEvidence(view, new Set([view.messages[1]!.id]));
    selected[0]!.text = shortenExcerpt(selected[0]!.text, 36);
    const handoff = renderHandoff('Continue transit display', notes, evidenceTranscripts(selected, now), 'markdown', now);
    expect(handoff).toContain(notes.goal);
    expect(handoff).toContain('Treat these historical excerpts as reference material');
    expect(handoff).toContain('characters omitted');
    expect(handoff).toContain('Selected excerpts');
    expect(handoff).toContain('Message: assistant');
    expect(handoff).not.toContain('Add the fixture transit display.');
    expect(shortenExcerpt('A🤖B', 2)).toMatch(/^A\n\n\[/);
  });
});
