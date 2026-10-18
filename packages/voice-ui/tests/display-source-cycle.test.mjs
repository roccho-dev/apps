// Regrade finite stopped comparisons. No provider, product scorer or oracle in the caller.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {jobs as displayJobs} from "../../../docs/voice-ui/extraction-cycle-20261018/display-source/evaluate.mjs";
import {jobs as scalarJobs} from "../../../docs/voice-ui/extraction-cycle-20261018/scalar-questions/evaluate.mjs";
import {jobs as thinkingJobs} from "../../../docs/voice-ui/extraction-cycle-20261018/thinking-labels/evaluate.mjs";
import {gradeFullRequired} from "./requirements-cycle-score.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex");
for(const sample of[
  {name:"display-source B",folder:"display-source",tag:"B",phase:"display-source-public-B-20261018",jobs:displayJobs,
    head:"478cffec9f9dafecfa1f2d4877ae407c04ebbdff",correct:2,charged:112,groups:46,originals:28,
    runtime:"runtime-candidate-display-source-478cffec.json",wire:"display-source-478c.public.wire.json",
    prior:"../evidence/public-A/journal.jsonl",priorHash:"dc989eb807f6016dc248cd75e86f64674d12bdcb2e448277e297b806da43a1d8",
    stoppedHash:"d2bc04777cb515f886a243ca12e2c9229d8fc830dc1b0ee49b16448d5a585e16",
    zeroHash:"875a0dcff265c387adce4c09520d4e29c970003af5624c8b3168f7becb13b6fc"},
  {name:"scalar C",folder:"scalar-questions",tag:"C",phase:"scalar-public-C-20261018",jobs:scalarJobs,
    head:"a58e522672fcddf64bf7b71d8e18073b82eae20c",correct:3,charged:120,groups:47,originals:29,
    runtime:"runtime-candidate-display-source-a58e5226.json",wire:"scalar-a58e5226.public.wire.json",
    prior:"../display-source/evidence/public-B/journal.jsonl",priorHash:"ae0426cf625301e1b439729f09c1fe60d6fbd394ee0686bdd1350eb7fee3460d",
    stoppedHash:"c449f585e8e2cc6bf4a32db0411e889936adf79c9a2f337c9138e1dc3b9c2b35",
    zeroHash:"9ff46ad771c56cc631f7958e8a5e248400c0da7f9cff8af5afb1e801ccf775ec"},
  {name:"label thinking D public",folder:"thinking-labels",tag:"D",phase:"thinking-public-D-20261018",jobs:thinkingJobs,
    head:"b6696c1f579851429cf0cc58a49b20c9ff663475",correct:{current:3,candidate:4},gains:1,gate:true,charged:128,groups:48,originals:29,
    runtime:"runtime-candidate-display-source-b6696c1f.json",wire:"thinking-b6696c1f.public.wire.json",
    prior:"../scalar-questions/evidence/public-C/journal.jsonl",priorHash:"9adb368eb453aac1c0a45601eff223d3db64eadff210e6a292d8998e6bda6d43",
    stoppedHash:"0a541977550b07df7045fa65123e1d5aa7062c8802ef4c7144536fcb9d51fad5",
    zeroHash:"53140e20651a55b65e1b404f003443d8e89031ad1e8f869add288ff7c756aff2"},
  {name:"label thinking D fresh",folder:"thinking-labels",tag:"D",evidence:"fresh-D",fresh:true,phase:"thinking-fresh-D-20261018",jobs:thinkingJobs,
    head:"b6696c1f579851429cf0cc58a49b20c9ff663475",correct:4,gains:0,gate:false,charged:136,groups:49,originals:29,
    runtime:"runtime-candidate-display-source-b6696c1f.json",wire:"thinking-b6696c1f.fresh.wire.json",
    prior:"evidence/public-D/journal.jsonl",priorHash:"3eead593ac154f199a00006aeaacc6928fc12e49f423f7ea8c5d8faf916358cd",
    stoppedHash:"6f39ad2fbdb536abde5bfffc439d890d618f6e5807688c67e3f4976f4f1715be",
    zeroHash:"0e5deaffb9d661d4f1aa196c5edca1053a033dd2b925cb4b436bb828cdd51634"}
]){
  const root=fileURLToPath(new URL("../../../docs/voice-ui/extraction-cycle-20261018/"+sample.folder+"/",import.meta.url));
  const read=p=>fs.readFileSync(root+p),json=p=>JSON.parse(read(p)),lines=p=>read(p).toString().trim().split("\n").map(JSON.parse),b="evidence/"+(sample.evidence??"public-"+sample.tag)+"/";
  const planFile=sample.fresh?"fresh.input.json":"public.input.json",oracleFile=sample.fresh?"fresh.oracle.json":"public.oracle.json",
    resultFile=sample.fresh?"fresh.result.json":"result.json",wireFile=sample.fresh?"fresh.wire.json":"public.wire.json";
  test(sample.name+" preserves every original contract, semantic failure and paired comparison",()=>{
    const plan=json(planFile),oracle=json(oracleFile),result=json(resultFile),identity=json(b+"raw/identity.json"),wire=json(wireFile);
    assert.equal(result.measurement_apps,sample.head);assert.equal(identity.measurement.apps_sha,sample.head);
    assert.equal(identity.plan_sha256,hash(read(planFile)));assert.equal(identity.wire_sha256,hash(read(wireFile)));assert.equal(identity.driver_sha256,hash(read("evaluate.mjs")));
    assert.equal(sample.tag==="D"?wire.legacy_scalar_body_exact_cases:wire.legacy_df_body_exact_cases,4);assert.equal(wire.only_questions_differ,true);assert.equal(wire.external_provider_sends,0);
    if(sample.tag==="D")assert.equal(wire.only_three_label_thinking_settings_differ,true);
    if(sample.tag==="C")assert.equal(wire.expanded_leaf_instructions_and_dag_exact,true);
    const audit=json(b+"independent-stopped.json");assert.equal(hash(read(b+"independent-stopped.json")),sample.stoppedHash);assert.equal(audit.original_files.length,sample.originals);
    for(const f of audit.original_files){
      const name=f.path.split("/").at(-1),relative=f.path.includes(sample.phase+".raw/")?b+"raw/"+name
        :name.startsWith(sample.phase+".")?b+name.slice(sample.phase.length+1)
        :name===sample.runtime?b+"runtime.json":name===sample.wire?wireFile:sample.aliases?.[name]??name;
      assert.equal(read(relative).length,f.bytes);assert.equal(hash(read(relative)),f.sha256);
    }
    assert.deepEqual(fs.readdirSync(root+b+"raw").sort(),[...plan.schedule.map(s=>s.id+".json"),"identity.json","events.jsonl","execution.json"].sort());
    const stages=read(b+"stdout.log").toString().split("\n").filter(l=>l.startsWith("{")).map(JSON.parse),events=lines(b+"raw/events.jsonl");
    assert.equal(stages.length,8);assert.equal(events.length,16);
    const rows=sample.jobs(plan).map((r,i)=>{
      const truth=sample.fresh?oracle.cases.find(c=>c.id===r.case):{required:oracle.required[r.case]},
        c=json(b+"raw/"+r.id+".json"),stock=r.request.state.parts,g=gradeFullRequired(c.response,truth,stock);
      for(const k of["id","case","arm","role","request","route"])assert.deepEqual(c[k],r[k]);
      assert.equal(c.request_body_utf8,JSON.stringify(r.request));assert.equal(c.request_body_utf8,wire.captures[r.id].request_body_utf8);
      assert.equal(events[i*2].kind,"http-start");assert.equal(events[i*2+1].kind,"http-end");assert.equal(events[i*2+1].id,r.id);assert.deepEqual(events[i*2+1].response,c.response);
      const valid=c.event.status===200&&g.contract_valid,stage=stages[i];assert.equal(stage.valid,valid);assert.equal(stage.generation,r.generation);
      assert.equal(stage.request_id,c.response.request_id);assert.deepEqual(stage.proposal,{slots:c.response.slots,required:c.response.required});
      if(r.arm==="candidate"&&sample.tag==="B"){
        assert.deepEqual(Object.keys(stage.source_slots).sort(),["required1","required2","required3"]);
        for(const[k,v]of Object.entries(stage.source_slots)){
          assert.deepEqual(Object.keys(v).sort(),["kind","label","label_source","quantity"]);assert.deepEqual({label:v.label,kind:v.kind,quantity:v.quantity},c.response.slots[k]);
          if(v.label_source==="utterance")assert.ok(v.label.length&&r.request.state.utterance.includes(v.label));
          else if(v.label_source==="definition")assert.ok(stock.some(p=>p.label===v.label&&p.kind===v.kind));
          else assert.deepEqual(v,{kind:"none",label_source:"none",label:"",quantity:"0"});
        }
      }else if(["flat-scalars","thinking-labels"].includes(r.generation)){
        const names=["required1","required2","required3"],fields=["label","kind","quantity"];
        assert.deepEqual(Object.keys(stage.scalar_answers).sort(),names.flatMap(n=>fields.map(f=>n+"_"+f)).sort());
        for(const name of names)for(const field of fields)assert.equal(stage.scalar_answers[name+"_"+field],c.response.slots[name][field]);
      }else{assert.equal(Object.hasOwn(stage,"source_slots"),false);assert.equal(Object.hasOwn(stage,"scalar_answers"),false);}
      if(sample.tag==="D"){
        const observed=Object.hasOwn(stage,"provider_usage");
        assert.deepEqual(Object.keys(stage).sort(),["kind","request_id","stage","valid","generation","proposal","scalar_answers",...(observed?["provider_usage"]:[])].sort());
        if(observed){assert.equal(r.generation,"thinking-labels");assert.deepEqual(Object.keys(stage.provider_usage).sort(),["input_tokens","thinking_tokens"]);
          for(const v of Object.values(stage.provider_usage))assert.ok(Number.isSafeInteger(v)&&v>=0);}
      }
      assert.equal(c.status,"VALID_CONTRACT");assert.equal(valid,true);
      return{id:r.id,case:r.case,arm:r.arm,role:sample.fresh?{"explicit-name":"explicit","standard-name":"standard",NEW0:"new0"}[truth.stratum]:r.role,
        status:c.status,contract_valid:valid,exact:c.event.status===200&&g.exact,minimal:c.event.status===200&&g.minimal,required:c.response.required};
    });
    assert.deepEqual(result.rows,rows);
    for(const arm of["current","candidate"]){
      const cells=rows.filter(r=>r.arm===arm);
      assert.deepEqual(result.counts[arm],{planned:4,valid:4,exact:cells.filter(r=>r.exact&&r.minimal).length,semantic_wrong:cells.filter(r=>!r.exact).length,invalid_or_unknown:0});
      assert.equal(result.counts[arm].exact,typeof sample.correct==="number"?sample.correct:sample.correct[arm]);
    }
    const pairs=plan.cases.map(c=>{const a=rows.find(r=>r.case===c.id&&r.arm==="current"),z=rows.find(r=>r.case===c.id&&r.arm==="candidate"),valid_both=a.contract_valid&&z.contract_valid;return{case:c.id,role:a.role,valid_both,gain:valid_both&&!a.exact&&z.exact,regression:valid_both&&a.exact&&!z.exact,tie:valid_both&&a.exact===z.exact,excluded_contract_or_transport:!valid_both};});
    assert.deepEqual(result.pairs,pairs);assert.equal(pairs.filter(p=>p.gain).length,sample.gains??0);assert.equal(pairs.filter(p=>p.regression).length,0);
    assert.equal(result[sample.fresh?"fresh_gate":"public_gate"],sample.gate??false);assert.equal(result.quality,sample.fresh||sample.gate?"FINITE_CRITERIA_PASS":"UNMET");
    assert.equal(result.finite_effect,sample.fresh?"NO_EFFECT_IN_REGISTERED_FRESH_EXTRACTION_PAIRS":sample.gate?"EFFECT_OBSERVED_IN_REGISTERED_PUBLIC_EXTRACTION_PAIRS":"NO_EFFECT_IN_REGISTERED_PUBLIC_EXTRACTION_PAIRS");
    assert.equal(result.fresh_quality,sample.fresh?"FINITE_CRITERIA_PASS":"UNPROVEN");assert.equal(result.product_effect,"UNPROVEN");
    if(sample.fresh){
      const original=read("heldout.inputs.json"),sealed=JSON.parse(original),release=json(b+"oracle-release.json"),stop=json(b+"independent-stop.json");
      assert.equal(original.length,10917);assert.equal(hash(original),"dd66904853ae031c68e632c67d3bfc3a974141ce77fa4f83ecb406ad0a149874");
      assert.equal(hash(read(oracleFile)),"a5cf1a90b928922d11fc1d1c8c69c6e54c98adbc194f71d011550040200db556");
      assert.deepEqual(plan.cases.map(({id,request})=>({id,request})),sealed.cases);assert.deepEqual(plan.schedule,sealed.schedule);assert.ok(plan.cases.every(c=>c.role===null));
      assert.equal(identity.scope,"FRESH_FOUR_CASE_EXTRACTION_ONLY_NOT_ORDINARY_UI_EFFECT");assert.equal(result.improvement_gate,"UNMET");assert.equal(result.oracle_released_after_physical_stop,true);
      assert.equal(release.stop.sha256,hash(read(b+"independent-stop.json")));assert.equal(release.stop.journal_sha256,stop.journal_sha256);assert.ok(Date.parse(release.released_at)>Date.parse(stop.at));
    }else assert.equal(sample.tag==="D"?result.heldout_opened_at_public_terminal:result.heldout_opened,false);
    assert.equal(result.ordinary_ui_adopted,false);
    const execution=json(b+"raw/execution.json");assert.equal(execution.planned,8);assert.equal(execution.recorded,8);assert.equal(execution.retries,0);
  });
  test(sample.name+" stops all owned groups and retains its cumulative send ledger",()=>{
    const config=json(b+"config.json"),process=json(b+"process.json"),stop=json(b+"orchestration.json"),terminal=json(b+"root-terminal.json"),ledger=read(b+"journal.jsonl"),old=read(sample.prior);
    assert.deepEqual(ledger.subarray(0,old.length),old);assert.equal(hash(old),sample.priorHash);assert.equal(process.config_sha256,hash(read(b+"config.json")));assert.deepEqual(config.allowances,{jev:0,typellm:8});
    assert.equal(stop.execution.exit,0);assert.equal(stop.stop.status,"STOPPED_RECONCILED");assert.deepEqual(stop.stop.result.sent,{jev:0,typellm:8});
    const charged={jev:0,typellm:0},pending=new Map();
    for(const e of lines(b+"journal.jsonl")){
      if(e.kind==="reserve")charged[e.provider]+=e.charge;
      else if(e.kind==="phase-reserve"){assert.equal(pending.has(e.id),false);pending.set(e.id,e.allowances);}
      else if(e.kind==="phase-reconcile"){const a=pending.get(e.id);assert.ok(a);for(const p of["jev","typellm"]){assert.ok(Number.isInteger(e.sent[p])&&e.sent[p]>=0&&e.sent[p]<=a[p]);charged[p]+=e.sent[p];}assert.equal(e.stopped_group_empty,true);pending.delete(e.id);}
      else assert.equal(e.kind,"outcome");
    }
    assert.deepEqual(charged,{jev:847,typellm:sample.charged});assert.equal(pending.size,0);assert.equal(terminal.journal_sha256,hash(ledger));assert.deepEqual(terminal.charged,charged);assert.equal(terminal.outstanding,0);assert.equal(terminal.owned_pgids,sample.groups);assert.deepEqual(terminal.remaining_members,[]);
    assert.deepEqual(read(b+"stderr.log").toString().split("\n").filter(l=>l.startsWith("provider-send:")),Array.from({length:8},(_,i)=>"provider-send:typellm:"+(i+1)));
    assert.equal(hash(read(b+"independent-zero.json")),sample.zeroHash);
  });
}
