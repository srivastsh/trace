import assert from 'node:assert/strict';

export const projectTitle = 'Miata Viewer';
export const decision = 'Keep asset decoding off the rendering thread.';
export const question = 'Can the Miata viewer load three trim variations quickly?';
export const replyText = `${decision}\n\nRelease checklist\n- Reset camera on trim change.\n- Cache lower-resolution previews first.\n- Preserve the labels ルーフ and café.\n\n\`\`\`js\n  const roof = trim.top;\n\`\`\``;
export const hiddenText = 'QA hidden record sentinel';
export const toolText = 'QA tool record sentinel';
export const remoteAsset = 'https://trace-fixture.invalid/asset.png';

export const historyPath = id => `/backend-api/conversation/${id}`;

function historyMessage(id, role, text, metadata = {}) {
  return {
    id, author: { role }, recipient: 'all', status: 'finished_successfully',
    content: { content_type: 'text', parts: [text] }, metadata,
  };
}

export function history(id, { temporary = false, model = true, regenerated = false } = {}) {
  const modelFields = model ? {
    resolved_model_slug: 'trace-fixture-resolved', model_slug: 'trace-fixture-generic',
    usage: { input_tokens: 1200, output_tokens: 0, effective_context_window_tokens: 4000 },
  } : {};
  return {
    conversation_id: id, title: projectTitle, is_temporary_chat: temporary,
    default_model_slug: 'trace-fixture-default', current_node: regenerated ? 'regenerated-1' : 'reply-1',
    mapping: {
      root: { parent: null, message: null },
      'question-1': { parent: 'root', message: historyMessage('question-1', 'user', question) },
      'hidden-1': { parent: 'question-1', message: historyMessage('hidden-1', 'assistant', hiddenText, { is_hidden: true }) },
      'tool-1': { parent: 'hidden-1', message: historyMessage('tool-1', 'tool', toolText, { resolved_model_slug: 'trace-fixture-tool' }) },
      'reply-1': { parent: 'tool-1', message: historyMessage('reply-1', 'assistant', replyText, modelFields) },
      'regenerated-1': { parent: 'tool-1', message: historyMessage('regenerated-1', 'assistant', 'Regenerated alternative for the same prompt.', modelFields) },
    },
  };
}

export async function fixtureFetch(browser, page, path, body, { method = 'GET', status = 200, contentType = 'application/json' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  browser.allowAppRequest(method, path, { status, body: payload, contentType });
  const response = await page.evaluate(async ({ path, method }) => {
    const result = await fetch(path, { method });
    return { status: result.status, body: await result.text() };
  }, { path, method });
  assert.deepEqual(response, { status, body: payload }, 'The ordinary page must receive the original response.');
}
