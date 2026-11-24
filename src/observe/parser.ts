import type { CapturedMessage, Metric, Quota } from '../contracts';
import {
  ADAPTER, BATCH_LIMIT, byteLength, count, id, label, MESSAGE_LIMIT, NODE_LIMIT, record,
  type Endpoint, type Observation, type ReplyFacts,
} from './protocol';

type Row = Record<string, unknown>;
type EndpointKind = Endpoint['kind'];
const hiddenKinds = new Set(['thoughts', 'reasoning_recap', 'code', 'execution_output', 'tether_browsing_display', 'model_editable_context']);
const ordinaryModels = /^[\p{L}\p{N}_.:/-]+$/u;
const validModel = (value: unknown) => label(value, 128) && ordinaryModels.test(value as string) ? value as string : undefined;

function findField<T>(row: Row | undefined, prefix: string, fields: string[], read: (value: unknown) => T | undefined) {
  for (const field of fields) {
    const value = read(row?.[field]);
    if (value !== undefined) return { value, sourceField: prefix + field };
  }
}
const number = (value: unknown) => count(value) ? value : undefined;
const positive = (value: unknown) => count(value) && value > 0 ? value : undefined;
const absoluteTime = (value: unknown) => {
  const milliseconds = typeof value === 'string' ? Date.parse(value) :
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : NaN;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 8.64e15 ? Math.round(milliseconds) : undefined;
};

export function metric<T>(value: T, sourceField: string, endpoint: EndpointKind, observedAt: number, replyId?: string): Metric<T> {
  return { value, sourceField, endpoint, observedAt, ...(replyId && { replyId }), adapterVersion: ADAPTER,
    sourceKind: 'server-reported', status: 'reported' };
}

export function roleOf(message: Row): CapturedMessage['role'] | undefined {
  const author = record(message.author);
  const metadata = record(message.metadata);
  const content = record(message.content);
  const role = author?.role;
  if ((role !== 'user' && role !== 'assistant') || (message.recipient != null && message.recipient !== 'all')) return;
  if (metadata?.is_visually_hidden_from_conversation === true || metadata?.is_internal === true || metadata?.is_hidden === true) return;
  if (author?.name || (typeof content?.content_type === 'string' && hiddenKinds.has(content.content_type))) return;
  if (message.channel === 'analysis' || message.channel === 'commentary' || metadata?.is_intermediate === true) return;
  return role;
}

function facts(reply: Row, replyId: string, endpoint: EndpointKind, at: number): ReplyFacts {
  const metadata = record(reply.metadata);
  const usage = record(metadata?.usage) ?? record(reply.usage);
  const usagePath = metadata?.usage === usage ? 'message.metadata.usage.' : 'message.usage.';
  const model = findField(metadata, 'message.metadata.', ['resolved_model_slug', 'model_slug'], validModel)
    ?? findField(reply, 'message.', ['model_slug'], validModel);
  const display = findField(metadata, 'message.metadata.', ['model_display_name', 'model_display_label'], label);
  const input = findField(usage, usagePath, ['input_tokens', 'prompt_tokens', 'context_tokens'], number);
  const output = findField(usage, usagePath, ['output_tokens', 'completion_tokens'], number);
  const window = findField(usage, usagePath, ['effective_context_window_tokens'], positive)
    ?? findField(metadata, 'message.metadata.', ['effective_context_window_tokens', 'context_window_tokens'], positive)
    ?? findField(usage, usagePath, ['context_window_tokens'], positive);
  const requested = findField(metadata, 'message.metadata.', ['requested_model_slug'], validModel);
  const make = <T>(field: { value: T; sourceField: string } | undefined) =>
    field && metric(field.value, field.sourceField, endpoint, at, replyId);
  // A window-shaped field alone says nothing about the accounting scope.
  const inputWindow = !!input && !!window
    && (metadata?.context_accounting_scope === 'input' || usage?.context_accounting_scope === 'input'
      || (input.sourceField.endsWith('.input_tokens') && window.sourceField.endsWith('.effective_context_window_tokens')));
  const comparable = inputWindow && input.value <= window.value;
  return {
    replyId, ...(model && { model: make(model) }), ...(display && model && { displayModel: make(display) }),
    ...(requested && { requestedModel: make(requested) }), ...(input && { input: make(input) }),
    ...(output && { output: make(output) }), ...(window && { effectiveWindow: make(window) }),
    comparable, comparableReason: comparable ? 'Reply-reported input count and effective window'
      : input && window && input.value > window.value ? 'Conflicting reported values' : input && window ? 'Accounting scope not established' : undefined,
    observedAt: at,
  };
}

function temporaryFlag(row: Row): boolean | undefined {
  const flags = [row.is_temporary_chat, row.is_temporary, row.temporary_chat];
  if (flags.includes(true)) return true;
  if (flags.includes(false)) return false;
}

function defaults(row: Row, endpoint: EndpointKind, at: number) {
  const value = validModel(row.default_model_slug);
  return value ? metric(value, 'default_model_slug', endpoint, at) : undefined;
}

function quota(row: Row, feature: string, endpoint: EndpointKind, at: number, prefix: string): Quota | undefined {
  const remaining = findField(row, prefix, endpoint === 'images' ? ['remaining_uploads', 'remaining'] : ['remaining'], number);
  const used = findField(row, prefix, ['used', 'used_count', 'consumed'], number);
  const total = findField(row, prefix, ['limit', 'total', 'max_requests', 'daily_upload_limit', 'image_upload_limit',
    'upload_limit', 'max_uploads_per_day'], number);
  const reset = findField(row, prefix, ['reset_after', 'reset_after_seconds'], number);
  const deadline = findField(row, prefix, ['reset_at', 'upload_reset_at'], absoluteTime);
  if (!remaining && !used && !total && !reset && !deadline) return;
  const make = (field: { value: number; sourceField: string }) => metric(field.value, field.sourceField, endpoint, at);
  const derived = reset && reset.value <= (8.64e15 - at) / 1000 ?
    { ...metric(at + reset.value * 1000, reset.sourceField, endpoint, at), sourceKind: 'derived' as const, status: 'derived' as const } : undefined;
  return { feature, scope: endpoint === 'images' ? 'image uploads' : 'current account', observedAt: at,
    ...(remaining && { remaining: make(remaining) }), ...(used && { used: make(used) }), ...(total && { total: make(total) }),
    ...(reset && { resetSeconds: make(reset) }), ...((deadline || derived) && { deadline: deadline ? make(deadline) : derived }),
  };
}

function projectQuotas(row: Row, endpoint: EndpointKind, at: number) {
  if (!Array.isArray(row.limits_progress)) return;
  return row.limits_progress.slice(0, 40).flatMap(value => {
    const entry = record(value);
    const feature = findField(entry, '', ['feature_name', 'feature', 'name'], label)?.value;
    const result = entry && feature && quota(entry, feature, endpoint, at, 'limits_progress[].');
    return result ? [result] : [];
  });
}

const finalMessage = (message: Row, role: CapturedMessage['role']) => role === 'user' ||
  message.status === 'finished_successfully' || message.status === 'complete' || message.end_turn === true;

function supportedText(message: Row): { text: string; gap: boolean } | undefined {
  const content = record(message.content);
  if (!content || (content.content_type !== 'text' && content.content_type !== 'multimodal_text') || !Array.isArray(content.parts)) return;
  const parts: string[] = [];
  let gap = false;
  let bytes = 0;
  for (const part of content.parts) {
    let text: string;
    if (typeof part === 'string') text = part;
    else {
      const asset = record(part);
      if (asset?.content_type === 'image_asset_pointer') text = '[Image omitted]';
      else if (asset?.content_type === 'audio_asset_pointer') text = '[Audio omitted]';
      else if (asset?.content_type === 'video_asset_pointer') text = '[Video omitted]';
      else { gap = true; continue; }
    }
    bytes += byteLength(text) + 1;
    if (bytes > MESSAGE_LIMIT || parts.length >= NODE_LIMIT) return;
    parts.push(text);
  }
  const attachments = record(message.metadata)?.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments.slice(0, 40)) {
      const file = record(attachment);
      const name = label(file?.name ?? file?.file_name);
      const type = label(file?.mime_type);
      parts.push(`[Attachment${name ? ': ' + name : ''}${type ? ' (' + type + ')' : ''}; file contents not included]`);
    }
    if (attachments.length > 40) gap = true;
  }
  return { text: parts.join('\n'), gap };
}

interface PathEntry { key: string; value: Row; }
function activePath(data: Row): { path: PathEntry[]; gap: boolean; ancestry: boolean } | undefined {
  const active = id(data.current_node);
  if (!active) return;
  if (Array.isArray(data.messages)) {
    const available = data.messages.slice(0, NODE_LIMIT);
    const leaf = available.findIndex(value => id(record(value)?.id) === active);
    if (leaf < 0) return;
    // A history page can expose an ordered selection without graph proof.
    const path = available.slice(0, leaf + 1).flatMap(value => {
      const message = record(value);
      const key = id(message?.id);
      return message && key ? [{ key, value: message }] : [];
    });
    const indexed: Row = Object.create(null) as Row;
    for (const entry of path) indexed[entry.key] = { message: entry.value, parent: entry.value.parent_id };
    const allPages = record(data.page_info)?.has_previous_page === false;
    if (path.some(entry => Object.hasOwn(entry.value, 'parent_id'))) {
      const tree = activePath({ current_node: active, mapping: indexed });
      if (tree) return { ...tree, gap: tree.gap || !allPages };
    }
    return { path, gap: !allPages || path.length !== leaf + 1, ancestry: false };
  }
  const mapping = record(data.mapping);
  if (!mapping) return;
  const seen = new Set<string>();
  const path: PathEntry[] = [];
  let key: string | undefined = active;
  let root = false;
  let malformed = false;
  while (key && !seen.has(key) && seen.size < NODE_LIMIT) {
    const item = Object.hasOwn(mapping, key) ? record(mapping[key]) : undefined;
    if (!item) break;
    seen.add(key);
    const message = record(item.message);
    if (message) {
      const messageId = id(message.id) ?? key;
      path.push({ key: messageId, value: message });
    } else if (item.message !== null) malformed = true;
    root = item.parent === null;
    key = id(item.parent);
  }
  return seen.size ? { path: path.reverse(), gap: !root || malformed, ancestry: true } : undefined;
}

function projectHistory(data: Row, conversationId: string, at: number, captureText: boolean): Observation | undefined {
  if (data.conversation_id != null && id(data.conversation_id) !== conversationId) return;
  const path = activePath(data);
  const visible = path?.path.flatMap(entry => {
    const role = roleOf(entry.value);
    return role ? [{ ...entry, role }] : [];
  }) ?? [];
  const latest = visible.at(-1);
  const reply = latest?.role === 'assistant' ? facts(latest.value, latest.key, 'history', at) : undefined;
  const observation: Observation = { conversationId, conversationDefault: defaults(data, 'history', at), temporary: temporaryFlag(data), reply };
  if (!captureText || observation.temporary === true || !path || !latest) return observation;
  const messages: CapturedMessage[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let gap = path.gap;
  for (const entry of visible) {
    const parsed = supportedText(entry.value);
    if (!parsed || parsed.gap) gap = true;
    if (!parsed?.text || seen.has(entry.key)) { gap = true; continue; }
    seen.add(entry.key);
    const previous = messages.at(-1);
    const activity = entry.role === 'assistant' ? facts(entry.value, entry.key, 'history', at) : undefined;
    const message: CapturedMessage = {
      id: entry.key, provisional: false, role: entry.role, text: parsed.text,
      observedAt: at, final: finalMessage(entry.value, entry.role),
      ...(path.ancestry && { parentId: previous?.id ?? (gap ? undefined : null) }),
      ...(activity && { activity: { ...activity, state: 'reported', adapterVersion: ADAPTER, quotas: [] } }),
    };
    const messageBytes = byteLength(JSON.stringify(message)) + 1;
    if (messageBytes > BATCH_LIMIT - 8192 || bytes + messageBytes > BATCH_LIMIT - 8192) {
      gap = true;
      // Keep the loaded suffix available even for conversations larger than
      // one observation. The archive will retain separately observed turns.
      if (messageBytes > BATCH_LIMIT - 8192) continue;
      while (messages.length && bytes + messageBytes > BATCH_LIMIT - 8192) {
        bytes -= byteLength(JSON.stringify(messages.shift())) + 1;
      }
    }
    messages.push(message);
    bytes += messageBytes;
  }
  if (!messages.length) return { ...observation, issue: 'bounded' };
  const leaf = messages.at(-1)!;
  gap ||= !leaf.final || leaf.id !== latest.key || messages.some(message => !message.final);
  observation.history = {
    selectionId: `history:${leaf.id}`, leafId: leaf.id, title: label(data.title, 240), messages,
    coverage: gap ? { state: 'partial', reason: 'History is incomplete, interrupted, or exceeds capture limits' }
      : path.ancestry ? { state: 'complete', reason: 'Observed finalized ancestry from the selected leaf to its root' }
      : { state: 'unknown', reason: 'The ordered history page does not identify parent relationships' },
  };
  return observation;
}

export function projectResponse(endpoint: Endpoint, value: unknown, at: number, captureText = false): Observation | undefined {
  const wrapped = record(value);
  if (!wrapped) return;
  const row = record(wrapped.data) ?? wrapped;
  switch (endpoint.kind) {
    case 'history': return projectHistory(row, endpoint.id, at, captureText);
    case 'models': return {
      accountDefault: defaults(row, endpoint.kind, at),
      catalog: Array.isArray(row.models) ? row.models.slice(0, 60).flatMap(value => {
        const entry = record(value);
        const model = validModel(entry?.slug);
        if (!model) return [];
        const display = findField(entry, 'models[].', ['title', 'display_name', 'name'], label);
        const maximum = findField(entry, 'models[].', ['context_window_tokens', 'context_window', 'context_length', 'max_context_tokens'], positive);
        return [{ model, ...(display && { display: metric(display.value, display.sourceField, endpoint.kind, at) }),
          ...(maximum && { maximum: metric(maximum.value, maximum.sourceField, endpoint.kind, at) }) }];
      }) : undefined,
    };
    case 'init': return { quotas: projectQuotas(row, endpoint.kind, at), temporary: temporaryFlag(row) };
    case 'images': {
      const explicit = record(row.upload_quota);
      const upload = explicit ?? row;
      if (!explicit && !['remaining_uploads', 'daily_upload_limit', 'image_upload_limit', 'upload_limit', 'max_uploads_per_day', 'upload_reset_at']
        .some(field => Object.hasOwn(row, field))) return;
      const result = quota(upload, 'image uploads', endpoint.kind, at, explicit ? 'upload_quota.' : '');
      return result ? { quotas: [result] } : undefined;
    }
    case 'account': {
      const accountId = id(row.active_account_id) ?? id(row.active_user_id);
      const accounts = record(row.accounts);
      const accountEntry = accountId && accounts && Object.hasOwn(accounts, accountId) ? record(accounts[accountId]) : undefined;
      const account = record(accountEntry?.account);
      const activeWorkspace = id(row.active_workspace_id);
      const nestedWorkspace = id(account?.workspace_id);
      if (activeWorkspace && nestedWorkspace && activeWorkspace !== nestedWorkspace) return { identity: null };
      const workspaceId = activeWorkspace ?? nestedWorkspace ??
        (account?.is_personal_workspace === true ? 'personal' : undefined);
      return { identity: accountId && workspaceId ? { accountId, workspaceId } : null };
    }
    case 'turn': {
      const turn = createTurnReader();
      return turn.accept(row, at);
    }
  }
}

// These explicitly supported patch paths were derived from the pinned Modus
// stream reader. Keep only facts and bounded shape markers, never a message body.
const retainedMetadata = [
  'resolved_model_slug', 'model_slug', 'requested_model_slug', 'model_display_name', 'model_display_label',
  'context_accounting_scope', 'effective_context_window_tokens', 'context_window_tokens',
  'is_visually_hidden_from_conversation', 'is_internal', 'is_hidden', 'is_intermediate',
];
const retainedUsage = [
  'input_tokens', 'prompt_tokens', 'context_tokens', 'output_tokens', 'completion_tokens',
  'context_accounting_scope', 'effective_context_window_tokens', 'context_window_tokens',
];

function putScalar(target: Row, key: string, value: unknown) {
  if ((typeof value === 'string' && value.length <= 160) || count(value) || typeof value === 'boolean') target[key] = value;
}

function retain(target: Row, source: Row | undefined, allowed: string[]) {
  for (const key of allowed) putScalar(target, key, source?.[key]);
}

function retainMeta(target: Row, value: Row | undefined) {
  retain(target, value, retainedMetadata);
  const usage = record(value?.usage);
  if (usage) {
    const prior = record(target.usage) ?? {};
    retain(prior, usage, retainedUsage);
    target.usage = prior;
  }
}

function streamMessage(message: Row) {
  const recipient = label(message.recipient);
  const author = record(message.author);
  if (author?.role !== 'assistant' || (message.recipient != null && recipient !== 'all') || author.name) return;
  const replyId = id(message.id);
  if (!replyId) return;
  const metadata: Row = {};
  const usage: Row = {};
  retainMeta(metadata, record(message.metadata));
  retain(usage, record(message.usage), retainedUsage);
  return {
    replyId, author: { role: 'assistant' }, recipient, metadata, ...(Object.keys(usage).length && { usage }),
    channel: label(message.channel), content: { content_type: label(record(message.content)?.content_type) },
    model_slug: validModel(message.model_slug),
  };
}

export function createTurnReader() {
  let active: ReturnType<typeof streamMessage>;
  let conversationId: string | undefined;
  let requestedModel: Metric<string> | undefined;
  let previous = '';
  let terminal = false;
  let mixed = false;

  function read(value: unknown, at: number, depth: number, budget: { left: number }, next: Observation) {
    const row = record(value);
    if (!row || depth > 5 || budget.left-- <= 0) return;
    // Excluded stream control frames (including resume-token frames) carry no facts.
    if (typeof row.type === 'string' && /(?:token|sentinel|auth)/i.test(row.type)) return;
    const explicitId = id(row.conversation_id);
    if (explicitId) {
      if (conversationId && conversationId !== explicitId) { mixed = true; return; }
      conversationId = explicitId;
    }
    if (row.message) {
      const message = record(row.message);
      const incoming = message && streamMessage(message);
      if (incoming && active?.replyId === incoming.replyId) {
        retainMeta(active.metadata, incoming.metadata);
        if (incoming.usage) {
          active.usage ??= {};
          retain(active.usage, incoming.usage, retainedUsage);
        }
        if (incoming.model_slug) active.model_slug = incoming.model_slug;
        if (incoming.channel !== undefined) active.channel = incoming.channel;
        if (incoming.content.content_type !== undefined) active.content = incoming.content;
      } else active = incoming;
    }

    if (active && typeof row.p === 'string' && row.p.startsWith('/message/metadata')) {
      const field = row.p.slice('/message/metadata'.length);
      const update = row.o === 'add' || row.o === 'replace' || row.o === 'append';
      if (!field && update) retainMeta(active.metadata, record(row.v));
      if (field === '/is_visually_hidden_from_conversation' && row.o === 'remove') active.metadata.is_visually_hidden_from_conversation = false;
      const key = field.slice(1);
      if (update && retainedMetadata.includes(key)) putScalar(active.metadata, key, row.v);
      if (update && key === 'usage') retainMeta(active.metadata, { usage: row.v });
      if (update && key.startsWith('usage/') && retainedUsage.includes(key.slice(6))) {
        active.metadata.usage ??= {};
        putScalar(record(active.metadata.usage)!, key.slice(6), row.v);
      }
    }

    if (row.type === 'server_ste_metadata' && active && id(record(row.metadata)?.message_id) === active.replyId) {
      retainMeta(active.metadata, record(row.metadata));
    }
    if (row.type === 'conversation_detail_metadata') {
      const requested = validModel(row.requested_model_slug);
      if (requested) requestedModel = metric(requested, 'requested_model_slug', 'turn', at);
      next.conversationDefault = defaults(row, 'turn', at);
      next.quotas = projectQuotas(row, 'turn', at);
      next.temporary = temporaryFlag(row);
    }
    if (row.type === 'message_stream_complete') terminal = true;

    if (!row.p && Array.isArray(row.v)) {
      for (const change of row.v) {
        if (budget.left <= 0) break;
        read(change, at, depth + 1, budget, next);
      }
    } else if (!row.p && row.v) read(row.v, at, depth + 1, budget, next);
  }

  return {
    accept(value: unknown, at: number): Observation | undefined {
      const next: Observation = {};
      read(value, at, 0, { left: 1024 }, next);
      if (mixed) return;
      if (conversationId) next.conversationId = conversationId;
      if (active && roleOf(active)) {
        next.reply = facts(active, active.replyId, 'turn', at);
        if (requestedModel && !next.reply.requestedModel) next.reply.requestedModel = requestedModel;
      } else if (requestedModel) next.reply = { requestedModel, comparable: false };
      // Observation times do not make recurring identical stream facts new.
      const fingerprint = JSON.stringify(next, (key, value: unknown) => key === 'observedAt' ? undefined : value);
      if (!Object.keys(next).length && previous === '') return;
      if (fingerprint === previous) return;
      previous = fingerprint;
      return next;
    },
    finished() { return terminal; },
    valid() { return !mixed; },
  };
}
