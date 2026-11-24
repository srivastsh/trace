import { openArchive } from '../archive/repository';
import { ALL_COLLECTIONS, LocalSearch, snippet, type SearchRequest, type SearchResponse } from './search';

const worker = self as unknown as {
  postMessage: (response: SearchResponse) => void;
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
};
const archive = openArchive();
let index = new LocalSearch();
let current: SearchRequest | undefined;
let archiveRevision = -1;
let refreshing = false;
let refreshPending = false;

async function publish(rebuilding: boolean): Promise<void> {
  const request = current;
  if (!request) return;
  const { ids, models, more } = index.search(request.query, request.filter, request.offset);
  const repo = await archive;
  const hydrated = await repo.hydrateSearch(ids, request.filter.collectionId === ALL_COLLECTIONS ? undefined : request.filter.collectionId);
  if (request !== current) return;
  if (hydrated.archiveRevision !== archiveRevision || hydrated.archiveRevision !== await repo.getArchiveRevision()) {
    refreshPending = true;
    return;
  }
  if (request !== current) return;
  const found = new Map(hydrated.documents.map((document) => [document.id, document]));
  const documents: SearchResponse['documents'] = ids.flatMap((id) => {
    const document = found.get(id);
    if (!document) return [];
    const { text: _text, note: _note, tags: _tags, ...metadata } = document;
    return [{ ...metadata, excerpt: snippet(document, request.query) }];
  });
  worker.postMessage({ version: request.version, documents, models, more,
    rebuilding, indexed: index.size });
}

async function rebuild(): Promise<void> {
  const repo = await archive;
  let cursor: string | null = null;
  let nextProgress = 0;
  index = new LocalSearch();
  archiveRevision = await repo.getArchiveRevision();
  do {
    const page = await repo.searchPage(cursor ?? undefined, 200);
    index.add(page.documents);
    cursor = page.next;
    if (cursor && performance.now() >= nextProgress) {
      await publish(true);
      nextProgress = performance.now() + 250;
    }
  } while (cursor);
}

async function refresh(): Promise<void> {
  refreshPending = true;
  if (refreshing) return;
  refreshing = true;
  try {
    const repo = await archive;
    while (refreshPending) {
      refreshPending = false;
      if (archiveRevision < 0) await rebuild();
      if (archiveRevision !== await repo.getArchiveRevision()) {
        const changes = await repo.searchChanges(archiveRevision);
        if (changes.reset) {
          await rebuild();
        } else {
          index.removeConversations(changes.conversationIds);
          for (let offset = 0; offset < changes.conversationIds.length; offset += 500) {
            const rows = await repo.searchConversations(changes.conversationIds.slice(offset, offset + 500));
            index.add(rows.documents);
          }
          archiveRevision = changes.archiveRevision;
        }
      }
      await publish(false);
    }
  } catch {
    if (current) worker.postMessage({ version: current.version, documents: [], models: [], more: false,
      rebuilding: false, indexed: 0, error: 'Search is unavailable. Try reopening the library.' });
  } finally {
    refreshing = false;
  }
}

worker.onmessage = (event) => {
  current = event.data;
  void refresh();
};
const changes = new BroadcastChannel('trace-archive');
changes.onmessage = () => void refresh();
