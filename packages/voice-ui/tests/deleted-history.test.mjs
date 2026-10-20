import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { savedHistoryPorts } from './saved-history-ports.mjs';

// Finite source/real reducer/history-handler checks; no browser, model or
// durable external storage. Expected records are separate static JSONL.
const source = process.env.DELETED_HISTORY_SOURCE_ROOT ?? new URL('..', import.meta.url).pathname;
const load = file => import(pathToFileURL(path.join(source, file)));
const { revertStep, revertable, appendStep } = await load('src/turn.mjs');
const { createSession, apply, undo } = await load('src/session.mjs');
const { commitLog, restoreLog, projectHistory } = await load('src/log.mjs');
const { renderHistory } = await load('src/render.mjs');
const protocol = await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL));
const ports = await savedHistoryPorts({ source, protocol });
const { append, domPort, controls, view, clickInverse } = ports;
const read = name => fs.readFileSync(new URL('./fixtures/deleted-history/' + name + '.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const inputs = read('inputs'), expected = read('expected');
const canon = x => Array.isArray(x) ? x.map(canon) : x !== null && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])])) : x;
const bag = rows => rows.map(row => JSON.stringify(canon(row))).sort();
const emit = row => { if (process.env.DELETED_HISTORY_EVIDENCE) fs.appendFileSync(process.env.DELETED_HISTORY_EVIDENCE, JSON.stringify(row) + '\n'); };
const sourceHashes = Object.fromEntries(['src/turn.mjs','src/log.mjs','src/session.mjs','src/render.mjs','web/app.mjs'].map(name =>
  [name, createHash('sha256').update(fs.readFileSync(path.join(source,name))).digest('hex')]));
emit({kind:'source-identity',source,sourceHashes,live_api:'NOT_RUN',browser:'NOT_RUN'});
globalThis.fetch = async () => { throw new Error('no network in deleted-history tests'); };

async function historyButton(session) {
  const history = await projectHistory(session.accepted, {verifyDecisionLog:protocol.verifyDecisionLog});
  const panel = domPort();
  renderHistory(panel, { projection:history, revertable:history.entries.map(e => revertable(e,history)) });
  controls(panel,session);
  return {history,button:panel.querySelectorAll('button[data-revert]').at(-1)};
}
async function deleted(input = inputs[0]) {
  const gold = expected.find(row => row.id === input.id);
  const data = await ports.created(input.goal,gold.goalExpected);
  assert.deepEqual(bag(data.after.records),bag(gold.restoredRecords),'fixed expected before deletion');
  const {button} = await historyButton(data.session); assert.equal(button.disabled,false);
  const cancelled = await clickInverse(data.session,button); assert.equal(cancelled.refusal,null);
  const saved = await apply(cancelled.session,{commit:data.commit}); assert.equal(saved.result.status,'committed');
  assert.deepEqual(bag(saved.session.working.records),bag(gold.deletedRecords));
  return {...data,gold,beforeDelete:data.after,afterDelete:saved.session.working,session:saved.session};
}
async function invert(data,working = data.afterDelete) {
  return revertStep({before:data.beforeDelete.records,after:data.afterDelete.records,working,protocol});
}
async function acceptedRestore(data,working = data.afterDelete) {
  const result = await invert(data,working);
  emit({kind:'restore-result',source,fixture:data.gold.id,outcome:result.outcome,reason:result.reason??null,detail:result.detail??null});
  assert.equal(result.outcome,'step');
  const next = await appendStep({working,step:result.step,protocol}); assert.equal(next.outcome,'step');
  return next.graph;
}

for(const input of inputs.filter(row => row.goal)) {
  test('restore the saved removal without re-generating its candidate / '+input.id,async()=>{
    const data=await deleted(input),graph=await acceptedRestore(data);
    assert.deepEqual(bag(graph.records),bag(data.gold.restoredRecords));
    assert.ok(graph.log.startsWith(data.afterDelete.log));
    assert.equal(graph.records.find(r=>r.id==='part-1').summary,data.gold.storedSummary);
    const previousLayout=protocol.layoutBoundsFor(data.beforeDelete.records,{pattern:protocol.GRAPH_PATTERN});
    const restoredLayout=protocol.layoutBoundsFor(graph.records,{pattern:protocol.GRAPH_PATTERN});
    assert.deepEqual(restoredLayout,previousLayout,'restored layout is calculated by the unchanged provider');
  });
  test('actual history handler restores a saved cancellation; Undo, Apply and Reload / '+input.id,async()=>{
    const data=await deleted(input),stages=[];
    const capture=async(stage,graph,wanted,stored)=>{
      const reread=await protocol.verifyDecisionLog(graph.log),disk=await protocol.verifyDecisionLog(stored);
      assert.equal(reread.head,graph.head);assert.deepEqual(bag(reread.records),bag(wanted));
      const envelope=await view(graph);
      stages.push({stage,log:graph.log,head:graph.head,stored,storedHead:disk.head,records:reread.records,expected:wanted,envelope});
    };
    await capture('saved-addition',data.beforeDelete,data.gold.restoredRecords,data.beforeDelete.log);
    await capture('saved-removal',data.afterDelete,data.gold.deletedRecords,data.stored());
    const {button,history}=await historyButton(data.session);
    emit({kind:'restore-button',source,fixture:input.id,enabled:!button.disabled,facts:history.entries.at(-1).facts});
    assert.equal(button.disabled,false,'a saved pure removal has a guarded inverse');
    const restored=await clickInverse(data.session,button);assert.equal(restored.refusal,null);
    await capture('restore-draft',restored.session.working,data.gold.restoredRecords,data.stored());
    assert.equal(data.stored(),data.afterDelete.log,'restoration remains uncommitted until Apply');
    const undone=await undo(restored.session,{verifyDecisionLog:protocol.verifyDecisionLog});
    await capture('undo-restoration',undone.working,data.gold.deletedRecords,data.stored());
    const again=await clickInverse(undone,button);assert.equal(again.refusal,null);
    await capture('restore-again',again.session.working,data.gold.restoredRecords,data.stored());
    const applied=await apply(again.session,{commit:data.commit});assert.equal(applied.result.status,'committed');
    await capture('applied-restoration',applied.session.working,data.gold.restoredRecords,data.stored());
    assert.ok(data.stored().startsWith(data.afterDelete.log),'never roll history back to an old saved prefix');
    const loaded=await restoreLog({key:'fixed-history',read:async()=>data.stored(),verifyDecisionLog:protocol.verifyDecisionLog});
    assert.equal(loaded.status,'restored');
    await capture('reloaded-restoration',loaded.graph,data.gold.restoredRecords,data.stored());
    const loadedSession=createSession({accepted:loaded.graph,stored:data.stored()});
    const inverseButton=(await historyButton(loadedSession)).button;assert.equal(inverseButton.disabled,false);
    const inverse=await clickInverse(loadedSession,inverseButton);assert.equal(inverse.refusal,null);
    await capture('cancel-restoration',inverse.session.working,data.gold.deletedRecords,data.stored());
    emit({kind:'deleted-history-lifecycle',source,fixture:input.id,stages,live_api:'NOT_RUN',browser:'NOT_RUN',port:'actual handler / DOM double / envelope / memory store'});
  });
}

async function rawDeletion(input) {
  const gold=expected.find(row=>row.id===input.id);
  const initial=await protocol.createDecisionLog(input.initialRecords,'voice-graph');
  const beforeDelete=await append(initial,[{type:'PinRegions',items:input.pins}]);
  assert.deepEqual(bag(beforeDelete.records),bag(gold.restoredRecords));
  const afterDelete=await append(beforeDelete,input.deletion);
  assert.deepEqual(bag(afterDelete.records),bag(gold.deletedRecords));
  let stored=afterDelete.log;
  const commit=({graph,expected})=>commitLog({graph,expected,key:'raw-history',read:async()=>stored,
    write:async(_k,v)=>{stored=v;},lock:async(_k,run)=>run(),verifyDecisionLog:protocol.verifyDecisionLog});
  return {gold,beforeDelete,afterDelete,session:createSession({accepted:afterDelete,stored}),commit,stored:()=>stored};
}
for(const input of inputs.filter(row=>!row.goal)) {
  test('fixed saved deletion restores every node, relation, pin and metadata / '+input.id,async()=>{
    const data=await rawDeletion(input),graph=await acceptedRestore(data);
    assert.deepEqual(bag(graph.records),bag(data.gold.restoredRecords));
    assert.deepEqual(protocol.layoutBoundsFor(graph.records,{pattern:protocol.GRAPH_PATTERN}),
      protocol.layoutBoundsFor(data.beforeDelete.records,{pattern:protocol.GRAPH_PATTERN}));
    await view(graph);
  });
  test('history-button restore from a fixed deleted subtree/record / '+input.id,async()=>{
    const data=await rawDeletion(input),{button}=await historyButton(data.session),stages=[];
    assert.equal(button.disabled,false);
    const capture=async(stage,graph,wanted)=>{
      const read=await protocol.verifyDecisionLog(graph.log);assert.deepEqual(bag(read.records),bag(wanted));
      stages.push({stage,head:graph.head,log:graph.log,stored:data.stored(),records:read.records,expected:wanted,envelope:await view(graph)});
    };
    await capture('fixed-deleted',data.afterDelete,data.gold.deletedRecords);
    const first=await clickInverse(data.session,button);assert.equal(first.refusal,null);
    await capture('restore-draft',first.session.working,data.gold.restoredRecords);
    const undone=await undo(first.session,{verifyDecisionLog:protocol.verifyDecisionLog});
    await capture('undo-restoration',undone.working,data.gold.deletedRecords);
    const again=await clickInverse(undone,button);assert.equal(again.refusal,null);
    const saved=await apply(again.session,{commit:data.commit});assert.equal(saved.result.status,'committed');
    await capture('applied',saved.session.working,data.gold.restoredRecords);
    const restored=await restoreLog({key:'raw-history',read:async()=>data.stored(),verifyDecisionLog:protocol.verifyDecisionLog});
    assert.equal(restored.status,'restored');await capture('reloaded',restored.graph,data.gold.restoredRecords);
    emit({kind:'fixed-deletion-lifecycle',source,fixture:input.id,stages,scope:'verified seeded history; not normal Send deletion',browser:'NOT_RUN'});
  });
}

if (!process.env.DELETED_HISTORY_BASELINE_ONLY) {
  async function refuses(data,ops,reason){
    const working=await append(data.afterDelete,ops),frozen=working.log;
    const result=await invert(data,working);
    assert.equal(result.outcome,'refused');if(reason)assert.equal(result.reason,reason);
    assert.equal(result.step,undefined);assert.equal(working.log,frozen);await view(working);
    emit({kind:'protected-later-edit',operations:ops,reason:result.reason,head:working.head,log:working.log});
  }
  for(const [id,operation] of [
    ['reused part ID',{type:'AddRegion',regionId:'part-1',parentId:'container',label:'New object',kind:'step',summary:'keep later',bounds:[400,200,140,64]}],
    ['reused as relation ID',{type:'ConnectRegions',relationId:'part-1',from:'keeper',to:'container',kind:'flow',label:'later'}],
  ])test(id+' refuses restoration rather than overwriting later work',async()=>{await refuses(await deleted(),[operation],'revert-reused');});
  for(const [id,operation] of [
    ['parent renamed',{type:'RenameRegion',regionId:'container',label:'Changed parent'}],
    ['parent moved',{type:'PinRegions',items:[{regionId:'container',bounds:[100,0,2000,900]}]}],
    ['parent unpinned',{type:'UnpinRegions',regionIds:['container']}],
  ])test(id+' is not assumed to be the old restoration context',async()=>{await refuses(await deleted(),[operation]);});
  test('missing parent refuses without publishing a partial restored object',async()=>{
    const data=await deleted();await refuses(data,[{type:'UnpinRegions',regionIds:['container','keeper']},
      {type:'RemoveSelection',regionIds:['container'],relationIds:[]}]);
  });
  test('a new occupant of the original space is not covered by restoration',async()=>{
    await refuses(await deleted(),[{type:'AddRegion',regionId:'new',parentId:'container',label:'Keep new',kind:'data',summary:'later',bounds:[12,72,180,92]},
      {type:'PinRegions',items:[{regionId:'new',bounds:[12,72,180,92]}]}],'revert-restore-no-room');
  });
  for(const [id,operation] of [
    ['unrelated sibling name',{type:'RenameRegion',regionId:'keeper',label:'Keep corrected name'}],
    ['unrelated sibling position',{type:'PinRegions',items:[{regionId:'keeper',bounds:[1100,450,180,92]}]}],
    ['unrelated later part',{type:'AddRegion',regionId:'later',parentId:'container',label:'Later',kind:'step',summary:'keep',bounds:[600,300,140,64]}],
  ])test(id+' remains unchanged while restoring the removed item',async()=>{
    const data=await deleted(),working=await append(data.afterDelete,[operation]),graph=await acceptedRestore(data,working);
    for(const row of working.records)assert.ok(graph.records.some(x=>JSON.stringify(canon(x))===JSON.stringify(canon(row))));
    assert.equal(graph.records.find(r=>r.id==='part-1').summary,data.gold.storedSummary);
  });
  for(const [id,extra] of [
    ['same-entry name change',{type:'RenameRegion',regionId:'keeper',label:'Changed in deletion'}],
    ['same-entry parent resize',{type:'PinRegions',items:[{regionId:'container',bounds:[0,0,2200,1000]}]}],
  ])test(id+' is not silently lost by restoring only the deleted item',async()=>{
    const data=await deleted();const mixed=await append(data.beforeDelete,[...data.afterDelete.decisions.at(-1).operations,extra]);
    assert.equal((await revertStep({before:data.beforeDelete.records,after:mixed.records,working:mixed,protocol})).outcome,'refused');
  });
  test('reapplying a successful restoration is refused and creates no second object',async()=>{
    const data=await deleted(),graph=await acceptedRestore(data),old=graph.log;
    assert.equal((await invert(data,graph)).outcome,'refused');assert.equal(graph.log,old);
  });
  test('a stale planned inverse cannot append to a subsequently changed graph',async()=>{
    const data=await deleted(),planned=await invert(data);assert.equal(planned.outcome,'step');
    const later=await append(data.afterDelete,[{type:'RenameRegion',regionId:'keeper',label:'newer'}]);
    assert.equal((await appendStep({working:later,step:planned.step,protocol})).reason,'stale');
  });
  test('restored state never overrides a newer saved log during Apply',async()=>{
    const data=await deleted();const button=(await historyButton(data.session)).button;
    const next=await clickInverse(data.session,button);assert.equal(next.refusal,null);
    const other=await append(data.afterDelete,[{type:'RenameRegion',regionId:'keeper',label:'other tab'}]);let stored=other.log,writes=0;
    const result=await apply(next.session,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,
      write:async(_k,v)=>{stored=v;writes++;},lock:async(_k,run)=>run(),verifyDecisionLog:protocol.verifyDecisionLog})});
    assert.equal(result.result.status,'conflict');assert.equal(writes,0);assert.equal(stored,other.log);
  });
}

if (!process.env.DELETED_HISTORY_BASELINE_ONLY) {
  for(const [name,ops] of [
    ['external endpoint change',[{type:'RenameRegion',regionId:'keeper',label:'different target'}]],
    ['restored edge ID reuse',[{type:'AddRegion',regionId:'request',parentId:'container',label:'new occupant of id',kind:'step',summary:'keep',bounds:[1400,1000,180,92]}]],
    ['restored child ID reuse',[{type:'AddRegion',regionId:'task-b',parentId:'container',label:'new child',kind:'data',summary:'keep',bounds:[1400,1000,180,92]}]],
  ])test('subtree restoration protects '+name,async()=>{
    const data=await rawDeletion(inputs.find(row=>row.id==='nested-subtree'));
    const current=await append(data.afterDelete,ops),text=current.log;
    const result=await invert(data,current);assert.equal(result.outcome,'refused');assert.equal(result.step,undefined);assert.equal(current.log,text);
  });
  test('unsupported record fields are rejected whole, not silently discarded',async()=>{
    const input=structuredClone(inputs.find(row=>row.id==='metadata-leaf'));
    const record=input.initialRecords.find(row=>row.id==='original');delete record.href;record.mount={src:'/reference/map'};
    const initial=await protocol.createDecisionLog(input.initialRecords,'voice-graph');
    const before=await append(initial,[{type:'PinRegions',items:input.pins}]);
    const removed=await append(before,input.deletion);
    const result=await revertStep({before:before.records,after:removed.records,working:removed,protocol});
    assert.equal(result.outcome,'refused');assert.equal(result.reason,'provider-rejected');assert.equal(result.step,undefined);
  });
  test('the existing 32-operation ceiling refuses an oversized restoration atomically',async()=>{
    const raw=inputs.find(row=>row.id==='metadata-leaf');
    const common=raw.initialRecords.filter(row=>row.id!=='original');
    const children=Array.from({length:33},(_,i)=>({type:'region',id:'large-'+i,parent:'container',label:'Part '+i,kind:'data',summary:'',bounds:[30+200*(i%6),200+100*Math.floor(i/6),140,64]}));
    const before=await protocol.createDecisionLog([...common,...children],'voice-graph');
    const removed=await append(before,[{type:'RemoveSelection',regionIds:children.map(r=>r.id),relationIds:[]}]);
    const result=await revertStep({before:before.records,after:removed.records,working:removed,protocol});
    assert.equal(result.outcome,'refused');assert.equal(result.reason,'provider-rejected');assert.match(result.detail,/operations exceed 32/);assert.equal(result.step,undefined);
  });
}
