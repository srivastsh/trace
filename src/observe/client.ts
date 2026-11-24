import type { ActionContext, ActivitySnapshot, CapturedMessage, Projection, Quota } from '../contracts';
import {
  affectsTranscript, MESSAGE, readDomMessages, readTitle, temporaryFromDom, unsupportedClearanceMutation, visibleMessages, type DomMessage,
} from './dom';
import {
  ADAPTER, BATCH_LIMIT, BRIDGE, byteLength, conversationRoute, record, STAGE_LIMIT,
  type Control, type Envelope, type Identity, type ModelCatalogEntry, type ReplyFacts, type Route,
} from './protocol';
import { validateEnvelope } from './validate';

export interface ObservationScope extends ActionContext {
  temporary: 'ordinary' | 'temporary' | 'unknown';
  identity?: Identity;
}
export interface ObserverCallbacks {
  onScope(scope: ObservationScope | null): void;
  onActivity(activity: ActivitySnapshot): void;
  onCapture(projection: Projection, generation: number): void;
  onDiagnostic(code: string): void;
}
type Grant = { epoch: number; generation: number; confirmedOrdinary?: boolean };

const sameIdentity = (left?: Identity, right?: Identity) =>
  left?.accountId === right?.accountId && left?.workspaceId === right?.workspaceId;

const canCapture = (temporary: ObservationScope['temporary'], grant: Grant) =>
  temporary === 'ordinary' || temporary === 'unknown' && grant.confirmedOrdinary === true;

function replyFacts(previous: ReplyFacts | undefined, next: ReplyFacts) {
  if (!previous || previous.replyId !== next.replyId) return next;
  // History may supplement the same reply with facts from the server. A
  // generic slug can never displace an explicit resolved attribution.
  const retained = { ...previous };
  for (const key of ['model', 'displayModel', 'requestedModel', 'input', 'output', 'effectiveWindow', 'observedAt'] as const) {
    const value = next[key];
    if (value !== undefined) Object.assign(retained, { [key]: value });
  }
  if (previous.model?.sourceField.endsWith('.resolved_model_slug') && !next.model?.sourceField.endsWith('.resolved_model_slug')) {
    retained.model = previous.model;
    retained.displayModel = previous.displayModel;
  } else if (previous.model?.value !== retained.model?.value && !next.displayModel) delete retained.displayModel;
  const proof = next.input && next.effectiveWindow ? next : previous;
  retained.comparable = !!(proof.comparable && retained.input?.value === proof.input?.value &&
    retained.effectiveWindow?.value === proof.effectiveWindow?.value);
  retained.comparableReason = retained.input && retained.effectiveWindow && retained.input.value > retained.effectiveWindow.value
    ? 'Conflicting reported values' : retained.comparable ? proof.comparableReason : retained.input && retained.effectiveWindow
      ? 'Accounting scope not established' : undefined;
  return retained;
}

export function createObserver(callbacks: ObserverCallbacks) {
  const channel = crypto.randomUUID();
  const origin = location.origin;
  let route: Route | null = null;
  let current: ObservationScope | null = null;
  let identity: Identity | undefined;
  let epoch = 0;
  let sequence = 0;
  let providerId = '';
  let aliasFrom: string | undefined;
  let promotion: { localId: string; canonicalId: string } | undefined;
  let capture: Grant | null = null;
  let knownTemporary = false;
  let destroyed = false;
  let seenStructure = false;
  let structureDirty = true;
  let clearanceDirty = true;
  let scopeQueued = false;
  let activityFrame = 0;
  let checkpoint = 0;
  let lastCheckpoint = 0;
  let rendered: DomMessage[] = [];
  let provisional = new WeakMap<Element, string>();
  let changed = new Set<Element>();
  let fullScan = false;
  let state: ActivitySnapshot['state'] = 'unavailable';
  let turn: { request: number; streaming: boolean } | undefined;
  let interruptedReply: string | undefined;
  let reply: ReplyFacts | undefined;
  let conversationDefault: ActivitySnapshot['conversationDefault'];
  let accountDefault: ActivitySnapshot['accountDefault'];
  let catalog: ModelCatalogEntry[] = [];
  let selectedHistoryLeaf: string | undefined;
  let currentHistory: { projection: Projection; epoch: number; generation: number } | undefined;
  const quotas = new Map<string, Quota>();
  const lastRequest = new Map<Envelope['endpoint'], number>();

  function describeActivity(): ActivitySnapshot {
    const entry = catalog.find(item => item.model === reply?.model?.value);
    return {
      ...reply, state, comparable: reply?.comparable ?? false, adapterVersion: ADAPTER,
      ...(reply?.model && !reply.displayModel && entry?.display && { displayModel: entry.display }),
      ...(entry?.maximum && { catalogMaximum: entry.maximum }),
      ...(conversationDefault && { conversationDefault }),
      ...(accountDefault && { accountDefault }), quotas: [...quotas.values()],
    };
  }

  function notifyActivity() {
    if (destroyed || activityFrame) return;
    activityFrame = requestAnimationFrame(() => {
      activityFrame = 0;
      if (!destroyed) callbacks.onActivity(describeActivity());
    });
  }

  function sendControl() {
    if (destroyed || !route) return;
    const notice: Control = { source: BRIDGE, type: 'control', channel, route: route.key, epoch,
      ...(capture && { generation: capture.generation }) };
    window.postMessage(notice, origin);
  }

  function clearCapture() {
    const active = capture;
    capture = null;
    currentHistory = undefined;
    changed.clear();
    fullScan = false;
    if (checkpoint) window.clearTimeout(checkpoint);
    checkpoint = 0;
    if (active) sendControl();
  }

  function emitScope() {
    if (scopeQueued || destroyed) return;
    scopeQueued = true;
    queueMicrotask(() => {
      scopeQueued = false;
      if (!destroyed) callbacks.onScope(current);
    });
  }

  function markEpoch() {
    epoch++;
    clearCapture();
    lastRequest.clear();
    sendControl();
  }

  function provisionalId(element: Element): string {
    let value = provisional.get(element);
    if (!value) {
      value = 'provisional:' + crypto.randomUUID();
      provisional.set(element, value);
    }
    return value;
  }

  function refresh() {
    if (destroyed) return null;
    let nextRoute = conversationRoute(new URL(location.href));
    if (nextRoute?.key.match(/\/(?:uc)\//)) nextRoute = null;
    const nav = nextRoute?.key !== route?.key;
    if (nav) {
      const promoted = promotion && promotion.localId === providerId && promotion.canonicalId === nextRoute?.providerId;
      aliasFrom = promoted ? providerId : undefined;
      promotion = undefined;
      route = nextRoute;
      providerId = route?.providerId ?? (route ? 'local:' + crypto.randomUUID() : '');
      provisional = new WeakMap();
      knownTemporary = false;
      if (!promoted) {
        turn = undefined;
        interruptedReply = undefined;
        reply = undefined;
        conversationDefault = undefined;
      }
      selectedHistoryLeaf = undefined;
      rendered = [];
      seenStructure = false;
      structureDirty = clearanceDirty = true;
      state = route ? turn?.streaming ? 'streaming' : reply?.model || reply?.input || reply?.output ? 'reported' : 'waiting' : 'unavailable';
      markEpoch();
      notifyActivity();
    }
    if (!route) {
      if (current) { current = null; emitScope(); }
      return null;
    }

    let temporary = current?.epoch === epoch ? current.temporary : 'unknown';
    if (clearanceDirty) {
      clearanceDirty = false;
      const flag = temporaryFromDom(document);
      temporary = route.temporary || knownTemporary || flag === true ? 'temporary' : flag === false ? 'ordinary' : 'unknown';
      if (current?.epoch === epoch && current.temporary !== temporary) markEpoch();
    }
    if (structureDirty) {
      structureDirty = false;
      rendered = visibleMessages(document, provisionalId);
      seenStructure ||= rendered.length > 0;
      const leaf = rendered.at(-1);
      if (leaf && selectedHistoryLeaf && selectedHistoryLeaf !== leaf.id) selectedHistoryLeaf = undefined;
      if (leaf && !leaf.provisional && reply?.replyId && leaf.id !== reply.replyId && !turn?.streaming) {
        reply = undefined;
        state = 'waiting';
        notifyActivity();
      }
    }
    if (route.temporary || knownTemporary) temporary = 'temporary';
    if (capture && (!canCapture(temporary, capture) || capture.epoch !== epoch)) clearCapture();
    const selectionId = selectedHistoryLeaf ? `history:${selectedHistoryLeaf}` : `dom:${rendered.at(-1)?.id ?? 'pending'}`;
    const next = { epoch, providerId, selectionId, temporary, ...(identity && { identity }) };
    if (current?.epoch !== next.epoch || current.providerId !== next.providerId || current.selectionId !== next.selectionId ||
      current.temporary !== next.temporary || !sameIdentity(current.identity, next.identity)) {
      current = next;
      emitScope();
    }
    return current;
  }

  function projection(scope: ObservationScope, messages: CapturedMessage[], coverage: Projection['coverage'], at: number): Projection {
    const latest = reply;
    const incomplete = messages.some(message => message.id === interruptedReply);
    return {
      providerId: scope.providerId, title: readTitle(document), sourceUrl: route?.providerId ? origin + route.key.split('?')[0] : origin + '/',
      selectionId: scope.selectionId, source: 'dom', messages: messages.map(message => {
        if (message.role !== 'assistant' || latest?.replyId !== message.id) return message;
        return { ...message, final: message.final && message.id !== interruptedReply,
          activity: { ...latest, state, adapterVersion: ADAPTER, quotas: [],
          ...(conversationDefault && { conversationDefault }) } };
      }),
      ...(rendered.at(-1) && { leafId: rendered.at(-1)!.id }),
      ...(aliasFrom && { aliasFrom }),
      coverage: incomplete ? { state: 'partial', reason: 'The observed reply was interrupted' } : coverage,
      observedAt: at, adapterVersion: ADAPTER, batchId: crypto.randomUUID(),
    };
  }

  function flushCapture() {
    checkpoint = 0;
    if (!capture || destroyed) return;
    const scope = refresh();
    if (!scope || !capture || !canCapture(scope.temporary, capture)) return;
    const generation = capture.generation;
    const at = Date.now();
    lastCheckpoint = at;
    const nodes = fullScan ? rendered : rendered.filter(message => changed.has(message.element));
    changed.clear();
    fullScan = false;
    const { messages, coverage } = readDomMessages(nodes, document, at, false);
    if (!messages.length) return;
    const selected = projection(scope, messages, coverage, at);
    let base = { ...selected, messages: [] };
    let bytes = byteLength(JSON.stringify(base));
    let chunk: CapturedMessage[] = [];
    function sendChunk() {
      if (!chunk.length) return;
      callbacks.onCapture({ ...base, messages: chunk }, generation);
      base = { ...base, batchId: crypto.randomUUID() };
      bytes = byteLength(JSON.stringify(base));
      chunk = [];
    }
    const enriched = selected.messages;
    if (enriched.some(message => byteLength(JSON.stringify(message)) > BATCH_LIMIT - 4096)) {
      base.coverage = { state: 'partial', reason: 'One or more visible messages exceed the automatic capture limit' };
      callbacks.onDiagnostic('dom-bounded');
    }
    for (const message of enriched) {
      const size = byteLength(JSON.stringify(message)) + 1;
      if (size > BATCH_LIMIT - 4096) continue;
      if (bytes + size > BATCH_LIMIT - 1024) sendChunk();
      chunk.push(message);
      bytes += size;
    }
    sendChunk();
  }

  function scheduleCapture(full = false) {
    if (!capture || destroyed) return;
    fullScan ||= full;
    if (checkpoint) return;
    // One outstanding checkpoint at a time. DOM text stays in the page
    // until a valid grant allows this scheduled projection to run.
    checkpoint = window.setTimeout(flushCapture, Math.max(80, 1000 - (Date.now() - lastCheckpoint)));
  }

  function acceptHistory(envelope: Envelope, scope: ObservationScope, generation: number) {
    const history = envelope.observation.history;
    if (!history || envelope.observation.conversationId !== scope.providerId || !capture || !canCapture(scope.temporary, capture)) return;
    const domLeaf = rendered.at(-1);
    if (domLeaf && (domLeaf.provisional || history.leafId !== domLeaf.id)) return;
    selectedHistoryLeaf = history.leafId;
    const selected = refresh();
    if (!selected || selected.selectionId !== history.selectionId) return;
    const result: Projection = {
      providerId: selected.providerId, title: history.title ?? readTitle(document),
      sourceUrl: origin + route!.key.split('?')[0], selectionId: selected.selectionId, leafId: history.leafId,
      source: 'history', messages: history.messages, coverage: history.coverage, observedAt: envelope.observedAt,
      adapterVersion: ADAPTER, batchId: crypto.randomUUID(), ...(aliasFrom && { aliasFrom }),
    };
    currentHistory = { projection: result, epoch: selected.epoch, generation };
    queueMicrotask(() => {
      if (capture?.generation === generation && current?.epoch === selected.epoch && current.selectionId === selected.selectionId &&
        canCapture(current.temporary, capture) && !destroyed) callbacks.onCapture(result, generation);
    });
  }

  function onBridge(event: MessageEvent) {
    if (destroyed || event.source !== window || event.origin !== origin) return;
    const data = record(event.data);
    if (data?.source !== BRIDGE) return;
    const scope = refresh();
    if (!scope || !route) return;
    if (data.type === 'ready') { sendControl(); return; }
    const envelope = validateEnvelope(data, { channel, epoch, route: route.key, sequence, generation: capture?.generation });
    if (!envelope) return;
    const { observation, request, endpoint, phase } = envelope;
    if (route.providerId && observation.conversationId && route.providerId !== observation.conversationId) return;
    if (endpoint === 'history' && observation.conversationId !== route.providerId && phase !== 'error') return;
    if (request < (lastRequest.get(endpoint) ?? 0)) return;
    sequence = envelope.sequence;
    lastRequest.set(endpoint, request);
    if (observation.identity !== undefined && !sameIdentity(identity, observation.identity ?? undefined)) {
      identity = observation.identity ?? undefined;
      quotas.clear();
      catalog = [];
      accountDefault = undefined;
      reply = undefined;
      conversationDefault = undefined;
      turn = undefined;
      interruptedReply = undefined;
      state = 'waiting';
      promotion = undefined;
      aliasFrom = undefined;
      clearanceDirty = true;
      markEpoch();
      refresh();
      notifyActivity();
      return;
    }
    if (observation.temporary === true && !knownTemporary) {
      knownTemporary = true;
      clearanceDirty = true;
      refresh();
    }
    if (observation.issue) callbacks.onDiagnostic(observation.issue);
    if (observation.catalog) catalog = observation.catalog;
    if (observation.accountDefault) accountDefault = observation.accountDefault;
    if (observation.conversationDefault) conversationDefault = observation.conversationDefault;
    if (observation.quotas) {
      for (const quota of observation.quotas) {
        if (quota.feature.length > 128) continue;
        // Latest response for a feature wins. Its deadline is left unchanged
        // until another explicit observation replaces it.
        quotas.set(quota.feature + ':' + quota.scope, quota);
        if (quotas.size > 40) quotas.delete(quotas.keys().next().value!);
      }
    }
    if (endpoint === 'turn') {
      if (phase === 'start') {
        turn = { request, streaming: true };
        interruptedReply = undefined;
        reply = undefined;
        state = 'streaming';
        selectedHistoryLeaf = undefined;
        currentHistory = undefined;
        refresh();
      } else {
        if (turn && request < turn.request) return;
        turn = { request, streaming: phase === 'data' };
        if (!route.providerId && observation.conversationId) promotion = { localId: providerId, canonicalId: observation.conversationId };
        if (observation.reply) reply = replyFacts(reply, observation.reply);
        else if (phase === 'data') reply = undefined;
        state = phase === 'data' ? 'streaming' : phase === 'error' ? 'partial'
          : reply?.model || reply?.input || reply?.output ? 'reported' : 'partial';
        if (phase === 'error') interruptedReply = reply?.replyId;
        if (phase === 'finish' || phase === 'error') scheduleCapture(true);
      }
    } else if (endpoint === 'history' && observation.reply) {
      const leaf = rendered.at(-1);
      const sameReply = !!reply?.replyId && reply.replyId === observation.reply.replyId;
      const matchingLeaf = !leaf || !leaf.provisional && leaf.id === observation.reply.replyId;
      if (sameReply || (!turn && matchingLeaf)) {
        reply = replyFacts(reply, observation.reply);
        if (!turn?.streaming) state = reply.model || reply.input || reply.output ? 'reported' : 'partial';
      }
    }
    const latest = current;
    if (latest && capture && envelope.generation === capture.generation) acceptHistory(envelope, latest, capture.generation);
    notifyActivity();
  }

  function mutate(mutations: MutationRecord[]) {
    if (destroyed) return;
    let checkpointChanged = false;
    for (const mutation of mutations) {
      if (unsupportedClearanceMutation(mutation)) clearanceDirty = true;
      const effect = affectsTranscript(mutation);
      if (effect.structure) structureDirty = clearanceDirty = true;
      if (effect.text) currentHistory = undefined;
      if (!capture || !effect.text) continue;
      checkpointChanged = true;
      const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const message = element?.closest(MESSAGE);
      if (message && !effect.structure) changed.add(message);
      else fullScan = true;
    }
    if (structureDirty || clearanceDirty || route?.key !== conversationRoute(new URL(location.href))?.key) refresh();
    if (checkpointChanged) scheduleCapture();
  }

  const dom = new MutationObserver(mutate);
  dom.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [
    'data-message-id', 'data-message-author-role', 'data-message-role', 'data-message-status', 'data-streaming',
    'data-temporary-chat', 'data-is-temporary-chat', 'aria-pressed', 'aria-hidden', 'hidden', 'class', 'style',
  ] });
  function resync() { refresh(); }
  window.addEventListener('message', onBridge);
  window.addEventListener('popstate', resync);
  window.navigation?.addEventListener('currententrychange', resync);
  refresh();

  return {
    scope() {
      const pending = dom.takeRecords();
      if (pending.length) mutate(pending);
      return refresh();
    },
    activity() {
      refresh();
      const snapshot = describeActivity();
      if (snapshot.state === 'waiting' && seenStructure) return { ...snapshot, state: 'partial' as const };
      return snapshot;
    },
    setCapture(grant: Grant | null) {
      const scope = refresh();
      if (!grant || !scope || !canCapture(scope.temporary, grant) || scope.epoch !== grant.epoch) { clearCapture(); return; }
      if (capture?.epoch === grant.epoch && capture.generation === grant.generation &&
        capture.confirmedOrdinary === grant.confirmedOrdinary) return;
      clearCapture();
      capture = grant;
      sendControl();
      scheduleCapture(true);
    },
    snapshot(expected: ActionContext, messageId?: string): Projection {
      const pending = dom.takeRecords();
      if (pending.length) mutate(pending);
      structureDirty = true;
      const scope = refresh();
      if (!scope || expected.epoch !== scope.epoch || expected.providerId !== scope.providerId || expected.selectionId !== scope.selectionId) {
        throw new Error('The conversation changed. Reopen Trace.');
      }
      if (currentHistory && capture && currentHistory.epoch === scope.epoch && currentHistory.generation === capture.generation &&
          currentHistory.projection.selectionId === scope.selectionId && currentHistory.projection.providerId === scope.providerId) {
        const history = currentHistory.projection;
        const messages = messageId ? history.messages.filter(message => message.id === messageId) : history.messages;
        if (messages.length) return { ...history, messages, batchId: crypto.randomUUID(),
          ...(messageId && { coverage: { state: 'unknown' as const, reason: 'Selected message only' } }) };
      }
      const at = Date.now();
      const nodes = messageId ? rendered.filter(message => message.id === messageId) : rendered;
      const { messages, coverage } = readDomMessages(nodes, document, at, true);
      if (!messages.length) throw new Error('There are no supported visible messages in this selection.');
      const result = projection(scope, messages, coverage, at);
      if (byteLength(JSON.stringify(result)) > STAGE_LIMIT - 2048) throw new Error('This selection is too large. Choose fewer messages.');
      return result;
    },
    destroy() {
      if (destroyed) return;
      window.postMessage({ source: BRIDGE, type: 'dispose', channel }, origin);
      clearCapture();
      destroyed = true;
      dom.disconnect();
      window.removeEventListener('message', onBridge);
      window.removeEventListener('popstate', resync);
      window.navigation?.removeEventListener('currententrychange', resync);
      if (activityFrame) cancelAnimationFrame(activityFrame);
    },
  };
}
