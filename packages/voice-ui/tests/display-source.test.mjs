import test from "node:test";
import assert from "node:assert/strict";
import { displaySourceRequest, inventoryQuestion, readDisplaySourceSlots } from "../src/completion.mjs";
import { onRequirements } from "../functions/api/parts.mjs";
const state = { utterance:"作業区に工程を二つ置き、両方の表示名を検算窓にしてください。", head:"fixture",
  regions:[{id:"root",label:"World",kind:"boundary",parent:null},{id:"container",label:"作業区",kind:"group",parent:"root"}],
  edges:[], parts:[{key:"step",purpose:"ordinary task",label:"工程",kind:"step"},{key:"decision",purpose:"branch",label:"判断",kind:"decision"}] };
const empty = () => ({kind:"none",label_source:"none",label:"",quantity:"0"});
const source = row => ({required1:row??empty(),required2:empty(),required3:empty()});
const named = () => source({kind:"step",label_source:"utterance",label:"検算窓",quantity:"2"});
test("display-source maps exact quoted or definition names to the same full NEW triples", () => {
  assert.deepEqual(readDisplaySourceSlots(named(),state).required,[{label:"検算窓",kind:"step",quantity:2}]);
  const standard = source({kind:"decision",label_source:"definition",label:"判断",quantity:"1"});
  assert.deepEqual(readDisplaySourceSlots(standard,state).required,[{label:"判断",kind:"decision",quantity:1}]);
  assert.deepEqual(readDisplaySourceSlots(source(),state).required,[]);
  const semanticError=named();semanticError.required1.kind="data";
  assert.notEqual(readDisplaySourceSlots(semanticError,state),null); // Provenance is not the semantic oracle.
  for (const mutate of [x=>x.extra=true,x=>x.required1.label="創作名",x=>x.required1.label_source="guess",
    x=>x.required1.kind="unsupported",x=>x.required1.label_source="definition",x=>x.required1.extra="unapproved",
    x=>x.required2={...x.required1},x=>x.required1.quantity="0",x=>x.required2.label="padding"]) {
    const x=named();mutate(x);assert.equal(readDisplaySourceSlots(x,state),null);
  }
});
test("display-source retains full definitions and dependent ordinals, without embedding an expected name", () => {
  const context=inventoryQuestion(state).state,request=displaySourceRequest(context);
  assert.deepEqual(JSON.parse(request.context).part_definitions,context.parts.map(({label,kind,purposes})=>({label,kind,purposes})));
  for(const [index,q]of Object.values(request.questions).entries()){
    assert.deepEqual(Object.keys(q.properties),["kind","label_source","label","quantity"]);
    assert.deepEqual(q.properties.label_source.enum,["utterance","definition","none"]);
    assert.deepEqual(q.properties.label.depends_on,["kind","label_source"]);
    if(index)assert.deepEqual(q.depends_on,Object.keys(request.questions).slice(0,index));
    assert.equal(JSON.stringify(q).includes("検算窓"),false);
  }
});
test("extraction opt-in invokes Type once, logs only validated provenance, and cannot change ordinary checks", async () => {
  const log=[],previous=console.info;console.info=x=>log.push(JSON.parse(x));
  let sent=0;
  const invoke=(mode,raw)=>onRequirements({request:new Request("http://fixture.invalid",{method:"POST",
    body:JSON.stringify({kind:"voice-ui.goal.inventory.v1",state})}),mode,method:"adaptive-v3",
    available:true,generation:"display-source"},{judge:()=>assert.fail("no Jev in F"),
    generate:async()=>{sent++;return{result:raw};}});
  try{
    const response=await invoke("requirements",named()),body=await response.json();
    assert.equal(response.status,200);assert.deepEqual(Object.keys(body).sort(),["request_id","required","schema","slots"]);
    assert.deepEqual(body.required,[{label:"検算窓",kind:"step",quantity:2}]);
    assert.equal(Object.hasOwn(body.slots.required1,"label_source"),false);
    assert.deepEqual(log[0].source_slots,named());
    const bad=named();bad.required1.extra="unapproved-provider-value";
    assert.equal((await invoke("requirements",bad)).status,502);
    assert.equal(JSON.stringify(log).includes("unapproved-provider-value"),false);
    assert.equal((await invoke("check",named())).status,422);assert.equal(sent,2);
  }finally{console.info=previous;}
});
