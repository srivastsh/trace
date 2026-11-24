import type { ActivitySnapshot, CapturedMessage, Coverage, Metric, Quota } from '../contracts';

export const ADAPTER = 'chatgpt-web/1';
export const BRIDGE = 'trace:observe:1';
export const JSON_LIMIT = 16 * 1024 * 1024;
export const STREAM_LIMIT = 32 * 1024 * 1024;
export const FRAME_LIMIT = 1024 * 1024;
export const MESSAGE_LIMIT = 512 * 1024;
export const BATCH_LIMIT = 128 * 1024;
export const STAGE_LIMIT = 2 * 1024 * 1024;
export const STREAM_TIME_LIMIT = 30 * 60 * 1000;
export const NODE_LIMIT = 5000;
export const ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
export const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const id = (value: unknown): string | undefined => typeof value === 'string' && /^[\w:-]{1,128}$/.test(value) ? value : undefined;
export const label = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() ? value.trim() : undefined;
const encoder = new TextEncoder();
export const byteLength = (value: string) => encoder.encode(value).byteLength;

export type Endpoint = { kind: 'history'; id: string } | { kind: 'turn' | 'models' | 'init' | 'account' | 'images' };
export type Identity = { accountId: string; workspaceId: string };
export interface Route {
  key: string;
  providerId?: string;
  temporary: boolean;
}

export function conversationRoute(url: URL): Route | null {
  if (!ORIGINS.has(url.origin)) return null;
  const path = url.pathname.replace(/\/$/, '') || '/';
  const match = path.match(/^\/(?:g\/[\w-]+\/)?(?:c|uc)\/([\w:-]{1,128})$/);
  if (!match && path !== '/' && !/^\/g\/[\w-]+$/.test(path)) return null;
  const temporary = url.searchParams.get('temporary-chat') === 'true' || url.searchParams.get('temporary-chat') === '1';
  return { key: path + (temporary ? '?temporary-chat=true' : ''), providerId: match?.[1], temporary };
}

// The pinned Modus endpoint classifier established these route families. Keep
// the allowlist tight and avoid inferring endpoint schemas from arbitrary JSON.
export function observedEndpoint(input: string | URL, method: string, origin: string): Endpoint | undefined {
  let url: URL;
  try { url = new URL(input, origin); } catch { return; }
  if (url.origin !== origin) return;
  const match = url.pathname.match(/^\/backend-(?:api|anon)(\/.*)$/);
  const path = match?.[1].replace(/\/$/, '') ?? '';
  if (method === 'POST' && /^\/(?:f\/)?conversation$/.test(path)) return { kind: 'turn' };
  if ((method === 'GET' || method === 'POST') && path === '/conversation/init') return { kind: 'init' };
  if (method !== 'GET') return;
  if (path === '/models') return { kind: 'models' };
  if (/^\/accounts\/(?:optimized\/)?check(?:\/v\d+)?$/.test(path)) return { kind: 'account' };
  if (path === '/images/bootstrap') return { kind: 'images' };
  const conversationId = id(path.match(/^\/conversations?\/([^/]+)$/)?.[1]);
  if (conversationId && !['init', 'prepare', 'stream', 'resume', 'list', 'token'].includes(conversationId)) {
    return { kind: 'history', id: conversationId };
  }
}

export interface ModelCatalogEntry {
  model: string;
  display?: Metric<string>;
  maximum?: Metric;
}
export type ReplyFacts = Omit<ActivitySnapshot, 'state' | 'adapterVersion' | 'quotas'>;
export interface HistoryText {
  selectionId: string;
  leafId?: string;
  title?: string;
  messages: CapturedMessage[];
  coverage: Coverage;
}
export interface Observation {
  reply?: ReplyFacts;
  conversationDefault?: Metric<string>;
  accountDefault?: Metric<string>;
  catalog?: ModelCatalogEntry[];
  quotas?: Quota[];
  identity?: Identity | null;
  conversationId?: string;
  temporary?: boolean;
  history?: HistoryText;
  issue?: 'bounded' | 'interrupted' | 'unsupported';
}
export interface Envelope {
  source: typeof BRIDGE;
  type: 'observation';
  channel: string;
  epoch: number;
  sequence: number;
  request: number;
  route: string;
  endpoint: Endpoint['kind'];
  phase: 'start' | 'data' | 'finish' | 'error';
  observedAt: number;
  generation?: number;
  observation: Observation;
}
export interface Control {
  source: typeof BRIDGE;
  type: 'control';
  channel: string;
  epoch: number;
  route: string;
  generation?: number;
}
