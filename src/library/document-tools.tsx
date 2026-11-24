import { useEffect, useMemo, useState } from 'preact/hooks';
import { makeConversationExport } from '../archive/backup';
import type { Collection, ConversationView, HandoffDraft, HandoffEvidence } from '../archive/types';
import { rpc } from '../rpc';
import { CollectionSelect, CoverageSummary, Feedback, NewCollection, useAction } from './components';
import { blankNotes, handoffFields, newFile, renderHandoff, renderTranscript, roleLabel, shortenExcerpt, templates, type DocumentFormat } from './format';
import { evidenceTranscripts, fromView } from './transcripts';

function DocumentActions({ value, filename, format, copyLabel }: { value: string; filename: string; format: DocumentFormat; copyLabel: string }) {
  const [status, setStatus] = useState('');
  return <><div class="actions">
    <button type="button" class="primary" onClick={() => newFile(value, filename, format)}>Download {format === 'json' ? 'JSON' : format === 'text' ? 'text' : 'Markdown'}</button>
    <button type="button" onClick={() => {
      const failed = () => setStatus('Clipboard unavailable. Open the preview to select and copy the text.');
      if (navigator.clipboard) void navigator.clipboard.writeText(value).then(() => setStatus('Copied.'), failed);
      else failed();
    }}>{copyLabel}</button>
  </div><Feedback text={status} />
  <details class="preview"><summary>Document preview</summary><textarea aria-label="Document preview" readOnly value={value} rows={12} /></details></>;
}

export function ExportEditor({ views, selection }: { views: ConversationView[]; selection?: string[] }) {
  const [format, setFormat] = useState<DocumentFormat>('markdown');
  const [exportedAt] = useState(Date.now());
  const transcripts = useMemo(() => views.map((view) => {
    const transcript = fromView(view);
    return selection ? { ...transcript, selected: true, messages: transcript.messages.filter((item) => selection.includes(item.revisionId ?? '')) } : transcript;
  }), [views, selection]);
  const value = useMemo(() => format === 'json'
    ? JSON.stringify({ ...makeConversationExport(views, selection), exportedAt }, null, 2)
    : renderTranscript(transcripts, format, exportedAt), [format, transcripts, views, selection, exportedAt]);
  const filename = views.length === 1 ? views[0]?.conversation.title || 'trace-conversation' : 'trace-conversations';
  return <section class="stack">
    <p class="muted">{selection ? 'Selected excerpts' : 'Selected branch or capture segment'} · {transcripts.reduce((total, item) => total + item.messages.length, 0)} messages</p>
    {transcripts.map((item, index) => <div key={index}>{transcripts.length > 1 && <strong>{item.title}</strong>}<CoverageSummary coverage={item.coverage} /></div>)}
    <label class="field">Format<select value={format} onChange={(event) => setFormat(event.currentTarget.value as DocumentFormat)}>
      <option value="markdown">Markdown</option><option value="text">Plain text</option><option value="json">Trace JSON</option>
    </select></label>
    <DocumentActions value={value} filename={filename} format={format} copyLabel={`Copy ${format === 'json' ? 'JSON' : format === 'text' ? 'text' : 'Markdown'}`} />
  </section>;
}

const noDeletedIds: string[] = [];

export function HandoffEditor({ title: initialTitle, evidence: initialEvidence, draft, collections, collectionId, onCollection, onSaved, deletedIds = noDeletedIds }: {
  title: string; evidence: HandoffEvidence[]; draft?: HandoffDraft; collections: Collection[]; collectionId?: string;
  onCollection: (collection: Collection) => void; onSaved?: (id: string) => void; deletedIds?: string[];
}) {
  const [id, setId] = useState(draft?.id);
  const [createdAt] = useState(draft?.createdAt ?? Date.now());
  const [title, setTitle] = useState(draft?.title ?? initialTitle);
  const [notes, setNotes] = useState(draft?.notes ?? blankNotes());
  const [template, setTemplate] = useState<HandoffDraft['template']>(draft?.template ?? 'general');
  const [budget, setBudget] = useState(draft?.budget ?? 20_000);
  const [editorEvidence, setEvidence] = useState(initialEvidence.map((item, index) => ({ key: index, source: item, keep: item.text.length, selected: true })));
  const [format, setFormat] = useState<'markdown' | 'text'>('markdown');
  const [destination, setDestination] = useState(draft?.collectionId ?? collectionId ?? collections[0]?.id ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const { run, error, busy } = useAction();
  const evidence = useMemo(() => editorEvidence.map((item) => item.source.conversationId && deletedIds.includes(item.source.conversationId)
    ? { ...item, keep: 0, source: { ...item.source, text: '', activity: undefined, unavailable: true } } : item), [editorEvidence, deletedIds]);
  useEffect(() => { if (deletedIds.length) setEvidence(evidence); }, [deletedIds]);
  const selected = useMemo(() => evidence.filter(({ selected }) => selected).map(({ source, keep }) => ({
    ...source, text: source.unavailable ? '' : shortenExcerpt(source.text, keep),
  })), [evidence]);
  const document = useMemo(() => renderHandoff(title, notes, evidenceTranscripts(selected, createdAt), format, createdAt),
    [title, notes, selected, format, createdAt]);
  const words = document.trim().split(/\s+/u).length;
  const over = document.length > budget;
  const largest = over ? new Set(evidence.filter((item) => item.selected && !item.source.unavailable)
    .sort((a, b) => b.keep - a.keep).slice(0, 3).map(({ key }) => key)) : new Set<number>();
  const templateIndex = templates.findIndex((item) => item.id === template);

  const submit = () => run(async () => {
    if (!destination) return;
    const draftId = id ?? crypto.randomUUID();
    await rpc('saveDraft', [{ id: draftId, collectionId: destination, title: title.trim() || 'Handoff',
      template, budget, notes, evidence: selected, createdAt, updatedAt: Date.now() } satisfies HandoffDraft]);
    setId(draftId);
    setStatus('Draft saved.');
    onSaved?.(draftId);
  });

  return <div class="handoff-layout">
    <section class="stack">
      <div class="row responsive">
        <label class="field grow">Draft title<input maxLength={240} value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
        <label class="field">Template<select value={template} onChange={(event) => setTemplate(event.currentTarget.value as HandoffDraft['template'])}>
          {templates.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}
        </select></label>
      </div>
      {handoffFields.map(({ key, label, hints }) => <label key={key} class="field">{label}
        <textarea rows={3} placeholder={hints[templateIndex]} value={notes[key]} onInput={(event) => setNotes({ ...notes, [key]: event.currentTarget.value })} />
      </label>)}
    </section>
    <aside class="stack" aria-label="Handoff evidence and export">
      <div class="section-heading"><h2>Selected evidence</h2><span class="muted">{selected.length} selected</span></div>
      {evidence.length === 0 && <p class="muted">No excerpts available.</p>}
      {evidence.map((item) => <details class={`evidence ${largest.has(item.key) ? 'largest' : ''}`} key={item.key}>
        <summary>{roleLabel(item.source.role)} · {item.source.title || 'Untitled chat'}{item.source.unavailable ? ' · Unavailable' : ` · ${item.keep.toLocaleString()} chars`}
          {largest.has(item.key) && <strong> · Large excerpt</strong>}</summary>
        <CoverageSummary coverage={item.source.coverage} />
        <label class="check"><input type="checkbox" checked={item.selected} onChange={(event) => {
          const selected = event.currentTarget.checked;
          setEvidence((previous) => previous.map((entry) => entry.key === item.key ? { ...entry, selected } : entry));
        }} /> Include excerpt</label>
        {!item.source.unavailable && <>
          <pre class="transcript-body">{shortenExcerpt(item.source.text, Math.min(item.keep, 350))}</pre>
          <label class="field">Keep first characters<input type="number" min="0" max={item.source.text.length} value={item.keep} onChange={(event) => {
            const keep = Math.min(item.source.text.length, Math.max(0, Number(event.currentTarget.value)));
            setEvidence((previous) => previous.map((entry) => entry.key === item.key ? { ...entry, keep } : entry));
          }} /></label>
        </>}
      </details>)}
      <div class="row responsive">
        <label class="field">Size budget (characters)<input type="number" min="100" max="500000" value={budget} onChange={(event) => {
          setBudget(Math.min(500_000, Math.max(100, Number(event.currentTarget.value))));
        }} /></label>
        <span class={over ? 'error' : 'muted'} role="status">{document.length.toLocaleString()} characters · {words.toLocaleString()} words{over ? ' · Over budget' : ''}</span>
      </div>
      <label class="field">Format<select value={format} onChange={(event) => setFormat(event.currentTarget.value === 'text' ? 'text' : 'markdown')}>
        <option value="markdown">Markdown</option><option value="text">Plain text</option>
      </select></label>
      <DocumentActions value={document} filename={title || 'trace-handoff'} format={format} copyLabel={format === 'text' ? 'Copy text' : 'Copy Markdown'} />
      {saving ? <div class="stack inset">
        <CollectionSelect collections={collections} value={destination} change={setDestination} label="Draft collection" />
        {collections.length === 0 && <NewCollection onCreate={(collection) => { onCollection(collection); setDestination(collection.id); }} />}
        <button type="button" disabled={busy || !destination} onClick={() => void submit()}>Confirm save draft</button>
      </div> : <button type="button" disabled={busy} onClick={() => {
        if (destination) void submit();
        else setSaving(true);
      }}>Save draft</button>}
      <Feedback error={error} text={status} busy={busy} />
    </aside>
  </div>;
}
