import type {
  BackupCollection, BackupConversation, CaptureSegment, Conversation, ConversationView,
  HandoffDraft, HandoffEvidence, ImportPreview, MessageRevision, SavedItem, TraceEnvelope,
} from './types';
import {
  bool, boundedString, coverage, fail, fields, integer, nullable, object, optional, pick,
  retention, safeConversationUrl, savedActivity, timestamp, token, validateNoteFields,
} from './validation';

export const maxImportBytes = 64 * 1024 * 1024;

function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) fail('Duplicate identity in the Trace file.');
  return values;
}

function readCollection(value: unknown): BackupCollection {
  const row = object(value);
  return { id: token(row.id), label: boundedString(row.label, 128), retention: retention(row.retention) };
}

function readConversation(value: unknown): Conversation {
  const row = object(value);
  const firstObservedAt = timestamp(row.firstObservedAt);
  const lastObservedAt = timestamp(row.lastObservedAt);
  if (firstObservedAt > lastObservedAt) fail('Invalid conversation capture interval.');
  return {
    id: token(row.id), collectionId: token(row.collectionId), providerId: token(row.providerId),
    title: boundedString(row.title, 1_024), sourceUrl: safeConversationUrl(row.sourceUrl),
    firstObservedAt, lastObservedAt, segmentId: nullable(row.segmentId, token), coverage: coverage(row.coverage),
  };
}

function readRevision(value: unknown): MessageRevision {
  const row = object(value);
  return {
    id: token(row.id), conversationId: token(row.conversationId), messageId: token(row.messageId),
    role: pick(row.role, ['user', 'assistant']), text: boundedString(row.text, 512 * 1024),
    provisional: bool(row.provisional), parentId: optional(row.parentId, (parent) => nullable(parent, token)),
    source: pick(row.source, ['dom', 'history']), adapterVersion: token(row.adapterVersion),
    observedAt: timestamp(row.observedAt), final: bool(row.final), activity: savedActivity(row.activity),
  };
}

function readSegment(value: unknown): CaptureSegment {
  const row = object(value);
  return {
    id: token(row.id), conversationId: token(row.conversationId), selectionId: token(row.selectionId),
    source: pick(row.source, ['dom', 'history']), leafId: optional(row.leafId, token),
    revisions: unique(fields(row.revisions, 50_000, (entry) => {
      const ref = object(entry);
      return { messageId: token(ref.messageId), revisionId: token(ref.revisionId) };
    }), (ref) => ref.messageId),
    coverage: coverage(row.coverage), observedAt: timestamp(row.observedAt),
    adapterVersion: token(row.adapterVersion),
  };
}

export function proveBranch(revisions: Pick<MessageRevision, 'messageId' | 'parentId' | 'provisional' | 'final'>[], leafId?: string): boolean {
  return revisions.length > 0
    && revisions.at(-1)?.messageId === leafId
    && revisions.every((row, i) => row.final && !row.provisional
      && row.parentId === (i === 0 ? null : revisions[i - 1]?.messageId));
}

function readBackupConversation(value: unknown): BackupConversation {
  const row = object(value);
  const conversation = readConversation(row.conversation);
  const aliases = unique(fields(row.aliases, 1_024, token), (alias) => alias);
  const revisions = unique(fields(row.revisions, 100_000, readRevision), (revision) => revision.id);
  const segments = unique(fields(row.segments, 30_000, readSegment), (segment) => segment.id);
  const sourceCoverage = optional(row.sourceCoverage, coverage);
  const selection = optional(row.selection, (raw) => pick(raw, ['branch', 'excerpts'] as const));
  if (!aliases.includes(conversation.providerId) || (conversation.segmentId !== null
    && !segments.some((segment) => segment.id === conversation.segmentId))) fail('Invalid conversation identity or selection.');
  const revisionMap = new Map(revisions.map((revision) => [revision.id, revision]));
  const roles = new Map<string, string>();
  for (const revision of revisions) {
    if (revision.conversationId !== conversation.id || revision.parentId === revision.messageId) fail('Invalid revision scope.');
    const role = roles.get(revision.messageId);
    if (role && role !== revision.role) fail('Conflicting roles for a Trace message.');
    roles.set(revision.messageId, revision.role);
  }
  for (const segment of segments) {
    if (segment.conversationId !== conversation.id) fail('Invalid segment scope.');
    const selected = segment.revisions.map((ref) => {
      const revision = revisionMap.get(ref.revisionId);
      if (!revision || revision.messageId !== ref.messageId) fail('Missing segment revision.');
      return revision;
    });
    if (segment.coverage.state === 'complete'
      && (segment.source !== 'history' || !proveBranch(selected, segment.leafId))) {
      fail('Invalid complete branch evidence.');
    }
  }
  const selectedSegment = segments.find((segment) => segment.id === conversation.segmentId);
  if (conversation.coverage.state === 'complete' && selectedSegment?.coverage.state !== 'complete') fail('Missing complete branch evidence.');
  return { conversation, aliases, segments, revisions, selection, sourceCoverage };
}

function readSaved(value: unknown): SavedItem {
  const row = object(value);
  const createdAt = timestamp(row.createdAt);
  const updatedAt = timestamp(row.updatedAt);
  if (updatedAt < createdAt) fail('Invalid saved excerpt interval.');
  return {
    id: token(row.id), conversationId: token(row.conversationId), collectionId: token(row.collectionId),
    revisionId: token(row.revisionId), messageId: token(row.messageId), role: pick(row.role, ['user', 'assistant']),
    text: boundedString(row.text, 512 * 1024), title: boundedString(row.title, 1_024),
    sourceUrl: safeConversationUrl(row.sourceUrl), coverage: coverage(row.coverage),
    activity: savedActivity(row.activity), ...validateNoteFields(row),
    capturedAt: timestamp(row.capturedAt), createdAt, updatedAt,
  };
}

function readEvidence(value: unknown): HandoffEvidence {
  const row = object(value);
  const unavailable = optional(row.unavailable, bool);
  return {
    conversationId: optional(row.conversationId, token), revisionId: optional(row.revisionId, token),
    messageId: optional(row.messageId, token), title: boundedString(row.title, 1_024),
    sourceUrl: safeConversationUrl(row.sourceUrl), role: pick(row.role, ['user', 'assistant']),
    text: unavailable ? '' : boundedString(row.text, 512 * 1024), coverage: coverage(row.coverage), unavailable,
    observedAt: optional(row.observedAt, timestamp), selectionId: optional(row.selectionId, token),
    activity: unavailable ? undefined : savedActivity(row.activity),
  };
}

export function validateDraft(value: unknown): HandoffDraft {
  const row = object(value);
  const notes = object(row.notes);
  const createdAt = timestamp(row.createdAt);
  const updatedAt = timestamp(row.updatedAt);
  const budget = integer(row.budget, 10_000_000);
  if (!budget || updatedAt < createdAt) fail('Invalid handoff draft metadata.');
  const note = (raw: unknown) => boundedString(raw, 256 * 1024);
  const result: HandoffDraft = {
    id: token(row.id), collectionId: token(row.collectionId), title: boundedString(row.title, 1_024),
    template: pick(row.template, ['general', 'codex', 'research']), budget,
    notes: {
      goal: note(notes.goal), currentState: note(notes.currentState), decisions: note(notes.decisions),
      constraints: note(notes.constraints), references: note(notes.references),
      openQuestions: note(notes.openQuestions), nextSteps: note(notes.nextSteps),
    },
    evidence: fields(row.evidence, 2_048, readEvidence),
    createdAt, updatedAt,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024) {
    fail('Handoff draft exceeds the Trace size limit.');
  }
  return result;
}

export function validateEnvelope(input: unknown): TraceEnvelope {
  let data = input;
  if (typeof data === 'string') {
    if (data.length > maxImportBytes || new TextEncoder().encode(data).byteLength > maxImportBytes) {
      fail('Trace file exceeds the 64 MiB restore limit.');
    }
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      fail('This file is not valid Trace JSON.');
    }
  } else {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(data);
    } catch {
      fail('This file is not valid Trace JSON.');
    }
    if (!encoded || new TextEncoder().encode(encoded).byteLength > maxImportBytes) fail('Invalid or oversized Trace file.');
  }
  const row = object(data);
  if (row.format !== 'trace' || row.version !== 1) fail('Unsupported Trace file format or version.');
  const kind = pick(row.kind, ['backup', 'conversation'] as const);
  const collections = unique(fields(row.collections, 5_000, readCollection), (collection) => collection.id);
  const conversations = unique(fields(row.conversations, 50_000, readBackupConversation), (entry) => entry.conversation.id);
  const saved = unique(fields(row.saved, 50_000, readSaved), (item) => item.id);
  const drafts = unique(fields(row.drafts, 10_000, validateDraft), (item) => item.id);
  const exportedAt = timestamp(row.exportedAt);
  const preferences = optional(row.preferences, (raw) => ({ contextAlert: bool(object(raw).contextAlert) }));
  if (kind === 'conversation' && (saved.length || drafts.length || preferences)) {
    fail('A conversation export cannot include archive notes or settings.');
  }
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const conversationMap = new Map<string, Conversation>();
  const aliasIds = new Set<string>();
  const revisionIds = new Set<string>();
  const segmentIds = new Set<string>();
  for (const entry of conversations) {
    const { conversation } = entry;
    if (!collectionIds.has(conversation.collectionId)) fail('Missing source collection.');
    conversationMap.set(conversation.id, conversation);
    for (const alias of entry.aliases) {
      const key = JSON.stringify([conversation.collectionId, alias]);
      if (aliasIds.has(key)) fail('Duplicate scoped provider identity.');
      aliasIds.add(key);
    }
    for (const revision of entry.revisions) {
      if (revisionIds.has(revision.id)) fail('Duplicate revision identity.');
      revisionIds.add(revision.id);
    }
    for (const segment of entry.segments) {
      if (segmentIds.has(segment.id)) fail('Duplicate segment identity.');
      segmentIds.add(segment.id);
    }
  }
  for (const item of [...saved, ...drafts]) {
    if (!collectionIds.has(item.collectionId)) fail('Missing source collection.');
  }
  for (const item of saved) {
    const conversation = conversationMap.get(item.conversationId);
    if (conversation && conversation.collectionId !== item.collectionId) fail('Saved excerpt collection mismatch.');
  }
  return { format: 'trace', version: 1, kind, exportedAt, collections, conversations, saved, drafts, preferences };
}

export function previewEnvelope(envelope: TraceEnvelope): ImportPreview {
  return {
    kind: envelope.kind, collections: envelope.collections, conversations: envelope.conversations.length,
    revisions: envelope.conversations.reduce((count, record) => count + record.revisions.length, 0),
    saved: envelope.saved.length, drafts: envelope.drafts.length,
  };
}

export function makeConversationExport(views: ConversationView[], selectedRevisionIds?: string[]): TraceEnvelope {
  const selected = selectedRevisionIds && new Set(selectedRevisionIds);
  const collections = new Map<string, BackupCollection>();
  const conversations: BackupConversation[] = [];
  for (const view of views) {
    const { collection, conversation, segment } = view;
    if (!segment) continue;
    const revisions = selected ? view.messages.filter((message) => selected.has(message.id)) : view.messages;
    if (selected && !revisions.length) continue;
    const revisionIds = new Set(revisions.map((message) => message.id));
    const coverage = selected
      ? { state: 'partial' as const, reason: ('Selected excerpts. Source coverage: ' + segment.coverage.reason).slice(0, 512) }
      : segment.coverage;
    collections.set(collection.id, { id: collection.id, label: collection.label, retention: collection.retention });
    conversations.push({
      conversation: { ...conversation, segmentId: segment.id, coverage },
      aliases: [conversation.providerId],
      revisions,
      segments: [{ ...segment, coverage, revisions: segment.revisions.filter((ref) => revisionIds.has(ref.revisionId)) }],
      selection: selected ? 'excerpts' : 'branch',
      sourceCoverage: selected ? segment.coverage : undefined,
    });
  }
  return { format: 'trace', version: 1, kind: 'conversation', exportedAt: Date.now(), collections: [...collections.values()],
    conversations, saved: [], drafts: [] };
}
