import type { ActivitySnapshot, Coverage, DocTarget, Projection } from '../contracts';

export type { Coverage } from '../contracts';

export type Retention = 30 | 90 | 'forever';

export interface Collection {
  id: string;
  label: string;
  mode: 'manual' | 'observed';
  scopeKey?: string;
  retention: Retention;
  autoExcluded: boolean;
  autoConsent: boolean;
  createdAt: number;
}

export interface ArchiveSettings {
  autoCapture: boolean;
  generation: number;
  contextAlert: boolean;
  welcomeComplete: boolean;
}

export interface DocumentFence extends DocTarget {
  collectionId: string | null;
  scopeKey?: string;
  providerId?: string;
  selectionId?: string;
  ordinary?: boolean;
}

export interface SaveAuthorization extends DocTarget {
  collectionId: string;
  generation: number;
  expiresAt: number;
  intentId: string;
}

export interface RevisionReference {
  messageId: string;
  revisionId: string;
}

export interface Conversation {
  id: string;
  collectionId: string;
  providerId: string;
  title: string;
  sourceUrl: string;
  firstObservedAt: number;
  lastObservedAt: number;
  segmentId: string | null;
  coverage: Coverage;
}

export interface Message {
  conversationId: string;
  id: string;
  parentId?: string | null;
  provisional: boolean;
  role: 'user' | 'assistant';
  currentRevisionId: string;
}

export interface MessageRevision {
  id: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  provisional: boolean;
  parentId?: string | null;
  source: Projection['source'];
  adapterVersion: string;
  observedAt: number;
  final: boolean;
  activity?: ActivitySnapshot;
}

export interface CaptureSegment {
  id: string;
  conversationId: string;
  selectionId: string;
  source: Projection['source'];
  leafId?: string;
  revisions: RevisionReference[];
  coverage: Coverage;
  observedAt: number;
  adapterVersion: string;
}

export interface SavedItem {
  id: string;
  conversationId: string;
  collectionId: string;
  revisionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  title: string;
  sourceUrl: string;
  coverage: Coverage;
  activity?: ActivitySnapshot;
  label: string;
  tags: string[];
  note: string;
  capturedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffEvidence {
  conversationId?: string;
  revisionId?: string;
  messageId?: string;
  title: string;
  sourceUrl: string;
  role: 'user' | 'assistant';
  text: string;
  coverage: Coverage;
  unavailable?: boolean;
  observedAt?: number;
  selectionId?: string;
  activity?: ActivitySnapshot;
}

export interface HandoffDraft {
  id: string;
  collectionId: string;
  title: string;
  template: 'general' | 'codex' | 'research';
  budget: number;
  notes: {
    goal: string;
    currentState: string;
    decisions: string;
    constraints: string;
    references: string;
    openQuestions: string;
    nextSteps: string;
  };
  evidence: HandoffEvidence[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationView {
  conversation: Conversation;
  collection: Collection;
  segments: CaptureSegment[];
  segment: CaptureSegment | null;
  messages: MessageRevision[];
  saved: SavedItem[];
  expired: boolean;
}

export interface SearchDocument {
  id: string;
  conversationId: string;
  collectionId: string;
  title: string;
  text: string;
  tags: string[];
  note: string;
  role: 'user' | 'assistant';
  reportedModel: string | null;
  capturedAt: number;
  updatedAt: number;
  saved: boolean;
  coverage: Coverage;
  segmentId?: string;
  revisionId: string;
  savedId?: string;
}

export interface SearchPage {
  archiveRevision: number;
  next: string | null;
  documents: SearchDocument[];
}

export interface BackupCollection {
  id: string;
  label: string;
  retention: Retention;
}

export interface BackupConversation {
  conversation: Conversation;
  aliases: string[];
  segments: CaptureSegment[];
  revisions: MessageRevision[];
  selection?: 'branch' | 'excerpts';
  sourceCoverage?: Coverage;
}

export interface TraceEnvelope {
  format: 'trace';
  version: 1;
  kind: 'backup' | 'conversation';
  exportedAt: number;
  collections: BackupCollection[];
  conversations: BackupConversation[];
  saved: SavedItem[];
  drafts: HandoffDraft[];
  preferences?: Pick<ArchiveSettings, 'contextAlert'>;
}

export interface ImportPreview {
  kind: TraceEnvelope['kind'];
  collections: BackupCollection[];
  conversations: number;
  revisions: number;
  saved: number;
  drafts: number;
}

export interface ImportJob {
  id: string;
  state: 'pending' | 'complete' | 'failed';
  processed: number;
  total: number;
  createdAt: number;
  error?: string;
}

export interface StorageStatus {
  conversations: number;
  saved: number;
  drafts: number;
  pendingCleanup: number;
  bytes?: number;
  quota?: number;
}
