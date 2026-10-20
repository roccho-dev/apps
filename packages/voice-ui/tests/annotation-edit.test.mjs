import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Same fixed expected labels on old and new source. Neither this expectation
// nor a model's complete verdict supplies the product's requested label text.
const source = process.env.ANNOTATION_SOURCE_ROOT ?? new URL('..', import.meta.url).pathname;
const load = rel => import(pathToFileURL(path.join(source, rel)));
const contract = await load('src/contract.mjs');
const { requestFor, planStep, revertStep, revertable } = await load('src/turn.mjs');
const { createSession, propose, undo, apply, appendRevert } = await load('src/session.mjs');
const { commitLog, restoreLog, projectHistory } = await load('src/log.mjs');
const { questionsFor } = await load('src/judgment.mjs');
const { onRequestPost } = await load('functions/api/judge.mjs');
const protocol = await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL ?? path.join(process.env.SEMANTIC_MAP, 'packages/semantic-map/protocol/index.js')));
const bundle = { goalSelection:'delta', version:'annotation-fixture', parts:[], diagrams:[] };
const seed = () => protocol.createDecisionLog([
  {type:'meta',schema:'semantic-map-state/1',root:'root',title:'annotation fixture'},
  {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:[0,0,2000,900],summary:''},
  {type:'region',id:'s',parent:'root',label:'API',kind:'step',bounds:[20,100,160,90],summary:''},
  {type:'region',id:'t',parent:'root',label:'Monitor',kind:'step',bounds:[480,100,160,90],summary:''},
  {type:'region',id:'x',parent:'root',label:'Unrelated',kind:'data',bounds:[240,300,160,90],summary:''},
  {type:'relation',id:'metrics',from:'s',to:'t',kind:'metrics',label:'RPS'},
  {type:'relation',id:'control',from:'t',to:'s',kind:'control',label:'scale'},
], 'voice-graph');
const asked = (working, utterance, typedEdges=true) => requestFor({working,utterance,bundle,
  layout:null, offeredFrame:null,draft:[],focus:null,pending:null,recent:[],typedEdges});
const answersFor = (turn, overrides={}) => Object.fromEntries(Object.entries(turn.slots).map(([slot])=>[slot,
  {type:'choice',choice:overrides[slot]??({action:'label-edge',edge:'metrics',edgeLabel:'label-1'}[slot]??'none'),confidence:1}]));
const change = async (before, utterance, overrides={}) => {
  const {turn,request}=asked(before,utterance),session=createSession({accepted:before,stored:before.log});
  const transition=await propose(session,{turn,answers:answersFor(turn,overrides),protocol,bundle,layout:null,visibleFrame:null,
    input:{source:'typed',text:utterance},repair:null});
  return {before,session,turn,request,...transition};
};
const bag = records => records.map(r=>JSON.stringify(r)).sort();
const expectOnlyLabel = (old, next, value) => assert.deepEqual(bag(next),bag(old.map(r=>r.id==='metrics'?{...r,label:value}:r)));

for(const [id,text,value] of [
  ['ascii','APIからMonitorへの計測線の注釈を「requests/s」に変更。他は変えない。','requests/s'],
  ['unicode','計測線の注釈を「毎秒要求」に変更。他は変えない。','毎秒要求'],
  ['empty','計測線の注釈を""に変更して空にする。他は変えない。',''],
  ['exact-spaces','計測線の注釈を「  RPS  」に変更。他は変えない。','  RPS  '],
])test('B ordinary annotation replacement / '+id,async()=>{
  const r=await change(await seed(),text); assert.equal(r.result.outcome,'step');
  expectOnlyLabel(r.before.records,r.session.working.records,value);
  const reread=await protocol.verifyDecisionLog(r.session.working.log); expectOnlyLabel(r.before.records,reread.records,value);
  assert.equal(r.session.stored,r.before.log);
});

if(!process.env.ANNOTATION_BASELINE_ONLY){
  test('new/old quoted alternatives remain distinct; choose only the explicit replacement',async()=>{
    const r=await change(await seed(),'注釈「RPS」を「requests/s」に変更。',{edgeLabel:'label-2'});
    assert.equal(r.result.outcome,'step');expectOnlyLabel(r.before.records,r.session.working.records,'requests/s');
    assert.deepEqual(r.request.state.offers.edgeLabels,[{key:'label-1',label:'RPS'},{key:'label-2',label:'requests/s'}]);
  });
  test('quoted strings offer choices, not an automatic graph change',async()=>{
    const r=await change(await seed(),'この注釈「RPS」を説明して。',{action:'none'});
    assert.equal(r.result.outcome,'no-change');assert.equal(r.session.working.log,r.before.log);
  });
  for(const slot of ['action','edge','edgeLabel'])test('one weak '+slot+' prevents mutation',async()=>{
    const before=await seed(),{turn}=asked(before,'注釈を「new」に変更'),answers=answersFor(turn);answers[slot].confidence=.49;
    const r=await planStep({working:before,turn,answers,bundle,protocol});
    assert.equal(r.outcome,'no-change');assert.equal(r.reason,'not-confident');
  });
  for(const slot of ['edge','edgeLabel'])test('unresolved '+slot+' is not guessed',async()=>{
    const r=await change(await seed(),'注釈を「new」に変更',{[slot]:'none'});
    assert.equal(r.result.outcome,'no-change');assert.equal(r.session.working.log,r.before.log);
  });
  test('unchanged annotation is an explicit no-op',async()=>{
    const r=await change(await seed(),'注釈を「RPS」に変更');
    assert.equal(r.result.reason,'annotation-unchanged');assert.equal(r.session.working.log,r.before.log);
  });
  test('stale head and fabricated choice cannot change the graph',async()=>{
    const before=await seed(),{turn}=asked(before,'注釈を「new」に変更');
    assert.equal((await planStep({working:before,turn:{...turn,head:'stale'},answers:answersFor(turn),bundle,protocol})).reason,'stale');
    assert.equal((await planStep({working:before,turn,answers:answersFor(turn,{edgeLabel:'not-offered'}),bundle,protocol})).reason,'answer-invalid');
  });
  for(const utterance of ['未引用の注釈に変更','「unterminated','「nested「x」」','"a\\b"','「line\nbreak」','」bad',
    '「'+'a'.repeat(121)+'」',Array.from({length:9},(_,i)=>'「'+i+'」').join(' '), '"quote「x」"']){
    test('unsupported literal cannot invent or truncate a replacement / '+JSON.stringify(utterance).slice(0,40),async()=>{
      assert.deepEqual(contract.annotationChoices(utterance),[]);
      const req=asked(await seed(),utterance);assert.equal(req.request.kind,contract.TYPED_REQUEST_KIND);
      assert.ok(!req.turn.slots.action.includes('label-edge'));
    });
  }
  test('eight alternatives and 120 exact characters remain bounded',()=>{
    assert.equal(contract.annotationChoices(Array.from({length:8},(_,i)=>'「'+i+'」').join(' ')).length,8);
    assert.equal(contract.annotationChoices('「'+'あ'.repeat(120)+'」')[0].label.length,120);
  });
  test('same literal deduplicates without adding synthetic name suffixes',()=>{
    assert.deepEqual(contract.annotationChoices('「RPS」 "RPS" 「新」'),[{key:'label-1',label:'RPS'},{key:'label-2',label:'新'}]);
  });
  test('v1 and unquoted v2 wire shapes remain unchanged',async()=>{
    const graph=await seed(),v1=asked(graph,'注釈を「new」に変更',false),v2=asked(graph,'注釈をnewに変更');
    assert.equal(v1.request.kind,contract.REQUEST_KIND);assert.equal(v2.request.kind,contract.TYPED_REQUEST_KIND);
    assert.deepEqual(Object.keys(v1.request.state.offers),['parts','diagrams']);
    assert.deepEqual(Object.keys(v2.request.state.offers),['parts','diagrams']);
    assert.ok(contract.isRequest(v1.request));assert.ok(contract.isRequest(v2.request));
    for (const value of [v1,v2]) assert.equal(questionsFor(value.request.state,value.turn.slots,{kind:value.request.kind}).edgeLabel,undefined);
  });
  test('v3 closed wire verifies quoted values from the utterance before judging',async()=>{
    const {request}=asked(await seed(),'注釈を「new」に変更');assert.equal(request.kind,contract.ANNOTATION_REQUEST_KIND);
    assert.ok(contract.isRequest(request));
    for(const mutate of [r=>r.state.offers.edgeLabels[0].label='invented',r=>r.state.offers.edgeLabels.push({key:'extra',label:'new'}),
      r=>r.state.offers.edgeLabels[0].extra='x',r=>r.kind=contract.TYPED_REQUEST_KIND,r=>r.state.utterance='no quotes',r=>r.state.graph.edges=[]]){
      const r=structuredClone(request);mutate(r);assert.equal(contract.isRequest(r),false);
    }
  });
  test('normal HTTP judge sees typed old relation and literal replacement; no generation required',async()=>{
    const graph=await seed(),{turn,request}=asked(graph,'計測線の注釈を「new」に変更');let calls=0;
    const response=await onRequestPost({available:true,request:new Request('https://local.invalid/api/judge',{
      method:'POST',body:JSON.stringify(request)})},async body=>{
      calls++;assert.deepEqual(body.state.graph.edges[0],{id:'metrics',from:'s',to:'t',kind:'metrics',label:'RPS'});
      assert.ok(body.questions.edge.options.metrics.includes('RPS'));
      assert.ok(body.questions.edgeLabel.options['label-1'].includes('"new"'));
      return {answers:Object.fromEntries(Object.entries(answersFor(turn)).map(([k,{type,...v}])=>[k,v]))};
    });
    assert.equal(response.status,200);assert.equal(calls,1);
    const decision=await response.json();assert.equal((await planStep({working:graph,turn,answers:decision.answers,bundle,protocol})).outcome,'step');
    const forged=structuredClone(request);forged.state.offers.edgeLabels[0].label='not in request';
    assert.equal((await onRequestPost({available:true,request:new Request('https://local.invalid/api/judge',{method:'POST',body:JSON.stringify(forged)})},async()=>assert.fail('invalid input must not call provider'))).status,422);
  });
  test('replacement Undo/save/reload and saved inverse preserve identity and every unrelated record',async()=>{
    const r=await change(await seed(),'注釈を「new」に変更');assert.equal(r.result.outcome,'step');
    const changed=r.session.working;
    assert.deepEqual((await undo(r.session,{verifyDecisionLog:protocol.verifyDecisionLog})).working.records,r.before.records);
    let stored=r.before.log;
    const commit=({graph,expected})=>commitLog({graph,expected,key:'test',read:async()=>stored,write:async(_,v)=>{stored=v;},lock:async(_,f)=>f(),verifyDecisionLog:protocol.verifyDecisionLog});
    const saved=await apply(r.session,{commit});assert.equal(saved.result.status,'committed');
    const restored=await restoreLog({key:'test',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
    expectOnlyLabel(r.before.records,restored.graph.records,'new');
    const inverse=await revertStep({before:r.before.records,after:changed.records,working:restored.graph,protocol});assert.equal(inverse.outcome,'step');
    const reversed=await appendRevert(saved.session,{step:inverse.step,protocol});assert.equal(reversed.result.outcome,'step');
    assert.deepEqual(bag(reversed.session.working.records),bag(r.before.records));
    const undone=await undo(reversed.session,{verifyDecisionLog:protocol.verifyDecisionLog});
    expectOnlyLabel(r.before.records,undone.working.records,'new');
    const inverseSaved=await apply(reversed.session,{commit});assert.equal(inverseSaved.result.status,'committed');
    const final=await restoreLog({key:'test',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
    assert.deepEqual(bag(final.graph.records),bag(r.before.records));
  });
  test('saved annotation appears as a reversible history entry, not untyped operations',async()=>{
    const r=await change(await seed(),'注釈を「new」に変更');
    const history=await projectHistory(r.session.working,{verifyDecisionLog:protocol.verifyDecisionLog});
    assert.equal(revertable(history.entries.at(-1),history),true);
    assert.deepEqual(history.entries.at(-1).facts,[
      {change:'removed',kind:'relation',id:'metrics',from:'s',to:'t'},
      {change:'added',kind:'relation',id:'metrics',from:'s',to:'t'},
    ]);
  });
  test('a later annotation edit blocks the old saved inverse',async()=>{
    const first=await change(await seed(),'注釈を「first」に変更');const second=await change(first.session.working,'注釈を「second」に変更');
    const inverse=await revertStep({before:first.before.records,after:first.session.working.records,working:second.session.working,protocol});
    assert.equal(inverse.outcome,'refused');assert.equal(inverse.reason,'revert-altered');
    expectOnlyLabel(first.before.records,second.session.working.records,'second');
  });
  test('out-of-scope labels cannot alter kind, direction, endpoints or authority',async()=>{
    const r=await change(await seed(),'注釈を「control from t to s」に変更');assert.equal(r.result.outcome,'step');
    expectOnlyLabel(r.before.records,r.session.working.records,'control from t to s');
  });
}
