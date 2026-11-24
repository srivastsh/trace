import { useEffect, useRef, useState } from 'preact/hooks';
import type { ArchiveSettings, Collection, Conversation, ConversationView } from '../archive/types';
import { rpc } from '../rpc';
import { CollectionSelect, Dialog, Feedback, useAction, useAsync } from './components';
import { ExportEditor } from './document-tools';
import { coverageLabel, relativeTime, roleLabel } from './format';
import { Reader, type ReaderTarget } from './reader';
import { ALL_COLLECTIONS, PAGE_SIZE, UNKNOWN_MODEL, type SearchFilter, type SearchRequest, type SearchResponse } from './search';

const start = (date: string): number | undefined => date ? new Date(`${date}T00:00:00`).valueOf() : undefined;
const end = (date: string): number | undefined => date ? new Date(`${date}T23:59:59.999`).valueOf() : undefined;

function useSearch(request: Omit<SearchRequest, 'version'>, revision: number) {
  const worker = useRef<Worker>();
  const counter = useRef(0);
  const [response, setResponse] = useState<SearchResponse>();
  const [workerError, setWorkerError] = useState('');
  useEffect(() => {
    worker.current = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    worker.current.onmessage = (event: MessageEvent<SearchResponse>) => {
      if (event.data.version === counter.current) setResponse(event.data);
    };
    worker.current.onerror = () => setWorkerError('Search could not start. Reopen the library to try again.');
    return () => worker.current?.terminate();
  }, []);
  const dependencies = JSON.stringify([request, revision]);
  useEffect(() => {
    const version = ++counter.current;
    setResponse(undefined);
    const timer = setTimeout(() => worker.current?.postMessage({ ...request, version }), request.query ? 90 : 0);
    return () => clearTimeout(timer);
  }, [dependencies]);
  return { response, workerError };
}

export function LibraryPage({ collections, settings, revision, onCollection, deletedIds }: {
  collections: Collection[]; settings?: ArchiveSettings; revision: number; onCollection: (collection: Collection) => void; deletedIds: string[];
}) {
  const [scope, setScope] = useState('');
  const [savedOnly, setSavedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [dateField, setDateField] = useState<SearchFilter['dateField']>('updatedAt');
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<ReaderTarget | null>(null);
  const [selectedChats, setSelectedChats] = useState(new Map<string, string>());
  const [exportReady, setExportReady] = useState<ConversationView[]>([]);
  const [lastModels, setLastModels] = useState<string[]>([]);
  const [localRefresh, setLocalRefresh] = useState(0);
  const { run, busy, error } = useAction();
  const scopeId = scope || collections[0]?.id || '';
  const archiveRevision = revision + localRefresh;
  const filtered = !!(query.trim() || savedOnly || role || model || since || until);
  const filter: SearchFilter = { collectionId: scopeId, savedOnly, role: role ? role as SearchFilter['role'] : undefined,
    model: model || undefined, since: start(since), until: end(until), dateField };
  const { response, workerError } = useSearch({ offset, filter, query }, archiveRevision);
  const result = useAsync(() => scopeId ? rpc<Conversation[]>('listConversations', [scopeId === ALL_COLLECTIONS ? undefined : scopeId]) : Promise.resolve([]), [scopeId, archiveRevision]);
  const allChats = (result.value ?? []).filter(({ id }) => !deletedIds.includes(id));
  const listed = allChats.slice(offset, offset + PAGE_SIZE);
  const searchHits = response?.documents.filter((item) => !deletedIds.includes(item.conversationId));
  const readerTarget = target && !deletedIds.includes(target.conversationId) ? target : null;
  const exportViews = exportReady.filter((view) => !deletedIds.includes(view.conversation.id));
  const more = filtered ? response?.more : allChats.length > offset + PAGE_SIZE;

  useEffect(() => { setOffset(0); }, [query, scopeId, savedOnly, role, model, dateField, since, until]);
  useEffect(() => { if (response?.models) setLastModels(response.models); }, [response?.models]);
  useEffect(() => { if (result.value) setSelectedChats((previous) => new Map([...previous].filter(([id]) => result.value?.some((chat) => chat.id === id)))); }, [result.value]);
  useEffect(() => {
    setTarget((previous) => previous && deletedIds.includes(previous.conversationId) ? null : previous);
    setExportReady((previous) => previous.filter((view) => !deletedIds.includes(view.conversation.id)));
  }, [deletedIds]);

  const open = (next: ReaderTarget) => {
    setTarget(next);
    requestAnimationFrame(() => document.getElementById('reader-anchor')?.focus());
  };
  const toggleChat = (chat: Conversation, checked: boolean) => setSelectedChats((current) => {
    const next = new Map(current);
    if (checked && chat.segmentId) next.set(chat.id, chat.segmentId); else next.delete(chat.id);
    return next;
  });
  const exportSelected = () => run(async () => {
    const views = await Promise.all([...selectedChats].map(([id, segmentId]) => rpc<ConversationView | undefined>('getConversation', [id, segmentId])));
    const ready = views.filter((view): view is ConversationView => Boolean(view?.messages.length));
    if (ready.length) setExportReady(ready);
  });

  return <main class={`library ${readerTarget ? 'reading' : ''}`}>
    <section class="list-pane stack" aria-label="Local library">
      <div><h1>Local library</h1><p class="muted">Saved ChatGPT conversations on this device.</p></div>
      <label class="field search-field">Search saved chats
        <input type="search" value={query} maxLength={500} placeholder="Search titles, messages, tags, and notes" onInput={(event) => setQuery(event.currentTarget.value)} />
      </label>
      <div class="row responsive">
        <CollectionSelect collections={collections} value={scopeId} change={(id) => { setScope(id); setLastModels([]); setModel(''); setTarget(null); setSelectedChats(new Map()); }} all={collections.length > 1 ? ALL_COLLECTIONS : undefined} />
        <div class="segmented" aria-label="Library view">
          <button aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>All chats</button>
          <button aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}>Saved</button>
        </div>
      </div>
      <details><summary>Filters</summary><div class="filter-grid">
        <label class="field">Role<select value={role} onChange={(event) => setRole(event.currentTarget.value)}>
          <option value="">Any role</option><option value="user">You</option><option value="assistant">Assistant</option>
        </select></label>
        <label class="field">Reported model<select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
          <option value="">Any model</option><option value={UNKNOWN_MODEL}>Unknown</option>
          {lastModels.map((id) => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <label class="field">Date type<select value={dateField} onChange={(event) => setDateField(event.currentTarget.value === 'capturedAt' ? 'capturedAt' : 'updatedAt')}>
          <option value="updatedAt">Updated date</option><option value="capturedAt">Captured date</option>
        </select></label>
        <label class="field">From<input type="date" value={since} onChange={(event) => setSince(event.currentTarget.value)} /></label>
        <label class="field">Through<input type="date" value={until} onChange={(event) => setUntil(event.currentTarget.value)} /></label>
      </div></details>
      {settings?.autoCapture === false && <p class="muted compact">Automatic saving is off. Your saved content is still searchable.</p>}
      <Feedback error={workerError || response?.error || result.error || error} text={response?.rebuilding ? `Building search index · ${response.indexed.toLocaleString()} messages ready` : undefined} />
      {selectedChats.size > 0 && <button type="button" disabled={busy} onClick={() => void exportSelected()}>Export {selectedChats.size} selected {selectedChats.size === 1 ? 'chat' : 'chats'}</button>}
      {(filtered ? !response : result.pending) && <Feedback text={filtered ? 'Searching local archive…' : 'Loading saved chats…'} />}
      {!filtered && !result.pending && listed.length === 0 && <div class="empty stack">
        <h2>No saved chats yet</h2><div class="actions"><a class="button primary" href="#settings">Enable saving</a><a class="button" href="#restore">Import Trace backup</a></div>
      </div>}
      {filtered && response && searchHits?.length === 0 && !response.rebuilding && <p class="muted">{savedOnly && !query.trim() ? 'No saved messages match this view.' : 'No matching results.'}</p>}
      <ul class="results" aria-label="Search results">
        {filtered ? searchHits?.map((item) => <li class="result" key={item.id}>
          <button class="result-button" aria-current={target?.revisionId === item.revisionId ? 'true' : undefined} onClick={() => open({
            conversationId: item.conversationId, revisionId: item.revisionId, segmentId: item.segmentId, savedId: item.savedId,
          })}>
            <strong>{item.title || 'Untitled chat'}</strong><span class="excerpt">{item.excerpt}</span>
            <span class="muted">{roleLabel(item.role)} · {relativeTime(item.updatedAt)} · {coverageLabel(item.coverage)}</span>
          </button>
        </li>) : listed.map((chat) => <li class="result with-select" key={chat.id}>
          <input type="checkbox" aria-label={`Select ${chat.title || 'Untitled chat'} for export`} checked={selectedChats.has(chat.id)} disabled={!chat.segmentId} onChange={(event) => toggleChat(chat, event.currentTarget.checked)} />
          <button class="result-button" aria-current={target?.conversationId === chat.id ? 'true' : undefined} onClick={() => open({ conversationId: chat.id, segmentId: chat.segmentId ?? undefined })}>
            <strong>{chat.title || 'Untitled chat'}</strong><span class="muted">{relativeTime(chat.lastObservedAt)} · {coverageLabel(chat.coverage)}</span>
          </button>
        </li>)}
      </ul>
      {(offset > 0 || more) && <nav class="actions" aria-label="Result pages">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
        <button type="button" disabled={!more} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
      </nav>}
    </section>
    <div id="reader-anchor" class="reader-anchor" tabIndex={-1}>
      {readerTarget ? <Reader key={`${readerTarget.conversationId}/${readerTarget.segmentId ?? ''}`} target={readerTarget} collections={collections} revision={archiveRevision} onCollection={onCollection}
        onBack={() => { setTarget(null); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.search-field input')?.focus()); }}
        onDeleted={() => { setTarget(null); setLocalRefresh((previous) => previous + 1); }}
        onSegment={(segmentId) => setTarget({ conversationId: readerTarget.conversationId, segmentId })} /> : <p class="reader-placeholder muted">Choose a conversation or search result to read its saved copy.</p>}
    </div>
    {exportViews.length > 0 && <Dialog title="Export saved conversations" onClose={() => setExportReady([])}><ExportEditor views={exportViews} /></Dialog>}
  </main>;
}
