import type { CapturedMessage, Coverage } from '../contracts';
import { byteLength, id, label, MESSAGE_LIMIT, NODE_LIMIT, STAGE_LIMIT } from './protocol';

export const MESSAGE = '[data-message-author-role="user"],[data-message-author-role="assistant"],[data-message-role="user"],[data-message-role="assistant"]';
const TEMPORARY = '[data-temporary-chat],[data-is-temporary-chat],[data-testid="temporary-chat-button"][aria-pressed],[data-testid="temporary-chat-toggle"][aria-pressed]';
const INTERNAL = '[hidden],[aria-hidden="true"],[data-is-visually-hidden="true"],[data-message-channel="analysis"],' +
  '[data-message-channel="commentary"],[data-message-recipient]:not([data-message-recipient="all"]),[data-message-author-role="tool"],' +
  '[data-message-role="tool"],[data-testid="thinking"],[data-testid="thinking-process"],.sr-only,.visually-hidden';
const ACTION = 'button,[role="button"],[role="menu"],[contenteditable],input,textarea,select,script,style,svg';
const STREAMING = '[data-streaming="true"],[data-message-status="in_progress"],[data-message-status="streaming"]';

export function temporaryFromDom(document: Document): boolean | undefined {
  let ordinary = false;
  for (const element of document.querySelectorAll(TEMPORARY)) {
    if (element.closest(INTERNAL)) continue;
    const flag = element.getAttribute('data-temporary-chat') ?? element.getAttribute('data-is-temporary-chat') ?? element.getAttribute('aria-pressed');
    if (flag === 'true') return true;
    if (flag === 'false') ordinary = true;
  }
  return ordinary ? false : undefined;
}

export function unsupportedClearanceMutation(mutation: MutationRecord): boolean {
  return mutation.type === 'attributes' && (mutation.attributeName === 'data-temporary-chat' ||
    mutation.attributeName === 'data-is-temporary-chat' || mutation.attributeName === 'aria-pressed' &&
      (mutation.target as Element).matches('[data-testid="temporary-chat-button"],[data-testid="temporary-chat-toggle"]'));
}

export interface DomMessage { element: Element; id: string; provisional: boolean; role: CapturedMessage['role']; }

function hiddenByStyle(element: Element, memo: WeakMap<Element, boolean>): boolean {
  const known = memo.get(element);
  if (known !== undefined) return known;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const hidden = !!style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
    style.opacity === '0' || style.contentVisibility === 'hidden');
  memo.set(element, hidden);
  return hidden;
}

function hiddenInTree(element: Element, memo: WeakMap<Element, boolean>) {
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.matches(INTERNAL) || hiddenByStyle(ancestor, memo)) return true;
  }
  return false;
}
export function visibleMessages(document: Document, provisionalId: (element: Element) => string): DomMessage[] {
  const root = document.querySelector('#thread, [data-testid="conversation-thread"]') ?? document.querySelector('main');
  if (!root) return [];
  const messages: DomMessage[] = [];
  const seen = new Set<string>();
  for (const element of root.querySelectorAll(MESSAGE)) {
    if (element.closest(INTERNAL) || element.parentElement?.closest(MESSAGE)) continue;
    if (element instanceof HTMLElement && (element.style.display === 'none' || element.style.visibility === 'hidden')) continue;
    const role = element.getAttribute('data-message-author-role') ?? element.getAttribute('data-message-role');
    if (role !== 'user' && role !== 'assistant') continue;
    const providerId = id(element.getAttribute('data-message-id'));
    const key = providerId ?? provisionalId(element);
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({ element, id: key, provisional: !providerId, role });
    if (messages.length >= NODE_LIMIT) break;
  }
  const visibility = new WeakMap<Element, boolean>();
  while (messages.length && hiddenInTree(messages.at(-1)!.element, visibility)) messages.pop();
  return messages;
}

const escapeMarkdown = (text: string) => text.replaceAll('\\', '\\\\').replace(/([\[\]`*_])/g, '\\$1');

function observedLink(raw: string | null, base: string) {
  if (!raw || raw.length > 2048) return;
  try {
    const url = new URL(raw, base);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return url.href.replace(/[()]/g, character => character === '(' ? '%28' : '%29');
    }
  } catch { /* Preserve any observed label if the destination cannot be used. */ }
}

function fencedCode(element: Element, state: RenderState): string {
  const code = element.querySelector('code') ?? element;
  if (hiddenInTree(code, state.visibility)) return '';
  function extract(node: Node, depth: number): string {
    if (++state.nodes > NODE_LIMIT * 4 || depth > 60) throw new Error('message-limit');
    if (node.nodeType === Node.TEXT_NODE) return boundedText(node.textContent ?? '', state);
    if (!(node instanceof Element) || node.matches(INTERNAL) || node.matches(ACTION) || hiddenByStyle(node, state.visibility)) return '';
    if (node.tagName === 'BR') return '\n';
    let result = '';
    for (const child of node.childNodes) result += extract(child, depth + 1);
    return result;
  }
  const actual = extract(code, 0);
  const longest = (actual.match(/\x60+/g) ?? []).reduce((size, run) => Math.max(size, run.length), 2);
  const fence = '\x60'.repeat(longest + 1);
  const language = code.getAttribute('data-language') ?? code.className.toString().match(/(?:^|\s)language-([\w.+-]+)/)?.[1] ?? '';
  const formatted = `\n\n${fence}${/^[\w.+-]{0,40}$/.test(language) ? language : ''}\n${actual}${actual.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  state.size -= actual.length;
  return boundedText(formatted, state);
}

interface RenderState { nodes: number; size: number; partial: boolean; visibility: WeakMap<Element, boolean>; }
function boundedText(value: string, state: RenderState): string {
  state.size += value.length;
  if (state.size > MESSAGE_LIMIT) throw new Error('message-limit');
  return value;
}

function renderNode(node: Node, state: RenderState, base: string, depth: number): string {
  if (++state.nodes > NODE_LIMIT * 4 || depth > 60) throw new Error('message-limit');
  if (node.nodeType === Node.TEXT_NODE) return boundedText(node.textContent ?? '', state);
  if (!(node instanceof Element) || node.matches(INTERNAL) || hiddenByStyle(node, state.visibility)) return '';
  const tag = node.tagName.toLowerCase();
  const file = node.getAttribute('data-file-name') ?? node.getAttribute('data-attachment-name');
  if (file) return boundedText(`[Attachment: ${label(file) ?? 'unnamed file'}; file contents not included]`, state);
  if (node.matches(ACTION)) return '';
  if (node instanceof HTMLElement && (node.style.display === 'none' || node.style.visibility === 'hidden')) return '';
  if (tag === 'pre') return fencedCode(node, state);
  if (tag === 'br') return '\n';
  if (tag === 'img' || tag === 'audio' || tag === 'video') return boundedText(
    `[${tag === 'img' ? 'Image' : tag === 'audio' ? 'Audio' : 'Video'} omitted${label(node.getAttribute('alt')) ? ': ' + label(node.getAttribute('alt')) : ''}]`, state);
  if (tag === 'iframe' || tag === 'canvas' || tag === 'object') { state.partial = true; return '[Embedded content omitted]'; }
  if (tag === 'math' || node.classList.contains('katex')) {
    const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex) return boundedText(`$${latex}$`, state);
    return '[Math expression; source unavailable]';
  }
  if (tag === 'table') {
    const rows = [...node.querySelectorAll('tr')].slice(0, NODE_LIMIT).filter(row => !hiddenInTree(row, state.visibility));
    if (!rows.length) return '';
    const cells = rows.map(row => [...row.children].filter(cell => cell.matches('th,td') && !hiddenByStyle(cell, state.visibility) && !cell.matches(INTERNAL)).map(cell =>
      renderChildren(cell, state, base, depth).trim()));
    const width = cells[0].length;
    const valid = width > 0 && cells.every(row => row.length === width) && !node.querySelector('[rowspan],[colspan]') && rows[0].querySelector('th');
    if (!valid) return '\n\n[Table retained as text]\n' + cells.map(row => row.join('\t')).join('\n') + '\n\n';
    const format = (row: string[]) => '| ' + row.map(cell => cell.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |';
    return '\n\n' + [format(cells[0]), format(cells[0].map(() => '---')), ...cells.slice(1).map(format)].join('\n') + '\n\n';
  }

  const body = renderChildren(node, state, base, depth);
  switch (tag) {
    case 'a': {
      const url = observedLink(node.getAttribute('href'), base);
      const title = body.trim();
      return url && title ? boundedText(`[${escapeMarkdown(title)}](${url})`, state) : body;
    }
    case 'code': {
      const count = (body.match(/\x60+/g) ?? []).reduce((size, run) => Math.max(size, run.length + 1), 1);
      const fence = '\x60'.repeat(count);
      const padding = body.startsWith('\x60') || body.endsWith('\x60') ? ' ' : '';
      return fence + padding + body + padding + fence;
    }
    case 'strong': case 'b': return body.trim() ? `**${body}**` : body;
    case 'em': case 'i': return body.trim() ? `*${body}*` : body;
    case 'li': {
      const parent = node.parentElement;
      const siblings = parent?.children;
      const start = Number(parent?.getAttribute('start') || '1');
      const prefix = parent?.tagName === 'OL' && siblings ? `${Number.isSafeInteger(start) ? start + [...siblings].indexOf(node) : 1}. ` : '- ';
      return prefix + body.trim().replaceAll('\n', '\n  ') + '\n';
    }
    case 'ol': case 'ul': return '\n' + body.trim() + '\n';
    case 'blockquote': return '\n\n' + body.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + body.trim() + '\n\n';
    case 'div': case 'section': case 'p': return '\n\n' + body + '\n\n';
    case 'hr': return '\n\n---\n\n';
    default: return body;
  }
}

function renderChildren(element: Element, state: RenderState, base: string, depth: number): string {
  let text = '';
  for (const child of element.childNodes) text += renderNode(child, state, base, depth + 1);
  return text;
}

export function readDomMessages(nodes: DomMessage[], document: Document, observedAt: number, explicit: boolean) {
  const messages: CapturedMessage[] = [];
  let partial = nodes.length >= NODE_LIMIT;
  let bytes = 0;
  const inProgress = !!document.querySelector('main [data-testid="stop-button"],main [data-testid="stop-generating-button"]');
  const leaf = nodes.at(-1);
  const visibility = new WeakMap<Element, boolean>();
  for (const observed of nodes) {
    if (hiddenInTree(observed.element, visibility)) continue;
    const state: RenderState = { nodes: 0, size: 0, partial: false, visibility };
    let text: string;
    try {
      text = renderChildren(observed.element, state, document.location.href, 0).trim();
      const size = byteLength(text);
      if (size > MESSAGE_LIMIT) throw new Error('message-limit');
      bytes += size;
      if (bytes > STAGE_LIMIT) throw new Error('stage-limit');
    } catch (error) {
      if (explicit) throw new Error(error instanceof Error && error.message === 'stage-limit'
        ? 'This selection is too large. Choose fewer messages.' : 'A selected message exceeds the capture limit.');
      partial = true;
      continue;
    }
    if (!text) continue;
    const final = !observed.element.closest(STREAMING) && !observed.element.querySelector(STREAMING) &&
      !(observed === leaf && observed.role === 'assistant' && inProgress);
    messages.push({ id: observed.id, provisional: observed.provisional, role: observed.role, text, observedAt, final });
    partial ||= state.partial || !final;
  }
  const coverage: Coverage = partial ? { state: 'partial', reason: 'Some rendered text is in progress, unsupported, or exceeds capture limits' }
    : { state: 'unknown', reason: 'Visible messages only; prior history and branch ancestry are unverified' };
  return { messages, coverage };
}

export function readTitle(document: Document): string {
  const explicit = document.querySelector('[data-testid="conversation-title"]')?.textContent;
  return label(explicit, 240) ?? label(document.title, 240) ?? 'ChatGPT conversation';
}

export function affectsTranscript(mutation: MutationRecord): { structure: boolean; text: boolean } {
  const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (!target) return { structure: false, text: false };
  if (target.closest('[contenteditable],textarea,input')) return { structure: false, text: false };
  if (mutation.type === 'characterData') return { structure: false, text: !!target.closest(MESSAGE) };
  if (target.closest(MESSAGE)) {
    const identity = mutation.type === 'attributes' && mutation.attributeName !== 'class' && mutation.attributeName !== 'style';
    return { structure: identity || target.matches(MESSAGE) && mutation.type === 'attributes', text: true };
  }
  if (mutation.type === 'attributes' && (mutation.attributeName === 'class' || mutation.attributeName === 'style') &&
    target.closest('main') && target.querySelector(MESSAGE)) return { structure: true, text: true };
  if (mutation.type === 'childList') {
    for (const element of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (!(element instanceof Element)) continue;
      if (element.matches(MESSAGE + ',main,' + TEMPORARY + ',[data-testid="stop-button"]') ||
        element.querySelector(MESSAGE + ',' + TEMPORARY + ',[data-testid="stop-button"]')) return { structure: true, text: true };
    }
  }
  return { structure: false, text: false };
}
