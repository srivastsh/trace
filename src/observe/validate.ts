import type { CapturedMessage, Coverage, Metric, Quota } from '../contracts';
import {
  ADAPTER, BATCH_LIMIT, BRIDGE, byteLength, count, id, label, record,
  type Endpoint, type Envelope, type HistoryText, type Observation, type ReplyFacts,
} from './protocol';

const endpoints = new Set<Endpoint['kind']>(['history', 'turn', 'models', 'init', 'account', 'images']);
const phases = new Set<Envelope['phase']>(['start', 'data', 'finish', 'error']);
const sourceField = /^[a-z][a-z._\[\]0-9]{0,119}$/i;
const modelId = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

function readMetric<T>(value: unknown, endpoint: Endpoint['kind'], at: number, read: (raw: unknown) => T | undefined): Metric<T> {
  const field = record(value);
  const observed = read(field?.value);
  const time = field?.observedAt;
  if (!field || observed === undefined || field.endpoint !== endpoint || field.adapterVersion !== ADAPTER ||
    typeof field.sourceField !== 'string' || !sourceField.test(field.sourceField) ||
    !count(time) || time > at + 5000 || time < at - 30 * 60 * 1000 ||
    (field.replyId !== undefined && !id(field.replyId))) throw new Error('invalid metric');
  const derived = field.sourceKind === 'derived' && field.status === 'derived';
  if (!derived && (field.sourceKind !== 'server-reported' || field.status !== 'reported')) throw new Error('invalid source');
  return { value: observed, sourceField: field.sourceField, endpoint, observedAt: time, adapterVersion: ADAPTER,
    ...(typeof field.replyId === 'string' && { replyId: field.replyId }), sourceKind: derived ? 'derived' : 'server-reported',
    status: derived ? 'derived' : 'reported' };
}

const numeric = (value: unknown) => count(value) && value <= 8.64e15 ? value : undefined;
const identifier = (value: unknown) => typeof value === 'string' && modelId.test(value) ? value : undefined;
const metricKeys = ['model', 'displayModel', 'requestedModel', 'input', 'output', 'effectiveWindow'] as const;
const coverageStates = new Set<Coverage['state']>(['complete', 'partial', 'unknown']);

function readReply(value: unknown, endpoint: Endpoint['kind'], at: number): ReplyFacts {
  const row = record(value);
  if (!row || typeof row.comparable !== 'boolean' || (row.replyId !== undefined && !id(row.replyId))) throw new Error('invalid reply');
  const reply: ReplyFacts = { comparable: false };
  const replyId = id(row.replyId);
  if (replyId) reply.replyId = replyId;
  for (const key of metricKeys) {
    if (row[key] === undefined) continue;
    if (key === 'model' || key === 'requestedModel' || key === 'displayModel') {
      const fact = readMetric(row[key], endpoint, at, key === 'displayModel' ? label : identifier);
      if (key !== 'requestedModel' && (!replyId || fact.replyId !== replyId)) throw new Error('unmatched reply');
      if (fact.replyId && fact.replyId !== replyId) throw new Error('unmatched reply');
      reply[key] = fact;
    } else {
      const fact = readMetric(row[key], endpoint, at, numeric);
      if (!replyId || fact.replyId !== replyId) throw new Error('unmatched reply');
      reply[key] = fact;
    }
  }
  if (count(row.observedAt) && row.observedAt <= at + 5000 && row.observedAt >= at - 30 * 60 * 1000) reply.observedAt = row.observedAt;
  const order = reply.input && reply.effectiveWindow && reply.effectiveWindow.value > 0;
  reply.comparable = !!(order && row.comparable && reply.input!.value <= reply.effectiveWindow!.value);
  if (order) {
    reply.comparableReason = reply.input!.value > reply.effectiveWindow!.value ? 'Conflicting reported values'
      : reply.comparable ? 'Reply-reported input count and effective window' : 'Accounting scope not established';
  }
  return reply;
}

function readQuotas(value: unknown, endpoint: Endpoint['kind'], at: number): Quota[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error('invalid quotas');
  return value.map(item => {
    const row = record(item);
    const feature = label(row?.feature);
    const scope = endpoint === 'images' ? 'image uploads' : 'current account';
    if (!row || !feature || row.scope !== scope || !count(row.observedAt) ||
      Math.abs(row.observedAt - at) > 5000) throw new Error('invalid quota');
    const quota: Quota = { feature, scope, observedAt: row.observedAt };
    for (const key of ['remaining', 'used', 'total', 'resetSeconds', 'deadline'] as const) {
      if (row[key] === undefined) continue;
      const metric = readMetric(row[key], endpoint, at, numeric);
      if (metric.replyId || (metric.status === 'derived' && key !== 'deadline')) throw new Error('invalid quota metric');
      quota[key] = metric;
    }
    if (quota.deadline?.status === 'derived' && (!quota.resetSeconds ||
      quota.deadline.value !== quota.observedAt + quota.resetSeconds.value * 1000)) throw new Error('invalid derived deadline');
    return quota;
  });
}

function readHistory(value: unknown, at: number): HistoryText {
  const row = record(value);
  const selectionId = id(row?.selectionId);
  const leafId = id(row?.leafId);
  const coverage = record(row?.coverage);
  if (!row || !selectionId || !coverage || !coverageStates.has(coverage.state as Coverage['state']) ||
    !Array.isArray(row.messages) || !row.messages.length || row.messages.length > 2000) throw new Error('invalid history');

  const messages: CapturedMessage[] = [];
  const seen = new Set<string>();
  let size = 0;
  for (const value of row.messages) {
    const message = record(value);
    const messageId = id(message?.id);
    if (!message || !messageId || seen.has(messageId) || message.provisional !== false ||
      (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || !message.text ||
      message.text.length > BATCH_LIMIT || !count(message.observedAt) || Math.abs(message.observedAt - at) > 5000 ||
      (message.parentId !== null && message.parentId !== undefined && !(id(message.parentId) && message.parentId !== messageId)) ||
      typeof message.final !== 'boolean') throw new Error('invalid history message');
    seen.add(messageId);
    size += byteLength(message.text);
    if (size > BATCH_LIMIT) throw new Error('invalid history size');
    const captured: CapturedMessage = {
      id: messageId, parentId: message.parentId as string | null | undefined, provisional: false,
      role: message.role, text: message.text, observedAt: message.observedAt, final: message.final,
    };
    if (message.activity !== undefined) {
      const reply = readReply(message.activity, 'history', at);
      if (captured.role !== 'assistant' || reply.replyId !== messageId) throw new Error('invalid history attribution');
      captured.activity = { ...reply, state: reply.model || reply.input || reply.output ? 'reported' : 'partial', adapterVersion: ADAPTER, quotas: [] };
    }
    messages.push(captured);
  }
  const proof = messages.every((message, index) => message.final && message.parentId === (index ? messages[index - 1].id : null));
  if (leafId !== messages.at(-1)?.id || selectionId !== `history:${leafId}` ||
    (coverage.state === 'complete' && !proof)) throw new Error('unproven history selection');
  const state = coverage.state as Coverage['state'];
  return { selectionId, leafId, title: label(row.title, 240), messages, coverage: { state,
    reason: state === 'complete' ? 'Observed finalized ancestry from the selected leaf to its root'
      : state === 'partial' ? 'History is incomplete, interrupted, or exceeds capture limits'
      : 'The ordered history page does not identify parent relationships' } };
}

export function validateEnvelope(value: unknown, expected: { channel: string; route: string; epoch: number; sequence: number; generation?: number },
  now = Date.now()): Envelope | undefined {
  const row = record(value);
  if (!row || row.source !== BRIDGE || row.type !== 'observation' || row.channel !== expected.channel ||
    row.route !== expected.route || row.epoch !== expected.epoch || !count(row.sequence) || row.sequence <= expected.sequence ||
    !count(row.request) || !row.request || !count(row.observedAt) || row.observedAt < now - 30 * 60 * 1000 ||
    row.observedAt > now + 5000 || !endpoints.has(row.endpoint as Endpoint['kind']) ||
    !phases.has(row.phase as Envelope['phase'])) return;
  const endpoint = row.endpoint as Endpoint['kind'];
  const phase = row.phase as Envelope['phase'];
  const payload = record(row.observation);
  if (!payload || (phase === 'start' || phase === 'finish') && endpoint !== 'turn') return;
  const observation: Observation = {};
  let generation: number | undefined;
  try {
    if (payload.conversationId !== undefined) {
      observation.conversationId = id(payload.conversationId);
      if (!observation.conversationId || endpoint !== 'history' && endpoint !== 'turn') return;
    }
    if (payload.identity !== undefined) {
      if (endpoint !== 'account') return;
      const identity = record(payload.identity);
      const accountId = id(identity?.accountId);
      const workspaceId = id(identity?.workspaceId);
      if (payload.identity !== null && (!accountId || !workspaceId)) return;
      observation.identity = accountId && workspaceId ? { accountId, workspaceId } : null;
    }
    if (payload.reply !== undefined) {
      if (endpoint !== 'history' && endpoint !== 'turn') return;
      observation.reply = readReply(payload.reply, endpoint, row.observedAt);
    }
    if (payload.conversationDefault !== undefined) {
      if (endpoint !== 'history' && endpoint !== 'turn') return;
      observation.conversationDefault = readMetric(payload.conversationDefault, endpoint, row.observedAt, identifier);
    }
    if (payload.accountDefault !== undefined) {
      if (endpoint !== 'models') return;
      observation.accountDefault = readMetric(payload.accountDefault, endpoint, row.observedAt, identifier);
    }
    if (payload.catalog !== undefined) {
      if (endpoint !== 'models' || !Array.isArray(payload.catalog) || payload.catalog.length > 60) return;
      observation.catalog = payload.catalog.map(item => {
        const entry = record(item);
        const model = identifier(entry?.model);
        if (!entry || !model) throw new Error('invalid catalog entry');
        return { model,
          ...(entry.display !== undefined && { display: readMetric(entry.display, endpoint, row.observedAt as number, label) }),
          ...(entry.maximum !== undefined && { maximum: readMetric(entry.maximum, endpoint, row.observedAt as number, numeric) }) };
      });
    }
    if (payload.quotas !== undefined) {
      if (endpoint !== 'init' && endpoint !== 'images' && endpoint !== 'turn') return;
      observation.quotas = readQuotas(payload.quotas, endpoint, row.observedAt);
    }
    if (payload.temporary !== undefined) {
      if (typeof payload.temporary !== 'boolean' || endpoint !== 'history' && endpoint !== 'turn' && endpoint !== 'init') return;
      observation.temporary = payload.temporary;
    }
    if (payload.history !== undefined) {
      if (endpoint !== 'history' || !count(expected.generation) || row.generation !== expected.generation) return;
      generation = expected.generation;
      observation.history = readHistory(payload.history, row.observedAt);
    }
    if (payload.issue !== undefined) {
      if (payload.issue !== 'bounded' && payload.issue !== 'interrupted' && payload.issue !== 'unsupported') return;
      observation.issue = payload.issue;
    }
  } catch { return; }
  const result: Envelope = {
    source: BRIDGE, type: 'observation' as const, channel: expected.channel, route: expected.route, epoch: expected.epoch,
    sequence: row.sequence, request: row.request, endpoint, phase, observedAt: row.observedAt, generation, observation,
  };
  return byteLength(JSON.stringify(result)) <= BATCH_LIMIT ? result : undefined;
}
