/** Semantic adapter for the current-conversation controls. */
export const HOST_ADAPTER_VERSION = 'chatgpt-menu-2';

const TESTED_TRIGGER = [
  'button[data-testid="conversation-header-actions-menu"]',
  'button[data-testid="conversation-header-actions"]',
  '[data-testid="conversation-header-actions-menu"] > button',
  'button#conversation-header-actions',
  'button#conversation-header-actions-menu',
].join(',');
const HEADER = 'header, [role="banner"], [data-testid="conversation-header"], #page-header';
const OTHER_SURFACE = 'aside, nav, [role="complementary"], [role="navigation"], [data-desktop-sidebar], [data-testid*="sidebar"], [data-message-author-role]';
const MENU_ROW = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
export const MESSAGE_COPY = 'button[data-testid="copy-turn-action-button"]';

export interface ConversationMenu {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
}

function visible(element: HTMLElement) {
  return element.isConnected && !element.hidden && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden';
}

function buttonLabel(button: HTMLButtonElement) {
  const labelledBy = button.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const label = labelledBy.map((id) => button.ownerDocument.getElementById(id)?.textContent?.trim() ?? '').join(' ');
  return (label || button.getAttribute('aria-label') || button.title || button.textContent || '').trim();
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export function findTrigger(root: Document = document): HTMLButtonElement | undefined {
  const tested = Array.from(root.querySelectorAll<HTMLButtonElement>(TESTED_TRIGGER))
    .filter((button) => button.tagName === 'BUTTON' && !button.closest(OTHER_SURFACE) && visible(button));
  if (tested.length) return only(tested);

  const candidates = new Set<HTMLButtonElement>();
  for (const header of root.querySelectorAll(HEADER)) {
    if (header.closest(OTHER_SURFACE)) continue;
    for (const button of header.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"][aria-expanded]')) {
      if (!button.closest(OTHER_SURFACE) && buttonLabel(button) === 'Chat actions' && visible(button)) {
        candidates.add(button);
      }
    }
  }
  return only(Array.from(candidates));
}

export function findMenu(trigger: HTMLButtonElement, root: Document = document): ConversationMenu | undefined {
  if (trigger.getAttribute('aria-expanded') !== 'true' && trigger.dataset.state !== 'open') return;
  const controlled = root.getElementById(trigger.getAttribute('aria-controls') || '');
  if (controlled?.getAttribute('role') === 'menu' && visible(controlled)) {
    return { trigger, menu: controlled };
  }

  // Portal menus can use the reverse label relationship without aria-controls.
  const associated = only(Array.from(root.querySelectorAll<HTMLElement>('[role="menu"]:not([data-trace-owned])'))
    .filter((menu) => trigger.id && menu.getAttribute('aria-labelledby')?.split(/\s+/).includes(trigger.id) && visible(menu)));
  if (associated) return { trigger, menu: associated };
}

function menuRows(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ROW))
    .filter((row) => row.closest('[role="menu"]') === menu && !row.closest('[data-trace-owned]'));
}

export function focusableNativeRows(menu: HTMLElement) {
  return menuRows(menu).filter((row) => !row.hasAttribute('data-disabled') && !row.hasAttribute('disabled')
    && row.getAttribute('aria-disabled') !== 'true' && (row.tabIndex >= 0 || row.hasAttribute('tabindex')) && visible(row));
}

const destructiveLabel = /^(?:archive|delete)(?: (?:chat|conversation))?$/i;
const destructiveTestId = /^(?:(?:chat|conversation)(?:-header)?-)?(?:archive|delete)(?:-(?:chat|conversation))?(?:-(?:button|menu-item|action))?$/i;
const shortcutContent = '[aria-hidden="true"],[hidden],svg,kbd,[data-shortcut],[data-keyboard-shortcut]';

function actionText(element: HTMLElement) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const ignored = node.parentElement?.closest(shortcutContent);
      return ignored && element.contains(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: string[] = [];
  while (walker.nextNode()) segments.push(walker.currentNode.nodeValue || '');
  return segments.join(' ');
}

function isDestructive(row: HTMLElement) {
  if (destructiveTestId.test(row.dataset.testid || '')) return true;
  const labelledBy = row.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const accessibleName = labelledBy.map((id) => row.ownerDocument.getElementById(id)?.textContent?.trim() ?? '').join(' ');
  return [accessibleName, row.getAttribute('aria-label'), row.getAttribute('data-text-value'), row.title, actionText(row)]
    .some((label) => destructiveLabel.test(label?.trim().replace(/\s+/g, ' ') ?? ''));
}

export function insertionPoint(menu: HTMLElement): { parent: HTMLElement; before: HTMLElement | null; bottomRule: boolean } {
  // Some layouts use an ordinary button for an action alongside semantic menuitems.
  const rows = Array.from(menu.querySelectorAll<HTMLElement>(`${MENU_ROW}, button:not([role])`))
    .filter((row) => row.closest('[role="menu"]') === menu && !row.closest('[data-trace-owned]')
      && (!row.closest(MENU_ROW) || row.matches(MENU_ROW)));
  const destructive = rows.find(isDestructive);
  if (!destructive?.parentElement) return { parent: menu, before: null, bottomRule: false };

  let boundary = destructive;
  // Keep host action groups intact, including a group containing only Archive.
  while (boundary.parentElement && boundary.parentElement !== menu
    && boundary.parentElement.getAttribute('role') === 'group'
    && rows.filter((row) => boundary.parentElement?.contains(row)).every(isDestructive)) {
    boundary = boundary.parentElement;
  }
  const parent = boundary.parentElement ?? menu;
  const separator = boundary.previousElementSibling;
  if (separator instanceof HTMLElement && separator.matches('[role="separator"], hr')) {
    return { parent, before: separator, bottomRule: false };
  }
  return { parent, before: boundary, bottomRule: true };
}

export function messageActionSlot(copy: HTMLButtonElement): { row: HTMLElement; id: string } | undefined {
  const turn = copy.closest('[data-testid^="conversation-turn-"], article[data-turn-id], article[data-message-id]');
  const row = copy.parentElement;
  if (!turn || !row || !turn.contains(row) || row === turn
    || row.closest('[role="menu"], [role="dialog"]')) return;
  const buttons = Array.from(row.children).filter((element) => element instanceof HTMLButtonElement);
  if (buttons.length < 2 && row.getAttribute('aria-label') !== 'Message actions') return;

  const supported = '[data-message-id][data-message-author-role="assistant"], [data-message-id][data-message-author-role="user"]';
  const messages = turn.matches(supported) ? [turn, ...turn.querySelectorAll(supported)] : Array.from(turn.querySelectorAll(supported));
  const id = only(Array.from(new Set(messages.map((node) => node.getAttribute('data-message-id') || '').filter(Boolean))));
  if (id && id.length <= 256) return { row, id };
}

export function includesRelevantStructure(node: Node) {
  if (!(node instanceof Element) || node.closest('[data-trace-owned], [contenteditable], input, textarea')) return false;
  const structural = `${TESTED_TRIGGER},${HEADER},[role="menu"],${MESSAGE_COPY}`;
  return node.matches(structural) || node.childElementCount > 0 && !!node.querySelector(structural);
}
