import type { ActionContext, ActivitySnapshot, CapturedMessage, Projection } from '../contracts';
import { PRODUCT } from '../product';

export const MAX_STAGE_BYTES = 2 * 1024 * 1024;
export const STAGE_TTL = 15 * 60 * 1000;
export const MAX_BATCH_BYTES = 128 * 1024;
export const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const id = (v: unknown): v is string => bounded(v, 256) && !/[\u0000-\u001f\u007f]/.test(v);
export function context(v: unknown): v is ActionContext {
  return record(v) && Number.isSafeInteger(v.epoch) && Number(v.epoch) >= 0 && id(v.providerId) && id(v.selectionId);
}
export function same(a?: ActionContext | null, b?: ActionContext | null) {
  return !!a && !!b && a.epoch === b.epoch && a.providerId === b.providerId && a.selectionId === b.selectionId;
}
export function providerAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== PRODUCT.origin || url.username || url.password) return null;
    const match = /^\/(?:g\/[^/]+\/)?c\/([A-Za-z0-9_-]{1,160})\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch { return null; }
}
export function providerMatches(value:unknown,provider:unknown):boolean {
  if(providerAt(value)===provider) return true;
  if(typeof value!=='string'||typeof provider!=='string'||!/^local:[0-9a-f-]{36}$/i.test(provider)) return false;
  try { const url=new URL(value);return url.origin===PRODUCT.origin && !url.username && !url.password &&
    (/^\/$/.test(url.pathname) || /^\/g\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)); } catch {return false;}
}
export function trustedSender(sender: chrome.runtime.MessageSender): 'content' | 'library' | 'popup' | null {
  if (sender.id !== chrome.runtime.id || !sender.url || (sender.frameId ?? 0) !== 0 || sender.tab?.incognito ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return null;
  try {
    const u = new URL(sender.url);
    if (sender.origin && sender.origin !== u.origin && sender.origin !== 'chrome-extension://' + chrome.runtime.id) return null;
    if (u.origin === PRODUCT.origin && sender.tab?.id !== undefined && sender.documentId) return 'content';
    if (u.protocol !== 'chrome-extension:' || u.hostname !== chrome.runtime.id) return null;
    return u.pathname === '/library.html' ? 'library' : u.pathname === '/popup.html' ? 'popup' : null;
  } catch { return null; }
}
const metricKeys = ['model','displayModel','requestedModel','conversationDefault','accountDefault','input','output','effectiveWindow','catalogMaximum'];
const quotaMetrics = ['remaining','used','total','resetSeconds','deadline'];
const time = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
function metricOk(x: unknown, string: boolean) {
  return record(x) && Object.keys(x).every(k=>['value','status','sourceKind','sourceField','observedAt','replyId','adapterVersion','endpoint'].includes(k)) &&
    (string ? bounded(x.value,256) : Number.isSafeInteger(x.value) && Number(x.value)>=0) &&
    ['reported','observed','derived'].includes(String(x.status)) && ['server-reported','dom-observed','local','derived'].includes(String(x.sourceKind)) &&
    bounded(x.sourceField,256) && bounded(x.endpoint,96) && bounded(x.adapterVersion,64) && time(x.observedAt) && (!x.replyId || id(x.replyId));
}
export function activityOk(x: unknown): x is ActivitySnapshot {
  if (!record(x) || !Object.keys(x).every(k=>[...metricKeys,'state','replyId','comparable','comparableReason','quotas','observedAt','adapterVersion'].includes(k)) ||
    !['waiting','streaming','reported','partial','unavailable'].includes(String(x.state)) || typeof x.comparable!=='boolean' ||
    !bounded(x.adapterVersion,64) || (x.replyId!==undefined && !id(x.replyId)) || (x.observedAt!==undefined && !time(x.observedAt)) ||
    (x.comparableReason!==undefined && !bounded(x.comparableReason,256)) || !Array.isArray(x.quotas) || x.quotas.length>64) return false;
  return metricKeys.every((key,i)=>x[key]===undefined || metricOk(x[key],i<5)) &&
    x.quotas.every(q=>record(q) && bounded(q.feature,128) && bounded(q.scope,256) && time(q.observedAt) &&
      Object.keys(q).every(k=>['feature','scope','observedAt',...quotaMetrics].includes(k)) &&
      quotaMetrics.every(key=>q[key]===undefined || metricOk(q[key],false)));
}
function messageOk(x: unknown): x is CapturedMessage {
  return record(x) && Object.keys(x).every(k=>['id','parentId','provisional','role','text','observedAt','final','activity'].includes(k)) &&
    id(x.id) && (x.parentId==null || id(x.parentId)) && typeof x.provisional==='boolean' &&
    (x.role==='user' || x.role==='assistant') && typeof x.text==='string' && new TextEncoder().encode(x.text).length<=512*1024 &&
    typeof x.final==='boolean' && time(x.observedAt) && (x.activity===undefined || activityOk(x.activity));
}
export function projectionOk(x: unknown, scope: ActionContext, limit: number): x is Projection {
  if (!record(x) || !Object.keys(x).every(k=>['providerId','title','sourceUrl','selectionId','leafId','source','messages','coverage','observedAt','adapterVersion','batchId','aliasFrom'].includes(k)) ||
     x.providerId!==scope.providerId || x.selectionId!==scope.selectionId || !providerMatches(x.sourceUrl,scope.providerId) ||
     typeof x.title!=='string' || x.title.length>1024 || !id(x.batchId) || !bounded(x.adapterVersion,64) ||
     !time(x.observedAt) || !['dom','history'].includes(String(x.source)) || !record(x.coverage) ||
     !['complete','unknown','partial'].includes(String(x.coverage.state)) || !bounded(x.coverage.reason,1024) ||
     !Array.isArray(x.messages) || !x.messages.length || x.messages.length>4096 ||
     (x.leafId!==undefined && !id(x.leafId)) || (x.aliasFrom!==undefined && !id(x.aliasFrom))) return false;
  if (x.coverage.state==='complete' && (x.source!=='history' || !x.leafId)) return false;
  return byteSize(x)<=limit && x.messages.every(messageOk) && new Set(x.messages.map(m=>m.id)).size===x.messages.length;
}
export function minimalProjection(p: Projection): Projection {
  // Account-scoped metadata is always transient, even if the reply is explicitly saved.
  return {...p, sourceUrl: p.providerId.startsWith('local:') ? PRODUCT.origin+'/' : PRODUCT.origin + '/c/' + encodeURIComponent(p.providerId), messages:p.messages.map(m=>{
    if (!m.activity) return m;
    const {accountDefault: _account, quotas: _quotas, ...reply} = m.activity;
    return {...m,activity:{...reply,quotas:[]}};
  })};
}
