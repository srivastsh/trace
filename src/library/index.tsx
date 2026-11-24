import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ArchiveSettings, Collection } from '../archive/types';
import { PRODUCT } from '../product';
import { rpc } from '../rpc';
import { Feedback, messageOf } from './components';
import { DraftsPage } from './drafts';
import { LibraryPage } from './library';
import { RestorePage } from './restore';
import { SettingsPage } from './settings';
import { StagePage } from './stage';
import './library.css';

const routeOf = () => location.hash.slice(1).split('/').filter(Boolean);

function App() {
  const [route, setRoute] = useState(routeOf);
  const [revision, setRevision] = useState(0);
  const [reset, setReset] = useState(0);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [settings, setSettings] = useState<ArchiveSettings>();
  const [error, setError] = useState('');
  const [dataCleared, setDataCleared] = useState(false);
  const onChanged = () => setRevision((current) => current + 1);
  const onCollection = (collection: Collection) => {
    setCollections((existing) => existing.some(({ id }) => id === collection.id) ? existing : [...existing, collection]);
    onChanged();
  };

  useEffect(() => {
    const navigate = () => { setRoute(routeOf()); setDataCleared(false); window.scrollTo(0, 0); };
    const theme = async () => {
      const value = await rpc<{ dark: boolean; fontFamily?: string } | null>('getTheme').catch(() => null);
      if (value) document.documentElement.dataset.theme = value.dark ? 'dark' : 'light';
      else delete document.documentElement.dataset.theme;
      const font = value?.fontFamily;
      if (font && /^[\w\s,"'-]{1,180}$/.test(font)) document.documentElement.style.setProperty('--host-font', font);
      else document.documentElement.style.removeProperty('--host-font');
    };
    const changes = new BroadcastChannel('trace-archive');
    let debounce: ReturnType<typeof setTimeout> | undefined;
    changes.onmessage = () => {
      clearTimeout(debounce);
      debounce = setTimeout(onChanged, 70);
    };
    const onMessage = (message: { v?: number; event?: string; conversationId?: string }) => {
      if (message.v !== 1) return;
      if (message.event === 'archive-changed') onChanged();
      if (message.event === 'archive-chat-deleted' && message.conversationId) {
        const conversationId = message.conversationId;
        setDeletedIds((previous) => [...previous, conversationId]);
        onChanged();
      }
      if (message.event === 'archive-import-removed') {
        setReset((current) => current + 1);
        onChanged();
      }
      if (message.event === 'archive-cleared') {
        if (!['#settings', '#library'].includes(location.hash)) location.hash = 'library';
        setCollections([]);
        setSettings(undefined);
        setDeletedIds([]);
        setReset((current) => current + 1);
        setDataCleared(true);
        onChanged();
      }
    };
    void theme();
    void rpc('cleanup').catch(() => {});
    window.addEventListener('hashchange', navigate);
    window.addEventListener('focus', theme);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      clearTimeout(debounce);
      changes.close();
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('focus', theme);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([rpc<Collection[]>('listCollections'), rpc<ArchiveSettings>('getSettings')]).then(([collections, settings]) => {
      if (!active) return;
      setCollections(collections);
      setSettings(settings);
      setError('');
    }, (failure: unknown) => { if (active) setError(messageOf(failure)); });
    return () => { active = false; };
  }, [revision]);

  const [page = 'library', id] = route;
  const common = { collections, settings, revision, onCollection, onChanged };
  return <>
    <header class="topbar">
      <a class="wordmark" href="#library">{PRODUCT.name}</a>
      <nav class="actions" aria-label="Trace pages">
        <a href="#library" aria-current={page === 'library' ? 'page' : undefined}>Local library</a>
        <a href="#drafts" aria-current={page === 'drafts' ? 'page' : undefined}>Handoff drafts</a>
        <a href="#settings" aria-current={page === 'settings' ? 'page' : undefined}>Settings</a>
      </nav>
    </header>
    {error && <div class="page"><Feedback error={error} /></div>}
    {dataCleared && <div class="page compact"><Feedback text="Trace data cleared. Automatic saving is off." /></div>}
    {page === 'settings' || page === 'welcome' ? <SettingsPage key={`${page}-${reset}`} {...common} welcome={page === 'welcome'} deletions={deletedIds.length} /> :
      page === 'restore' ? <RestorePage key={reset} collections={collections} revision={revision} changed={onChanged} /> :
        page === 'stage' && id ? <StagePage key={`${id}-${reset}`} id={id} collections={collections} onCollection={onCollection} /> :
          page === 'drafts' ? <DraftsPage key={`${id ?? ''}-${reset}`} id={id} collections={collections} revision={revision} onCollection={onCollection} deletedIds={deletedIds} /> :
            <LibraryPage key={reset} {...common} deletedIds={deletedIds} />}
  </>;
}

document.title = PRODUCT.name;
const mount = document.getElementById('app');
if (mount) render(<App />, mount);
