// ===========================================================================
// ChatGPT Enhanced - Export Module
// Extracts conversation data from the DOM and formats local exports.
// Supports Markdown, Plain Text, PDF, and JSON formats.
// Also supports a "context package" format for portability to other AIs.
// ===========================================================================

import { conversationId } from './context-data.js';

/**
 * Extract conversation data from the current page DOM.
 * This is the primary extraction method — more reliable than API calls
 * because it reads what the user actually sees.
 */
export function extractFromDOM() {
  const chatId = conversationId(location.pathname);
  if (!chatId) return null;

  const titleEl = document.querySelector('[data-testid="conversation-title"], nav a[aria-current="page"], [aria-label="Chat history"] a[aria-current="page"]');
  const title = titleEl?.textContent.trim() || document.title.trim() || 'Untitled';
  const model = document.getElementById('cgpt-activity-button')?.dataset.responseModel || null;

  const msgs = getTranscriptEntries().map(({ role, text, body }) => {
    const markdown = role === 'assistant' ? exportMarkdownNode(body).trim() : '';
    return { role, text, ...(markdown && markdown !== text ? { markdown } : {}) };
  });

  return {
    chatId, title, model,
    exportedAt: new Date().toISOString(),
    messageCount: msgs.length,
    messages: msgs,
    source: 'DOM',
  };
}

export function getTranscriptEntries() {
  const transcript = document.querySelector('[role="region"][aria-label="Conversation"]') || document;
  const modern = '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]';
  const legacy = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-message-role="user"], [data-message-role="assistant"]';
  const seen = new Set();
  const msgs = [];
  const messageNodes = transcript.querySelectorAll(modern);
  for (const node of messageNodes.length ? messageNodes : transcript.querySelectorAll(legacy)) {
    const role = node.getAttribute('data-chatgpt-search-unit-key')?.split(':').at(-1) ||
      node.getAttribute('data-message-author-role') || node.getAttribute('data-message-role');
    const id = node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-message-id');
    if (id && seen.has(id)) continue;
    const source = role === 'user'
      ? node.querySelector('[data-user-message-bubble], [data-submit-message-animation-target], [data-message-content]')
      : node.querySelector('[data-response-body], [data-markdown-text-style], .markdown, [data-message-content]');
    if (!source && node.matches(modern)) continue;
    const body = source || node;
    const text = (body.innerText || body.textContent || '').trim();
    if (!text) continue;
    if (id) seen.add(id);
    msgs.push({ role, text, element: node, body });
  }
  return msgs;
}

function exportMarkdownNode(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.matches('button, [role="button"], [hidden], [aria-hidden="true"], [data-markdown-copy="exclude"]')) return '';
  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'PRE') {
    const code = node.querySelector('code') || node;
    const fence = '`'.repeat(Math.max(3, ...[...code.textContent.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const language = code.className?.match?.(/(?:^|\s)language-([\w+-]+)/)?.[1] || '';
    return `\n\n${fence}${language}\n${code.textContent.replace(/\n$/, '')}\n${fence}\n\n`;
  }
  const content = [...node.childNodes].map(exportMarkdownNode).join('');
  if (!content.trim()) return content;
  if (tag === 'CODE') {
    const fence = '`'.repeat(1 + Math.max(0, ...[...content.matchAll(/`+/g)].map(match => match[0].length)));
    const inner = content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content;
    return fence + inner + fence;
  }
  if (/^H[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
  if (tag === 'STRONG' || tag === 'B') return `**${content.trim()}**`;
  if (tag === 'EM' || tag === 'I') return `*${content.trim()}*`;
  if (tag === 'A' && /^https?:/i.test(node.href)) return `[${content.trim()}](<${node.href}>)`;
  if (tag === 'LI') {
    const list = node.parentElement;
    const marker = list?.tagName === 'OL' ? `${list.start + [...list.children].indexOf(node)}.` : '-';
    return `${marker} ${content.trim()}\n`;
  }
  if (tag === 'BLOCKQUOTE') return `\n${content.trim().split('\n').map(line => '> ' + line).join('\n')}\n\n`;
  if (['P', 'UL', 'OL'].includes(tag)) return `${content.trimEnd()}\n\n`;
  return content;
}

/**
 * Parse the ChatGPT conversation API response into a normalized format.
 */
export function parseApiResponse(data, chatId) {
  if (!data?.mapping) return null;
  const map = data.mapping;
  const path = [];
  let cur = data.current_node;
  const seen = new Set();
  while (cur && map[cur] && !seen.has(cur)) {
    seen.add(cur);
    const node = map[cur];
    const msg = node.message;
    if (msg?.author && msg?.content) {
      const role = msg.author.role;
      const parts = msg.content.parts;
      const text = Array.isArray(parts)
        ? parts.map(p => typeof p === 'string' ? p : (p?.text || '')).join('')
        : (msg.content.text || '');
      if ((role === 'user' || role === 'assistant') && text.trim()) {
        path.unshift({ role, text: text.trim(), createTime: msg.create_time });
      }
    }
    cur = node.parent;
  }
  return {
    chatId,
    title: data.title || 'Untitled',
    model: data.default_model_slug || null,
    exportedAt: new Date().toISOString(),
    messageCount: path.length,
    messages: path.map(m => ({ role: m.role, text: m.text })),
    source: 'API',
  };
}

/**
 * Build a Markdown export from conversation data.
 */
export function toMarkdown(convos) {
  if (!Array.isArray(convos)) convos = [convos];
  const date = new Date().toISOString().slice(0, 10);
  const out = [];
  convos.forEach((c, ci) => {
    const msgs = Array.isArray(c?.messages) ? c.messages : [];
    if (ci > 0) out.push('', '---', '');
    out.push('# ' + (c?.title || 'Untitled'), '');
    out.push('Model: ' + (c?.model || 'Not reported'));
    out.push('Exported: ' + date);
    out.push('Source: ' + (c?.source || 'Modus'));
    if (c?.messageCount !== undefined) out.push('Messages: ' + c.messageCount);
    out.push('');
    msgs.forEach(m => {
      const role = m?.role === 'user' ? 'USER' : 'ASSISTANT';
      out.push('## ' + role, '');
      out.push(m?.markdown || (typeof m?.text === 'string' ? m.text : ''));
      out.push('');
    });
  });
  return out.join('\n');
}

/**
 * Build a plain text export.
 */
export function toPlainText(convos) {
  if (!Array.isArray(convos)) convos = [convos];
  const SEP = '-'.repeat(72);
  const date = new Date().toISOString().slice(0, 10);
  const out = [];
  convos.forEach((c, ci) => {
    const msgs = Array.isArray(c?.messages) ? c.messages : [];
    if (ci > 0) out.push('', SEP, '');
    out.push((c?.title || 'UNTITLED').toUpperCase(), '');
    out.push('Model:    ' + (c?.model || 'Not reported'));
    out.push('Exported: ' + date);
    out.push('Source:   ' + (c?.source || 'Modus'));
    out.push('', SEP, '');
    msgs.forEach(m => {
      out.push('[' + (m?.role === 'user' ? 'USER' : 'ASSISTANT') + ']');
      out.push(typeof m?.text === 'string' ? m.text : '');
      out.push('');
    });
  });
  return out.join('\n');
}

/**
 * Build a JSON export (structured, portable).
 */
export function toJSON(convos) {
  if (!Array.isArray(convos)) convos = [convos];
  return JSON.stringify({
    format: 'chatgpt-enhanced-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: convos,
  }, null, 2);
}

/**
 * Build a "context package" — a portable representation of a conversation
 * suitable for importing into another AI session or agent.
 */
export function toContextPackage(convo) {
  if (!convo) return '';
  const msgs = Array.isArray(convo.messages) ? convo.messages : [];
  const sysPrompt = `You are receiving a conversation context from ChatGPT Enhanced. This export contains ${msgs.length} messages:\n\n`;
  const history = msgs.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${m.text}`;
  }).join('\n\n');
  return sysPrompt + history + `\n\n---\nEnd of conversation "${convo.title || 'Untitled'}". Model: ${convo.model || 'Not reported'}`;
}

/**
 * Build HTML for PDF printing.
 */
export function toPdfHtml(convos) {
  if (!Array.isArray(convos)) convos = [convos];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtBody = raw => esc(raw).split(/(`{3,}[^\n]*\n[\s\S]*?\n`{3,})/g).map((part, index) => {
    if (index % 2) {
      const code = part.slice(part.indexOf('\n') + 1, part.lastIndexOf('\n'));
      return `<pre class="cb"><code>${code}</code></pre>`;
    }
    return part.replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }).join('');
  const date = new Date().toISOString().slice(0, 10);
  const modelName = esc(convos[0]?.model || 'Not reported');
  const totalMsgs = convos.reduce((a, c) => a + (Array.isArray(c?.messages) ? c.messages.length : 0), 0);
  const singleTitle = convos.length === 1 ? esc(convos[0]?.title || 'Untitled') : null;
  const docTitle = singleTitle || 'ChatGPT Enhanced Export';
  const msgsHtml = convos.map((c, ci) => {
    const msgList = Array.isArray(c?.messages) ? c.messages : [];
    const sep = ci > 0 ? '<div class="conv-sep"></div>' : '';
    const hdr = convos.length > 1 ? '<h2 class="ctitle">' + esc(c?.title || 'Untitled') + '</h2>' : '';
    const msgs = msgList.map(m => {
      const isUser = m?.role === 'user';
      return '<div class="msg ' + (isUser ? 'mu' : 'ma') + '"><div class="role">' + (isUser ? 'USER' : 'ASSISTANT') + '</div><div class="body">' + fmtBody(m?.markdown || m?.text) + '</div></div>';
    }).join('');
    return sep + hdr + '<div class="msgs">' + msgs + '</div>';
  }).join('');
  const metaExtra = convos.length > 1 ? '<br>Conversations: ' + convos.length + ' · Messages: ' + totalMsgs : '';
  const css = [
    '@page{size:A4;margin:1in}',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica Neue,Arial,sans-serif;background:#fff;color:#1a1a1a;font-size:12pt;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.page{max-width:680px;margin:0 auto;padding:48px 0}',
    '.doc-title{font-size:22pt;font-weight:700;color:#000;line-height:1.2}',
    '.meta{font-size:9pt;color:#888;line-height:1.9;margin-top:12px}',
    '.divider{border:none;border-top:1px solid #000;margin:20px 0 32px}',
    '.conv-sep{border:none;border-top:1px solid #d0d0d0;margin:40px 0;page-break-after:always}',
    '.ctitle{font-size:15pt;font-weight:700;color:#000;margin-bottom:20px;page-break-after:avoid}',
    '.msgs{display:flex;flex-direction:column}',
    '.msg{padding:14px 0 14px 16px;border-left:1px solid rgba(0,0,0,.15);margin-bottom:18px;page-break-inside:avoid}',
    '.role{font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;color:#000}',
    '.body{color:#1a1a1a;white-space:pre-wrap;word-wrap:break-word;font-size:11pt;line-height:1.65}',
    'pre.cb{background:#f5f5f5;color:#1a1a1a;border:1px solid #ccc;border-radius:4px;padding:14px 16px;margin:12px 0;font-family:Consolas,Courier New,monospace;font-size:9pt;line-height:1.55;page-break-inside:avoid;white-space:pre;overflow-x:auto}',
    'code.ic{background:#f0f0f0;color:#1a1a1a;padding:1px 5px;border:1px solid #ddd;border-radius:3px;font-family:Consolas,Courier New,monospace;font-size:9pt}',
    'strong{font-weight:700}em{font-style:italic}',
    '.footer{margin-top:48px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:8pt;color:#aaa;text-align:center}',
    '@media print{.page{padding:0;max-width:100%}.conv-sep{page-break-after:always}.msg{page-break-inside:avoid}}',
  ].join('\n');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + docTitle + '</title>\n' +
    '<style>\n' + css + '\n</style></head><body><div class="page">\n' +
    '<div class="doc-title">' + docTitle + '</div>\n' +
    '<div class="meta">Model: ' + modelName + '<br>Exported: ' + date + '<br>Source: ChatGPT Enhanced' + metaExtra + '</div>\n' +
    '<hr class="divider">\n' +
    msgsHtml + '\n' +
    '<div class="footer">ChatGPT Enhanced</div>\n' +
    '</div></body></html>';
}

/**
 * Download a blob with the given filename.
 */
export function downloadBlob(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * Open a print dialog with HTML content.
 */
export function printHtml(html, w = window.open('', '_blank', 'width=940,height=720')) {
  if (!w || w.closed) throw new Error('The print window could not open. Allow pop-ups and try again.');
  w.document.open(); w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 900);
}
