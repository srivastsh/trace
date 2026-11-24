import type { Action, ActionContext } from '../contracts';
import { PRODUCT } from '../product';

export const ACTIONS = [
  { action: 'activity', label: 'Activity', icon: 'activity' },
  { action: 'save', label: 'Save chat', icon: 'save' },
  { action: 'export', label: 'Export chat', icon: 'export' },
  { action: 'handoff', label: 'Prepare handoff', icon: 'handoff' },
  { action: 'library', label: 'Local library', icon: 'library' },
  { action: 'settings', label: 'Settings', icon: 'settings' },
] as const;

export const STALE = `The current chat or selected branch changed. Reopen ${PRODUCT.name} and select the action again.`;
export const ACTION_FAILED = `${PRODUCT.name} could not complete this action. Try reopening the current chat.`;
export function actionContext(context?: ActionContext): ActionContext | undefined {
  if (context) {
    const { epoch, providerId, selectionId } = context;
    return { epoch, providerId, selectionId };
  }
}
export function sameContext(a?: ActionContext, b?: ActionContext) {
  return a?.epoch === b?.epoch && a?.providerId === b?.providerId && a?.selectionId === b?.selectionId;
}
export function globalAction(action: Action) {
  return action === 'library' || action === 'settings';
}
export function requiresSelection(action: Action) {
  return !globalAction(action) && action !== 'activity';
}
