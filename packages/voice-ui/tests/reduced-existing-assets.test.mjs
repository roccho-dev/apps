import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {auditReducedView} from './reduced-view-audit.mjs';
import {drawGraph} from '../src/render.mjs';
import {createSession} from '../src/session.mjs';
import {commitLog, restoreLog} from '../src/log.mjs';
const protocol=await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')).href);
// Independent fixed description, not built by the product encoder.
const description='{"schema":"voice-ui.part-description/1","key":"sql-one","purpose":"retained database","symbol":{"href":"/assets/sql.svg","alt":"SQL fixture","provenanceRef":"fixture:sql/1"}}';
const records=[{type:'meta',schema:'semantic-map-state/1',root:'root',title:'existing resource correspondence'},
 {type:'region',id:'root',parent:null,label:'World',kind:'boundary',summary:'',bounds:[0,0,2000,1000]},
 {type:'region',id:'cloud',parent:'root',label:'Cloud',kind:'group',summary:'',bounds:[0,0,1800,800]},
 {type:'region',id:'retained',parent:'cloud',label:'SQL',kind:'data',summary:description,bounds:[24,72,180,92]}];
const start=await protocol.createDecisionLog(records,'voice-graph');
const decision=await protocol.createDecision(start.head,[{type:'AddRegion',regionId:'new-sql',parentId:'cloud',label:'SQL',kind:'data',summary:description,bounds:[240,72,180,92]}],start.records);
const after=(await protocol.appendDecision(start.log,decision.decision)).verified;
const unchanged={expected_added_regions:[],expected_added_edges:[]};
const added={expected_added_regions:[{label:'SQL',kind:'data',parent:'fixture:cloud',summary:description}],expected_added_edges:[]};
const viewOf=async graph=>{
 let result; const mount={children:[],append:()=>{},replaceChildren:()=>{}};
 const document={defaultView:{getComputedStyle:()=>({position:'relative'})},createElement:()=>({style:{},remove:()=>{}})};
 await drawGraph({graph,frame:null,mount,document,protocol,renderProjection:async({input})=>{
  const seen=await protocol.inspectEnvelope(input.envelope);
  result={head:seen.base.head,records:seen.base.records,view:seen.envelope.view};
 }});return result;
};
const argsFor=async(graph=start,oracle=unchanged)=>({log:graph.log,ui:await viewOf(graph),initialRecords:start.records,oracle,protocol});

test('B full reduce retains an existing symbol even when no new parts are requested',async()=>{
 const result=await auditReducedView(await argsFor());assert.equal(result.status,'PASS');assert.equal(result.expected_images,1);
});
test('B the same catalogue key may appear in an existing and a newly added instance',async()=>{
 const result=await auditReducedView(await argsFor(after,added));assert.equal(result.status,'PASS');assert.equal(result.expected_images,2);
});
for(const [id,mutate] of [
 ['lost-existing-placement',x=>{x.ui.view.resourceComposition.placements.shift();}],
 ['borrowed-source',x=>{x.ui.view.resourceComposition.resources[0].source.href='/assets/other.svg';}],
 ['stale-existing-record',x=>{x.ui.records.find(r=>r.id==='retained').summary='';}],
 ['duplicate-existing-placement',x=>{x.ui.view.resourceComposition.placements.push({...x.ui.view.resourceComposition.placements[0],id:'dup'});}],
 ['wrong-independent-initial-state',x=>{x.initialRecords.find(r=>r.id==='retained').label='Changed';}],
])test('B reject '+id+' without replacing actual view from expected',async()=>{
 const a=await argsFor(after,added);const {protocol:unused,...data}=a;const x=structuredClone(data);mutate(x);
 assert.equal((await auditReducedView({...x,protocol})).status,'RED');
});
test('B exact replay of saved log keeps old and new symbols; stale reload fails',async()=>{
 const beforeSession=createSession({accepted:start,stored:start.log});
 // Use the existing verified decision as one draft change; persistence is exercised independently of model choice.
 let stored=start.log;
 const result=await commitLog({graph:after,expected:start.log,key:'local-test',read:async()=>stored,write:async(_k,s)=>{stored=s;},lock:async(_k,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(result.status,'committed');
 const restored=await restoreLog({key:'local-test',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(restored.status,'restored');assert.deepEqual(restored.graph.records,after.records);
 assert.equal((await auditReducedView(await argsFor(restored.graph,added))).status,'PASS');
 assert.equal((await auditReducedView(await argsFor(start,added))).status,'RED');
 assert.equal(beforeSession.stored,start.log);
});
test('B unrelated ordinary JSON summaries are not converted into image expectations',async()=>{
 const ordinary=await protocol.createDecisionLog(records.map(r=>r.id==='retained'?{...r,summary:'{"note":"ordinary text"}'}:r),'voice-graph');
 const a=await argsFor(ordinary,unchanged);a.initialRecords=ordinary.records;
 assert.equal((await auditReducedView(a)).status,'PASS');
});
test('B adding an ordinary node must not erase the expectation of an existing symbol',async()=>{
 const d=await protocol.createDecision(start.head,[{type:'AddRegion',regionId:'api',parentId:'cloud',label:'API',kind:'step',summary:'',bounds:[450,72,180,92]}],start.records);
 const g=(await protocol.appendDecision(start.log,d.decision)).verified;
 const oracle={expected_added_regions:[{label:'API',kind:'step',parent:'fixture:cloud'}],expected_added_edges:[]};
 assert.equal((await auditReducedView(await argsFor(g,oracle))).status,'PASS');
});
