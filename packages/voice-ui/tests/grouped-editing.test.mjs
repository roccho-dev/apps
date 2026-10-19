import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requestFor, planStep, appendStep } from "../src/turn.mjs";
import { partResourceView } from "../src/part-description.mjs";
import { createSession, propose, undo, apply } from "../src/session.mjs";
import { commitLog, restoreLog } from "../src/log.mjs";

const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")));
const view = { pattern: protocol.GRAPH_PATTERN };
const bundle = { version:"editing-fixture", parts:[], diagrams:[] };
const symbol = '{"schema":"voice-ui.part-description/1","key":"database-instance","purpose":"retained data service","symbol":{"href":"/assets/sql.svg","alt":"SQL fixture","provenanceRef":"fixture:sql/1"}}';
const frame = [0,0,3000,1800];
const region = (id,parent,label,kind,bounds,summary="") => ({type:"region",id,parent,label,kind,bounds,summary});
const recordsFor = ({nested=false, flat=false, blocked=false, otherGroup=false, top=false, escape=false, unpinned=false}={}) => [
 {type:"meta",schema:"semantic-map-state/1",root:"root",title:"fixed editing expectation"},
 region("root",null,"World","boundary",frame),
 ...flat?[]:[region("cloud","root","Cloud","group",[0,0,2400,1200])],
 ...nested?[region("private","cloud","Private","group",[24,96,1600,800])]:[],
 region("api",flat?"root":nested?"private":"cloud","API","step",nested?[48,288,180,92]:[24,288,180,92]),
 region("db",flat?"root":nested?"private":"cloud","DB","data",
  nested?[500,288,180,92]:top?[500,160,180,92]:escape?[2250,288,138,92]:[500,288,180,92],symbol),
 region("unrelated",flat?"root":nested?"private":"cloud","Unrelated","decision",
  nested?[48,600,180,92]:blocked?[704,288,180,92]:[24,600,180,92]),
 ...otherGroup?[region("other","cloud","Other","group",[700,250,700,400])]:[],
 {type:"relation",id:"requests",from:"api",to:"db",kind:"reads",label:"query"},
 {type:"relation",id:"unrelated-edge",from:"unrelated",to:"db",kind:"reports",label:"preserve"}
];
async function seed(options={}) {
 const initial=await protocol.createDecisionLog(recordsFor(options),"voice-graph");
 const items=initial.records.filter(r=>r.type==="region"&&r.parent!==null
  &&(!options.unpinned||r.kind!=="group")).map(r=>({regionId:r.id,bounds:r.bounds}));
 const p=await protocol.createDecision(initial.head,[{type:"PinRegions",items}],initial.records);
 return (await protocol.appendDecision(initial.log,p.decision)).verified;
}
const layoutFor=g=>protocol.layoutBoundsFor(g.records,view);
const prepared=(graph,picks={},visibleFrame=frame)=> {
 const layout=layoutFor(graph);
 const {turn,request}=requestFor({working:graph,utterance:"APIをDBの右へ。他は変更しない。",bundle,layout,
  offeredFrame:frame,draft:[],focus:null,pending:null,recent:[]});
 const choices={action:"place-part",move:"api",anchor:"db",direction:"right",...picks};
 const answers=Object.fromEntries(Object.keys(turn.slots).map(key=>[key,{type:"choice",choice:choices[key]??"none",confidence:1}]));
 return {working:graph,turn,answers,layout,bundle,protocol,visibleFrame:{head:graph.head,frame:visibleFrame}};
};
const stableWithoutMover = rows => rows.filter(r=>!(r.type==="layout"&&r.regionId==="api"));
async function assertMove(options, direction, expected) {
 const before=await seed(options), input=prepared(before,{direction}), planned=await planStep(input);
 assert.equal(planned.outcome,"step",JSON.stringify(planned));
 assert.deepEqual(planned.step.decision.operations,[{type:"PinRegions",items:[{regionId:"api",bounds:expected}]}]);
 const after=(await appendStep({working:before,step:planned.step,protocol})).graph;
 assert.deepEqual(stableWithoutMover(after.records),stableWithoutMover(before.records));
 assert.deepEqual(layoutFor(after).bounds.api,expected);
 for(const r of before.records.filter(r=>r.type==="region"&&r.id!=="api"&&r.parent!==null))
  assert.deepEqual(layoutFor(after).bounds[r.id],input.layout.bounds[r.id],"other part positions remain unchanged");
 assert.deepEqual(partResourceView(after.records),partResourceView(before.records));
 const restored=await protocol.verifyDecisionLog(after.log);
 assert.deepEqual(restored.records,after.records);
 assert.equal((await planStep(prepared(after,{direction}))).reason,"already-there");
}
for(const nested of [false,true]) for(const [direction,expected] of [
 ["right",[704,288,180,92]],["left",[296,288,180,92]],
 ["above",[500,172,180,92]],["below",[500,404,180,92]]
]) test(`B placement inside ${nested?"two groups":"one group"} / ${direction}`,()=>assertMove({nested},direction,expected));

test("legacy root-level placement still uses the same single pin",()=>assertMove({flat:true},"right",[704,288,180,92]));
for(const [name,options,direction] of [
 ["sibling collision",{blocked:true},"right"],
 ["unrelated nested group collision",{otherGroup:true},"right"],
 ["parent escape",{escape:true},"right"],
 ["parent heading",{top:true},"above"]
]) test("B refuses "+name,async()=>{
 const g=await seed(options), before=g.log, p=await planStep(prepared(g,{direction}));
 assert.equal(p.outcome,"no-change");assert.equal(p.reason,"spot-taken");assert.equal(g.log,before);
});
test("mover cannot enter a different group by placing beside its child",async()=>{
 const records=recordsFor();
 records.splice(-2,0,region("elsewhere","root","Elsewhere","group",[2500,0,450,900]),
  region("foreign","elsewhere","Foreign","step",[2520,200,180,92]));
 const g=await protocol.createDecisionLog(records,"voice-graph");
 const p=await protocol.createDecision(g.head,[{type:"PinRegions",items:records.filter(r=>r.type==="region"&&r.id!=="root").map(r=>({regionId:r.id,bounds:r.bounds}))}],g.records);
 const pinned=(await protocol.appendDecision(g.log,p.decision)).verified;
 const result=await planStep(prepared(pinned,{anchor:"foreign",direction:"below"}));
 assert.equal(result.outcome,"no-change");assert.equal(result.reason,"spot-taken");
});
for(const [name,mutate,reason] of [
 ["stale-turn",x=>{x.turn={...x.turn,head:"other"};},"stale"],
 ["stale-frame",x=>{x.visibleFrame={...x.visibleFrame,head:"other"};},"frame-behind"],
 ["off-pane",x=>{x.visibleFrame={...x.visibleFrame,frame:[0,0,10,10]};},"spot-off-pane"],
 ["weak",x=>{x.answers.move.confidence=.49;},"placement-missing-move"],
 ["invalid-answer",x=>{x.answers.move.choice="not-a-part";},"answer-invalid"]
]) test("B existing guard / "+name,async()=>{
 const g=await seed(), input=prepared(g);mutate(input);const result=await planStep(input);
 assert.notEqual(result.outcome,"step");assert.equal(result.reason,reason);
});

test("B an edit persists with original identities, symbols and typed relations; Undo and stale writes remain guarded",async()=>{
 const g=await seed({nested:true});
 const session=createSession({accepted:g,stored:g.log});
 const changed=await propose(session,{...prepared(g),repair:null,input:{source:"typed",text:"APIをDBの右へ。他は変更しない。"}});
 assert.equal(changed.result.outcome,"step",JSON.stringify(changed.result));
 assert.equal(changed.session.stored,g.log);
 assert.deepEqual((await undo(changed.session,{verifyDecisionLog:protocol.verifyDecisionLog})).working.records,g.records);
 let stored=g.log;
 const saved=await apply(changed.session,{commit:({graph,expected})=>commitLog({graph,expected,key:"fixture",
  read:async()=>stored,write:async(_key,log)=>{stored=log;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
 assert.equal(saved.result.status,"committed");
 const restored=await restoreLog({key:"fixture",read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(restored.status,"restored");assert.deepEqual(restored.graph.records,changed.session.working.records);
 assert.deepEqual(stableWithoutMover(restored.graph.records),stableWithoutMover(g.records));
 assert.deepEqual(layoutFor(restored.graph).bounds.api,[704,288,180,92]);
});
test("B reverse/remove refer to the chosen edge and preserve every other record, kind, label and symbol",async()=>{
 const g=await seed();
 for(const action of ["reverse-edge","remove-edge"]) {
  const p=await planStep(prepared(g,{action,edge:"requests"}));
  assert.equal(p.outcome,"step");
  const after=(await appendStep({working:g,step:p.step,protocol})).graph;
  assert.deepEqual(after.records.filter(r=>r.type!=="relation"),g.records.filter(r=>r.type!=="relation"));
  assert.deepEqual(after.records.find(r=>r.id==="unrelated-edge"),g.records.find(r=>r.id==="unrelated-edge"));
  const changed=after.records.filter(r=>r.type==="relation"&&r.id!=="unrelated-edge");
  assert.deepEqual(changed.map(({from,to,kind,label})=>({from,to,kind,label})),action==="remove-edge"?[]:[{from:"db",to:"api",kind:"reads",label:"query"}]);
 }
});
