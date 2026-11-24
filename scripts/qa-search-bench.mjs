import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { LocalSearch } from '../src/library/search.ts';

const index = new LocalSearch();
const count = 50_000;
const at = Date.now();
const topics = ['rendering', 'transit', 'import', 'revisions', 'camera', 'search', 'maps', 'interface'];
const coverage = { state: 'unknown', reason: 'Synthetic rendered sequence' };
const documents = Array.from({ length: count }, (_, number) => {
  const topic = topics[number % topics.length];
  return {
    id: `revision-${number}`,
    conversationId: `conversation-${Math.floor(number / 25)}`,
    collectionId: number % 11 === 0 ? 'scratch' : 'qa',
    title: `${topic} fixture prototype ${Math.floor(number / 25)}`,
    text: `Fixture message ${number} about ${topic}. Keep asset decoding off the rendering thread for unit ${number}. Latency goal step ${number % 101}. A punctuation probe: trim.top.`,
    tags: [topic, number % 29 === 0 ? 'slow-path' : 'normal'],
    note: number % 31 === 0 ? 'Recheck transfer costs with a low-memory device.' : '',
    role: number % 5 === 0 ? 'user' : 'assistant',
    reportedModel: number % 5 === 0 ? null : 'trace-fixture-resolved',
    capturedAt: at - number * 1000,
    updatedAt: at - number * 1000,
    saved: number % 31 === 0,
    coverage,
    revisionId: `revision-${number}`,
  };
});

const coldStart = performance.now();
index.add(documents);
const inMemoryIndexBuildMs = performance.now() - coldStart;
assert.equal(index.size, count);
const filter = { collectionId: 'qa', dateField: 'updatedAt' };
const summarize = values => {
  const ordered = values.toSorted((a, b) => a - b);
  const at = p => Number(ordered[Math.ceil(p * ordered.length) - 1].toFixed(2));
  return { medianMs: at(0.5), p95Ms: at(0.95), samples: ordered.length };
};

const queries = ['camera prototype', '"asset decoding"', '"low-memory device"', 'trim.top', 'revision', 'unit 24523', 'no-fixture-matches', ''];
for (const query of queries) index.search(query, filter, 0);
const measurements = new Map(queries.map(query => [query, []]));
for (let round = 0; round < 12; round++) {
  for (const query of queries) {
    const start = performance.now();
    index.search(query, filter, (round % 3) * 24);
    measurements.get(query).push(performance.now() - start);
  }
}

const summary = summarize([...measurements.values()].flat());
console.log(JSON.stringify({
  scope: 'Standalone in-memory search implementation. Browser worker, IndexedDB hydration and UI debounce timing are excluded.',
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  fixtureMessages: index.size,
  inMemoryIndexBuildMs: Number(inMemoryIndexBuildMs.toFixed(2)),
  warm: summary,
  queries: Object.fromEntries([...measurements].map(([query, samples]) => [query || '(unfiltered)', summarize(samples)])),
}, null, 2));
