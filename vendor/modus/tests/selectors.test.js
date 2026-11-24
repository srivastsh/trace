// ===========================================================================
// ChatGPT Enhanced - Selector Module Tests
// ===========================================================================
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

describe('Selector Compatibility Layer', () => {
  let dom;

  before(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  });

  after(() => {
    dom.window.close();
  });

  describe('extractId', () => {
    it('should extract UUID from /c/ path', () => {
      const extractId = (href) => {
        const m = href?.match(/\/c\/([^/?#]+)/);
        return m ? m[1] : null;
      };
      assert.equal(extractId('/c/abc-123-def'), 'abc-123-def');
      assert.equal(extractId('/c/abc?foo=bar'), 'abc');
      assert.equal(extractId('/c/abc#section'), 'abc');
      assert.equal(extractId('/c/'), null);
      assert.equal(extractId('/'), null);
      assert.equal(extractId(null), null);
      assert.equal(extractId(undefined), null);
      assert.equal(extractId(''), null);
    });
  });

  describe('CSS selector strategies', () => {
    it('should match sidebar links with various selectors', () => {
      const { document } = dom.window;
      document.body.innerHTML = `
        <nav>
          <a href="/c/test-123">Chat 1</a>
          <a href="/c/test-456">Chat 2</a>
          <a href="/">New chat</a>
        </nav>
      `;

      const selectors = [
        'a[href^="/c/"]',
        'nav a[href^="/c/"]',
        'aside a[href^="/c/"]',
      ];

      let found = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { found = el; break; }
      }
      assert.ok(found, 'Should find at least one sidebar link');
      assert.equal(found.getAttribute('href'), '/c/test-123');
    });

    it('should match message blocks with data-message-author-role', () => {
      const { document } = dom.window;
      document.body.innerHTML = `
        <main>
          <div data-message-author-role="user">Hello</div>
          <div data-message-author-role="assistant">Hi there</div>
        </main>
      `;

      const selectors = [
        'div[data-message-author-role]',
        '[data-message-author-role="user"], [data-message-author-role="assistant"]',
      ];

      let found = [];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length) { found = [...nodes]; break; }
      }
      assert.equal(found.length, 2);
    });

    it('should handle missing elements gracefully', () => {
      const { document } = dom.window;
      document.body.innerHTML = '<div>empty</div>';
      const result = document.querySelector('a[href^="/c/"]');
      assert.equal(result, null);
    });
  });

  describe('findByText (TreeWalker)', () => {
    it('should find element by text content', () => {
      const { document, NodeFilter } = dom.window;
      document.body.innerHTML = `
        <div>
          <span>Search chats</span>
          <span>Other text</span>
        </div>
      `;

      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.trim() === 'Search chats' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      });
      const tn = tw.nextNode();
      assert.ok(tn, 'Should find text node');
      assert.equal(tn.parentElement.textContent.trim(), 'Search chats');
    });

    it('should return null for non-existent text', () => {
      const { document, NodeFilter } = dom.window;
      document.body.innerHTML = '<div>Other text</div>';

      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.textContent.trim() === 'Nonexistent' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      });
      const tn = tw.nextNode();
      assert.equal(tn, null);
    });
  });

  describe('Bucket/date grouping logic', () => {
    it('should bucket timestamps correctly', () => {
      const bucket = (ts) => {
        if (!ts) return 'Older';
        const msg = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
        if (isNaN(msg.getTime())) return 'Older';
        const now = new Date();
        if (msg.toDateString() === now.toDateString()) return 'Today';
        const yd = new Date(now); yd.setDate(now.getDate() - 1);
        if (msg.toDateString() === yd.toDateString()) return 'Yesterday';
        const d7 = new Date(now); d7.setDate(now.getDate() - 7); d7.setHours(0,0,0,0);
        if (msg >= d7) return 'Last 7 Days';
        const d30 = new Date(now); d30.setDate(now.getDate() - 30); d30.setHours(0,0,0,0);
        if (msg >= d30) return 'Last 30 Days';
        return 'Older';
      };

      const now = Date.now() / 1000;
      assert.equal(bucket(now), 'Today');
      assert.equal(bucket(now - 86400), 'Yesterday');
      assert.equal(bucket(now - 3 * 86400), 'Last 7 Days');
      assert.equal(bucket(now - 15 * 86400), 'Last 30 Days');
      assert.equal(bucket(now - 60 * 86400), 'Older');
      assert.equal(bucket(null), 'Older');
    });

    it('should handle ISO string timestamps', () => {
      const bucket = (ts) => {
        if (!ts) return 'Older';
        const msg = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
        if (isNaN(msg.getTime())) return 'Older';
        const now = new Date();
        if (msg.toDateString() === now.toDateString()) return 'Today';
        return 'Older';
      };

      const nowIso = new Date().toISOString();
      assert.equal(bucket(nowIso), 'Today');
      assert.equal(bucket('invalid'), 'Older');
    });
  });
});
