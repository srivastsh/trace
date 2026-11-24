import type { JSX } from 'preact';

type IconName = 'trace' | 'chevron' | 'back' | 'activity' | 'save' | 'export' | 'handoff' | 'library' | 'settings' | 'close';
const paths: Record<IconName, JSX.Element> = {
  trace: <><path d="M4 5h5m4 0h3M4 10h9m3 0h0M4 15h3m4 0h5"/><circle cx="11" cy="5" r="1"/><circle cx="9" cy="15" r="1"/></>,
  chevron: <path d="m8 5 5 5-5 5"/>,
  back: <path d="M16 10H4m5-5-5 5 5 5"/>,
  activity: <path d="M2.5 10h4l2.25-5.5 3 11 2.25-5.5h3.5"/>,
  save: <path d="M5.5 4.5c0-.55.45-1 1-1h7c.55 0 1 .45 1 1v12l-4.5-3-4.5 3z"/>,
  export: <><path d="M10 3v10m-4-4 4 4 4-4"/><path d="M4 14v2c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-2"/></>,
  handoff: <><path d="M5 10V4h10v4m-8 0h4M5 13v3h4m1-3h7m-3-3 3 3-3 3"/></>,
  library: <path d="M3.5 4.5h3v11h-3zm5 0h3v11h-3zm5 1 2.5-.75 3 9.75-2.5.75z"/>,
  settings: <><circle cx="10" cy="10" r="2.5"/><path d="M8.9 2.75h2.2l.4 1.9 1.5.85 1.85-.6 1.1 1.9-1.4 1.3v1.8l1.4 1.3-1.1 1.9-1.85-.6-1.5.85-.4 1.9H8.9l-.4-1.9-1.5-.85-1.85.6-1.1-1.9 1.4-1.3V8.1l-1.4-1.3 1.1-1.9 1.85.6 1.5-.85z" transform="translate(0 1)"/></>,
  close: <path d="m5 5 10 10M15 5 5 15"/>,
};

export function Icon({ name }: { name: IconName }) {
  return <svg class="trace-icon" aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">{paths[name]}</svg>;
}
