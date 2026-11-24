import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Collection } from '../archive/types';
import type { Stage } from '../contracts';
import { rpc } from '../rpc';
import { CollectionSelect, CoverageSummary, Feedback, NewCollection, retentionLabel, SourceLink, useAction, useAsync } from './components';
import { ExportEditor, HandoffEditor } from './document-tools';
import { roleLabel, safeSource } from './format';
import { stagedView, viewEvidence } from './transcripts';

export interface SavedFields { label: string; tags: string[]; note: string }

export function SavedFieldsForm({ value, onChange }: { value: SavedFields; onChange: (value: SavedFields) => void }) {
  const [tags, setTags] = useState(value.tags.join(', '));
  return <>
    <label class="field">Label<input maxLength={160} value={value.label} onInput={(event) => onChange({ ...value, label: event.currentTarget.value })} /></label>
    <label class="field">Tags (comma separated)<input maxLength={480} value={tags} onInput={(event) => {
      setTags(event.currentTarget.value);
      onChange({ ...value, tags: [...new Set(event.currentTarget.value.split(',').map((tag) => tag.trim().slice(0, 64)).filter(Boolean))].slice(0, 20) });
    }} /></label>
    <label class="field">Private note<textarea rows={4} maxLength={16_384} value={value.note} onInput={(event) => onChange({ ...value, note: event.currentTarget.value })} /></label>
  </>;
}

function StageReview({ stage, collections, onCollection }: { stage: Stage; collections: Collection[]; onCollection: (collection: Collection) => void }) {
  const { action, projection } = stage;
  const view = useMemo(() => stagedView(projection, stage.id), [projection, stage.id]);
  const [selected, setSelected] = useState(new Set(view.messages.filter((message) => !stage.messageId || message.messageId === stage.messageId).map(({ id }) => id)));
  const [destination, setDestination] = useState('');
  const [saveExcerpts, setSaveExcerpts] = useState(action === 'save-message');
  const [savedFields, setSavedFields] = useState<SavedFields>({ label: '', tags: [], note: '' });
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  useEffect(() => {
    const invalidate = (message: { v: number; event?: string; providerId?: string; sourceUrl?: string }) => {
      if (message.v === 1 && message.event === 'archive-chat-deleted' &&
        (message.providerId === projection.providerId || (message.sourceUrl && message.sourceUrl === projection.sourceUrl))) {
        location.hash = 'library';
      }
    };
    chrome.runtime.onMessage.addListener(invalidate);
    return () => chrome.runtime.onMessage.removeListener(invalidate);
  }, [projection.providerId, projection.sourceUrl]);
  const destinationId = destination || collections[0]?.id || '';
  const collection = collections.find(({ id }) => id === destinationId);
  const evidence = useMemo(() => viewEvidence(view), [view]);
  const heading = { save: 'Save chat', 'save-message': 'Save message', export: 'Export chat', handoff: 'Prepare handoff' }[action];
  const picked = view.messages.filter(({ id }) => selected.has(id));
  const all = picked.length === view.messages.length;
  return <main class={action === 'handoff' ? 'page wide stack' : 'page stack'}>
    <div class="section-heading"><div><h1>{heading}</h1><p class="muted">{projection.title || 'Untitled chat'}</p></div><SourceLink url={projection.sourceUrl} /></div>
    {!safeSource(projection.sourceUrl) && <p class="muted compact">Source conversation URL unavailable.</p>}
    <CoverageSummary coverage={projection.coverage} />
    {action === 'handoff' ? <HandoffEditor title={projection.title} evidence={evidence} collections={collections} onCollection={onCollection} /> :
      done ? <div class="stack"><p role="status">{saveExcerpts ? 'Selected messages saved.' : 'Chat saved.'}</p><a class="button primary" href="#library">Open Local library</a></div> : <>
        <section class="stack" aria-label="Review captured messages">
          <div class="section-heading"><h2>Review messages</h2><span class="muted">{picked.length} of {view.messages.length} selected</span></div>
          {view.messages.map((message) => <article class="review-row" key={message.id}>
            <label class="check"><input type="checkbox" checked={selected.has(message.id)} onChange={(event) => {
              const checked = event.currentTarget.checked;
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(message.id); else next.delete(message.id);
                return next;
              });
            }} />{roleLabel(message.role)} · {message.text.length.toLocaleString()} characters</label>
            <details><summary>Preview message</summary><pre class="transcript-body">{message.text}</pre></details>
          </article>)}
        </section>
        {action === 'export' ? (picked.length > 0 ? <ExportEditor views={[view]} selection={all ? undefined : picked.map(({ id }) => id)} /> : <p class="muted">Select messages to export.</p>) : <section class="stack inset">
          <h2>Save to collection</h2>
          <CollectionSelect collections={collections} value={destinationId} change={setDestination} />
          <NewCollection onCreate={(created) => { onCollection(created); setDestination(created.id); }} />
          {action === 'save' && <label class="check"><input type="checkbox" checked={saveExcerpts} onChange={(event) => setSaveExcerpts(event.currentTarget.checked)} /> Save as individual messages</label>}
          {saveExcerpts && <SavedFieldsForm value={savedFields} onChange={setSavedFields} />}
          {collection && <p class="muted">Transcript retention · {retentionLabel(collection.retention)}.
            {saveExcerpts && ' Explicitly saved messages and notes stay until you delete them.'}
            {!all && ` ${picked.length} selected excerpts will be saved.`}</p>}
          <p class="muted">This save applies to your current selection. Manage ongoing capture in Settings.</p>
          <button type="button" class="primary" disabled={busy || picked.length === 0 || !collection} onClick={() => void run(async () => {
            await rpc('saveStage', { id: stage.id, collectionId: destinationId,
              selectedMessageIds: all && !saveExcerpts ? undefined : picked.map(({ messageId }) => messageId), savedItem: saveExcerpts ? savedFields : undefined });
            setDone(true);
          })}>{saveExcerpts ? 'Save selected messages' : 'Save chat'}</button>
          <Feedback busy={busy} error={error} />
        </section>}
      </>}
  </main>;
}

export function StagePage({ id, collections, onCollection }: { id: string; collections: Collection[]; onCollection: (collection: Collection) => void }) {
  const { value, error, pending } = useAsync(() => rpc<Stage>('readStage', { id }), [id]);
  if (value) return <StageReview key={value.id} stage={value} collections={collections} onCollection={onCollection} />;
  return <main class="page stack"><h1>Review selection</h1><Feedback busy={pending} error={error || (pending ? undefined : 'The selection expired. Open the action again from ChatGPT.')} /></main>;
}
