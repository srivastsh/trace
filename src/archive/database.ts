import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  ArchiveSettings, BackupCollection, BackupConversation, CaptureSegment, Collection, Conversation,
  HandoffDraft, ImportJob, Message, MessageRevision, SavedItem,
} from './types';

export const DEFAULT_SETTINGS: ArchiveSettings = {
  autoCapture: false, generation: 1, contextAlert: false, welcomeComplete: false,
};

export const archiveChannel = 'trace-archive';

export type Owned<T> = T & { jobId?: string; localOrigin?: string };

export interface Alias {
  collectionId: string;
  providerId: string;
  conversationId: string;
  jobId?: string;
}

export interface CommitFence {
  tabId: number;
  epoch: number;
  documentHash: string;
  collectionHash?: string;
  providerHash?: string;
  selectionHash?: string;
  ordinary: boolean;
}

export interface Receipt {
  key: string;
  conversationId: string;
  segmentId: string | null;
  savedIds: string[];
  observedAt: number;
}

export interface StoredJob extends ImportJob {
  destinationId?: string;
  contextAlert?: boolean;
}

export type ImportUnit = { kind: 'collection'; record: BackupCollection }
  | { kind: 'conversation'; record: BackupConversation }
  | { kind: 'prepare'; record: Pick<BackupConversation, 'conversation' | 'aliases'> }
  | { kind: 'revisions'; conversationId: string; records: MessageRevision[] }
  | { kind: 'segments'; conversationId: string; records: CaptureSegment[] }
  | { kind: 'finish'; conversationId: string; segmentId: string | null }
  | { kind: 'saved'; record: SavedItem }
  | { kind: 'draft'; record: HandoffDraft };

export type ArchiveMeta = {
  key: 'settings'; value: ArchiveSettings;
} | {
  key: 'revision'; value: { number: number; changes: { revision: number; ids: string[]; reset: boolean }[] };
};

export interface ArchiveDB extends DBSchema {
  meta: { key: ArchiveMeta['key']; value: ArchiveMeta };
  collections: { key: string; value: Owned<Collection>; indexes: { scope: string; job: string } };
  fences: { key: number; value: CommitFence };
  aliases: { key: [string, string]; value: Alias; indexes: { conversation: string; job: string } };
  exclusions: { key: [string, string]; value: { collectionId: string; providerId: string; groupId?: string }; indexes: { group: string } };
  conversations: { key: string; value: Owned<Conversation>; indexes: { collection: string; job: string } };
  messages: { key: [string, string]; value: Owned<Message>; indexes: { conversation: string; job: string } };
  revisions: { key: string; value: Owned<MessageRevision>; indexes: { conversation: string; message: [string, string]; job: string } };
  segments: { key: string; value: Owned<CaptureSegment>; indexes: { conversation: string; selection: [string, string]; job: string } };
  saved: { key: string; value: Owned<SavedItem>; indexes: { conversation: string; collection: string; job: string } };
  drafts: { key: string; value: Owned<HandoffDraft>; indexes: { collection: string; job: string } };
  receipts: { key: string; value: Receipt; indexes: { conversation: string; time: number } };
  jobs: { key: string; value: StoredJob };
  importPayloads: { key: [string, number]; value: ImportUnit };
  importMap: { key: [string, string, string]; value: string };
  importLocks: { key: string; value: { conversationId: string; jobId: string }; indexes: { job: string } };
}

export const archiveStores = [
  'meta', 'collections', 'fences', 'aliases', 'exclusions', 'conversations', 'messages',
  'revisions', 'segments', 'saved', 'drafts', 'receipts', 'jobs', 'importPayloads', 'importMap', 'importLocks',
] as const;

export const importedStores = ['conversations', 'collections', 'revisions', 'segments', 'saved', 'drafts', 'aliases', 'messages'] as const;

export type ArchiveTx = IDBPTransaction<ArchiveDB, typeof archiveStores, 'readwrite'>;
export type ArchiveRead = IDBPTransaction<ArchiveDB, typeof archiveStores, 'readonly'> | ArchiveTx;

export function connectArchive(name = 'trace-archive'): Promise<IDBPDatabase<ArchiveDB>> {
  return openDB<ArchiveDB>(name, 4, {
    blocking(_currentVersion, _blockedVersion, event) {
      (event.target as IDBDatabase).close();
    },
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion >= 1) {
        if (oldVersion < 2) {
          const exclusions = tx.objectStore('exclusions');
          if (!exclusions.indexNames.contains('group')) exclusions.createIndex('group', 'groupId');
        }
        if (oldVersion < 3) {
          tx.objectStore('revisions').createIndex('message', ['conversationId', 'messageId']);
          tx.objectStore('segments').createIndex('selection', ['conversationId', 'selectionId']);
        }
        if (oldVersion < 4) {
          for (const table of importedStores) tx.objectStore(table).createIndex('job', 'jobId');
        }
        return;
      }
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('collections', { keyPath: 'id' }).createIndex('scope', 'scopeKey', { unique: true });
      db.createObjectStore('fences', { keyPath: 'tabId' });
      db.createObjectStore('aliases', { keyPath: ['collectionId', 'providerId'] }).createIndex('conversation', 'conversationId');
      db.createObjectStore('exclusions', { keyPath: ['collectionId', 'providerId'] }).createIndex('group', 'groupId');
      db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('collection', 'collectionId');
      db.createObjectStore('messages', { keyPath: ['conversationId', 'id'] }).createIndex('conversation', 'conversationId');
      const revisions = db.createObjectStore('revisions', { keyPath: 'id' });
      revisions.createIndex('conversation', 'conversationId');
      revisions.createIndex('message', ['conversationId', 'messageId']);
      const segments = db.createObjectStore('segments', { keyPath: 'id' });
      segments.createIndex('conversation', 'conversationId');
      segments.createIndex('selection', ['conversationId', 'selectionId']);
      const saved = db.createObjectStore('saved', { keyPath: 'id' });
      saved.createIndex('conversation', 'conversationId');
      saved.createIndex('collection', 'collectionId');
      db.createObjectStore('drafts', { keyPath: 'id' }).createIndex('collection', 'collectionId');
      const receipts = db.createObjectStore('receipts', { keyPath: 'key' });
      receipts.createIndex('conversation', 'conversationId');
      receipts.createIndex('time', 'observedAt');
      db.createObjectStore('jobs', { keyPath: 'id' });
      db.createObjectStore('importPayloads');
      db.createObjectStore('importMap');
      db.createObjectStore('importLocks', { keyPath: 'conversationId' }).createIndex('job', 'jobId');
      for (const table of importedStores) tx.objectStore(table).createIndex('job', 'jobId');
    },
  });
}

export async function settings(tx: ArchiveRead): Promise<ArchiveSettings> {
  const record = await tx.objectStore('meta').get('settings');
  return record?.key === 'settings' ? record.value : { ...DEFAULT_SETTINGS };
}

export async function revisionMeta(tx: ArchiveRead) {
  const entry = await tx.objectStore('meta').get('revision');
  return entry?.key === 'revision' ? entry.value : { number: 0, changes: [] };
}

export async function bumpRevision(tx: ArchiveTx, ids: string[] = [], reset = false): Promise<number> {
  const previous = await revisionMeta(tx);
  const number = previous.number + 1;
  const change = { revision: number, ids: reset ? [] : [...new Set(ids)], reset };
  await tx.objectStore('meta').put({
    key: 'revision',
    value: { number, changes: [...previous.changes.slice(-255), change] },
  });
  return number;
}

export function announce(archiveRevision: number): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(archiveChannel);
    channel.postMessage({ archiveRevision });
    channel.close();
  } catch {
    // Revision polling still reconciles readers if this context cannot broadcast.
  }
}

export function expire(conversation: Conversation, collection: Collection, now: number): boolean {
  return collection.retention !== 'forever'
    && conversation.lastObservedAt + collection.retention * 86_400_000 <= now;
}

export async function visible<T extends object>(tx: ArchiveRead, record?: Owned<T>): Promise<boolean> {
  return !!record && (!record.jobId || (await tx.objectStore('jobs').get(record.jobId))?.state === 'complete');
}

export function clean<T extends object>(record: Owned<T>): T {
  const copy = { ...record };
  delete copy.jobId;
  delete copy.localOrigin;
  return copy;
}

export async function onlyVisible<T extends object>(tx: ArchiveRead, records: Owned<T>[]): Promise<T[]> {
  const owners = [...new Set(records.flatMap((record) => record.jobId ? [record.jobId] : []))];
  const jobs = await Promise.all(owners.map((id) => tx.objectStore('jobs').get(id)));
  const complete = new Set(jobs.flatMap((job) => job?.state === 'complete' ? [job.id] : []));
  return records.filter((record) => !record.jobId || complete.has(record.jobId)).map(clean);
}
