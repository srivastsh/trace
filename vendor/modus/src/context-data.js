const textField = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
const countField = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const contextKeys = ['context_window_tokens', 'context_window', 'context_length', 'max_context_tokens', 'input_token_limit', 'prompt_token_limit'];
const firstCount = (object, keys) => keys.map(key => countField(object?.[key])).find(value => value !== null) ?? null;
const firstText = (object, keys) => keys.map(key => textField(object?.[key])).find(Boolean) ?? null;
const contextWindow = value => firstCount(value, contextKeys) || null;
function chatIdentifier(value) {
  if (typeof value !== 'string') return null;
  try { value = decodeURIComponent(value); } catch { return null; }
  return /^[\w:-]{1,128}$/.test(value) ? value : null;
}

export const SNIFF_SOURCE = 'cgpt-modus-net';

export function conversationId(pathname) {
  return chatIdentifier(pathname?.match(/\/(?:c|uc)\/([^/?#]+)\/?$/)?.[1]);
}

export function observedEndpoint(input, method, origin) {
  let url;
  try { url = new URL(input, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  const path = url.pathname.replace(/^\/backend-(?:api|anon)(?=\/)/, '').replace(/\/$/, '');
  if (!/^\/backend-(?:api|anon)\//.test(url.pathname)) return null;
  if (/^\/(?:auth|sentinel|sessions?)(?:\/|$)|(?:^|[\/_-])(?:sync[-_]token|resume[-_]token)(?:\/|$)/i.test(path)) return null;
  if (method === 'POST' && /^\/(?:f\/)?conversation$/.test(path)) return { kind: 'turn' };
  if (path === '/conversation/init' && ['GET', 'POST'].includes(method)) return { kind: 'init' };
  if (method === 'GET') {
    if (path === '/conversations') return { kind: 'conversations' };
    if (path === '/models') return { kind: 'models' };
    if (/^\/accounts\/(?:optimized\/)?check(?:\/[^/]+)?$/.test(path)) return { kind: 'account' };
    if (path === '/images/bootstrap') return { kind: 'images' };
    if (path === '/memories') return { kind: 'memory' };
    if (path === '/user_system_messages') return { kind: 'instructions' };
    const id = chatIdentifier(path.match(/^\/conversations?\/([^/]+)$/)?.[1]);
    if (id && !['init', 'prepare'].includes(id)) return { kind: 'conversation', id };
  }
  return { kind: 'unclassified' };
}

function isAssistantMessage(message) {
  return message?.author?.role === 'assistant'
    && (!message.recipient || message.recipient === 'all')
    && !['thoughts', 'reasoning_recap', 'code', 'execution_output'].includes(message.content?.content_type);
}

function isAssistantReply(message) {
  return isAssistantMessage(message) && message.metadata?.is_visually_hidden_from_conversation !== true;
}

function responseFacts(message) {
  const metadata = message?.metadata;
  const usage = metadata?.usage ?? message?.usage;
  return {
    model: firstText(metadata, ['resolved_model_slug', 'model_slug']) || firstText(message, ['model_slug']),
    used: firstCount(usage, ['prompt_tokens', 'input_tokens', 'context_tokens']),
    output: firstCount(usage, ['completion_tokens', 'output_tokens']),
    total: contextWindow(metadata) ?? contextWindow(usage),
  };
}

function projectConversation(data, id) {
  if (data.conversation_id && chatIdentifier(data.conversation_id) !== id) return null;
  if (Array.isArray(data.messages)) {
    const active = chatIdentifier(data.current_node);
    const index = active ? data.messages.findIndex(message => chatIdentifier(message?.id) === active) : -1;
    // Skip history pages that don't contain the active message.
    if (index === -1) return null;
    return summarizeConversation(data, data.messages.slice(0, index + 1).reverse(), data.page_info?.has_previous_page === false);
  }
  if (!data.mapping || typeof data.mapping !== 'object') return null;
  let key = chatIdentifier(data.current_node);
  if (!key) return null;
  const nodes = [];
  const seen = new Set();
  while (key && Object.hasOwn(data.mapping, key) && !seen.has(key)) {
    const node = data.mapping[key];
    if (!node || typeof node !== 'object') break;
    seen.add(key);
    if (node.message) nodes.push({ ...node.message, id: node.message.id ?? key });
    key = node.parent;
  }
  return seen.size ? summarizeConversation(data, nodes, !key) : null;
}

function summarizeConversation(data, messages, complete) {
  const attachments = new Set();
  let count = 0;
  let reportsAttachments = false;
  let reply = null;
  for (const message of messages) {
    if (!reply && isAssistantReply(message)) {
      reply = { ...responseFacts(message), replyId: chatIdentifier(message.id), replyAt: messageTime(message.create_time) };
    }
    if (Array.isArray(message?.metadata?.attachments)) {
      reportsAttachments = true;
      for (const file of message.metadata.attachments) {
        const fileId = firstText(file, ['id', 'file_id']);
        if (fileId && attachments.has(fileId)) continue;
        if (fileId) attachments.add(fileId);
        count++;
      }
    }
  }
  return {
    ...reply,
    requested: firstText(data, ['default_model_slug', 'model_slug']),
    total: reply?.total ?? contextWindow(data),
    files: complete && reportsAttachments ? count : null,
  };
}

function messageTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

// Recognize stable, explicit shapes when a route changes. Only extract the
// same metadata fields used for known endpoints.
export function identifyResponse(endpoint, value) {
  if (!value || typeof value !== 'object') return null;
  const data = value.data && typeof value.data === 'object' ? value.data : value;
  const id = chatIdentifier(data.conversation_id);
  if (id && data.current_node && (Array.isArray(data.messages) || data.mapping)) {
    if (endpoint.id && endpoint.id !== id) return null;
    return { endpoint: { kind: 'conversation', id }, data };
  }
  if (endpoint.kind !== 'unclassified') return { endpoint, data: value };
  if (typeof data.default_model_slug === 'string' && Array.isArray(data.models) &&
      data.models.some(model => typeof model?.slug === 'string')) return { endpoint: { kind: 'models' }, data };
  if (Array.isArray(data.limits_progress) && (Array.isArray(data.blocked_features) || data.file_attachment_limits)) {
    return { endpoint: { kind: 'init' }, data };
  }
  if (data.accounts?.default?.account || (Array.isArray(data.account_ordering) && data.accounts)) {
    return { endpoint: { kind: 'account' }, data };
  }
  return null;
}

const resetValue = value => countField(value) ?? (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

function quotaReset(row) {
  const absolute = row?.reset_at ?? row?.upload_reset_at;
  if (typeof absolute === 'number' && Number.isFinite(absolute)) {
    const date = new Date(absolute < 1e12 ? absolute * 1000 : absolute);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return resetValue(absolute ?? row?.reset_after);
}

function quotaNumbers(row) {
  const total = firstCount(row, ['limit', 'total', 'max_requests']);
  const used = firstCount(row, ['used', 'used_count', 'consumed']);
  const percent = row?.used_percent;
  return {
    ...(total != null && total > 0 && { total }),
    ...(used != null && { used }),
    ...(typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 && { percent }),
  };
}

export function projectResponse(endpoint, data) {
  if (!data || typeof data !== 'object') return null;
  switch (endpoint.kind) {
    case 'conversation': return projectConversation(data, endpoint.id);
    case 'models':
      return {
        defaultModel: textField(data.default_model_slug),
        entries: (Array.isArray(data.models) ? data.models : []).slice(0, 150).flatMap(entry => {
          const slug = textField(entry?.slug);
          return slug ? [{ slug, title: firstText(entry, ['title', 'display_name', 'name']), total: contextWindow(entry) }] : [];
        }),
      };
    case 'init':
      return {
        limits: (Array.isArray(data.limits_progress) ? data.limits_progress : []).slice(0, 100).flatMap(row => {
          const feature = firstText(row, ['feature_name', 'feature', 'name']);
          return feature ? [{ feature, remaining: countField(row.remaining), reset: quotaReset(row), ...quotaNumbers(row) }] : [];
        }),
        fileSizeMb: countField(data.file_attachment_limits?.max_size_mb),
        blocked: (Array.isArray(data.blocked_features) ? data.blocked_features : []).slice(0, 100)
          .map(row => textField(row) || firstText(row, ['feature_name', 'feature', 'name'])).filter(Boolean),
      };
    case 'account': {
      const key = data.account_ordering?.[0];
      const account = data.accounts?.default?.account ?? (typeof key === 'string' && Object.hasOwn(data.accounts ?? {}, key) ? data.accounts[key]?.account : null);
      const plan = firstText(account, ['plan_display_name', 'plan_type']);
      return plan ? { plan } : null;
    }
    case 'images': {
      const upload = data.upload_quota ?? data;
      return {
        limit: firstCount(upload, ['daily_upload_limit', 'image_upload_limit', 'upload_limit', 'max_uploads_per_day']),
        remaining: firstCount(upload, data.upload_quota ? ['remaining_uploads', 'remaining'] : ['remaining_uploads']),
        reset: quotaReset(data.upload_quota ? upload : { upload_reset_at: upload.upload_reset_at }),
        ...quotaNumbers(upload),
      };
    }
    case 'memory': return { enabled: typeof data.memory_enabled === 'boolean' ? data.memory_enabled : null,
      count: Array.isArray(data.memories) ? data.memories.length : null };
    case 'instructions': return { enabled: typeof data.enabled === 'boolean' ? data.enabled : null };
    case 'conversations': {
      const items = data.items ?? data.conversations;
      if (!Array.isArray(items)) return null;
      return items.slice(0, 500).flatMap(item => {
        const id = chatIdentifier(item?.id);
        const time = item?.update_time ?? item?.create_time;
        return id && (typeof time === 'string' || Number.isFinite(time)) ? [{ id, time }] : [];
      });
    }
    default: return null;
  }
}

export function createTurnReader() {
  let id = null;
  let active = null;
  let reply = null;
  let requested = null;
  let limits = null;
  let finished = false;
  let previous = '';

  function mergeFacts(facts) {
    for (const [key, field] of Object.entries(facts)) {
      if (field != null) active.facts[key] = field;
    }
  }

  function publishActive() {
    if (active && !active.hidden) reply = active.facts;
  }

  function read(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    id = chatIdentifier(value.conversation_id) || id;
    const message = value.message;
    if (message) {
      const replyId = chatIdentifier(message.id);
      if (isAssistantMessage(message) && replyId) {
        const facts = active?.facts.replyId === replyId ? active.facts : { replyId, ...responseFacts(null) };
        active = { facts, hidden: !isAssistantReply(message) };
        mergeFacts({ ...responseFacts(message), replyAt: messageTime(message.create_time) });
      } else active = null;
    }

    if (active && typeof value.p === 'string') {
      const field = value.p.match(/^\/message\/metadata(?:\/(.+))?$/);
      if (field) {
        const key = field[1];
        const update = ['add', 'replace', 'append'].includes(value.o);
        if (key === 'is_visually_hidden_from_conversation') {
          if (value.o === 'remove') active.hidden = false;
          else if (update) active.hidden = value.v === true;
        }
        if (!key && update) {
          mergeFacts(responseFacts({ metadata: value.v }));
          if (typeof value.v?.is_visually_hidden_from_conversation === 'boolean') active.hidden = value.v.is_visually_hidden_from_conversation;
        }
        if (update && ['resolved_model_slug', 'model_slug'].includes(key)) mergeFacts({ model: textField(value.v) });
        if (update && key === 'usage') mergeFacts(responseFacts({ usage: value.v }));
        if (update && /^usage\/(?:prompt|input|context)_tokens$/.test(key)) mergeFacts({ used: countField(value.v) });
        if (update && /^usage\/(?:completion|output)_tokens$/.test(key)) mergeFacts({ output: countField(value.v) });
        if (update && contextKeys.includes(key)) mergeFacts({ total: countField(value.v) || null });
      }
    }

    if (value.type === 'server_ste_metadata' && active?.facts.replyId === chatIdentifier(value.metadata?.message_id)) {
      const facts = responseFacts({ metadata: value.metadata });
      if (active.facts.model) facts.model = null;
      mergeFacts(facts);
    }
    if (value.type === 'conversation_detail_metadata') {
      requested = textField(value.default_model_slug) ?? requested;
      if (Array.isArray(value.limits_progress)) limits = projectResponse({ kind: 'init' }, value);
    }
    if (value.type === 'message_stream_complete') finished = true;

    publishActive();
    if (Array.isArray(value.v) && (value.o === 'patch' || !value.p)) value.v.forEach(read);
    else if (value.v && !value.p) read(value.v);
  }

  return value => {
    read(value);
    const facts = reply || requested || limits ? { ...reply, ...(requested && { requested }), ...(limits && { limits }) } : null;
    const result = { id, facts, ...(finished && { finished }) };
    const serialized = JSON.stringify(result);
    if (serialized === previous) return null;
    previous = serialized;
    return JSON.parse(serialized);
  };
}

export function buildContextSnapshot({ conversation, models, init, account, images, memory, instructions } = {}) {
  const model = conversation?.model ?? null;
  const requested = conversation?.requested ?? null;
  const entry = models?.entries?.find(item => item.slug === model);
  const label = slug => models?.entries?.find(item => item.slug === slug)?.title || slug;
  return {
    model: label(model),
    requested: label(requested),
    defaultModel: label(models?.defaultModel ?? null),
    used: conversation?.used ?? null,
    output: conversation?.output ?? null,
    total: conversation?.total ?? entry?.total ?? null,
    files: conversation?.files ?? null,
    plan: account?.plan ?? null,
    uploads: images,
    limits: init?.limits ?? [],
    blocked: init?.blocked ?? [],
    fileSizeMb: init?.fileSizeMb ?? null,
    memory,
    instructions,
  };
}

export const formatTokenCount = value => countField(value) === null ? 'Not reported' : value.toLocaleString();
