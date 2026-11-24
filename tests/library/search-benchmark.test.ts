import 'fake-indexeddb/auto';
import { cpus, release } from 'node:os';
import { expect, it } from 'vitest';
import { connectArchive } from '../../src/archive/database';
import { openArchive } from '../../src/archive/repository';
import type { CaptureSegment, Collection, Conversation, MessageRevision } from '../../src/archive/types';
import { LocalSearch } from '../../src/library/search';

// TRACE_SEARCH_BENCHMARK=1 npx vitest run tests/library/search-benchmark.test.ts
it.skipIf(process.env.TRACE_SEARCH_BENCHMARK !== '1')('benchmarks warm search and paged hydration against a 50,000-message synthetic archive', async () => {
  const name = 'trace-bench';
  const db = await connectArchive(name);
  const now = Date.now();
  const collections: Collection[] = ['qa', 'scratch'].map((id) => ({
    id, label: id, createdAt: now, mode: 'manual', retention: 'forever', autoExcluded: false, autoConsent: false,
  }));
  const coverage = { state: 'unknown', reason: 'Synthetic rendered sequence' } as const;
  const seed = db.transaction(['collections', 'conversations', 'revisions', 'segments'], 'readwrite');
  for (const collection of collections) await seed.objectStore('collections').put(collection);
  const topics = ['rendering', 'transit', 'import', 'revisions', 'camera', 'search', 'maps', 'interface'];
  for (let group = 0; group < 2000; group++) {
    const id = `conversation-${group}`;
    const segmentId = `segment-${group}`;
    const topic = topics[group % topics.length]!;
    const observedAt = now - group * 1000;
    const row: Conversation = { id, providerId: id, collectionId: group % 11 === 0 ? 'scratch' : 'qa',
      title: `${topic} fixture prototype ${group}`, sourceUrl: `https://chatgpt.com/c/${id}`,
      firstObservedAt: observedAt - 500, lastObservedAt: observedAt, coverage, segmentId };
    await seed.objectStore('conversations').put(row);
    const segment: CaptureSegment = { id: segmentId, conversationId: id, selectionId: segmentId,
      source: 'dom', revisions: [], coverage, observedAt, adapterVersion: 'fixture/1' };
    for (let message = 0; message < 25; message++) {
      const id = `revision-${group}-${message}`;
      const revision: MessageRevision = { id, messageId: `message-${message}`, conversationId: row.id,
        role: message % 2 === 0 ? 'user' : 'assistant', source: 'dom', provisional: false, final: true,
        observedAt, adapterVersion: 'fixture/1', text: `Fixture ${group}:${message} about ${topic}. Keep asset decoding off the rendering thread. A punctuation probe: trim.top.` };
      segment.revisions.push({ messageId: revision.messageId, revisionId: id });
      await seed.objectStore('revisions').put(revision);
    }
    await seed.objectStore('segments').put(segment);
  }
  await seed.done;
  db.close();

  const archive = await openArchive(name);
  const search = new LocalSearch();
  const started = performance.now();
  let cursor: string | null = null;
  do {
    const page = await archive.searchPage(cursor, 200);
    search.add(page.documents);
    cursor = page.next;
  } while (cursor);
  const coldMs = performance.now() - started;
  expect(search.size).toBe(50_000);
  const filter = { collectionId: 'qa', dateField: 'updatedAt' } as const;
  const queries = ['camera prototype', '"asset decoding"', 'trim.top', 'revisions', 'fixture', 'unknown-nonexistent', ''];
  const samples: number[] = [];
  for (let round = 0; round <= 12; round++) {
    for (const query of queries) {
      const begin = performance.now();
      const { ids } = search.search(query, filter, (round % 3) * 24);
      const hydrated = await archive.hydrateSearch(ids, filter.collectionId);
      expect(hydrated.archiveRevision).toBe(await archive.getArchiveRevision());
      expect(hydrated.documents).toHaveLength(ids.length);
      if (round > 0) samples.push(performance.now() - begin);
    }
  }
  const sorted = samples.sort((a, b) => a - b);
  const percentile = (p: number) => Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(2));
  console.log(JSON.stringify({ scope: 'Actual library index and archive hydration in Node with fake IndexedDB. Browser worker transport and UI debounce excluded.',
    machine: { cpu: cpus()[0]?.model, release: release(), arch: process.arch, node: process.version },
    messages: search.size, coldMs: Number(coldMs.toFixed(2)), samples: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95) }, null, 2));
}, 120_000);
