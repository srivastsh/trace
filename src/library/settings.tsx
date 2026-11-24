import { useEffect, useState } from 'preact/hooks';
import type { ArchiveSettings, Collection, Retention, StorageStatus, TraceEnvelope } from '../archive/types';
import { PRODUCT } from '../product';
import { rpc } from '../rpc';
import { CollectionSelect, Dialog, Feedback, NewCollection, RetentionSelect, useAction, useAsync } from './components';
import { absoluteTime, newFile } from './format';

interface Target {
  providerId: string;
  temporary: 'ordinary' | 'temporary' | 'unknown';
  identityObserved: boolean;
  boundCollectionId: string | null;
  paused?: boolean;
  manualOrdinary?: boolean;
}

interface Diagnostic { code: string; at: number; count: number; adapter: string }

const diagnosticLabels: Record<string, string> = {
  'adapter-degraded': 'Some ChatGPT controls or fields were unavailable',
  'observer-cap': 'An observation reached its size or time limit',
  'stream-interrupted': 'A reply observation was interrupted',
  'storage-full': 'Local storage reached its limit',
  'cleanup-failed': 'Retention cleanup could not finish',
  'receiver-unavailable': 'The current ChatGPT page was unavailable',
};

function bytes(value?: number): string {
  if (value === undefined) return 'Unavailable';
  return `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

function Diagnostics() {
  const [revision, setRevision] = useState(0);
  const { value, error } = useAsync(() => rpc<Diagnostic[]>('diagnostics'), [revision]);
  const { run, busy, error: actionError } = useAction();
  return <section class="settings-section stack">
    <h2>Diagnostics</h2>
    <p class="muted">Recent local adapter and storage events. Reports contain event codes, timestamps, counts, and adapter version.</p>
    {value && value.length ? <ul class="diagnostic-list">
      {[...value].reverse().map((item, index) => <li key={index}>
        <strong>{diagnosticLabels[item.code] ?? item.code}</strong><span class="muted">{absoluteTime(item.at)} · {item.count} · {item.adapter}</span>
      </li>)}
    </ul> : <p class="muted">No recent events.</p>}
    <div class="actions">
      <button disabled={!value?.length} onClick={() => newFile(JSON.stringify({ version: PRODUCT.version, events: value?.map(({ code, at, count, adapter }) => ({ code, at, count, adapter })) }, null, 2), 'trace-diagnostics', 'json')}>Export diagnostics</button>
      <button disabled={busy || !value?.length} onClick={() => void run(async () => { await rpc('clearDiagnostics'); setRevision(revision + 1); })}>Clear diagnostics</button>
    </div>
    <Feedback error={error || actionError} />
  </section>;
}

function BackupReview({ collections, onClose }: { collections: Collection[]; onClose: () => void }) {
  const [selected, setSelected] = useState(new Set(collections.map(({ id }) => id)));
  const [data, setData] = useState<TraceEnvelope>();
  const { run, busy, error } = useAction();
  return <Dialog title="Export Trace backup" onClose={onClose}>
    <div class="stack">
      <p>Backup files include the selected collections’ captured text, saved messages, private notes, handoff drafts, and supported preferences.</p>
      {collections.map(({ label, id }) => <label class="check" key={id}><input type="checkbox" checked={selected.has(id)} onChange={(event) => {
        const checked = event.currentTarget.checked;
        const ids = new Set(selected);
        if (checked) ids.add(id); else ids.delete(id);
        setSelected(ids);
        setData(undefined);
      }} />{label}</label>)}
      {data && <p class="notice">Backup preview · {data.collections.length} collections · {data.conversations.length} chats · {data.saved.length} saved messages · {data.drafts.length} handoff drafts</p>}
      <div class="actions">
        <button disabled={busy || (collections.length > 0 && selected.size === 0)} onClick={() => void run(async () => {
          setData(await rpc<TraceEnvelope>('makeBackup', [[...selected]]));
        })}>Preview backup</button>
        <button class="primary" disabled={!data} onClick={() => {
          if (data) newFile(JSON.stringify(data, null, 2), 'trace-backup', 'json');
        }}>Download Trace backup</button>
      </div>
      <Feedback error={error} busy={busy} />
    </div>
  </Dialog>;
}

export function SettingsPage({ collections, settings, revision, onCollection, onChanged, welcome = false, deletions }: {
  collections: Collection[]; settings?: ArchiveSettings; revision: number; onCollection: (collection: Collection) => void;
  onChanged: () => void; welcome?: boolean; deletions: number;
}) {
  const target = useAsync(() => rpc<Target | null>('getTarget'), [revision]);
  const status = useAsync(() => welcome ? Promise.resolve(undefined) : rpc<StorageStatus>('storageStatus'), [revision, welcome]);
  const [collectionSelection, setCollectionSelection] = useState('');
  const [confirmConsent, setConfirmConsent] = useState(false);
  const [observed, setObserved] = useState(true);
  const [ordinary, setOrdinary] = useState(false);
  const [retention, setRetention] = useState<Retention>(90);
  const [modal, setModal] = useState<'clear' | 'backup' | null>(null);
  const [feedback, setFeedback] = useState('');
  const { busy, run, error } = useAction();
  const collectionId = collectionSelection || target.value?.boundCollectionId || collections[0]?.id || '';
  const collection = collections.find(({ id }) => id === collectionId);
  useEffect(() => { if (collection) setRetention(collection.retention); }, [collection?.id, collection?.retention]);

  const changeSettings = (patch: Partial<ArchiveSettings>) => rpc('setSettings', [patch]);
  const welcomeDone = async () => {
    await changeSettings({ welcomeComplete: true });
    location.hash = 'library';
  };
  const enable = () => run(async () => {
    if (!collection) return;
    if (target.value) await rpc('bindTarget', { collectionId, observed });
    await rpc('updateCollection', [collectionId, { autoConsent: true, retention }]);
    await changeSettings({ autoCapture: true, ...(welcome ? { welcomeComplete: true } : {}) });
    setConfirmConsent(false);
    onChanged();
    setFeedback(collection.autoExcluded ? `Automatic saving is on. ${collection.label} remains excluded.` :
      target.value ? `Automatic saving enabled for ${collection.label}.` : `Automatic saving enabled for ${collection.label}. Bind an eligible chat to start capture.`);
    if (welcome) location.hash = 'library';
  });
  const saving = settings?.autoCapture ?? false;
  const storage = status.value;
  return <main class="page stack">
    <div><h1>{welcome ? `Welcome to ${PRODUCT.name}` : 'Settings'}</h1>
      {welcome && <p>Activity uses reply information available to this browser. Some model, token, and limit details may be unavailable.</p>}
      <p class="muted">Trace data sits apart from ChatGPT history and stays on this device. The local archive uses browser storage without extension-level encryption.</p>
    </div>
    <section class="settings-section stack">
      <h2>Automatic saving</h2>
      <label class="check"><input type="checkbox" role="switch" checked={saving || confirmConsent} onChange={(event) => {
        if (event.currentTarget.checked) setConfirmConsent(true);
        else if (saving) void run(async () => {
          await changeSettings({ autoCapture: false });
          setConfirmConsent(false);
          onChanged();
          setFeedback('Saving off. Existing local copies are still available.');
        });
        else setConfirmConsent(false);
      }} disabled={busy || !settings} /> Save chats I open{welcome && ' on this device'}</label>
      <p class="muted">Capture stores supported user and assistant text as you open eligible chats. Temporary Chats and pages with uncertain eligibility are skipped.</p>
      <CollectionSelect collections={collections} value={collectionId} change={setCollectionSelection} />
      <NewCollection onCreate={(created) => { onCollection(created); setCollectionSelection(created.id); }} />
      {collection && <>
        <RetentionSelect value={retention} onChange={setRetention} />
        {!welcome && !confirmConsent && retention !== collection.retention && <button disabled={busy} onClick={() => void run(async () => {
          await rpc('updateCollection', [collectionId, { retention }]); onChanged(); setFeedback('Transcript retention updated.');
        })}>Apply retention policy</button>}
        <p class="muted">Private notes and explicitly saved excerpts stay until you delete them.</p>
      </>}
      {(confirmConsent || (saving && collection && !collection.autoConsent)) && <>
        {!!target.value?.identityObserved && <label class="check"><input type="checkbox" checked={observed} onChange={(event) => setObserved(event.currentTarget.checked)} /> Bind using the observed account and workspace</label>}
        <button class="primary" disabled={busy || !collection} onClick={() => void enable()}>Enable saving</button>
      </>}
      {collection && !welcome && <label class="check"><input type="checkbox" checked={collection.autoExcluded} disabled={busy} onChange={(event) => {
        const autoExcluded = event.currentTarget.checked;
        void run(async () => { await rpc('updateCollection', [collectionId, { autoExcluded }]); onChanged(); });
      }} /> Exclude this collection from automatic saving</label>}
      {!welcome && target.value && <div class="stack inset">
        <h3>Current ChatGPT conversation</h3>
        <p class="muted">{target.value.identityObserved ? 'Account and workspace observed.' : 'Manual collection binding applies to this document session.'}
          {target.value.temporary === 'temporary' ? ' Temporary Chat stays outside automatic capture.' : target.value.temporary === 'unknown'
            ? target.value.manualOrdinary ? ' You confirmed this is an ordinary chat for this document session.' : ' Chat eligibility is unknown. Automatic saving is paused until you confirm it.' : ''}</p>
        {!!target.value.identityObserved && !confirmConsent && <label class="check"><input type="checkbox" checked={observed} onChange={(event) => setObserved(event.currentTarget.checked)} /> Bind using the observed account and workspace</label>}
        <div class="actions">
          <button disabled={busy || !collection} onClick={() => void run(async () => {
            await rpc('bindTarget', { collectionId, observed }); onChanged(); setFeedback(`This conversation is bound to ${collection?.label}.`);
          })}>Bind current chat</button>
          {target.value.boundCollectionId && <>
            <button disabled={busy} onClick={() => void run(async () => { await rpc('setTargetPause', { paused: true }); setFeedback('Saving paused on this chat.'); })}>Pause on this chat</button>
            <button disabled={busy} onClick={() => void run(async () => { await rpc('resumeTarget'); setFeedback('Capture can resume when this chat meets your capture settings.'); })}>Resume saving</button>
          </>}
        </div>
        {target.value.temporary === 'unknown' && target.value.boundCollectionId && (target.value.manualOrdinary ?
          <button disabled={busy} onClick={() => void run(async () => {
            await rpc('confirmOrdinary', { confirmed: false }); setOrdinary(false); onChanged(); setFeedback('Confirmation removed. Automatic saving is paused on this chat.');
          })}>Remove ordinary-chat confirmation</button> : <>
            <label class="check"><input type="checkbox" checked={ordinary} onChange={(event) => setOrdinary(event.currentTarget.checked)} /> I confirm this is an ordinary chat</label>
            <p class="muted">This confirmation applies to this conversation and document session.</p>
            <button disabled={busy || !ordinary} onClick={() => void run(async () => {
              await rpc('confirmOrdinary', { confirmed: true }); setOrdinary(false); onChanged(); setFeedback('Ordinary chat confirmed for this session.');
            })}>Confirm ordinary chat</button>
          </>)}
      </div>}
      {!welcome && target.value === null && <p class="muted">Open Trace Settings from a ChatGPT conversation to bind that session to a collection.</p>}
      <Feedback error={error || target.error} text={feedback} busy={busy} />
      {welcome && <div class="actions"><button class={confirmConsent ? '' : 'primary'} disabled={busy} onClick={() => void run(welcomeDone)}>Continue to Local library</button></div>}
    </section>
    {!welcome && <>
      <section class="settings-section stack"><h2>Activity</h2>
        <label class="check"><input type="checkbox" checked={settings?.contextAlert ?? false} disabled={busy || !settings} onChange={(event) => {
          const contextAlert = event.currentTarget.checked;
          void run(async () => { await changeSettings({ contextAlert }); onChanged(); });
        }} /> Warn when reported input reaches 90% of a comparable reported limit</label>
        <p class="muted">Set optional Activity and Local library shortcuts from your browser’s extension keyboard shortcuts page.</p>
      </section>
      <section class="settings-section stack"><h2>Local data</h2>
        {storage && <><dl class="metrics"><dt>Storage in use</dt><dd>{bytes(storage.bytes)}</dd><dt>Captured chats</dt><dd>{storage.conversations}</dd>
          <dt>Saved messages</dt><dd>{storage.saved}</dd><dt>Handoff drafts</dt><dd>{storage.drafts}</dd><dt>Pending cleanup</dt><dd>{storage.pendingCleanup}</dd></dl>
          {storage.bytes && storage.quota && storage.bytes / storage.quota >= 0.8 ? <p class="notice">Trace is using at least 80% of the estimated available storage.</p> : null}</>}
        <Feedback error={status.error} busy={status.pending} />
        <div class="actions"><button onClick={() => setModal('backup')}>Export Trace backup</button><a href="#restore" class="button">Import Trace backup</a>
          <button onClick={() => setModal('clear')}>Clear Trace data</button></div>
      </section>
      <Diagnostics />
      <section class="settings-section stack"><h2>About {PRODUCT.name}</h2><p class="muted">Version {PRODUCT.version} · Independent extension for ChatGPT.</p></section>
    </>}
    {modal === 'backup' && <BackupReview key={deletions} collections={collections} onClose={() => setModal(null)} />}
    {modal === 'clear' && <Dialog title="Clear Trace data?" onClose={() => setModal(null)}>
      <div class="stack"><p>This turns off automatic saving and removes Trace transcripts, saved messages, notes, drafts, settings, diagnostics, and incomplete imports from this profile.</p>
        <p class="muted">Your ChatGPT history stays in ChatGPT. Files you already downloaded stay wherever you saved them.</p>
        <button class="danger" disabled={busy} onClick={() => void run(async () => { await rpc('clearAll'); setModal(null); setFeedback('Trace data cleared.'); onChanged(); })}>Clear Trace data</button>
        <Feedback error={error} busy={busy} />
      </div>
    </Dialog>}
  </main>;
}
