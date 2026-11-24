import { afterEach, expect, it, vi } from 'vitest';
import { insertionPoint } from '../../src/host/adapter';

afterEach(() => vi.unstubAllGlobals());

it('places Trace before the ArchiveA row with a separate, aria-hidden shortcut', () => {
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 });
  const menu = { querySelectorAll: () => [project, archive, remove] };
  const label = { closest: () => null };
  const shortcut = { closest: (selector: string) => selector.includes('[aria-hidden="true"]') ? shortcut : null };

  function row(text: string, trailingShortcut = '') {
    const nodes = [
      { nodeValue: text, parentElement: label },
      ...(trailingShortcut ? [{ nodeValue: trailingShortcut, parentElement: shortcut }] : []),
    ];
    const item = {
      dataset: {}, textContent: text + trailingShortcut, parentElement: menu, previousElementSibling: null,
      getAttribute: () => null,
      closest: (selector: string): object | null => selector === '[role="menu"]' ? menu : selector.includes('[role="menuitem"]') ? item : null,
      matches: (selector: string) => selector.includes('[role="menuitem"]'),
      contains: (child: object) => nodes.some(node => node.parentElement === child),
      ownerDocument: {
        createTreeWalker(_root: object, _show: number, filter: { acceptNode: (node: typeof nodes[number]) => number }) {
          const visible = nodes.filter(node => filter.acceptNode(node) === NodeFilter.FILTER_ACCEPT);
          return { nextNode: () => visible.length > 0, get currentNode() { return visible.shift(); } };
        },
      },
    };
    return item;
  }

  const project = row('Move to project');
  const archive = row('Archive', 'A');
  const remove = row('Delete');
  expect(archive.textContent).toBe('ArchiveA');
  const placement = insertionPoint(menu as unknown as HTMLElement);
  expect(placement.parent).toBe(menu);
  expect(placement.before).toBe(archive);
});
