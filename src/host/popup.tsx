import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, ActionContext, ActivitySnapshot } from '../contracts';
import { PRODUCT } from '../product';
import { rpc } from '../rpc';
import { Activity } from './activity';
import { ACTION_FAILED, ACTIONS, globalAction, requiresSelection } from './actions';
import { HOST_ADAPTER_VERSION } from './adapter';
import { Icon } from './icons';
import './host.css';

interface PopupContext {
  context?: ActionContext;
  activity?: ActivitySnapshot;
  documentId?: string;
  tabId?: number;
  theme?: 'light' | 'dark';
}

const unavailable: ActivitySnapshot = {
  state: 'unavailable', adapterVersion: HOST_ADAPTER_VERSION, comparable: false, quotas: [],
};

function Popup() {
  const [snapshot, setSnapshot] = useState<PopupContext>();
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [error, setError] = useState('');
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const root = useRef<HTMLElement | null>(null);
  const returnActivityFocus = useRef(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await rpc<PopupContext>('popupContext'));
    } catch {
      setSnapshot(undefined);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (showActivity) root.current?.querySelector<HTMLElement>('[data-trace-close]')?.focus();
    else if (returnActivityFocus.current) {
      root.current?.querySelector<HTMLElement>('[data-trace-action="activity"]')?.focus();
      returnActivityFocus.current = false;
    }
  }, [showActivity]);

  const context = snapshot?.context;
  const theme = snapshot?.theme === 'dark' || snapshot?.theme === 'light' ? snapshot.theme : systemTheme;
  useEffect(() => { document.documentElement.style.colorScheme = theme; }, [theme]);

  function closeActivity() {
    setShowActivity(false);
    returnActivityFocus.current = true;
  }

  async function choose(action: Action, event: MouseEvent) {
    if (!event.isTrusted || running) return;
    if (action === 'activity') {
      setShowActivity(true);
      return;
    }
    if (requiresSelection(action) && !context) return;
    setRunning(true);
    setError('');
    try {
      await rpc('popupAction', globalAction(action) ? { action } : {
        action, context, documentId: snapshot?.documentId, tabId: snapshot?.tabId,
      });
      window.close();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '';
      const visible = /^(?:The chat|The current chat|The conversation|A selected message|This selection|The selection|Choose a collection|Trace is unavailable)/.test(message)
        && message.length <= 240;
      setError(visible ? message : ACTION_FAILED);
    } finally {
      setRunning(false);
    }
  }

  return <main ref={root} data-trace-owned data-trace-theme={theme} class={`trace-popup${showActivity ? ' trace-popup-activity' : ''}`}
    onKeyDown={(event) => {
      if (showActivity && event.key === 'Escape') {
        event.preventDefault();
        closeActivity();
      }
    }}>
    {showActivity ? <section aria-label="Activity">
      <Activity snapshot={snapshot?.activity ?? unavailable} onClose={closeActivity}
        onAction={context && !running ? (action, event) => void choose(action, event) : undefined}
      />
    </section> : <>
      <div class="trace-surface-header"><h1>{PRODUCT.name}</h1></div>
      <p class="trace-secondary" role="status">{loading ? 'Finding the current chat…'
        : context ? 'Current chat' : 'Open a ChatGPT conversation'}</p>
      {ACTIONS.map(({ action, label, icon }) => <div key={action}>
        {action === 'library' && <hr class="trace-popup-divider"/>}
        <button type="button" class="trace-menu-row" data-trace-action={action}
          aria-disabled={running || requiresSelection(action) && !context || undefined}
          onClick={(event) => void choose(action, event)}>
          <Icon name={icon}/><span>{label}</span>
        </button>
      </div>)}
    </>}
    {error && <>
      <p class="trace-secondary" role="status">{error}</p>
      <button type="button" class="trace-menu-row" onClick={(event) => { if (event.isTrusted) void load(); }}>Refresh current chat</button>
    </>}
  </main>;
}

document.title = PRODUCT.name;
const root = document.querySelector('#trace-popup-root');
if (root) render(<Popup/>, root);
