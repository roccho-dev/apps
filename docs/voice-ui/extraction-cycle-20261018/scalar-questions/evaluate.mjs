// Fixed scalar-layout comparison. No oracle, credentials, retries or product adoption.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pathToFileURL,fileURLToPath} from "node:url";
import {classify} from "../diagnostic.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex"),json=p=>JSON.parse(fs.readFileSync(p));
const write=(p,v)=>{const fd=fs.openSync(p,"wx",0o600);try{fs.writeSync(fd,JSON.stringify(v,null,2)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function readPlan(file){
  const p=json(file);
  if(p.sealed_input){
    assert.equal(p.scope,"FRESH_FOUR_CASE_EXTRACTION_ONLY_NOT_ORDINARY_UI_EFFECT");
    assert.equal(path.basename(p.sealed_input.file),p.sealed_input.file);
    const bytes=fs.readFileSync(path.join(path.dirname(file),p.sealed_input.file));
    assert.equal(bytes.length,10917);
    assert.equal(hash(bytes),"dd66904853ae031c68e632c67d3bfc3a974141ce77fa4f83ecb406ad0a149874");
    assert.equal(p.sealed_input.sha256,hash(bytes));
    const sealed=JSON.parse(bytes);assert.equal(sealed.schema,"voice-ui.extraction-comparison-input/1");
    assert.deepEqual(p.cases.map(({id,request})=>({id,request})),sealed.cases);
    assert.deepEqual(p.schedule,sealed.schedule);
    p.cases.forEach((c,i)=>assert.equal(JSON.stringify(c.request),JSON.stringify(sealed.cases[i].request)));
    assert.equal(JSON.stringify(p.schedule),JSON.stringify(sealed.schedule));
    assert.ok(p.cases.every(c=>c.role===null));
  }else assert.equal(p.scope,"PUBLIC_FOUR_CASE_SCALAR_EXTRACTION_ONLY_NOT_FRESH_OR_ORDINARY_UI_EFFECT");
  return p;
}
export function jobs(plan){
  assert.equal(plan.schema,"voice-ui.scalar-layout-comparison/1");
  assert.deepEqual(plan.authority.phase_cap,{jev:0,typellm:8});
  assert.equal(plan.cases.length,4);assert.equal(plan.schedule.length,8);
  assert.equal(new Set(plan.schedule.map(s=>s.id)).size,8);
  return plan.schedule.map(s=>{
    assert.match(s.id,/^[A-Za-z0-9_-]{1,96}$/u);
    const c=plan.cases.find(c=>c.id===s.case);assert.ok(c);
    assert.ok(["current","candidate"].includes(s.arm));
    assert.equal(plan.schedule.filter(x=>x.case===s.case&&x.arm===s.arm).length,1);
    const generation=plan.arms[s.arm].generation;
    assert.equal(generation,s.arm==="current"?"dependent":"flat-scalars");
    return{...s,role:c.role??null,request:c.request,generation,
      route:plan.measurement.endpoint+"?generation="+generation};
  });
}
async function capture(worker,row){
  const sent=[],original=globalThis.fetch,info=console.info;
  try{
    console.info=()=>{};
    globalThis.fetch=async(input,init)=>{
      assert.equal(input,"https://api.typellm.ai/v1/generate");assert.equal(init.method,"POST");assert.equal(sent.length,0);
      sent.push(init.body);
      const result=row.generation==="flat-scalars"
        ?Object.fromEntries([1,2,3].flatMap(n=>[["required"+n+"_label",""],["required"+n+"_kind","none"],["required"+n+"_quantity","0"]]))
        :Object.fromEntries([1,2,3].map(n=>["required"+n,{label:"",kind:"none",quantity:"0"}]));
      return Response.json({status:"completed",result});
    };
    const response=await worker.fetch(new Request("http://127.0.0.1:18845"+row.route,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(row.request)}),
      {TYPELLM_API_KEY:"synthetic-wire-only"});
    assert.equal(response.status,200);assert.equal(sent.length,1);return sent[0];
  }finally{globalThis.fetch=original;console.info=info;}
}
async function wire(planFile,runtimeFile,oldRuntimeFile,out){
  const plan=readPlan(planFile),rt=json(runtimeFile),old=json(oldRuntimeFile),rows=jobs(plan);
  for(const item of[rt.worker,rt.provider,rt.typed_provider,old.worker,old.provider])assert.equal(hash(fs.readFileSync(item.path)),item.sha256);
  assert.equal(old.apps_sha,plan.measurement.frozen_df_body_bridge);
  const worker=(await import(pathToFileURL(rt.worker.path))).default;
  const oldWorker=(await import(pathToFileURL(old.worker.path))).default,captures={};
  for(const row of rows){
    const body=await capture(worker,row);
    captures[row.id]={route:row.route,request_body_utf8:JSON.stringify(row.request),type_body_utf8:body};
  }
  for(const row of rows.filter(r=>r.arm==="current")){
    const a=captures[row.id].type_body_utf8,legacy=await capture(oldWorker,row);assert.equal(a,legacy);
    const candidate=rows.find(r=>r.case===row.case&&r.arm==="candidate"),b=JSON.parse(captures[candidate.id].type_body_utf8),baseline=JSON.parse(a);
    assert.deepEqual({...b,questions:baseline.questions},baseline);
    assert.equal(b.model,"typellm-latest");assert.equal(b.options.temperature,0);assert.equal(b.timeout,30);
    const expected={};
    for(const[name,parent]of Object.entries(baseline.questions))for(const[field,schema]of Object.entries(parent.properties)){
      const deps=[...(parent.depends_on??[]).flatMap(key=>Object.keys(baseline.questions[key].properties).map(f=>key+"_"+f)),...(schema.depends_on??[]).map(key=>name+"_"+key)];
      expected[name+"_"+field]={...schema,instructions:parent.instructions+"\n"+schema.instructions,thinking:false};
      if(deps.length)expected[name+"_"+field].depends_on=deps;else delete expected[name+"_"+field].depends_on;
    }
    assert.deepEqual(b.questions,expected);assert.deepEqual(Object.keys(b.questions),Object.keys(expected));
  }
  const witness={status:"PASS",scope:"KEYLESS_TYPE_BODIES_NOT_LIVE_UPSTREAM_CAPTURE_OR_QUALITY",
    measurement_apps:rt.apps_sha,legacy_df_apps:old.apps_sha,plan_sha256:hash(fs.readFileSync(planFile)),
    worker_sha256:rt.worker.sha256,typed_provider_sha256:rt.typed_provider.sha256,
    same_worker_both_arms:true,full_definitions_both_arms:true,legacy_df_body_exact_cases:4,
    only_questions_differ:true,expanded_leaf_instructions_and_dag_exact:true,resolved_model_version:"UNOBSERVED",external_provider_sends:0,captures};
  write(out,witness);console.log(JSON.stringify({status:"PASS",live_slots:8,keyless_captures:12,external_provider_sends:0}));
}
async function run(planFile,runtimeFile,origin,out,wireFile){
  assert.match(origin,/^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{3,4}$/u);
  const plan=readPlan(planFile),rt=json(runtimeFile),witness=json(wireFile),rows=jobs(plan);
  assert.equal(witness.status,"PASS");assert.equal(witness.measurement_apps,rt.apps_sha);
  assert.equal(witness.plan_sha256,hash(fs.readFileSync(planFile)));
  assert.equal(hash(fs.readFileSync(rt.worker.path)),witness.worker_sha256);
  assert.equal(hash(fs.readFileSync(rt.typed_provider.path)),witness.typed_provider_sha256);
  const helper=rt.source_path+"/packages/voice-ui/tests/requirements-cycle-http.mjs";
  const {evaluationPost}=await import(pathToFileURL(helper));
  const {readRequiredSlots,readRequired}=await import(pathToFileURL(rt.source_path+"/packages/voice-ui/src/completion.mjs"));
  fs.mkdirSync(out,{mode:0o700});
  write(path.join(out,"identity.json"),{scope:plan.scope,measurement:rt,plan_sha256:witness.plan_sha256,
    wire_sha256:hash(fs.readFileSync(wireFile)),driver_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    classifier_sha256:hash(fs.readFileSync(fileURLToPath(new URL("../diagnostic.mjs",import.meta.url)))),
    http_helper_sha256:hash(fs.readFileSync(helper)),ordered_ids:rows.map(r=>r.id),sealed_input:plan.sealed_input??null,oracle_policy:"never read or forwarded"});
  const journal=fs.openSync(path.join(out,"events.jsonl"),"wx",0o600),summary=[];
  const record=e=>{fs.writeSync(journal,JSON.stringify({at:new Date().toISOString(),...e})+"\n");fs.fsyncSync(journal);};
  try{
    for(const[index,row]of rows.entries()){
      const body=JSON.stringify(row.request),fixed=witness.captures[row.id];
      assert.equal(body,fixed.request_body_utf8);assert.equal(row.route,fixed.route);
      const event={id:row.id,arm:row.arm,n:index+1,route:row.route,request:row.request};
      record({kind:"http-start",...event});let response=null;
      try{response=await evaluationPost({url:origin+row.route,event,record});}catch{/* Keep this failed slot. */}
      response??=event.response??null;
      const {status,required}=classify(response,event,readRequiredSlots,readRequired);
      write(path.join(out,row.id+".json"),{...row,request_body_utf8:body,response,event,status,required});
      summary.push({id:row.id,case:row.case,arm:row.arm,role:row.role,status});
    }
  }finally{
    fs.fsyncSync(journal);fs.closeSync(journal);
    write(path.join(out,"execution.json"),{planned:8,recorded:summary.length,summary,retries:0,additional_setup_provider_sends:0});
  }
  console.log(JSON.stringify({planned:8,recorded:summary.length,valid_contract:summary.filter(r=>r.status==="VALID_CONTRACT").length}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const[action,...args]=process.argv.slice(2);
  if(action==="wire"&&args.length===4)await wire(...args);
  else if(action==="run"&&args.length===5)await run(...args);
  else throw Error("expected wire PLAN RUNTIME OLD_RUNTIME OUT or run PLAN RUNTIME ORIGIN OUT WIRE");
}
