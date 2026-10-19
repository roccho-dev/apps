import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditReducedView } from './reduced-view-audit.mjs';
import { drawGraph } from '../src/render.mjs';

const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')).href);
const description = '{"schema":"voice-ui.part-description/1","key":"sql-one","purpose":"database fixture","symbol":{"href":"/assets/sql.svg","alt":"SQL fixture","provenanceRef":"fixture:sql/1"}}';
const initialRecords = [
  {type:'meta',schema:'semantic-map-state/1',root:'root',title:'fixed reduce expectation'},
  {type:'region',id:'root',parent:null,label:'World',kind:'boundary',summary:'',bounds:[0,0,1000,700]},
  {type:'region',id:'cloud',parent:'root',label:'Cloud',kind:'group',summary:'',bounds:[0,0,800,500]},
];
const oracle = {expected_added_regions:[{label:'SQL',kind:'data',parent:'fixture:cloud',summary:description}],expected_added_edges:[]};
const start=await protocol.createDecisionLog(initialRecords,'voice-graph');
const choice=await protocol.createDecision(start.head,[{type:'AddRegion',regionId:'sql',parentId:'cloud',label:'SQL',kind:'data',summary:description,bounds:[24,72,180,92]}],start.records);
const after=(await protocol.appendDecision(start.log,choice.decision)).verified;
const document = {defaultView:{getComputedStyle:()=>({position:'relative'})},createElement:()=>({style:{},remove:()=>{}})};
const mount={children:[],append:()=>{},replaceChildren:()=>{}};
let ui;
await drawGraph({graph:after,frame:null,mount,protocol,document,renderProjection:async({input})=>{
 const inspected=await protocol.inspectEnvelope(input.envelope);
 ui={head:inspected.base.head,records:inspected.base.records,view:inspected.envelope.view};
}});
const args={log:after.log,ui,initialRecords:start.records,oracle,protocol};
test('separately declared structure matches the real reducer and app view input, not a pixel verdict',async()=>{
 const result=await auditReducedView(args);assert.equal(result.status,'PASS');
 assert.equal(result.expected_images,1);assert.equal(result.pixels,'SEPARATE_REQUIRED_GATE');
});
for (const [name,mutate] of [
 ['invalid-view-field',x=>{x.ui.view.unexpected=true;}],
 ['invalid-composition-schema',x=>{x.ui.view.resourceComposition.schema='unknown/1';}],
 ['stale-ui-head',x=>{x.ui.head=start.head;}],
 ['stale-ui-records',x=>{x.ui.records=start.records;}],
 ['wrong-kind',x=>{x.oracle.expected_added_regions[0].kind='step';}],
 ['wrong-parent',x=>{x.oracle.expected_added_regions[0].parent='fixture:root';}],
 ['missing-required-node',x=>{x.oracle.expected_added_regions.push({label:'missing',kind:'step',parent:'fixture:cloud'});}],
 ['wrong-summary',x=>{x.oracle.expected_added_regions[0].summary=description.replace('sql-one','sql-other');}],
 ['missing-view',x=>{delete x.ui.view.resourceComposition;}],
 ['wrong-asset',x=>{x.ui.view.resourceComposition.resources[0].source.href='/assets/wrong.svg';}],
 ['wrong-provenance',x=>{x.ui.view.resourceComposition.resources[0].provenanceRef='wrong';}],
 ['wrong-alt',x=>{x.ui.view.resourceComposition.placements[0].view.alt='wrong';}],
 ['hidden-image',x=>{x.ui.view.resourceComposition.placements[0].view.opacity=0;}],
 ['wrong-target',x=>{x.ui.view.resourceComposition.placements[0].targetRef='node:cloud';}],
 ['wrong-slot',x=>{x.ui.view.resourceComposition.placements[0].slot='other';}],
 ['duplicate-placement',x=>{x.ui.view.resourceComposition.placements.push({...x.ui.view.resourceComposition.placements[0],id:'duplicate'});}],
 ['missing-resource',x=>{x.ui.view.resourceComposition.resources=[];}],
 ['duplicate-resource',x=>{x.ui.view.resourceComposition.resources.push(x.ui.view.resourceComposition.resources[0]);}],
 ['unreferenced-resource',x=>{x.ui.view.resourceComposition.resources.push({...x.ui.view.resourceComposition.resources[0],id:'unused'});}],
])test('does not promote '+name,async()=>{
 const {protocol:unused,...data}=args;const next=structuredClone(data);mutate(next);
 assert.equal((await auditReducedView({...next,protocol})).status,'RED');
});
test('changed JSONL bytes fail integrity checking instead of borrowing the UI state',async()=>{
 await assert.rejects(()=>auditReducedView({...args,log:after.log.replace('database fixture','changed fixture')}));
});
test('Undo expectation and view both return to the original empty added set',async()=>{
 const envelope=await protocol.createEnvelope(start.log,null,{pattern:protocol.GRAPH_PATTERN});
 const result=await auditReducedView({log:start.log,ui:{head:start.head,records:start.records,view:envelope.view},initialRecords:start.records,
  oracle:{expected_added_regions:[],expected_added_edges:[]},protocol});
 assert.equal(result.status,'PASS');
 assert.equal((await auditReducedView({log:start.log,ui,initialRecords:start.records,oracle:{expected_added_regions:[],expected_added_edges:[]},protocol})).status,'RED');
});
