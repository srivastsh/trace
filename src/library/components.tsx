import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Collection, Retention } from '../archive/types';
import type { Coverage } from '../contracts';
import { rpc } from '../rpc';
import { coverageLabel, safeSource } from './format';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Trace could not complete this action.';
}

export function useAsync<T>(load: () => Promise<T>, inputs: readonly unknown[], keepValue = false): { value: T | undefined; error: string; pending: boolean } {
  const [state, setState] = useState<{ value: T | undefined; error: string; pending: boolean }>({ value: undefined, error: '', pending: true });
  useEffect(() => {
    let active = true;
    setState((previous) => ({ value: keepValue ? previous.value : undefined, error: '', pending: true }));
    void load().then((value) => {
      if (active) setState({ value, error: '', pending: false });
    }, (error: unknown) => {
      if (active) setState({ value: undefined, error: messageOf(error), pending: false });
    });
    return () => { active = false; };
  }, inputs);
  return state;
}

export function useAction(): { run: (action: () => Promise<void>) => Promise<void>; busy: boolean; error: string } {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  return { run, busy, error };
}

export function Feedback({ error, text, busy }: { error?: string; text?: string; busy?: boolean }) {
  return <>{error && <p class="error" role="alert">{error}</p>}
    {(text || busy) && <p class="muted status" role="status">{busy ? 'Working…' : text}</p>}</>;
}

export function CoverageSummary({ coverage }: { coverage: Coverage }) {
  return <p class="muted coverage"><strong>{coverageLabel(coverage)}</strong> · {coverage.reason}</p>;
}

export function SourceLink({ url }: { url: string }) {
  const source = safeSource(url);
  return source ? <a class="button" href={source} target="_blank" rel="noopener noreferrer">Open in ChatGPT ↗</a> : null;
}

export const retentionLabel = (retention: Retention): string => retention === 'forever' ? 'Keep until I delete' : `${retention} days since last capture`;

export function RetentionSelect({ value, onChange }: { value: Retention; onChange: (value: Retention) => void }) {
  return <label class="field">Transcript retention
    <select value={String(value)} onChange={(event) => onChange(event.currentTarget.value === 'forever' ? 'forever' : event.currentTarget.value === '30' ? 30 : 90)}>
      <option value="30">{retentionLabel(30)}</option>
      <option value="90">{retentionLabel(90)}</option>
      <option value="forever">{retentionLabel('forever')}</option>
    </select>
  </label>;
}

export function CollectionSelect({ collections, value, change, all, label = 'Collection' }: {
  collections: Collection[]; value: string; change: (id: string) => void; all?: string; label?: string;
}) {
  return <label class="field">{label}<select value={value} onChange={(event) => change(event.currentTarget.value)}>
    {!value && <option value="">Choose a collection</option>}
    {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.label}</option>)}
    {all && <option value={all}>All collections</option>}
  </select></label>;
}

export function NewCollection({ onCreate, retention = 90 }: { onCreate: (collection: Collection) => void; retention?: Retention }) {
  const [label, setLabel] = useState('');
  const { run, busy, error } = useAction();
  return <form class="inline-form" onSubmit={(event) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    void run(async () => {
      const created = await rpc<Collection>('createCollection', [{ label: trimmed, retention }]);
      onCreate(created);
      setLabel('');
    });
  }}>
    <label class="field">New collection name<input required maxLength={80} value={label} onInput={(event) => setLabel(event.currentTarget.value)} /></label>
    <button type="submit" disabled={busy || !label.trim()}>Create collection</button>
    <Feedback error={error} />
  </form>;
}

export function Dialog({ title, children, onClose }: { title: string; children: ComponentChildren; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div class="section-heading"><h2>{title}</h2><button type="button" onClick={onClose}>Close</button></div>
    {children}
  </dialog>;
}
