import test from "node:test";
import assert from "node:assert/strict";
import {flatRequiredRequest,inventoryQuestion,readFlatRequiredSlots,requiredRequest} from "../src/completion.mjs";
import {onRequirements} from "../functions/api/parts.mjs";
const state={utterance:"作業区に工程を二つ追加して、表示名は検算窓にしてください。",head:"fixture",
  regions:[{id:"root",label:"World",kind:"boundary",parent:null},{id:"g",label:"作業区",kind:"group",parent:"root"}],
  edges:[],parts:[{key:"step",purpose:"ordinary task",label:"工程",kind:"step"}]};
const raw=()=>Object.fromEntries([1,2,3].flatMap(n=>[["required"+n+"_label",n===1?"検算窓":""],["required"+n+"_kind",n===1?"step":"none"],["required"+n+"_quantity",n===1?"2":"0"]]));
test("flattened questions keep the full context, leaf meaning and expanded dependency DAG",()=>{
  const context=inventoryQuestion(state).state,old=requiredRequest(context),flat=flatRequiredRequest(context);
  assert.equal(flat.context,old.context);assert.equal(Object.keys(flat.questions).length,9);
  for(const [name,parent]of Object.entries(old.questions))for(const [field,schema]of Object.entries(parent.properties)){
    const q=flat.questions[name+"_"+field],deps=[...(parent.depends_on??[]).flatMap(p=>Object.keys(old.questions[p].properties).map(f=>p+"_"+f)),...(schema.depends_on??[]).map(f=>name+"_"+f)];
    assert.equal(q.type,"string");assert.equal(q.instructions,parent.instructions+"\n"+schema.instructions);
    assert.deepEqual(q.enum,schema.enum);assert.deepEqual(q.depends_on??[],deps);
    assert.equal(Object.hasOwn(q,"properties"),false);assert.equal(q.instructions.includes("検算窓"),false);
  }
  assert.deepEqual(readFlatRequiredSlots(raw()).required,[{label:"検算窓",kind:"step",quantity:2}]);
  for(const mutate of[x=>x.extra="unapproved",x=>delete x.required3_kind,x=>x.required1_quantity=2,x=>x.required1_kind="unsupported",
    x=>{x.required2_label=x.required1_label;x.required2_kind="step";x.required2_quantity="2";}]){
    const value=raw();mutate(value);assert.equal(readFlatRequiredSlots(value),null);
  }
});
test("flat F makes one Type call and maps all nine validated values without name repair",async()=>{
  const log=[],before=console.info;console.info=s=>log.push(JSON.parse(s));let calls=0;
  const invoke=(mode,value)=>onRequirements({request:new Request("http://fixture.invalid",{method:"POST",body:JSON.stringify({kind:"voice-ui.goal.inventory.v1",state})}),mode,method:"adaptive-v3",available:true,generation:"flat-scalars"},
    {judge:()=>assert.fail("no Jev in F"),generate:async()=>{calls++;return{result:value};}});
  try{
    const response=await invoke("requirements",raw()),body=await response.json();
    assert.equal(response.status,200);assert.deepEqual(body.required,[{label:"検算窓",kind:"step",quantity:2}]);assert.deepEqual(log[0].scalar_answers,raw());
    const wrong=raw();wrong.required1_label="工程";
    assert.deepEqual((await(await invoke("requirements",wrong)).json()).required,[{label:"工程",kind:"step",quantity:2}]); // semantic errors remain evidence
    assert.equal((await invoke("requirements",{...raw(),extra:"unapproved-provider-value"})).status,502);
    assert.equal(JSON.stringify(log).includes("unapproved-provider-value"),false);
    assert.equal((await invoke("check",raw())).status,422);assert.equal(calls,3);
  }finally{console.info=before;}
});
