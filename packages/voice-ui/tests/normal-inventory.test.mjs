import assert from 'node:assert/strict';
import test from 'node:test';
import {onRequirements, onParts} from '../functions/api/parts.mjs';
import {isInventory, readRequirementInspection, readLiteralInspection, readRequired, quotaGoalBundle} from '../src/completion.mjs';

const part = (key, label=key, kind='step') => ({key,label,kind,purpose:`one ${label}`});
const input = (n=4, parts=[], extended=true) => ({kind:extended?'voice-ui.goal.inventory.v2':'voice-ui.goal.inventory.v1', state:{
  utterance:`Cloud内に${Array.from({length:n},(_,i)=>`step「項目${i}」を1個`).join('、')}追加。他は変えない。`,head:'sha256:'+'1'.repeat(64),
  regions:[{id:'root',label:'World',kind:'boundary',parent:null},{id:'cloud',label:'Cloud',kind:'group',parent:'root'}],edges:[],parts,
  ...(extended?{maxRequired:16,relations:[{kind:'flow',label:''}]}:{})}});
const rows = n => Array.from({length:n},(_,i)=>({label:`項目${i}`,kind:'step',quantity:1}));
const factors = (complete='complete', confidence=.9) => Object.fromEntries(Object.entries({intent:'change',labels:'missing',capacity:'within',completeness:complete}).map(([key,choice])=>[key,{choice,confidence}]));
const scalar = (required,max=16) => Object.fromEntries(Array.from({length:max},(_,i)=>{
  const row=required[i]??{label:'',kind:'none',quantity:0};
  return Object.entries({...row,quantity:String(row.quantity)}).map(([field,v])=>[`required${i+1}_${field}`,v]);
}).flat());
const invoke = (inventory, ports, extra={}) => onRequirements({request:new Request('https://fixture.invalid/api/parts/check',{method:'POST',body:JSON.stringify(inventory)}),mode:'check',method:'adaptive-v3',available:true,...extra}, ports);

for(const n of [4,16])test(`ordinary check: all ${n} explicit requirements survive API and readback without TypeLLM`,async()=>{
 const i=input(n);let calls=0;
 const r=await invoke(i,{judge:async()=>{calls++;return {answers:factors()};},generate:async()=>assert.fail('literal requirements need no generation')});
 assert.equal(r.status,200);const body=await r.json();
 assert.deepEqual(body.inspection.required,rows(n));assert.equal(body.inspection.missing.length,n);
 assert.equal(calls,1);assert.equal(body.choice,'missing');
 assert.ok(readRequirementInspection(body.inspection,i.state,readLiteralInspection));
});
test('ordinary interpreted request: all 16 slots and quantities are fixed before generation',async()=>{
 const i=input(4);i.state.utterance='Cloud内に項目0、項目1、項目2、項目3を各1個追加';let checks=0,types=0;
 const r=await invoke(i,{judge:async()=>({answers:factors(++checks===1?'incomplete':'complete')}),generate:async req=>{
  types++;assert.equal(Object.keys(req.questions).length,48);assert.equal(req.questions.required16_quantity.enum.at(-1),'16');
  return {result:scalar(rows(4))};
 }});assert.equal(r.status,200);const body=await r.json();assert.deepEqual(body.inspection.required,rows(4));
 assert.equal(checks,2);assert.equal(types,1);assert.ok(readRequirementInspection(body.inspection,i.state,readLiteralInspection));
});
test('complete stock preserves original keys and descriptions; no extra generated rows',async()=>{
 const stock=rows(4).map((r,i)=>part('original-'+i,r.label));const i=input(4,stock);
 const response=await invoke(i,{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('stock complete')});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.choice,'sufficient');assert.deepEqual(body.inspection.missing,[]);
 const prepared=quotaGoalBundle({parts:stock,goalSelection:'delta'},body.inspection.required);
 assert.deepEqual(prepared.parts,stock);assert.deepEqual(i.state.parts,stock);
});
test('repeated new count is not reduced by existing graph nodes',async()=>{
 const i=input(1,[part('held','項目0')]);i.state.utterance='Cloud内にstep「項目0」を5個追加';
 i.state.regions.push({id:'already',label:'項目0',kind:'step',parent:'cloud'});
 const response=await invoke(i,{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('literal')});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.inspection.required[0].quantity,5);
 assert.equal(body.inspection.missing.length,4);
});
test('receipt is bound to exact input; changed head, text, stock and graph are refused',async()=>{
 const i=input(4);const r=await invoke(i,{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('literal')});
 assert.equal(r.status,200);const {inspection}=await r.json();
 for(const mutate of [s=>s.head='other',s=>s.utterance+='余計な変更',s=>s.parts.push(part('x')),s=>s.regions[1].label='Other',s=>s.maxRequired=4,s=>s.relations[0].label='changed']){
  const changed=structuredClone(i.state);mutate(changed);
  assert.equal(readRequirementInspection(inspection,changed,readLiteralInspection),null);
 }
 const bad=structuredClone(inspection);bad.missing.pop();assert.equal(readRequirementInspection(bad,i.state,readLiteralInspection),null);
});
test('invalid input boundaries are refused before any provider call',async()=>{
 for(const mutate of [s=>s.maxRequired=17,s=>s.parts=Array.from({length:33},(_,i)=>part('p'+i)),s=>s.parts=[part('p'),part('p')],s=>s.relations=[{kind:'flow',label:'',extra:1}]]){
  const i=input(4);mutate(i.state);assert.equal(isInventory(i),false);
  const r=await invoke(i,{judge:async()=>assert.fail('invalid input'),generate:async()=>assert.fail('invalid input')});assert.equal(r.status,422);
 }
});
test('wrong slot count, duplicate names, total overflow and ungrounded names cannot become candidates',async()=>{
 const i=input(4);i.state.utterance='Cloud内に項目0、項目1、項目2、項目3を追加';
 for(const value of [scalar(rows(4),3),scalar([rows(1)[0],rows(1)[0]]),scalar([{label:'項目0',kind:'step',quantity:16},{label:'項目1',kind:'step',quantity:1}]),scalar([{label:'invented',kind:'step',quantity:1}])]){
  let calls=0;const r=await invoke(i,{judge:async()=>{calls++;return {answers:factors('incomplete')};},generate:async()=>({result:value})});
  assert.equal(r.status,502);assert.equal(calls,1,'invalid generation is never verified as good');
 }
});
test('unverified extracted rows remain unknown, not sufficient',async()=>{
 const i=input(4);i.state.utterance='Cloud内に項目0、項目1、項目2、項目3を追加';let checks=0;
 const r=await invoke(i,{judge:async()=>({answers:factors(++checks===1?'incomplete':'complete',checks===1?.9:.49)}),generate:async()=>({result:scalar(rows(4))})});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.choice,'unknown');assert.equal(body.confidence,null);
});
test('legacy inventory stays strict: default three rows, no extended fields',async()=>{
 assert.equal(isInventory(input(3,[],false)),true);assert.equal(readRequired(rows(4)),null);
 const old=input(3,[],false);old.state.maxRequired=16;assert.equal(isInventory(old),false);
 const r=await invoke(input(3,[],false),{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('legacy literal')});assert.equal(r.status,200);
 const body=await r.json();assert.equal(body.inspection.schema,'voice-ui.parts.inspection/3');assert.equal(Object.hasOwn(body.inspection,'input'),false);
});
test('direct extraction, explicit verify, and legacy complete all honor the same new capacity',async()=>{
 const i=input(4);
 const request=mode=>new Request('https://fixture.invalid/api/parts/'+mode,{method:'POST',body:JSON.stringify(mode==='verify'?{schema:'voice-ui.parts.verify/2',inventory:i,required:rows(4)}:i)});
 const r=await onRequirements({request:request('requirements'),mode:'requirements',method:'adaptive-v3',generation:'flat-scalars',available:true},{judge:async()=>assert.fail('extract only'),generate:async()=>({result:scalar(rows(4))})});
 assert.equal(r.status,200);assert.deepEqual((await r.json()).required,rows(4));
 const v=await onRequirements({request:request('verify'),mode:'verify',method:'adaptive-v3',available:true},{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('verify only')});assert.equal(v.status,200);assert.equal((await v.json()).accepted,true);
 const c=await onParts({request:request('complete'),mode:'complete',method:'literal',available:true},{judge:async()=>assert.fail('literal'),generate:async()=>assert.fail('literal')});assert.equal(c.status,200);assert.equal((await c.json()).missing.length,4);
});
test('declared symbols and instance keys survive the supply receipt; unsafe or ambiguous identity is refused',async()=>{
 const symbol={href:'/assets/sql.svg',alt:'SQL service',provenanceRef:'catalog:sql:v1'};
 const stock=rows(4).map((r,i)=>({...part('original-'+i,r.label),symbol}));const i=input(4,stock);
 const r=await invoke(i,{judge:async()=>({answers:factors()}),generate:async()=>assert.fail('complete literal')});
 assert.equal(r.status,200);const body=await r.json();assert.deepEqual(body.inspection.input.parts,stock);
 assert.deepEqual(quotaGoalBundle({parts:stock,goalSelection:'delta'},body.inspection.required).parts,stock);
 for(const href of ['https://example.invalid/logo.svg','//host/logo.png','javascript:alert(1)','/assets/../x.svg','/assets/%2e%2e/x.svg']){
  const bad=structuredClone(i);bad.state.parts[0].symbol.href=href;assert.equal(isInventory(bad),false);
 }
 const alternatives=[part('one','same'),{...part('two','same'),purpose:'different service'}];
 assert.equal(quotaGoalBundle({goalSelection:'delta',parts:alternatives},[{label:'same',kind:'step',quantity:1}]),null,'do not silently keep the first of semantically different instances');
});
