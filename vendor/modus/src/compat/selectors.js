// ===========================================================================
// ChatGPT Enhanced - Selector Compatibility Layer
// Centralizes all ChatGPT DOM selectors with multi-strategy fallbacks.
// When ChatGPT changes its DOM, only this file needs updating.
// ===========================================================================

/**
 * Each entry is an array of selector strategies tried in order.
 * Strategies include:
 *   - CSS selectors (aria-label, data-testid, structural)
 *   - Structural patterns (tag + attribute combos)
 *   - Text-based matching (for elements without stable attributes)
 */
const SELECTORS = {
  sidebarRoot: [
    'aside[aria-label="Sidebar"]',
    '[data-desktop-sidebar]',
    '[role="complementary"]',
    'nav[aria-label="Sidebar"]',
  ],

  // Sidebar conversation links
  sidebarLink: [
    'a[href^="/c/"], a[href^="/uc/"], a[href^="/g/"][href*="/c/"]',
    'nav a[href^="/c/"]',
    'nav a[href^="/uc/"]',
    'aside a[href^="/c/"]',
    'aside a[href^="/uc/"]',
    '[role="complementary"] a[href^="/c/"]',
    '[role="complementary"] a[href^="/uc/"]',
    '[role="navigation"] a[href^="/c/"]',
    '[role="navigation"] a[href^="/uc/"]',
  ],

  // Message blocks in the conversation
  msgBlock: [
    'div[data-message-author-role]',
    'li[data-message-role]',
    '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    '[data-message-role="user"], [data-message-role="assistant"]',
    'article[data-testid]',
    'main [data-message-author-role]',
    'main li[data-message-role]',
    'div[class*="messageGroup"]',
    'div[class*="message-group"]',
  ],

  // Only explicit model controls are eligible. Generic menus may be chat actions.
  modelBtn: [
    'main button[aria-label*="current model" i]',
    'main [data-testid*="model-switcher" i]',
    'main button[class*="__composer-pill"]',
    'main button[class*="model-switcher" i]',
    'button[aria-label*="current model" i]',
    'header [data-testid*="model-switcher" i]',
    'button[class*="model-switcher" i]',
  ],

  // Header / banner area
  banner: [
    'header',
    '[role="banner"]',
    'main > header',
    'div[class*="header"]',
  ],

  // Prompt textarea / composer
  composer: [
    '#prompt-textarea',
    'textarea#prompt-textarea',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'textarea[aria-label*="message"]',
    'textarea[aria-label*="prompt"]',
  ],

  // Send button
  sendBtn: [
    '[data-testid="send-button"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[class*="send"]',
  ],

  // Sidebar tool links
  sidebarTools: [
    'a[href="/images"]',
    'a[href="/apps"]',
    'a[href="/projects"]',
    'a[href="/search"]',
    'a[href="/codex"]',
    'a[href*="/images"]',
    'a[href*="/apps"]',
    'a[href*="/plugins"]',
    'button[aria-label="Deep research"]',
    'button[aria-label*="search" i]',
    '[data-octane-navigation-item="images"]',
    '[data-octane-navigation-item="plugins"]',
    '[data-octane-navigation-item="deep_research"]',
    '[data-octane-navigation-item="search"]',
    '[data-octane-navigation-item="projects"]',
    '[data-octane-navigation-item="codex"]',
    '[data-octane-navigation-item="new_chat"]',
  ],

  // Conversation title (current chat)
  convoTitle: [
    'h1',
    '[data-testid="conversation-title"]',
    'header h1',
    'h2[class*="title"]',
  ],
};

/**
 * Try multiple selectors and return the first matching element.
 */
export function queryFirst(key, root = document) {
  const sels = SELECTORS[key] || [];
  for (const sel of sels) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {}
  }
  return null;
}

/**
 * Try multiple selectors and return the first non-empty NodeList.
 */
export function queryAll(key, root = document) {
  const sels = SELECTORS[key] || [];
  for (const sel of sels) {
    try {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) return nodes;
    } catch {}
  }
  // Fallback: ':not(*)' is a valid selector that matches nothing, so this
  // returns a real (empty) NodeList instead of throwing like '' would.
  return root.querySelectorAll(':not(*)');
}

/**
 * Check if a node matches any of the selector strategies for a key.
 */
export function nodeMatches(node, key) {
  if (!node || node.nodeType !== 1) return false;
  const sels = SELECTORS[key] || [];
  for (const sel of sels) {
    try {
      if (node.matches(sel)) return true;
      if (node.querySelector(sel)) return true;
    } catch {}
  }
  return false;
}

/**
 * Extract conversation ID from an href.
 */
export function findSidebarRoot(root = document) {
  const explicit = queryFirst('sidebarRoot', root);
  const candidates = [...root.querySelectorAll('a,button')];
  const newChat = candidates.find(el =>
    el.matches('[data-testid="create-new-chat-button"]') ||
    (el.getAttribute('aria-label') || '').trim().toLowerCase() === 'new chat' ||
    (el.textContent || '').trim().toLowerCase() === 'new chat'
  ) || candidates.find(el => el.getAttribute('href') === '/');
  if (!newChat) return explicit;
  const tools = candidates.filter(el => el !== newChat && nodeMatches(el, 'sidebarTools'));
  if (!tools.length) return explicit;
  let current = newChat;
  while (current && current !== root) {
    if (tools.some(tool => current.contains(tool))) return current;
    current = current.parentElement;
  }
  return explicit;
}

export function extractId(href) {
  const m = href?.match(/\/(?:c|uc)\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Find element by visible text content using TreeWalker (efficient).
 */
export function findByText(text, root = document) {
  const doc = root.ownerDocument || document;
  const nodeFilter = doc.defaultView?.NodeFilter || NodeFilter;
  const tw = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode: n => n.textContent.trim() === text ? nodeFilter.FILTER_ACCEPT : nodeFilter.FILTER_SKIP,
  });
  const tn = tw.nextNode();
  return tn ? tn.parentElement : null;
}

/**
 * Find element by href attribute.
 */
export function findByHref(href, root = document) {
  return root.querySelector(`a[href="${href}"]`) || null;
}
