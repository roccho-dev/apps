import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requestFor, appendStep, planStep } from "../src/turn.mjs";
import { readBundle } from "../src/bundle.mjs";
import { canonical } from "./semantic-score.mjs";
import { auditReducedView } from "./reduced-view-audit.mjs";
import { partResourceView } from "../src/part-description.mjs";

const protocol=await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP,"packages/semantic-map/protocol/index.js")));
const fixtures=fs.readFileSync(new URL("./fixtures/normal-composition/editing.jsonl",import.meta.url),"utf8").trim().split("\n").map(JSON.parse);
const bag=records=>records.map(row=>JSON.stringify(canonical(row))).sort();
for(const fixture of fixtures)test("fixed editing expectation / "+fixture.id,async()=>{
 const {edit}=fixture;
 const start=await protocol.createDecisionLog(edit.initialRecords,"voice-graph");
 const pin=await protocol.createDecision(start.head,[{type:"PinRegions",items:edit.pins}],start.records);
 const working=(await protocol.appendDecision(start.log,pin.decision)).verified;
 const layout=protocol.layoutBoundsFor(working.records,{pattern:protocol.GRAPH_PATTERN});
 const frame=[0,0,3000,1800],bundle=readBundle(fixture.bundle);
 const {turn}=requestFor({working,utterance:fixture.text,bundle,typedEdges:bundle.goalSelection==="delta",layout,offeredFrame:frame,draft:[],focus:null,pending:null,recent:[]});
 const answers=Object.fromEntries(Object.keys(turn.slots).map(key=>[key,{type:"choice",choice:edit.response[key]??"none",confidence:1}]));
 const planned=await planStep({working,turn,answers,bundle,protocol,layout,visibleFrame:{head:working.head,frame}});
 assert.equal(planned.outcome,"step",JSON.stringify(planned));
 const after=(await appendStep({working,step:planned.step,protocol})).graph;
 assert.deepEqual(bag(after.records),bag(edit.expectedRecords),"fixed full record result, including geometry and typed relation identity");
 const envelope=await protocol.createEnvelope(after.log,null,{pattern:protocol.GRAPH_PATTERN,...partResourceView(after.records)});
 const reopened=await protocol.inspectEnvelope(envelope);
 const ui={head:reopened.base.head,records:reopened.base.records,view:reopened.envelope.view};
 const oracle={expected_added_regions:[],expected_added_edges:[]};
 const result=await auditReducedView({log:after.log,ui,initialRecords:edit.expectedRecords,oracle,protocol});
 assert.equal(result.status,"PASS");
 const wrong=structuredClone(edit.expectedRecords);
 wrong.find(r=>r.type==="region"&&r.parent!==null&&r.kind!=="group").label="Wrong identity";
 const invalid=await auditReducedView({log:after.log,ui,initialRecords:wrong,oracle,protocol});
 assert.equal(invalid.status,"RED");
 if(edit.response.action==="place-part") {
  const wrongPin=structuredClone(edit.expectedRecords);
  wrongPin.find(r=>r.type==="layout"&&r.regionId==="api").bounds[0]=24;
  assert.notDeepEqual(bag(after.records),bag(wrongPin),"the strict full-record comparison catches wrong pins even when semantics match");
 }
});
