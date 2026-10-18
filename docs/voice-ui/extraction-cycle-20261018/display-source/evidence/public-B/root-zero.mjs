import fs from"node:fs";import assert from"node:assert/strict";import{createHash}from"node:crypto";
const b="/work/repos/voice-ui-typellm-20261016",phase="display-source-public-B-20261018",hash=x=>createHash("sha256").update(x).digest("hex");
const cb=fs.readFileSync(b+"/"+phase+".config.json"),config=JSON.parse(cb),pb=fs.readFileSync(b+"/"+phase+".process.json"),r=JSON.parse(pb);
const rb=fs.readFileSync(config.runtime_file),rt=JSON.parse(rb),wb=fs.readFileSync(config.wire_file),w=JSON.parse(wb);
assert.equal(r.config_sha256,hash(cb));assert.equal(r.phase_id,phase);assert.deepEqual(r.heads,config.heads);assert.deepEqual(r.allowances,{jev:0,typellm:8});
const stat=fs.readFileSync("/proc/"+r.pid+"/stat","utf8"),f=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
assert.equal(f[19],r.start_ticks);assert.equal(+f[2],r.pid);assert.notEqual(f[0],"Z");
assert.equal(/^Uid:\s+(\d+)/m.exec(fs.readFileSync("/proc/"+r.pid+"/status","utf8"))[1],"1000");
assert.equal(fs.readFileSync(r.stderr,"utf8").split("\n").filter(l=>l.startsWith("provider-send:")).length,0);
for(const item of[rt.dev_program,rt.worker,rt.provider,rt.typed_provider,rt.manifest,rt.semantic_map.protocol])assert.equal(hash(fs.readFileSync(item.path)),item.sha256);
assert.deepEqual(JSON.parse(fs.readFileSync(rt.manifest.path)).sources,rt.manifest_sources);assert.equal(rt.apps_sha,config.heads.apps);
assert.equal(w.status,"PASS");assert.equal(w.measurement_apps,rt.apps_sha);assert.equal(w.worker_sha256,rt.worker.sha256);
assert.equal(w.typed_provider_sha256,rt.typed_provider.sha256);assert.equal(w.plan_sha256,hash(fs.readFileSync(config.public_plan)));
assert.equal(w.legacy_df_body_exact_cases,4);assert.equal(w.only_questions_differ,true);assert.equal(w.external_provider_sends,0);
const response=await fetch("http://127.0.0.1:18845/",{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);
assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(rt.artifact_root+"/site/index.html"));
const proof={status:"PASS",scope:"ROOT_ZERO_SEND_PREFLIGHT_NOT_INDEPENDENT_GO",at:new Date().toISOString(),phase,pid:r.pid,start_ticks:r.start_ticks,pgid:+f[2],uid:1000,
config_sha256:hash(cb),process_sha256:hash(pb),runtime_sha256:hash(rb),wire_sha256:hash(wb),launcher_sha256:hash(fs.readFileSync(config.program)),
driver_sha256:hash(fs.readFileSync(config.driver)),provider_sends:{jev:0,typellm:0},served_index_equals_completed_artifact:true};
fs.writeFileSync(b+"/"+phase+".root-zero.json",JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify(proof));
