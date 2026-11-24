import { describe, expect, it } from 'vitest';
import { createTurnReader, projectResponse } from '../../src/observe/parser';
import { BRIDGE, conversationRoute, observedEndpoint } from '../../src/observe/protocol';
import { validateEnvelope } from '../../src/observe/validate';

const origin = 'https://chatgpt.com';
const epoch = 2;
const at = 1_800_000_000_000;
const historyEndpoint = { kind: 'history', id: 'chat-a' } as const;
const message = (id: string, role: string, metadata: Record<string, unknown> = {}) => ({
  id, author: { role }, recipient: 'all', metadata, status: 'finished_successfully',
  content: { content_type: 'text', parts: [`Text of ${id}`] },
});
const complete = (metadata: Record<string, unknown> = {}) => ({
  conversation_id: 'chat-a', title: 'Synthetic fixture', default_model_slug: 'default-model', current_node: 'reply',
  mapping: {
    root: { parent: null, message: null },
    user: { parent: 'root', message: message('user', 'user') },
    hidden: { parent: 'user', message: message('hidden', 'assistant', { is_visually_hidden_from_conversation: true }) },
    tool: { parent: 'hidden', message: message('tool', 'tool', { model_slug: 'tool-model' }) },
    reply: { parent: 'tool', message: message('reply', 'assistant', metadata) },
    sibling: { parent: 'user', message: message('sibling', 'assistant', { model_slug: 'sibling-model' }) },
  },
});

describe('passive observation schemas', () => {
  it('allows supported same-origin method and route combinations only', () => {
    expect(observedEndpoint('/backend-api/f/conversation', 'POST', origin)).toEqual({ kind: 'turn' });
    expect(observedEndpoint('/backend-anon/conversation/chat-a?cache=1', 'GET', origin)).toEqual(historyEndpoint);
    for (const path of ['/backend-api/auth/session', '/backend-api/sentinel/chat-requirements', '/backend-api/conversation/resume',
      '/backend-api/memories', '/backend-api/user_system_messages', '/backend-api/new-endpoint', '/backend-api/conversations']) {
      expect(observedEndpoint(path, 'GET', origin), path).toBeUndefined();
    }
    expect(observedEndpoint('https://fixture.invalid/backend-api/models', 'GET', origin)).toBeUndefined();
    expect(conversationRoute(new URL('/share/chat-a', origin))).toBeNull();
    expect(conversationRoute(new URL('/g/g-example/c/chat-a?temporary-chat=true&unrelated=private', origin))).toEqual({
      providerId: 'chat-a', key: '/g/g-example/c/chat-a?temporary-chat=true', temporary: true,
    });
  });

  it('keeps only active visible reply facts and does not send history text without a grant', () => {
    const source = complete({ resolved_model_slug: 'raw-model-x', model_slug: 'generic-model-y',
      usage: { input_tokens: 25, output_tokens: 0, effective_context_window_tokens: 40 } });
    const metadata = projectResponse(historyEndpoint, source, at);
    expect(metadata?.reply?.model).toMatchObject({
      value: 'raw-model-x', sourceField: 'message.metadata.resolved_model_slug', observedAt: at, replyId: 'reply',
    });
    expect(metadata?.conversationDefault?.value).toBe('default-model');
    expect(metadata?.reply?.output?.value).toBe(0);
    expect(metadata?.reply?.comparable).toBe(true);
    expect(JSON.stringify(metadata)).not.toMatch(/Synthetic fixture|Text of|tool-model|sibling-model/);

    const enabled = projectResponse(historyEndpoint, source, at, true);
    expect(enabled?.history?.messages.map(({ id, parentId }) => [id, parentId])).toEqual([['user', null], ['reply', 'user']]);
    expect(enabled?.history?.coverage.state).toBe('complete');
    expect(JSON.stringify(enabled)).not.toMatch(/Text of hidden|Text of tool|Text of sibling/);
  });

  it('keeps absent replies, catalog maxima and accounting incompatibilities separate', () => {
    expect(projectResponse(historyEndpoint, complete(), at)?.reply?.model).toBeUndefined();
    expect(projectResponse(historyEndpoint, complete({ model_slug: 'generic' }), at)?.reply?.model?.value).toBe('generic');
    expect(projectResponse({ kind: 'models' }, { default_model_slug: 'default',
      models: [{ slug: 'old', title: 'Old', context_window_tokens: 256 }] }, at)).toMatchObject({
      accountDefault: { value: 'default' }, catalog: [{ model: 'old', maximum: { value: 256 } }],
    });
    const conflicting = projectResponse(historyEndpoint, complete({ usage: {
      input_tokens: 41, effective_context_window_tokens: 40,
    } }), at)?.reply;
    expect(conflicting).toMatchObject({ comparable: false, comparableReason: 'Conflicting reported values' });
    const ambiguous = projectResponse(historyEndpoint, complete({ context_window_tokens: 40, usage: { prompt_tokens: 25 } }), at)?.reply;
    expect(ambiguous).toMatchObject({ comparable: false, comparableReason: 'Accounting scope not established' });
  });

  it('labels disconnected, interrupted, and merely ordered histories conservatively', () => {
    const source = complete();
    source.mapping.user.parent = 'missing';
    expect(projectResponse(historyEndpoint, source, at, true)?.history?.coverage.state).toBe('partial');
    source.mapping.user.parent = 'root';
    source.mapping.reply.message!.status = 'in_progress';
    expect(projectResponse(historyEndpoint, source, at, true)?.history?.coverage.state).toBe('partial');
    expect(projectResponse(historyEndpoint, { current_node: 'reply', messages: [message('user', 'user'), message('reply', 'assistant')],
      page_info: { has_previous_page: false } }, at, true)?.history?.coverage.state).toBe('unknown');
    expect(projectResponse(historyEndpoint, { ...source, conversation_id: 'different' }, at, true)).toBeUndefined();
  });

  it('preserves explicitly observed quotas and derives a deadline once', () => {
    const snapshot = projectResponse({ kind: 'init' }, { limits_progress: [
      { feature_name: 'images', remaining: 0, total: 10, reset_after: 3600 },
      { feature_name: 'files', used: 0, reset_at: 1_810_000_000 },
      { feature_name: 'empty' },
    ] }, at);
    expect(snapshot?.quotas).toHaveLength(2);
    expect(snapshot?.quotas?.[0]).toMatchObject({
      remaining: { value: 0 }, resetSeconds: { value: 3600 }, deadline: { value: at + 3_600_000, status: 'derived' },
    });
    expect(snapshot?.quotas?.[1]).toMatchObject({ used: { value: 0 }, deadline: { value: 1_810_000_000_000, status: 'reported' } });
    expect(snapshot?.quotas?.[1].remaining).toBeUndefined();
    expect(projectResponse({ kind: 'images' }, { remaining: 3 }, at)).toBeUndefined();
  });

  it('requires explicit active account and workspace identifiers', () => {
    expect(projectResponse({ kind: 'account' }, {
      account_ordering: ['id-a'], accounts: { 'id-a': { account: { workspace_id: 'w-a' } } },
    }, at)?.identity).toBeNull();
    expect(projectResponse({ kind: 'account' }, { active_account_id: 'id-a', active_workspace_id: 'w-a', email: 'omit@example.invalid' },
      at)?.identity).toEqual({ accountId: 'id-a', workspaceId: 'w-a' });
  });

  it('handles hidden streamed updates, zeros and separate reply IDs', () => {
    const turn = createTurnReader();
    expect(turn.accept({ type: 'resume_conversation_token', conversation_id: 'leak', token: 'discard' }, at)).toBeUndefined();
    const hidden = turn.accept({ v: { conversation_id: 'chat-a', message: message('reply', 'assistant', {
      is_visually_hidden_from_conversation: true, model_slug: 'generic',
    }) } }, at);
    expect(hidden?.reply).toBeUndefined();
    const visible = turn.accept({ o: 'patch', v: [
      { p: '/message/metadata/is_visually_hidden_from_conversation', o: 'remove' },
      { p: '/message/metadata', o: 'append', v: { resolved_model_slug: 'raw-model' } },
      { p: '/message/metadata/usage/output_tokens', o: 'add', v: 0 },
      { p: '/message/content/parts/0', o: 'append', v: 'unretained text' },
    ] }, at);
    expect(visible?.reply?.model?.value).toBe('raw-model');
    expect(visible?.reply?.output?.value).toBe(0);
    expect(JSON.stringify(visible)).not.toMatch(/unretained text|Text of|discard/);
    expect(turn.accept({ type: 'server_ste_metadata', metadata: { message_id: 'other', model_slug: 'unrelated' } }, at)).toBeUndefined();
    expect(turn.accept({ message: message('tool', 'tool', { model_slug: 'tool-model' }) }, at)?.reply).toBeUndefined();
    expect(turn.accept({ message: message('regeneration', 'assistant') }, at)?.reply?.model).toBeUndefined();
    turn.accept({ type: 'message_stream_complete' }, at);
    expect(turn.finished()).toBe(true);
  });
});

describe('isolated bridge validation', () => {
  const context = { channel: 'channel', route: '/c/chat-a', epoch, sequence: 1, generation: 7 };
  const envelope = () => ({
    source: BRIDGE, type: 'observation', ...context, sequence: 2, endpoint: 'history',
    request: 1, phase: 'data', observedAt: at, observation: projectResponse(historyEndpoint, complete(), at, true)!,
  });

  it('rejects stale or unauthorized text, malformed facts, and a falsely complete branch', () => {
    const initial = envelope();
    expect(validateEnvelope(initial, context, at)?.observation.history?.messages).toHaveLength(2);
    expect(validateEnvelope({ ...initial, generation: 6 }, context, at)).toBeUndefined();
    expect(validateEnvelope(initial, { ...context, generation: undefined }, at)).toBeUndefined();
    expect(validateEnvelope({ ...initial, epoch: 1 }, context, at)).toBeUndefined();
    expect(validateEnvelope({ ...initial, sequence: 1 }, context, at)).toBeUndefined();
    expect(validateEnvelope({ ...initial, route: '/c/chat-b' }, context, at)).toBeUndefined();
    const forged = structuredClone(initial);
    forged.observation.history!.messages[1].parentId = 'missing';
    expect(validateEnvelope(forged, context, at)).toBeUndefined();
    const oversized = structuredClone(initial);
    oversized.observation.history!.messages[1].text = '🚗'.repeat(60_000);
    expect(validateEnvelope(oversized, context, at)).toBeUndefined();
    const bad = structuredClone(initial);
    bad.observation.reply!.output = { value: -1, replyId: 'reply' } as never;
    expect(validateEnvelope(bad, context, at)).toBeUndefined();
  });
});
