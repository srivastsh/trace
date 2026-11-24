export type Action =
  | 'activity'
  | 'save'
  | 'save-message'
  | 'export'
  | 'handoff'
  | 'library'
  | 'settings'
  | 'pause';
export interface ActionContext {
  epoch: number;
  providerId: string;
  selectionId: string;
}
export type Coverage = {
  state: 'complete' | 'partial' | 'unknown';
  reason: string;
};
export interface Metric<T = number> {
  value: T;
  sourceField: string;
  sourceKind: 'server-reported' | 'dom-observed' | 'local' | 'derived';
  observedAt: number;
  replyId?: string;
  adapterVersion: string;
  endpoint: string;
  status: 'reported' | 'observed' | 'derived';
}
export interface Quota {
  feature: string;
  scope: string;
  observedAt: number;
  remaining?: Metric;
  used?: Metric;
  total?: Metric;
  resetSeconds?: Metric;
  deadline?: Metric;
}
export interface ActivitySnapshot {
  state: 'waiting' | 'streaming' | 'reported' | 'partial' | 'unavailable';
  replyId?: string;
  model?: Metric<string>;
  displayModel?: Metric<string>;
  requestedModel?: Metric<string>;
  conversationDefault?: Metric<string>;
  accountDefault?: Metric<string>;
  input?: Metric;
  output?: Metric;
  effectiveWindow?: Metric;
  catalogMaximum?: Metric;
  comparable: boolean;
  comparableReason?: string;
  quotas: Quota[];
  observedAt?: number;
  adapterVersion: string;
}
export interface CapturedMessage {
  id: string;
  parentId?: string | null;
  provisional: boolean;
  role: 'user' | 'assistant';
  text: string;
  observedAt: number;
  final: boolean;
  activity?: ActivitySnapshot;
}
export interface Projection {
  providerId: string;
  title: string;
  sourceUrl: string;
  selectionId: string;
  leafId?: string;
  source: 'dom' | 'history';
  messages: CapturedMessage[];
  coverage: Coverage;
  observedAt: number;
  adapterVersion: string;
  batchId: string;
  aliasFrom?: string;
}
export interface Stage {
  id: string;
  action: 'save' | 'save-message' | 'export' | 'handoff';
  projection: Projection;
  messageId?: string;
  createdAt: number;
  expiresAt: number;
}
export interface DocTarget {
  tabId: number;
  documentId: string;
  epoch: number;
}
export interface HostActionRequest {
  action: Action;
  context?: ActionContext;
  messageId?: string;
}
export interface CaptureStatus {
  enabled: boolean;
  generation: number;
  bound: boolean;
  paused: boolean;
}
