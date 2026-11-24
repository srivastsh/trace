import { useEffect, useRef, useState } from 'preact/hooks';
import type { Collection, ConversationView, HandoffEvidence, MessageRevision, SavedItem } from '../archive/types';
import { rpc } from '../rpc';
import { CoverageSummary, Dialog, Feedback, SourceLink, useAction, useAsync } from './components';
import { ExportEditor, HandoffEditor } from './document-tools';
import { absoluteTime, coverageLabel, roleLabel, safeSource } from './format';
import { SavedFieldsForm, type SavedFields } from './stage';
import { savedEvidence, viewEvidence } from './transcripts';

export interface ReaderTarget { conversationId: string; segmentId?: string; revisionId?: string; savedId?: string }

function NoteDialog({ item, view, revision, onClose }: {
  item?: SavedItem; view: ConversationView; revision: MessageRevision | SavedItem; onClose: () => void;
}) {
  const [fields, setFields] = useState<SavedFields>({ label: item?.label ?? '', tags: item?.tags ?? [], note: item?.note ?? '' });
  const { busy, run, error } = useAction();
  return <Dialog title={item ? 'Edit saved message' : 'Save message'} onClose={onClose}>
    <form class="stack" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        if (item) await rpc('updateSaved', [item.id, fields]);
        else await rpc('saveMessage', [{ conversationId: view.conversation.id, revisionId: revision.id, ...fields }]);
        onClose();
      });
    }}>
      <p class="muted">Saved excerpts and private notes stay until you delete them.</p>
      <SavedFieldsForm value={fields} onChange={setFields} />
      <div class="actions">
        <button class="primary" type="submit" disabled={busy}>{item ? 'Update saved message' : 'Save message'}</button>
        {item && <button type="button" disabled={busy} onClick={() => void run(async () => { await rpc('deleteSaved', [item.id]); onClose(); })}>Remove saved message</button>}
      </div><Feedback error={error} busy={busy} />
    </form>
  </Dialog>;
}

function MessageBody({ message, item, edit, scroll, select, selected }: {
  message: MessageRevision | SavedItem; item?: SavedItem; edit: () => void;
  scroll?: boolean; select?: (value: boolean) => void; selected?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (scroll) ref.current?.scrollIntoView({ block: 'start' }); }, [scroll]);
  return <article class="message stack" ref={ref} aria-label={`${roleLabel(message.role)} message`}>
    <div class="section-heading">
      <h3>{item?.label || roleLabel(message.role)}</h3>
      <div class="actions">
        {select && <label class="check"><input type="checkbox" checked={selected} onChange={(event) => select(event.currentTarget.checked)} /> Select excerpt</label>}
        <button type="button" onClick={edit}>{item ? 'Edit saved message' : 'Save message'}</button>
      </div>
    </div>
    <pre class="transcript-body">{message.text}</pre>
    {item && <>
      {item.tags.length > 0 && <ul class="tags" aria-label="Tags">{item.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
      {item.note && <div class="private-note"><strong>Private note</strong><p>{item.note}</p></div>}
    </>}
    <details class="muted"><summary>Message details</summary>
      <dl><dt>Role</dt><dd>{roleLabel(message.role)}</dd>
        <dt>Captured</dt><dd>{absoluteTime('observedAt' in message ? message.observedAt : message.capturedAt)}</dd>
        <dt>Message</dt><dd>{message.messageId}</dd>
        <dt>Revision</dt><dd>{'revisionId' in message ? message.revisionId : message.id}</dd>
        {message.activity?.model && <><dt>Reported response model</dt><dd>{message.activity.model.value}</dd>
          <dt>Observed from</dt><dd>{message.activity.model.endpoint} · {message.activity.model.sourceField} · adapter {message.activity.model.adapterVersion}</dd></>}
      </dl>
    </details>
  </article>;
}

function ReaderContent({ view, target, selectSegment, onDeleted, onBack, collections, onCollection }: {
  view: ConversationView; target: ReaderTarget; selectSegment: (id: string) => void; onDeleted: () => void; onBack: () => void;
  collections: Collection[]; onCollection: (collection: Collection) => void;
}) {
  const [modal, setModal] = useState<'delete' | 'export' | null>(null);
  const [note, setNote] = useState<{ message: MessageRevision | SavedItem; item?: SavedItem } | null>(null);
  const [selection, setSelection] = useState(new Set<string>());
  const [handoff, setHandoff] = useState<HandoffEvidence[] | null>(null);
  const [status, setStatus] = useState('');
  const { run, error, busy } = useAction();
  const { conversation, segment, messages, expired, saved, segments } = view;
  const savedTarget = saved.find(({ id }) => id === target.savedId);
  const savedOnly = Boolean(savedTarget && (expired || messages.every(({ id }) => id !== savedTarget.revisionId)));
  const shown = savedOnly && savedTarget ? [savedTarget] : messages;
  const evidence = savedOnly && savedTarget ? [savedEvidence(savedTarget)] : viewEvidence(view, selection.size ? selection : undefined);
  return <div class="reader-content stack">
    <div class="section-heading"><button type="button" class="mobile-back" onClick={onBack}>← Back</button><SourceLink url={conversation.sourceUrl} /></div>
    <h2>{conversation.title || 'Untitled chat'}</h2>
    <p class="muted">{view.collection.label} · Captured {absoluteTime(conversation.firstObservedAt)} · Updated {absoluteTime(conversation.lastObservedAt)}</p>
    <CoverageSummary coverage={savedOnly && savedTarget ? savedTarget.coverage : segment?.coverage ?? conversation.coverage} />
    {safeSource(conversation.sourceUrl) && <p class="muted compact">ChatGPT opens the conversation. This saved copy stays at the selected message.</p>}
    {expired && <p class="notice">The transcript has expired. Explicitly saved excerpts and notes are still available.</p>}
    {!savedOnly && segments.length > 1 && <label class="field">Branch or capture segment
      <select value={segment?.id ?? ''} onChange={(event) => selectSegment(event.currentTarget.value)}>
        {segments.map((item, index) => <option key={item.id} value={item.id}>
          {item.leafId ? 'Branch' : 'Capture segment'} {index + 1} · {coverageLabel(item.coverage)} · {absoluteTime(item.observedAt)}
        </option>)}
      </select></label>}
    <div class="actions">
      {messages.length > 0 && !savedOnly && <button type="button" onClick={() => setModal('export')}>Export {selection.size ? 'selected excerpts' : 'chat'}</button>}
      {shown.length > 0 && <button type="button" onClick={() => setHandoff(handoff ? null : evidence)}>{handoff ? 'Close handoff' : 'Prepare handoff'}</button>}
      <button type="button" onClick={() => setModal('delete')}>Delete local copy</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await rpc('setConversationExcluded', [conversation.id, false]);
        setStatus('Automatic saving may resume when this chat meets your capture settings.');
      })}>Resume saving</button>
    </div>
    <Feedback error={error} text={status} />
    {handoff && <section class="stack inset"><h2>Prepare handoff</h2>
      <HandoffEditor title={conversation.title} evidence={handoff} collections={collections} collectionId={view.collection.id} onCollection={onCollection} />
    </section>}
    {shown.length === 0 && <p class="muted">No messages are available in this saved copy.</p>}
    {shown.map((message) => {
      const item = 'revisionId' in message ? message : saved.find((savedItem) => savedItem.revisionId === message.id);
      return <MessageBody key={message.id} message={message} item={item} edit={() => setNote({ message, item })}
        scroll={message.id === target.revisionId || Boolean(target.savedId && item?.id === target.savedId)}
        selected={selection.has(message.id)} select={savedOnly ? undefined : (checked) => setSelection((previous) => {
          const next = new Set(previous);
          if (checked) next.add(message.id); else next.delete(message.id);
          return next;
        })} />;
    })}
    {note && <NoteDialog view={view} item={note.item} revision={note.message} onClose={() => setNote(null)} />}
    {modal === 'export' && <Dialog title="Export chat" onClose={() => setModal(null)}>
      <ExportEditor views={[view]} selection={selection.size ? [...selection] : undefined} />
    </Dialog>}
    {modal === 'delete' && <Dialog title="Delete local copy?" onClose={() => setModal(null)}>
      <div class="stack"><p>This removes the local transcript, its saved messages and notes, and its evidence in handoff drafts. ChatGPT still keeps the original conversation.</p>
        <p class="muted">Trace will skip automatic recapture until you explicitly resume saving this chat.</p>
        <button class="danger" disabled={busy} onClick={() => void run(async () => { await rpc('deleteConversation', [view.conversation.id]); onDeleted(); })}>Delete local copy</button>
        <Feedback busy={busy} error={error} />
      </div>
    </Dialog>}
  </div>;
}

export function Reader({ target, revision, onBack, onDeleted, onSegment, collections, onCollection }: {
  target: ReaderTarget; revision: number; onBack: () => void; onDeleted: () => void; onSegment: (segmentId: string) => void;
  collections: Collection[]; onCollection: (collection: Collection) => void;
}) {
  const { value, pending, error } = useAsync(() => rpc<ConversationView | undefined>('getConversation', [target.conversationId, target.segmentId]), [target.conversationId, target.segmentId, revision], true);
  return <section class="reader" aria-label="Saved copy">
    {value ? <ReaderContent key={`${target.conversationId}/${target.segmentId ?? ''}`} view={value} target={target} onBack={onBack} onDeleted={onDeleted}
      selectSegment={onSegment} collections={collections} onCollection={onCollection} /> : <div class="stack reader-content">
      <button type="button" class="mobile-back" onClick={onBack}>← Back</button>
      <Feedback busy={pending} error={error} text={!pending && !error ? 'This saved copy is unavailable.' : undefined} />
    </div>}
  </section>;
}
