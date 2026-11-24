import {describe,it,expect,vi,afterEach} from 'vitest';
import type {Projection,ActivitySnapshot} from '../../src/contracts';
import {activityOk,minimalProjection,projectionOk,trustedSender,MAX_BATCH_BYTES,providerMatches,same} from '../../src/runtime/policy';
const scope={providerId:'first-chat',selectionId:'first-branch',epoch:1};
const p:Projection={batchId:'b',...scope,messages:[{id:'m',text:'Reference only.',role:'user',provisional:false,final:true,observedAt:1}],
  source:'dom',sourceUrl:'https://chatgpt.com/c/first-chat',title:'Synthetic test',coverage:{state:'unknown',reason:'Rendered segment.'},observedAt:1,adapterVersion:'v1'};
delete (p as unknown as Record<string,unknown>).epoch;
describe('runtime authority',()=>{
  const ext='abcdefghijklmnopabcdefghijklmnop'; afterEach(()=>vi.unstubAllGlobals());
  it('derives the calling area from the runtime origin, document, frame and private mode',()=>{
    vi.stubGlobal('chrome',{runtime:{id:ext}});
    const src={url:'https://chatgpt.com/c/first-chat',origin:'https://chatgpt.com',id:ext,tab:{id:2,incognito:false},frameId:0,documentId:'doc'};
    const identify=(value:object)=>trustedSender(value as chrome.runtime.MessageSender);
    expect(identify(src)).toBe('content');
    for(const override of [{id:'other'},{origin:'https://example.net'},{frameId:1},{tab:{id:2,incognito:true}},{documentLifecycle:'prerender'},{url:'https://evil.test'},{documentId:undefined}]) expect(identify({...src,...override})).toBeNull();
    for(const [route,expected] of [['library.html','library'],['popup.html','popup'],['unspecified.html',null]]) {
      expect(identify({id:ext,url:'chrome-extension://'+ext+'/'+route,origin:'chrome-extension://'+ext})).toBe(expected);
    }
  });
  it('rejects unsupported origins, credentialed URLs, mismatched provider, scope and selection',()=>{
    expect(projectionOk(p,scope,MAX_BATCH_BYTES)).toBe(true);
    for(const patch of [{selectionId:'stale'},{providerId:'other'},{sourceUrl:'https://a@chatgpt.com/c/first-chat'},{sourceUrl:'https://chatgpt.com.example.com/c/first-chat'},{sourceUrl:'https://chatgpt.com/share/first-chat'},{rawPayload:{text:'unreviewed'}}]){
      expect(projectionOk({...p,...patch},scope,MAX_BATCH_BYTES)).toBe(false);
    }
    expect(same(scope,{...scope,epoch:2})).toBe(false);
  });
  it('requires supported payloads, bounded bytes and distinct identifiers',()=>{
    for(const patch of [{messages:[]},{messages:[...p.messages,...p.messages]},{messages:[{...p.messages[0],role:'tool'}]},
      {messages:[{...p.messages[0],text:'🦉'.repeat(50000)}]},{messages:[{...p.messages[0],hidden:'raw text'}]},
      {coverage:{state:'complete',reason:'No branch proof'}}]) expect(projectionOk({...p,...patch},scope,MAX_BATCH_BYTES)).toBe(false);
  });
  it('explicitly scopes provisional root URLs',()=>{
    const local='local:'+crypto.randomUUID();
    expect(providerMatches('https://chatgpt.com/',local)).toBe(true);
    expect(providerMatches('https://chatgpt.com/share/x',local)).toBe(false);
    expect(providerMatches('https://chatgpt.com/','canonical')).toBe(false);
  });
  it('strips temporary account-level observations and source query data before archiving',()=>{
    const metric={value:'test',sourceField:'account.default',sourceKind:'server-reported',status:'reported',adapterVersion:'test',observedAt:1,endpoint:'account'} as const;
    const a:ActivitySnapshot={quotas:[{feature:'images',scope:'workspace',observedAt:1}],state:'reported',comparable:false,accountDefault:metric,adapterVersion:'test'};
    expect(activityOk(a)).toBe(true);
    const reduced=minimalProjection({...p,sourceUrl:p.sourceUrl+'?private=x',messages:[{...p.messages[0],activity:a}]});
    expect(reduced.sourceUrl).toBe(p.sourceUrl);expect(reduced.messages[0].activity?.quotas).toEqual([]);expect(reduced.messages[0].activity?.accountDefault).toBeUndefined();
    expect(activityOk({...a,raw:'sensitive'})).toBe(false);
  });
});
