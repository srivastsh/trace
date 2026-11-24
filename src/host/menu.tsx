import { render } from 'preact';
import type { Action, ActionContext, ActivitySnapshot, CaptureStatus, HostActionRequest } from '../contracts';
import { PRODUCT } from '../product';
import { Activity, CONTEXT_ALERT, contextAssessment } from './activity';
import { ACTION_FAILED, ACTIONS, actionContext, globalAction, requiresSelection, sameContext, STALE } from './actions';
import { findMenu, findTrigger, focusableNativeRows, includesRelevantStructure, insertionPoint } from './adapter';
import { Icon } from './icons';
import { mountMessageActions } from './message-actions';
import { applyRowGeometry, applyTheme, currentTheme } from './theme';

interface HostOptions {
  getContext(): ActionContext | undefined;
  getActivity(): ActivitySnapshot;
  getAlertEnabled?(): boolean;
  getCaptureStatus?(): CaptureStatus | undefined;
  dispatch(request: HostActionRequest, activation: Event): Promise<void>;
  onCapability?(state: 'supported' | 'unavailable'): void;
}

interface MenuState {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  group: HTMLElement;
  row: HTMLButtonElement;
  surface?: HTMLElement;
  context?: ActionContext;
  path: string;
  listeners: AbortController;
}

interface ActivityState {
  trigger: HTMLButtonElement;
  surface: HTMLElement;
  context?: ActionContext;
  path: string;
  status?: string;
  warningKey?: string;
}

interface NoticeState {
  surface: HTMLElement;
  trigger?: HTMLElement;
  timer: number;
  warningKey?: string;
}

const MENU_ID = 'trace-owned-actions';
const REOPEN = 'Open a ChatGPT conversation to use this action.';

function owned(tag: 'div' | 'button' = 'div') {
  const element = document.createElement(tag);
  element.dataset.traceOwned = '';
  return element;
}

function focus(element: HTMLElement | undefined) {
  if (element?.isConnected) element.focus({ preventScroll: true });
}

function topLayer(surface: HTMLElement) {
  if (typeof surface.showPopover !== 'function') return false;
  surface.setAttribute('popover', 'manual');
  try {
    surface.showPopover();
    return true;
  } catch {
    surface.removeAttribute('popover');
    return false;
  }
}

function closeNativeMenu(state: MenuState) {
  state.menu.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true,
  }));
}

function viewport() {
  const visual = window.visualViewport;
  return {
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function positionPanel(surface: HTMLElement, trigger?: HTMLElement, gap = 6) {
  const bounds = viewport();
  const rect = trigger?.getBoundingClientRect();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  if (!width || !height) return;
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const left = clamp((rect?.right ?? right) - width, bounds.left + 12, right - width - 12);
  const below = (rect?.bottom ?? bounds.top + 12) + gap;
  const above = (rect?.top ?? below) - height - gap;
  const top = clamp(below + height <= bottom - 12 ? below : above, bounds.top + 12, bottom - height - 12);
  surface.style.left = `${left}px`;
  surface.style.top = `${top}px`;
}

function nextNative(row: HTMLElement, nativeRows: HTMLElement[], forward: boolean) {
  const order = forward ? nativeRows : [...nativeRows].reverse();
  const relation = forward ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  return order.find((item) => !!(row.compareDocumentPosition(item) & relation)) ?? order[0];
}

export function mountHost(options: HostOptions) {
  let menuState: MenuState | undefined;
  let activity: ActivityState | undefined;
  let notice: NoticeState | undefined;
  let capability: 'supported' | 'unavailable' | undefined;
  let validatedTrigger: HTMLButtonElement | undefined;
  let layoutFrame = 0;
  let updateFrame = 0;
  let activityFocusFrame = 0;
  let alive = true;
  const warned = new Set<string>();
  const lifecycle = new AbortController();
  const signal = lifecycle.signal;

  function status(state: 'supported' | 'unavailable') {
    if (state === capability) return;
    capability = state;
    options.onCapability?.(state);
  }

  function clearNotice() {
    if (!notice) return;
    window.clearTimeout(notice.timer);
    render(null, notice.surface);
    notice.surface.remove();
    notice = undefined;
  }

  function notify(text: string, trigger = findTrigger(), warningKey?: string) {
    if (!alive) return;
    clearNotice();
    const surface = owned();
    surface.className = `trace-floating trace-notice${warningKey ? ' trace-warning' : ''}`;
    const themeSource = trigger ?? document.body;
    if (themeSource) applyTheme(surface, themeSource, menuState?.menu);
    render(<><span role="status">{text}</span>
      <button type="button" class="trace-icon-button" aria-label={warningKey ? 'Dismiss context alert' : 'Dismiss notice'} onClick={clearNotice}><Icon name="close"/></button>
    </>, surface);
    document.body.append(surface);
    positionPanel(surface, trigger);
    const timer = window.setTimeout(clearNotice, warningKey ? 12_000 : 8_000);
    notice = { surface, trigger, timer, warningKey };
  }

  function closeFlyout(restore: boolean) {
    const state = menuState;
    if (!state?.surface) return;
    render(null, state.surface);
    state.surface.remove();
    state.surface = undefined;
    state.row.setAttribute('aria-expanded', 'false');
    state.row.removeAttribute('aria-controls');
    if (restore) focus(state.row);
  }

  function detachMenu() {
    if (!menuState) return;
    closeFlyout(false);
    menuState.listeners.abort();
    render(null, menuState.group);
    menuState.group.remove();
    menuState = undefined;
  }

  function closeActivity(restore: boolean) {
    const state = activity;
    if (!state) return;
    activity = undefined;
    render(null, state.surface);
    state.surface.remove();
    if (restore) focus(state.trigger);
  }

  function dispatch(request: HostActionRequest, event: Event, onFailure?: (text: string) => void) {
    if (!event.isTrusted) return;
    void options.dispatch(request, event).then(update)
      .catch((error: unknown) => {
        const browserMessage = error instanceof Error ? error.message : '';
        const text = /^(?:The chat|The current chat|The conversation|A selected message|This selection|The selection|Choose a collection|Trace is unavailable)/.test(browserMessage)
          && browserMessage.length <= 240 ? browserMessage : ACTION_FAILED;
        if (onFailure) onFailure(text);
        else notify(text);
      });
  }

  function cancelActivityFocus() {
    if (!activityFocusFrame) return;
    window.cancelAnimationFrame(activityFocusFrame);
    activityFocusFrame = 0;
  }

  function afterMenuDismisses(state: MenuState, callback: () => void) {
    cancelActivityFocus();
    const deadline = performance.now() + 400;
    const check = (now: number) => {
      if (!alive || !state.trigger.isConnected || state.path !== location.pathname) {
        activityFocusFrame = 0;
        return;
      }
      const hidden = !state.menu.isConnected || state.menu.hidden || state.menu.getClientRects().length === 0
        || getComputedStyle(state.menu).visibility === 'hidden';
      if (hidden || now >= deadline && state.trigger.getAttribute('aria-expanded') === 'false') {
        // Native focus restoration can be deferred until after the exit animation.
        activityFocusFrame = window.requestAnimationFrame(() => {
          activityFocusFrame = 0;
          const focus = document.activeElement;
          if (alive && state.trigger.getAttribute('aria-expanded') !== 'true'
            && (!focus || focus === document.body || focus === state.trigger || state.menu.contains(focus))) callback();
        });
        return;
      }
      activityFocusFrame = now < deadline ? window.requestAnimationFrame(check) : 0;
    };
    activityFocusFrame = window.requestAnimationFrame(check);
  }

  function choose(action: Action, event: Event, state: MenuState) {
    if (!event.isTrusted || state !== menuState) return;
    if (!globalAction(action) && (state.path !== location.pathname || !sameContext(state.context, options.getContext()))) {
      closeFlyout(true);
      notify(STALE, state.trigger);
      return;
    }
    if (requiresSelection(action) && !state.context) {
      notify(REOPEN, state.trigger);
      return;
    }
    if (action !== 'activity') {
      dispatch({ action, context: globalAction(action) ? undefined : state.context }, event);
    }
    closeFlyout(false);
    closeNativeMenu(state);
    if (action === 'activity') {
      afterMenuDismisses(state, () => {
        if (state.path === location.pathname && sameContext(state.context, options.getContext())) {
          openActivity(state.trigger, state.context);
        }
      });
    } else {
      window.requestAnimationFrame(() => focus(state.trigger));
    }
  }

  function placeFlyout(state: MenuState) {
    const surface = state.surface;
    if (!surface || surface.dataset.tracePlacement === 'inline') return;
    const rect = state.menu.getBoundingClientRect();
    const row = state.row.getBoundingClientRect();
    const bounds = viewport();
    const leftLimit = bounds.left + 8;
    const rightLimit = bounds.left + bounds.width - 8;
    const bottom = bounds.top + bounds.height - 8;
    const width = surface.offsetWidth;
    const right = rect.right + 4;
    const left = rect.left - 4 - width;
    const fitsRight = right + width <= rightLimit;
    const fitsLeft = left >= leftLimit;
    const placement = fitsRight ? 'right' : fitsLeft ? 'left' : 'compact';
    surface.dataset.tracePlacement = placement;
    const actualWidth = surface.offsetWidth;
    const nextLeft = placement === 'compact' ? clamp(rect.right - actualWidth, leftLimit, rightLimit - actualWidth)
      : placement === 'left' ? left : right;
    surface.style.left = `${nextLeft}px`;
    surface.style.top = `${clamp(row.top, bounds.top + 8, bottom - surface.offsetHeight)}px`;
  }

  function openFlyout(state: MenuState) {
    if (state !== menuState || state.surface) return;
    const surface = owned();
    surface.className = 'trace-floating trace-flyout';
    surface.id = MENU_ID;
    surface.setAttribute('role', 'menu');
    surface.setAttribute('aria-label', `${PRODUCT.name} actions`);
    state.surface = surface;
    state.menu.append(surface);
    applyTheme(surface, state.row, state.menu);
    render(<>
      <button class="trace-menu-row trace-back-row" type="button" role="menuitem" tabIndex={-1} data-trace-back
        onClick={(event) => { if (event.isTrusted) closeFlyout(true); }}><Icon name="back"/><span>Back</span></button>
      {ACTIONS.map(({ action, label, icon }) => <button key={action} type="button" role="menuitem" tabIndex={-1}
        data-trace-action={action} class="trace-menu-row" aria-disabled={requiresSelection(action) && !state.context || undefined}
        onClick={(event) => choose(action, event, state)}><Icon name={icon}/><span>{label}</span></button>)}
    </>, surface);
    if (!topLayer(surface)) surface.dataset.tracePlacement = 'inline';
    else placeFlyout(state);
    state.row.setAttribute('aria-expanded', 'true');
    state.row.setAttribute('aria-controls', MENU_ID);
    focus(surface.querySelector<HTMLElement>('[data-trace-action="activity"]') ?? undefined);
  }

  function flyoutKeys(state: MenuState, event: KeyboardEvent, target: HTMLElement) {
    const surface = state.surface;
    if (!surface) return;
    const buttons = Array.from(surface.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .filter((button) => button.getClientRects().length);
    const index = buttons.indexOf(target.closest('button') as HTMLButtonElement);
    if (index < 0) return;
    const step = (offset: number) => buttons[(index + offset + buttons.length) % buttons.length];
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown': next = step(1); break;
      case 'ArrowUp': next = step(-1); break;
      case 'Home': next = buttons[0]; break;
      case 'End': next = buttons.at(-1); break;
      case 'Escape':
      case 'ArrowLeft':
        closeFlyout(true);
        break;
      case 'Tab':
        closeFlyout(false);
        closeNativeMenu(state);
        focus(state.trigger);
        break;
      case 'Enter':
      case ' ': {
        const button = buttons[index];
        const action = ACTIONS.find((item) => item.action === button?.dataset.traceAction)?.action;
        if (event.isTrusted && button?.hasAttribute('data-trace-back')) closeFlyout(true);
        else if (action) choose(action, event, state);
        break;
      }
      case 'ArrowRight': break;
      default: {
        // Keep submenu typeahead separate from the native item's collection.
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const letter = event.key.toLocaleLowerCase();
          for (let offset = 1; offset < buttons.length; offset += 1) {
            const candidate = step(offset);
            if (candidate?.textContent?.trim().toLocaleLowerCase().startsWith(letter)) {
              next = candidate;
              break;
            }
          }
        } else {
          return;
        }
      }
    }
    if (next) focus(next);
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function menuKeys(state: MenuState, event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (state.surface?.contains(target)) {
      flyoutKeys(state, event, target);
      return;
    }
    if (target.closest('[role="menu"]') !== state.menu) return;
    const onTrace = state.row.contains(target);
    if (onTrace && ['ArrowRight', 'Enter', ' '].includes(event.key)) {
      if (event.isTrusted) openFlyout(state);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = focusableNativeRows(state.menu);
    const current = rows.find((row) => row.contains(target));
    const ordered = [...rows, state.row].sort((a, b) => a === b ? 0
      : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    let next: HTMLElement | undefined;
    if (event.key === 'Home' || event.key === 'End') {
      const edge = event.key === 'Home' ? ordered[0] : ordered.at(-1);
      if (onTrace || edge === state.row) next = edge;
    } else {
      const down = event.key === 'ArrowDown';
      if (onTrace) next = nextNative(state.row, rows, down);
      else if (current && ordered[ordered.indexOf(current) + (down ? 1 : -1)] === state.row) next = state.row;
    }
    if (next) {
      focus(next);
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function attachMenu(trigger: HTMLButtonElement, menu: HTMLElement, pinned?: Pick<MenuState, 'context' | 'path'>) {
    if (menu.hasAttribute('aria-activedescendant')) return;
    const group = owned();
    group.className = 'trace-menu-group';
    group.setAttribute('role', 'none');
    const { parent, before, bottomRule } = insertionPoint(menu);
    const nearest = focusableNativeRows(menu)[0];
    if (!nearest) return;
    if (bottomRule) group.dataset.traceBottomRule = '';
    applyTheme(group, nearest, menu);
    applyRowGeometry(group, nearest);
    render(<button type="button" role="menuitem" class="trace-menu-row trace-root-row" tabIndex={-1}
      aria-haspopup="menu" aria-expanded="false">
      <Icon name="trace"/><span>{PRODUCT.name}</span><Icon name="chevron"/>
    </button>, group);
    const row = group.firstElementChild;
    if (!(row instanceof HTMLButtonElement)) return;
    parent.insertBefore(group, before);
    const listeners = new AbortController();
    const state: MenuState = { trigger, menu, group, row, context: actionContext(pinned ? pinned.context : options.getContext()),
      path: pinned?.path ?? location.pathname, listeners };
    menuState = state;
    validatedTrigger = trigger;
    status('supported');

    row.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (state.surface) closeFlyout(true);
      else openFlyout(state);
    }, { signal: listeners.signal });
    row.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse' && !state.surface && document.activeElement !== row) focus(row);
    }, { signal: listeners.signal, passive: true });
    menu.addEventListener('focusin', (event) => {
      const target = event.target;
      if (state.surface && target instanceof Node && !state.surface.contains(target) && !row.contains(target)) {
        closeFlyout(false);
      }
    }, { signal: listeners.signal });
    menu.addEventListener('keydown', (event) => menuKeys(state, event), { capture: true, signal: listeners.signal });
  }

  function reconcile() {
    layoutFrame = 0;
    if (!alive) return;
    const trigger = findTrigger();
    const found = trigger && findMenu(trigger);
    const previous = menuState;
    if (found?.menu !== previous?.menu || !previous?.group.isConnected) {
      detachMenu();
      if (found) {
        const pinned = previous?.menu === found.menu ? previous : undefined;
        attachMenu(found.trigger, found.menu, pinned);
      }
    }
    if (!trigger || trigger !== validatedTrigger || (found && !menuState)) status('unavailable');
    if (menuState) {
      const nearby = focusableNativeRows(menuState.menu)[0] ?? menuState.trigger;
      applyTheme(menuState.group, nearby, menuState.menu);
      if (menuState.surface) {
        applyTheme(menuState.surface, nearby, menuState.menu);
        placeFlyout(menuState);
      }
    }
    if (activity) {
      if (!activity.trigger.isConnected || activity.path !== location.pathname || !sameContext(activity.context, options.getContext())) {
        closeActivity(false);
      } else {
        applyTheme(activity.surface, activity.trigger);
        positionPanel(activity.surface, activity.trigger);
      }
    }
    if (notice) {
      applyTheme(notice.surface, notice.trigger ?? document.body);
      positionPanel(notice.surface, notice.trigger);
    }
  }

  function queueLayout() {
    if (!layoutFrame && alive) layoutFrame = window.requestAnimationFrame(reconcile);
  }

  function paintActivity() {
    const state = activity;
    if (!state) return;
    const capture = options.getCaptureStatus?.();
    const pauseLabel = capture?.bound ? capture.paused ? 'Resume saving on this chat'
      : capture.enabled ? 'Pause on this chat' : undefined : undefined;
    render(<Activity snapshot={options.getActivity()} onClose={() => closeActivity(true)}
      warning={!!state.warningKey} onDismissWarning={() => { state.warningKey = undefined; paintActivity(); }}
      status={state.status} pauseLabel={pauseLabel}
      onAction={state.context ? (action, event) => {
        if (!event.isTrusted) return;
        if (state.path !== location.pathname || !sameContext(state.context, options.getContext())) {
          state.status = STALE;
          paintActivity();
          return;
        }
        state.status = undefined;
        dispatch({ action, context: state.context }, event, (text) => {
          if (activity === state) {
            state.status = text;
            paintActivity();
          }
        });
      } : undefined}
    />, state.surface);
    positionPanel(state.surface, state.trigger);
  }

  function openActivity(trigger: HTMLButtonElement, context?: ActionContext) {
    if (!alive || !trigger.isConnected || !document.body) return false;
    closeActivity(false);
    const surface = owned();
    surface.className = 'trace-floating trace-activity';
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-label', 'Activity');
    applyTheme(surface, trigger, menuState?.menu);
    document.body.append(surface);
    activity = { trigger, surface, context: actionContext(context), path: location.pathname, warningKey: notice?.warningKey };
    if (notice?.warningKey) clearNotice();
    paintActivity();
    if (topLayer(surface)) positionPanel(surface, trigger);
    focus(surface.querySelector<HTMLElement>('[data-trace-close]') ?? undefined);
    return true;
  }

  function refresh() {
    updateFrame = 0;
    if (activity && (activity.path !== location.pathname || !sameContext(activity.context, options.getContext()))) closeActivity(false);
    if (activity) paintActivity();
    const snapshot = options.getActivity();
    const context = options.getContext();
    const warningKey = context && snapshot.replyId ? `${context.providerId}/${snapshot.replyId}` : undefined;
    if (notice?.warningKey && notice.warningKey !== warningKey) clearNotice();
    if (activity?.warningKey && activity.warningKey !== warningKey) {
      activity.warningKey = undefined;
      paintActivity();
    }
    if (!warningKey || !options.getAlertEnabled?.() || warned.has(warningKey)) return;
    const assessment = contextAssessment(snapshot);
    if (assessment.kind !== 'comparable' || assessment.percentage < 90) return;
    const trigger = activity?.trigger ?? findTrigger();
    if (!trigger) return;
    warned.add(warningKey);
    if (warned.size > 256) {
      const oldest = warned.values().next().value;
      if (oldest) warned.delete(oldest);
    }
    if (activity) {
      activity.warningKey = warningKey;
      paintActivity();
    } else {
      notify(CONTEXT_ALERT, trigger, warningKey);
    }
  }

  function update() {
    if (alive && !updateFrame) updateFrame = window.requestAnimationFrame(refresh);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (target instanceof Element && target.closest('[data-trace-owned]')) continue;
      if (record.type === 'attributes') {
        if (!(target instanceof Element)
          || (!target.matches('[aria-haspopup="menu"], [role="menu"]') && target !== menuState?.trigger)) continue;
      } else if (![...record.addedNodes, ...record.removedNodes].some((node) =>
        node === menuState?.group || node === menuState?.menu
        || includesRelevantStructure(node))) continue;
      queueLayout();
      break;
    }
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-expanded', 'aria-controls', 'data-state', 'hidden'],
  });

  const themeObserver = new MutationObserver(queueLayout);
  const themeAttributes = ['class', 'style', 'data-theme', 'data-color-mode'];
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributes });
  if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: themeAttributes });
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', queueLayout, { signal });

  function reposition() {
    if (activity || menuState?.surface || notice) queueLayout();
  }
  window.addEventListener('resize', reposition, { signal, passive: true });
  window.addEventListener('scroll', reposition, { signal, passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', reposition, { signal, passive: true });
  window.visualViewport?.addEventListener('scroll', reposition, { signal, passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.isTrusted) cancelActivityFocus();
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (menuState?.surface && !menuState.menu.contains(target)) closeFlyout(false);
    if (activity && !activity.surface.contains(target)) {
      const otherControl = target.closest('button, a[href], input, textarea, [contenteditable], [tabindex]');
      closeActivity(!otherControl);
    }
  }, { signal, capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.isTrusted) cancelActivityFocus();
    if (event.key !== 'Escape' || !(event.target instanceof Node)) return;
    if (menuState?.surface?.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeFlyout(true);
    } else if (activity && (activity.surface.contains(event.target) || event.target === activity.trigger)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeActivity(true);
    }
  }, { signal, capture: true });

  const stopMessages = mountMessageActions({ getContext: options.getContext, dispatch, report: notify });
  reconcile();
  update();

  return {
    update,
    getTheme: currentTheme,
    showActivity(context: ActionContext) {
      const trigger = findTrigger();
      if (!trigger || !sameContext(context, options.getContext())) return false;
      if (menuState) {
        const state = menuState;
        closeFlyout(false);
        closeNativeMenu(state);
        afterMenuDismisses(state, () => {
          if (sameContext(context, options.getContext())) openActivity(trigger, context);
        });
        return true;
      }
      return openActivity(trigger, context);
    },
    dispose() {
      if (!alive) return;
      alive = false;
      observer.disconnect();
      themeObserver.disconnect();
      lifecycle.abort();
      stopMessages();
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      if (updateFrame) window.cancelAnimationFrame(updateFrame);
      cancelActivityFocus();
      closeActivity(false);
      clearNotice();
      detachMenu();
    },
  };
}
