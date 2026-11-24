import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextSnapshot, conversationId, createTurnReader, identifyResponse, observedEndpoint, projectResponse } from '../src/context-data.js';

const origin = 'https://chatgpt.com';
const assistant = (model, usage, extra = {}) => ({
  author: { role: 'assistant' }, recipient: 'all', metadata: { model_slug: model, usage, ...extra },
});
const conversation = (data, id = 'chat-a') => projectResponse({ kind: 'conversation', id }, data);

describe('observed API metadata', () => {
  it('scopes observations to allowed same-origin endpoints and methods', () => {
    assert.deepEqual(observedEndpoint('/backend-api/f/conversation', 'POST', origin), { kind: 'turn' });
    assert.deepEqual(observedEndpoint('/backend-anon/conversation/chat-a?cache=1', 'GET', origin), { kind: 'conversation', id: 'chat-a' });
    assert.deepEqual(observedEndpoint('/backend-api/conversation/chat-a', 'PATCH', origin), { kind: 'unclassified' });
    assert.equal(observedEndpoint('/backend-api/auth/session', 'GET', origin), null);
    assert.equal(observedEndpoint('https://other.example/backend-api/models', 'GET', origin), null);
    assert.equal(observedEndpoint('/backend-api/sentinel/chat-requirements/prepare', 'POST', origin), null);
    assert.equal(conversationId('/g/g-example/c/WEB:chat-1'), 'WEB:chat-1');
    assert.equal(conversationId('/c/local-chatgpt%3Achat-1'), 'local-chatgpt:chat-1');
    assert.deepEqual(observedEndpoint('/backend-api/conversations/chat-a', 'GET', origin), { kind: 'conversation', id: 'chat-a' });
  });

  it('keeps response and default models separate, even for a discontinued reply model', () => {
    const snapshot = buildContextSnapshot({
      conversation: conversation({
        conversation_id: 'chat-a', current_node: 'r', default_model_slug: 'auto',
        mapping: { r: { message: assistant('retired-model', { input_tokens: 429, output_tokens: 0 }) } },
      }),
      models: projectResponse({ kind: 'models' }, { default_model_slug: 'auto', models: [{ slug: 'auto', title: 'Auto', max_tokens: 999 }] }),
    });
    assert.equal(snapshot.model, 'retired-model');
    assert.equal(snapshot.requested, 'Auto');
    assert.equal(snapshot.defaultModel, 'Auto');
    assert.equal(snapshot.used, 429);
    assert.equal(snapshot.output, 0);
    assert.equal(snapshot.total, null);
    assert.equal(snapshot.files, null);
  });

  it('uses the visible active branch and does not borrow usage or files from other replies', () => {
    const result = conversation({
      current_node: 'r',
      mapping: {
        unrelated: { message: assistant('unrelated', { prompt_tokens: 19 }, { attachments: [{ id: 'unused' }] }) },
        first: { message: assistant('old', { prompt_tokens: 140 }, { attachments: [{ id: 'first' }] }) },
        user: { parent: 'first', message: { author: { role: 'user' }, metadata: { attachments: [{ id: 'first' }, { id: 'second' }] } } },
        r: { parent: 'user', message: assistant('new', { total_tokens: 760 }) },
      },
    });
    assert.equal(result.model, 'new');
    assert.equal(result.used, null);
    assert.equal(result.files, 2);
    assert.equal(conversation({ conversation_id: 'wrong', current_node: 'r', mapping: { r: {} } }), null);
  });

  it('recognizes an active paginated conversation when the API route changes', () => {
    const response = { data: {
      conversation_id: 'chat-a', current_node: 'reply', default_model_slug: 'auto',
      messages: [
        { id: 'system', author: { role: 'system' }, metadata: { model_slug: 'system-model' } },
        { id: 'reply', ...assistant('selected-model', undefined, { resolved_model_slug: 'actual-model' }) },
        { id: 'different', ...assistant('other-branch') },
      ],
      page_info: { has_previous_page: true },
    } };
    const observed = identifyResponse({ kind: 'unclassified' }, response);
    assert.deepEqual(observed.endpoint, { kind: 'conversation', id: 'chat-a' });
    const result = projectResponse(observed.endpoint, observed.data);
    assert.equal(result.model, 'actual-model');
    assert.equal(result.used, null);
    assert.equal(result.files, null);
    assert.equal(conversation({ ...response.data, current_node: 'different-page' }), null);
    assert.equal(identifyResponse({ kind: 'conversation', id: 'different' }, response), null);
    assert.equal(identifyResponse({ kind: 'unclassified' }, { model: 'ambiguous' }), null);
  });

  it('publishes the model after ChatGPT unhides the streamed assistant message', () => {
    const read = createTurnReader();
    const id = 'chat-a';
    read({ type: 'resume_conversation_token', conversation_id: id, token: 'do-not-retain' });
    const opening = read({ v: { conversation_id: id, message: {
      id: 'reply', ...assistant(undefined, undefined, { is_visually_hidden_from_conversation: true }),
    } } });
    assert.equal(opening, null);
    const visible = read({ o: 'patch', v: [
      { p: '/message/metadata/is_visually_hidden_from_conversation', o: 'remove' },
      { p: '/message/metadata', o: 'append', v: { model_slug: 'selected-model', resolved_model_slug: 'actual-model' } },
    ] });
    assert.equal(visible.facts.model, 'actual-model');
    assert.equal(visible.facts.used, null);
    assert.equal(read({ type: 'server_ste_metadata', metadata: { message_id: 'other', model_slug: 'unrelated' } }), null);
    assert.equal(read({ type: 'message_stream_complete', conversation_id: id }).finished, true);
    const limits = read({ type: 'conversation_detail_metadata', conversation_id: id,
      default_model_slug: 'auto', limits_progress: [{ feature_name: 'messages', remaining: 3 }] });
    assert.equal(limits.facts.requested, 'auto');
    assert.equal(limits.facts.limits.limits[0].remaining, 3);
    assert.doesNotMatch(JSON.stringify(limits), /do-not-retain/);
  });

  it('keeps account and quota facts available without inventing chat data', () => {
    const init = projectResponse({ kind: 'init' }, { limits_progress: [{ feature_name: 'images', remaining: 0, reset_after: 3600 }] });
    const images = projectResponse({ kind: 'images' }, { remaining: 5, images_count: 8 });
    const snapshot = buildContextSnapshot({ init, images, models: { defaultModel: 'auto' } });
    assert.equal(snapshot.model, null);
    assert.equal(snapshot.used, null);
    assert.equal(snapshot.defaultModel, 'auto');
    assert.deepEqual(snapshot.uploads, { limit: null, remaining: null, reset: null });
    assert.deepEqual(snapshot.limits, [{ feature: 'images', remaining: 0, reset: 3600 }]);
  });

  it('projects only assistant model and usage from streaming metadata patches', () => {
    const read = createTurnReader();
    assert.deepEqual(read({ conversation_id: 'chat-a', message: { ...assistant('reply-model'), id: 'r' } }), {
      id: 'chat-a', facts: { replyId: 'r', model: 'reply-model', used: null, output: null, total: null },
    });
    assert.equal(read({ p: '/message/content/parts/0', o: 'append', v: 'private reply' }), null);
    assert.equal(read({ v: [
      { p: '/message/metadata/usage/prompt_tokens', o: 'replace', v: 25 },
      { p: '/message/metadata/usage/output_tokens', o: 'add', v: 0 },
      { p: '/message/metadata/context_window_tokens', o: 'replace', v: 40 },
    ] }).facts.total, 40);
    assert.equal(read({ message: { author: { role: 'tool' }, metadata: { model_slug: 'tool-model' } } }), null);
    assert.equal(read({ p: '/message/metadata/model_slug', o: 'replace', v: 'other' }), null);
  });
  it('keeps absolute resets and preserves a cap only when the API reports one', () => {
    const observed = projectResponse({ kind: 'init' }, { limits_progress: [
      { feature_name: 'images', remaining: 4, limit: 10, reset_at: 1_800_000_000 },
      { feature_name: 'uploads', remaining: 2, reset_after: 3600 },
    ] });
    assert.deepEqual(observed.limits[0], {
      feature: 'images', remaining: 4, total: 10, reset: new Date(1_800_000_000_000).toISOString(),
    });
    assert.deepEqual(observed.limits[1], { feature: 'uploads', remaining: 2, reset: 3600 });
  });

});
