import { useState } from 'preact/hooks';
import type { Collection, ImportJob, ImportPreview } from '../archive/types';
import { rpc } from '../rpc';
import { Dialog, Feedback, useAction, useAsync } from './components';
import { absoluteTime } from './format';

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

async function finishRestore(id: string, changed: () => void): Promise<ImportJob> {
  let job: ImportJob;
  do {
    job = await rpc<ImportJob>('resumeImport', [id]);
    changed();
  } while (job.state === 'pending');
  return job;
}

function ImportJobs({ revision, changed }: { revision: number; changed: () => void }) {
  const { value, error } = useAsync(() => rpc<ImportJob[]>('listJobs'), [revision], true);
  const [remove, setRemove] = useState<ImportJob | null>(null);
  const { run, busy, error: jobError } = useAction();
  if (!value?.length && !error && !jobError) return null;
  return <section class="settings-section stack">
    <h2>Restore history</h2>
    {value?.map((job) => <article class="stack inset" key={job.id}>
      <strong>{job.state === 'complete' ? 'Restore complete' : job.state === 'failed' ? 'Restore incomplete · error' : 'Restore incomplete'}</strong>
      <p class="muted">{absoluteTime(job.createdAt)} · {job.processed} of {job.total} steps</p>
      <progress aria-label="Restore progress" value={job.processed} max={Math.max(1, job.total)} />
      {job.error && <p class="error">{job.error}</p>}
      {job.state !== 'complete' && <div class="actions">
        <button disabled={busy} onClick={() => void run(async () => { await finishRestore(job.id, changed); })}>Resume restore</button>
        <button disabled={busy} onClick={() => setRemove(job)}>Remove incomplete import</button>
      </div>}
    </article>)}
    <Feedback error={error || jobError} busy={busy} />
    {remove && <Dialog title="Remove incomplete import?" onClose={() => setRemove(null)}><div class="stack">
      <p>This removes the records created by this restore job. Data that was already in Trace stays available.</p>
      <button class="danger" disabled={busy} onClick={() => void run(async () => {
        await rpc('removeImport', [remove.id]); setRemove(null); changed();
      })}>Remove incomplete import</button>
      <Feedback error={jobError} busy={busy} />
    </div></Dialog>}
  </section>;
}

export function RestorePage({ collections, revision, changed }: { collections: Collection[]; revision: number; changed: () => void }) {
  const [pending, setPending] = useState<{ filename: string; input: unknown; preview: ImportPreview }>();
  const [destination, setDestination] = useState('');
  const [status, setStatus] = useState('');
  const { run, busy, error } = useAction();
  return <main class="page stack">
    <div><h1>Import Trace backup</h1><p class="muted">Restore a Trace backup or a Trace conversation JSON export from this device.</p></div>
    <label class="field">Trace JSON file<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      setPending(undefined);
      setStatus('');
      setDestination('');
      if (!file) return;
      void run(async () => {
        if (file.size > MAX_BACKUP_BYTES) throw new Error('This file is too large to preview. Choose a smaller Trace backup.');
        let input: unknown;
        try { input = JSON.parse(await file.text()); }
        catch { throw new Error('This file does not contain valid JSON.'); }
        const preview = await rpc<ImportPreview>('previewImport', [input]);
        setPending({ filename: file.name, input, preview });
      });
    }} /></label>
    {pending && <section class="settings-section stack">
      <h2>Restore preview</h2>
      <p>{pending.filename} · {pending.preview.kind === 'backup' ? 'Trace backup' : 'Trace conversation export'}</p>
      <dl class="metrics"><dt>Collections</dt><dd>{pending.preview.collections.length}</dd><dt>Chats</dt><dd>{pending.preview.conversations}</dd>
        <dt>Message revisions</dt><dd>{pending.preview.revisions}</dd><dt>Saved messages</dt><dd>{pending.preview.saved}</dd><dt>Handoff drafts</dt><dd>{pending.preview.drafts}</dd></dl>
      {pending.preview.collections.length > 0 && <p class="muted">Source collections · {pending.preview.collections.map(({ label }) => label).join(', ')}</p>}
      <label class="field">Destination collection<select value={destination} onChange={(event) => setDestination(event.currentTarget.value)}>
        <option value="">Create restored collections</option>
        {collections.map(({ label, id }) => <option value={id} key={id}>Merge into {label}</option>)}
      </select></label>
      <p class="muted">Restored collections require fresh consent and binding before automatic capture.</p>
      <button class="primary" disabled={busy} onClick={() => void run(async () => {
        let job = await rpc<ImportJob>('startImport', [pending.input, destination || undefined]);
        setPending(undefined);
        changed();
        if (job.state === 'pending') job = await finishRestore(job.id, changed);
        setStatus(job.state === 'complete' ? 'Restore complete.' : 'Restore incomplete. Review the job below.');
      })}>Restore Trace data</button>
    </section>}
    <Feedback busy={busy} error={error} text={status} />
    <ImportJobs revision={revision} changed={changed} />
  </main>;
}
