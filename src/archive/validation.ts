import type { ActivitySnapshot, Coverage, Metric, Projection } from '../contracts';
import type { Retention } from './types';

export type RecordValue = Record<string, unknown>;

export function fail(message: string): never {
  throw new Error(message);
}

export function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid Trace record.');
  return value as RecordValue;
}

export function boundedString(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) fail('Invalid or oversized Trace text.');
  return value;
}

export function token(value: unknown): string {
  const id = boundedString(value, 640);
  if (!id || /[\u0000-\u001f\u007f]/u.test(id)) fail('Invalid Trace identifier.');
  return id;
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('Invalid Trace flag.');
  return value;
}

export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail('Invalid Trace number.');
  }
  return value;
}

export function timestamp(value: unknown): number {
  return integer(value, 8_640_000_000_000_000);
}

export function fields<T>(value: unknown, max: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid or oversized Trace list.');
  return value.map(parse);
}

export function pick<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) fail('Unsupported Trace value.');
  return value as T;
}

export function optional<T>(value: unknown, parse: (entry: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

export function nullable<T>(value: unknown, parse: (entry: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

export function retention(value: unknown): Retention {
  if (value !== 30 && value !== 90 && value !== 'forever') fail('Unsupported retention policy.');
  return value;
}

export function coverage(value: unknown): Coverage {
  const row = object(value);
  return { state: pick(row.state, ['unknown', 'partial', 'complete']), reason: boundedString(row.reason, 512) };
}

export function safeConversationUrl(value: unknown): string {
  const text = boundedString(value, 2_048);
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('Unsupported source conversation URL.');
  }
  if (url.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
    || url.username || url.password || url.port
    || !/^\/(?:c\/[A-Za-z0-9_-]+|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+)?\/?$/u.test(url.pathname)) {
    fail('Unsupported source conversation URL.');
  }
  return url.origin + url.pathname;
}

function metric<T>(value: unknown, readValue: (input: unknown) => T): Metric<T> {
  const row = object(value);
  return {
    value: readValue(row.value),
    sourceField: boundedString(row.sourceField, 256),
    sourceKind: pick(row.sourceKind, ['server-reported', 'dom-observed', 'local', 'derived']),
    observedAt: timestamp(row.observedAt),
    replyId: optional(row.replyId, token),
    adapterVersion: token(row.adapterVersion),
    endpoint: boundedString(row.endpoint, 128),
    status: pick(row.status, ['reported', 'observed', 'derived']),
  };
}

export function savedActivity(value: unknown): ActivitySnapshot | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  const readN = (input: unknown) => metric(input, integer);
  const readS = (input: unknown) => metric(input, (raw) => boundedString(raw, 256));
  return {
    state: pick(row.state, ['waiting', 'streaming', 'reported', 'partial', 'unavailable']),
    model: optional(row.model, readS),
    displayModel: optional(row.displayModel, readS),
    requestedModel: optional(row.requestedModel, readS),
    conversationDefault: optional(row.conversationDefault, readS),
    input: optional(row.input, readN),
    output: optional(row.output, readN),
    effectiveWindow: optional(row.effectiveWindow, readN),
    catalogMaximum: optional(row.catalogMaximum, readN),
    comparable: bool(row.comparable),
    comparableReason: optional(row.comparableReason, (text) => boundedString(text, 512)),
    quotas: [],
    observedAt: optional(row.observedAt, timestamp),
    replyId: optional(row.replyId, token),
    adapterVersion: token(row.adapterVersion),
  };
}

export function validateProjection(value: unknown, explicit: boolean): Projection {
  const row = object(value);
  const messages = fields(row.messages, 8_192, (input) => {
    const message = object(input);
    return {
      id: token(message.id),
      parentId: optional(message.parentId, (parent) => nullable(parent, token)),
      provisional: bool(message.provisional),
      role: pick(message.role, ['user', 'assistant'] as const),
      text: boundedString(message.text, 512 * 1024),
      observedAt: timestamp(message.observedAt),
      final: bool(message.final),
      activity: explicit ? savedActivity(message.activity) : undefined,
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length) fail('Duplicate message in this capture.');
  const projection: Projection = {
    providerId: token(row.providerId),
    title: boundedString(row.title, 1_024),
    sourceUrl: safeConversationUrl(row.sourceUrl),
    selectionId: token(row.selectionId),
    leafId: optional(row.leafId, token),
    source: pick(row.source, ['dom', 'history']),
    messages,
    coverage: coverage(row.coverage),
    observedAt: timestamp(row.observedAt),
    adapterVersion: token(row.adapterVersion),
    batchId: token(row.batchId),
    aliasFrom: optional(row.aliasFrom, token),
  };
  const byteLimit = explicit ? 2_097_152 : 131_072;
  if (new TextEncoder().encode(JSON.stringify(projection)).byteLength > byteLimit) fail('Capture exceeds the Trace size limit.');
  return projection;
}

export function validateNoteFields(value: unknown): { label: string; tags: string[]; note: string } {
  const row = object(value);
  return {
    label: row.label === undefined ? '' : boundedString(row.label, 256),
    tags: row.tags === undefined ? [] : fields(row.tags, 32, (entry) => boundedString(entry, 128)),
    note: row.note === undefined ? '' : boundedString(row.note, 65_536),
  };
}
