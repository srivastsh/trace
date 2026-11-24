import { useState } from 'preact/hooks';
import type { Collection, HandoffDraft } from '../archive/types';
import { rpc } from '../rpc';
import { Dialog, Feedback, useAction, useAsync } from './components';
import { HandoffEditor } from './document-tools';
import { relativeTime } from './format';

export function DraftsPage({ id, collections, revision, onCollection, deletedIds }: {
  id?: string; collections: Collection[]; revision: number; onCollection: (collection: Collection) => void; deletedIds: string[];
}) {
  const drafts = useAsync(() => rpc<HandoffDraft[]>('listDrafts'), [revision], true);
  const [editing, setEditing] = useState(false);
  const [remove, setRemove] = useState<HandoffDraft>();
  const { run, busy, error } = useAction();
  const selected = id ? drafts.value?.find((draft) => draft.id === id) : undefined;
  if (selected) return <main class="page wide stack">
    <div class="section-heading"><h1>Prepare handoff</h1><a class="button" href="#drafts">Handoff drafts</a></div>
    <HandoffEditor key={selected.id} title={selected.title} evidence={selected.evidence} draft={selected} collections={collections} onCollection={onCollection} deletedIds={deletedIds} />
  </main>;
  return <main class="page stack">
    <div class="section-heading"><h1>Handoff drafts</h1><button type="button" onClick={() => setEditing(true)}>New handoff</button></div>
    {editing && <HandoffEditor title="Handoff" evidence={[]} collections={collections} onCollection={onCollection} onSaved={(id) => { setEditing(false); location.hash = `drafts/${id}`; }} />}
    <Feedback busy={drafts.pending} error={drafts.error || error} />
    {!drafts.pending && !drafts.value?.length && <p class="muted">No drafts yet. Prepare a handoff from a conversation or start with blank notes.</p>}
    <ul class="results" aria-label="Saved handoffs">
      {drafts.value?.map((draft) => <li class="section-heading draft-row" key={draft.id}>
        <a class="stack draft-link" href={`#drafts/${draft.id}`}><strong>{draft.title}</strong><span class="muted">{collections.find(({ id }) => id === draft.collectionId)?.label ?? 'Collection'} · {relativeTime(draft.updatedAt)} · {draft.evidence.length} excerpts</span></a>
        <button type="button" onClick={() => setRemove(draft)}>Delete draft</button>
      </li>)}
    </ul>
    {remove && <Dialog title="Delete handoff draft?" onClose={() => setRemove(undefined)}><div class="stack">
      <p>This removes “{remove.title}” and its copied excerpts from saved drafts.</p>
      <button class="danger" disabled={busy} onClick={() => void run(async () => { await rpc('deleteDraft', [remove.id]); setRemove(undefined); })}>Delete draft</button>
      <Feedback error={error} busy={busy} />
    </div></Dialog>}
  </main>;
}
