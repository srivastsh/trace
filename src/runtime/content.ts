import type {ActionContext, CaptureStatus, HostActionRequest, Projection} from '../contracts';
import {createObserver} from '../observe/client';
import {mountHost} from '../host/menu';
import {rpc} from '../rpc';
import {byteSize, record, same} from './policy';

function startContent() {
const instance = crypto.randomUUID();
const off = ():CaptureStatus => ({enabled:false,bound:false,paused:false,generation:0});
let status = off();
let alertEnabled = false;
let confirmedOrdinary = false;
let disposed = false;
let sequence = 0;
let refreshCounter = 0;
let pendingBytes = 0;
let generationQueue = 0;
let contentReady = false;
let queued = Promise.resolve();
let sendScope = Promise.resolve();
let capturedScope: ActionContext|null = null;
const listenerDiagnostic = (name:string) => {
  if (disposed || !chrome.runtime?.id) return;
  const code = name.includes('bound') || name.includes('limit') ? 'observer-cap' :
    name.includes('interrupt') ? 'stream-interrupted' : 'adapter-degraded';
  void rpc('diagnostic',{code}).catch(()=>{});
};
function stopCapture() {
  status=off();
  confirmedOrdinary=false;
  generationQueue++;
  pendingBytes=0;
  if(contentReady) observer.setCapture(null);
}
function refreshHost() {if(contentReady && !disposed) host.update();}
function cleanup() {
  if(disposed) return;
  disposed=true;
  stopCapture();
  if(contentReady) { observer.destroy(); host.dispose(); }
  chrome.runtime?.onMessage?.removeListener(receive);
}
function checkRuntime() {
  if (!chrome.runtime?.id) { cleanup(); return false; }
  return !disposed;
}
async function refresh() {
  if(!checkRuntime()) return;
  const mark=++refreshCounter;
  const observed=observer.scope();
  if(!observed) { stopCapture(); refreshHost(); return; }
  try {
    const next=await rpc<{status:CaptureStatus,alertEnabled:boolean,confirmedOrdinary?:boolean}>('status',{context:observed,instance});
    if(mark!==refreshCounter || !same(observed,observer.scope()) || disposed) return;
    status=next.status; alertEnabled=next.alertEnabled;confirmedOrdinary=next.confirmedOrdinary===true;
    observer.setCapture(status.enabled && (observed.temporary==='ordinary'||(observed.temporary==='unknown'&&confirmedOrdinary)) ? {epoch:observed.epoch,generation:status.generation,confirmedOrdinary}:null);
  } catch { if(mark===refreshCounter) stopCapture(); }
  refreshHost();
}
function announce() {
  if(!contentReady || !checkRuntime()) return;
  const scope=observer.scope();
  const changed=!capturedScope || !scope || capturedScope.epoch!==scope.epoch || capturedScope.providerId!==scope.providerId;
  if(changed) stopCapture();
  capturedScope=scope?{...scope}:null;
  const serial=++sequence;
  sendScope=sendScope.catch(()=>{}).then(async()=>{
    if(!checkRuntime() || serial!==sequence) return;
    await rpc('scope',{instance,sequence:serial,scope,href:location.href});
    if(serial===sequence) await refresh();
  }).catch(()=>{ if(!chrome.runtime?.id) cleanup(); else if(serial===sequence) stopCapture(); });
  refreshHost();
}
function enqueue(projection:Projection,generation:number) {
  if(!status.enabled || status.generation!==generation || !contentReady || !checkRuntime()) return;
  const scope=observer.scope(), mark=generationQueue;
  const size=byteSize(projection);
  if(!scope || (scope.temporary!=='ordinary' && !(scope.temporary==='unknown'&&confirmedOrdinary)) || size>128*1024 || pendingBytes+size>2*1024*1024) {
    listenerDiagnostic('bounded'); return;
  }
  pendingBytes+=size;
  queued=queued.then(async()=>{
    await sendScope;
    for(let retry=0;retry<2;retry++) {
      if(mark!==generationQueue || !checkRuntime() || status.generation!==generation || !same(scope,observer.scope())) return;
      try { await rpc('capture',{instance,context:scope,projection,generation}); return; }
      catch { if(retry===0) await new Promise(resolve=>setTimeout(resolve,150)); else listenerDiagnostic('capture-interrupted'); }
    }
  }).catch(()=>{}).finally(()=>{if(mark===generationQueue) pendingBytes-=size;});
}
const observer=createObserver({
  onScope:()=>{ if(contentReady) announce(); },
  onActivity:refreshHost,
  onCapture:enqueue,
  onDiagnostic:listenerDiagnostic,
});
const host=mountHost({
  getContext:()=>observer.scope() ?? undefined,
  getActivity:()=>observer.activity(),
  getCaptureStatus:()=>status,
  getAlertEnabled:()=>alertEnabled,
  dispatch:async(req:HostActionRequest,event:Event)=>{
    if(!event.isTrusted || !checkRuntime()) throw Error('Reopen Trace and select the action again.');
    if(req.action==='library' || req.action==='settings') {
      await rpc('open',{action:req.action,instance,context:observer.scope()}); return;
    }
    if(!same(req.context,observer.scope())) throw Error('The conversation changed. Reopen Trace.');
    if(req.action==='pause') { await rpc('togglePause',{instance,context:req.context}); await refresh(); return; }
    if(req.action==='activity') return;
    const projection=observer.snapshot(req.context!,req.messageId);
    await rpc('stage',{instance,context:req.context,action:req.action,messageId:req.messageId,projection});
  },
  onCapability:state=>{if(state==='unavailable' && contentReady) listenerDiagnostic('adapter-degraded');},
});
function receive(msg:unknown,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void) {
  if(sender.id!==chrome.runtime.id || sender.tab || !record(msg) || msg.v!==1 || !checkRuntime()) return;
  try {
    if(msg.op==='trace-who') { respond({instance,context:observer.scope()}); return; }
    if(msg.op==='trace-policy') { stopCapture(); void refresh(); respond(true); return; }
    if(msg.op==='trace-reconnect') {stopCapture();announce();respond(true);return;}
    if(msg.op==='trace-theme') {
      const anchor=document.querySelector('header')??document.documentElement;
      const cs=getComputedStyle(anchor),root=document.documentElement;
      const theme=(root.dataset.theme??root.style.colorScheme??'').toLowerCase();
      respond({dark:theme==='dark'||(theme!=='light'&&(root.classList.contains('dark')||matchMedia('(prefers-color-scheme: dark)').matches)),fontFamily:cs.fontFamily});return;
    }
    if(msg.op==='trace-popup') {
      respond({instance,context:observer.scope(),activity:observer.activity(),theme:host.getTheme(),alertEnabled}); return;
    }
    if(msg.op==='trace-snapshot' || msg.op==='trace-activity') {
      const scope=observer.scope();
      if(msg.instance!==instance || !scope || !same(msg.context as ActionContext,scope)) throw Error();
      if(msg.op==='trace-activity') { respond({shown:host.showActivity(scope)}); return; }
      respond({instance,projection:observer.snapshot(scope),context:scope}); return;
    }
  } catch {respond({error:'The conversation changed or the selection is too large. Reopen Trace.'});}
}
chrome.runtime.onMessage.addListener(receive);
contentReady=true;
announce();
window.addEventListener('pagehide',e=>{if(!e.persisted) cleanup();else stopCapture();});
window.addEventListener('pageshow',e=>{if(e.persisted) announce();});

}
if(document.documentElement) startContent();
else {
  const boot=new MutationObserver(()=>{
    if(!document.documentElement) return;
    boot.disconnect();startContent();
  });
  boot.observe(document,{childList:true});
}
