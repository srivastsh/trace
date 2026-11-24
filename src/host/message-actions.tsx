import { render } from 'preact';
import type { ActionContext, HostActionRequest } from '../contracts';
import { PRODUCT } from '../product';
import { actionContext, sameContext, STALE } from './actions';
import { MESSAGE_COPY, messageActionSlot } from './adapter';
import { Icon } from './icons';

interface Options {
  getContext(): ActionContext | undefined;
  dispatch(request: HostActionRequest, activation: Event): void;
  report(text: string): void;
}

interface Mounted {
  button: HTMLButtonElement;
  row: HTMLElement;
  id: string;
  path: string;
}

export function mountMessageActions(options: Options) {
  const mounted = new Map<HTMLButtonElement, Mounted>();
  const pending = new Set<HTMLButtonElement>();
  let frame = 0;
  let prune = false;

  function scan(scope: Element | Document) {
    if (scope instanceof HTMLButtonElement && scope.matches(MESSAGE_COPY)) pending.add(scope);
    if (scope.firstElementChild) {
      for (const copy of scope.querySelectorAll<HTMLButtonElement>(MESSAGE_COPY)) pending.add(copy);
    }
  }

  function flush() {
    frame = 0;
    if (prune) {
      prune = false;
      for (const [copy, mount] of mounted) {
        const current = copy.isConnected && copy.matches(MESSAGE_COPY) ? messageActionSlot(copy) : undefined;
        if (current?.row === mount.row && current.id === mount.id && mount.button.isConnected && mount.path === location.pathname) continue;
        remove(copy, mount);
      }
    }
    for (const copy of pending) {
      if (!mounted.has(copy) && copy.isConnected) mount(copy);
    }
    pending.clear();
  }

  function remove(copy: HTMLButtonElement, { button, row }: Mounted) {
    render(null, button);
    button.remove();
    row.removeAttribute('data-trace-message-row');
    mounted.delete(copy);
  }

  function mount(copy: HTMLButtonElement) {
    const slot = messageActionSlot(copy);
    if (!slot || slot.row.hasAttribute('data-trace-message-row')) return;
    const { row, id } = slot;
    const path = location.pathname;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trace-message-save';
    button.dataset.traceOwned = '';
    const label = `Save message to ${PRODUCT.name}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    const width = Math.round(copy.getBoundingClientRect().width);
    if (width >= 24 && width <= 48) button.style.setProperty('--trace-message-control-size', `${width}px`);
    render(<Icon name="save"/>, button);
    row.dataset.traceMessageRow = '';
    row.append(button);

    let pointerContext: ActionContext | undefined;
    let focusContext: ActionContext | undefined;
    button.addEventListener('focus', (event) => { if (event.isTrusted) focusContext = actionContext(options.getContext()); });
    button.addEventListener('blur', () => { focusContext = undefined; });
    button.addEventListener('pointerdown', (event) => { if (event.isTrusted) pointerContext = actionContext(options.getContext()); });
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const active = actionContext(options.getContext());
      const started = event.detail ? pointerContext : focusContext ?? active;
      pointerContext = undefined;
      const currentSlot = messageActionSlot(copy);
      if (!active || !started || !sameContext(started, active) || path !== location.pathname || currentSlot?.id !== id) {
        options.report(STALE);
        return;
      }
      options.dispatch({ action: 'save-message', context: started, messageId: id }, event);
    });
    mounted.set(copy, { button, row, id, path });
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (target instanceof Element && (target.closest('[data-trace-owned], [contenteditable="true"]'))) continue;
      if (record.type === 'attributes' && target instanceof Element) {
        const turn = target.closest('[data-testid^=conversation-turn-], article[data-turn-id], article[data-message-id]');
        if (turn) { scan(turn); prune = true; }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element && !node.hasAttribute('data-trace-owned')) scan(node);
      }
      if (!prune && record.removedNodes.length) {
        prune = Array.from(record.removedNodes).some((node) => node instanceof Element
          && (node.matches('[data-trace-message-row], [data-trace-owned].trace-message-save, '+ MESSAGE_COPY)
            || !!node.querySelector('[data-trace-message-row]')));
        if (prune && target instanceof Element) scan(target);
      }
    }
    if (!frame && (pending.size || prune)) frame = window.requestAnimationFrame(flush);
  });

  scan(document);
  flush();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-message-id', 'data-message-author-role'] });
  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    for (const [copy, mount] of mounted) remove(copy, mount);
    pending.clear();
  };
}
