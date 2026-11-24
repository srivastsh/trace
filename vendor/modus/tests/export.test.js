// ===========================================================================
// ChatGPT Enhanced - Export Module Tests
// ===========================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import { extractFromDOM, parseApiResponse, toMarkdown, toPlainText, toJSON, toContextPackage, toPdfHtml } from '../src/export.js';

describe('Export Module', () => {
  const sampleConvo = {
    chatId: 'test-123',
    title: 'Test Conversation',
    model: 'gpt-4o',
    messageCount: 2,
    messages: [
      { role: 'user', text: 'Hello!' },
      { role: 'assistant', text: 'Hi there! How can I help?' },
    ],
  };

  describe('parseApiResponse', () => {
    it('should parse a valid API response', () => {
      const data = {
        title: 'My Chat',
        default_model_slug: 'gpt-4o',
        current_node: 'node2',
        mapping: {
          node1: {
            parent: null,
            message: {
              author: { role: 'user' },
              content: { parts: ['Hello'] },
              create_time: 1000,
            },
          },
          node2: {
            parent: 'node1',
            message: {
              author: { role: 'assistant' },
              content: { parts: ['Hi there'] },
              create_time: 2000,
            },
          },
        },
      };

      const result = parseApiResponse(data, 'abc');
      assert.ok(result, 'Should return parsed data');
      assert.equal(result.chatId, 'abc');
      assert.equal(result.title, 'My Chat');
      assert.equal(result.model, 'gpt-4o');
      assert.equal(result.messageCount, 2);
      // Messages should be in order: user first, then assistant
      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.messages[0].text, 'Hello');
      assert.equal(result.messages[1].role, 'assistant');
      assert.equal(result.messages[1].text, 'Hi there');
    });

    it('should handle null/missing data', () => {
      assert.equal(parseApiResponse(null, 'id'), null);
      assert.equal(parseApiResponse({}, 'id'), null);
      // mapping: {} is valid but produces empty messages
      const emptyResult = parseApiResponse({ mapping: {} }, 'id');
      assert.ok(emptyResult, 'Should return result even with empty mapping');
      assert.equal(emptyResult.messageCount, 0);
    });

    it('should handle new content format (objects in parts)', () => {
      const data = {
        title: 'Test',
        current_node: 'n1',
        mapping: {
          n1: {
            parent: null,
            message: {
              author: { role: 'user' },
              content: { parts: [{ type: 'text', text: 'New format' }] },
            },
          },
        },
      };
      const result = parseApiResponse(data, 'id');
      assert.ok(result);
      assert.equal(result.messages[0].text, 'New format');
    });
  });

  it('exports modern ChatGPT turns and retains heading, list and code formatting', () => {
    const { window } = new JSDOM(`<title>Browser chat</title>
      <button id="cgpt-activity-button" data-response-model="Observed model"></button>
      <div role="region" aria-label="Conversation">
        <div data-chatgpt-search-unit-key="turn:0:user"><div data-user-message-bubble>Example question</div><button>Copy message</button></div>
        <div data-chatgpt-search-unit-key="turn:1:assistant"><div data-response-body>
          <h2>Answer</h2><ul><li>One</li></ul><pre><code class="language-js">const x = 2 * 3;</code></pre>
        </div><button>Copy response</button></div>
      </div>`, { url: 'https://chatgpt.com/c/sample' });
    const previous = { document: globalThis.document, location: globalThis.location };
    Object.assign(globalThis, { document: window.document, location: window.location });
    try {
      const chat = extractFromDOM();
      assert.equal(chat.title, 'Browser chat');
      assert.equal(chat.model, 'Observed model');
      assert.equal(chat.messageCount, 2);
      assert.match(toMarkdown(chat), /## Answer[\s\S]*- One[\s\S]*```js/);
      assert.doesNotMatch(toPlainText(chat), /Copy response|Copy message/);
      assert.match(toPdfHtml(chat), /<pre class="cb"><code>const x = 2 \* 3;<\/code><\/pre>/);
    } finally {
      Object.assign(globalThis, previous);
      window.close();
    }
  });

  it('escapes the model and title in printed exports', () => {
    const pdf = toPdfHtml({ ...sampleConvo, model: '<img>', title: '<script>' });
    assert.match(pdf, /&lt;img&gt;/);
    assert.doesNotMatch(pdf, /<img>|<script>/);
  });

  describe('toMarkdown', () => {
    it('should produce valid Markdown', () => {
      const md = toMarkdown(sampleConvo);
      assert.ok(md.includes('# Test Conversation'));
      assert.ok(md.includes('## USER'));
      assert.ok(md.includes('Hello!'));
      assert.ok(md.includes('## ASSISTANT'));
      assert.ok(md.includes('Hi there! How can I help?'));
      assert.ok(md.includes('Model: gpt-4o'));
    });

    it('should handle multiple conversations with separator', () => {
      const md = toMarkdown([sampleConvo, { ...sampleConvo, title: 'Chat 2' }]);
      assert.ok(md.includes('---'));
      assert.ok(md.includes('# Chat 2'));
    });

    it('should handle empty messages', () => {
      const md = toMarkdown({ title: 'Empty', messages: [] });
      assert.ok(md.includes('# Empty'));
    });
  });

  describe('toPlainText', () => {
    it('should produce plain text output', () => {
      const txt = toPlainText(sampleConvo);
      assert.ok(txt.includes('TEST CONVERSATION'));
      assert.ok(txt.includes('[USER]'));
      assert.ok(txt.includes('Hello!'));
      assert.ok(txt.includes('[ASSISTANT]'));
    });

    it('should include separator for multiple convos', () => {
      const txt = toPlainText([sampleConvo, sampleConvo]);
      const sepCount = (txt.match(/^-{72}$/gm) || []).length;
      assert.ok(sepCount >= 2, 'Should have separators between conversations');
    });
  });

  describe('toJSON', () => {
    it('should produce valid JSON', () => {
      const json = toJSON(sampleConvo);
      const parsed = JSON.parse(json);
      assert.equal(parsed.format, 'chatgpt-enhanced-export');
      assert.equal(parsed.version, 1);
      assert.ok(Array.isArray(parsed.conversations));
      assert.equal(parsed.conversations[0].title, 'Test Conversation');
    });
  });

  describe('toContextPackage', () => {
    it('should produce a context package with system prompt', () => {
      const ctx = toContextPackage(sampleConvo);
      assert.ok(ctx.includes('You are receiving a conversation context'));
      assert.ok(ctx.includes('User: Hello!'));
      assert.ok(ctx.includes('Assistant: Hi there! How can I help?'));
      assert.ok(ctx.includes('Test Conversation'));
    });

    it('should handle empty conversation', () => {
      const ctx = toContextPackage({ title: 'Empty', messages: [] });
      assert.ok(ctx.includes('0 messages'));
    });

    it('should return empty string for null', () => {
      assert.equal(toContextPackage(null), '');
    });
  });
});
