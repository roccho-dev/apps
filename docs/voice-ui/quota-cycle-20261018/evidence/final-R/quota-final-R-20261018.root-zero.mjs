import fs from "node:fs";import assert from "node:assert/strict";import{createHash}from"node:crypto";
const base="/work/repos/voice-ui-typellm-20261016",phase="quota-final-R-20261018",hash=b=>createHash("sha256").update(b).digest("hex");
const configBytes=fs.readFileSync(base+"/"+phase+".config.json"),config=JSON.parse(configBytes),processBytes=fs.readFileSync(base+"/"+phase+".process.json"),receipt=JSON.parse(processBytes);
const runtimeBytes=fs.readFileSync(base+"/runtime-candidate-quota-admission-59ded27.json"),rt=JSON.parse(runtimeBytes);
assert.equal(hash(configBytes),"b72b6db819fbc08fc83f0010bd473e9c4d338637e189339d3d2f2033922721d9");assert.equal(hash(runtimeBytes),"aea2d4a780256fca602e07546d37e3e74844a5e1a1e885d5d02092eae9ae2fb6");
assert.equal(receipt.config_sha256,hash(configBytes));assert.equal(receipt.phase_id,phase);assert.deepEqual(receipt.heads,config.heads);assert.deepEqual(receipt.allowances,{"jev":32,"typellm":0});
const stat=fs.readFileSync("/proc/"+receipt.pid+"/stat","utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
assert.equal(fields[19],receipt.start_ticks);assert.equal(+fields[2],receipt.pid);assert.notEqual(fields[0],"Z");
const uid=/^Uid:\s+(\d+)/m.exec(fs.readFileSync("/proc/"+receipt.pid+"/status","utf8"));assert.equal(uid[1],"1000");
const stderrBytes=fs.readFileSync(receipt.stderr),sends=stderrBytes.toString("utf8").split("\n").filter(l=>l.startsWith("provider-send:"));assert.equal(sends.length,0);
assert.equal(hash(fs.readFileSync(config.program)),"2bda2882f0d8e489198241dc987d2cd28f989dd7fefad1a1640e152ac913a6c5");
assert.equal(hash(fs.readFileSync(rt.dev_program.path)),rt.dev_program.sha256);
for(const item of [rt.worker,rt.provider])assert.equal(hash(fs.readFileSync(item.path)),item.sha256);
assert.equal(hash(fs.readFileSync(rt.manifest.path)),rt.manifest.sha256);assert.equal(hash(fs.readFileSync(rt.semantic_map.protocol.path)),rt.semantic_map.protocol.sha256);
assert.equal(rt.apps_sha,config.heads.apps);assert.equal(rt.manifest_sources.apps,config.heads.apps);
const response=await fetch("http://127.0.0.1:18845/",{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);
assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(rt.artifact_root+"/site/index.html"));
const source={schema:"voice-ui.poc.runtime/1",origin:"http://127.0.0.1:18845",heads:config.heads,
 sealed_inputs_sha256:"b2aea0ad175e93786b5f566b020204ac7c2f3734b867cb9b53741794a2a401ec",
 worker_entry:{path:rt.worker.path,sha256:rt.worker.sha256},provider_entry:{path:rt.provider.path,sha256:rt.provider.sha256},
 semantic_map:{root:rt.semantic_map.root,protocol_sha256:rt.semantic_map.protocol.sha256},
 launcher:{program:config.program,dev_program:rt.dev_program.path,pid:receipt.pid,start_ticks:receipt.start_ticks,phase_id:phase,allowances:config.allowances},
 artifact:{root:rt.artifact_root,manifest_sha256:rt.manifest.sha256},audit_sha256:hash(runtimeBytes),preflight_counters:{jev:0,typellm:0}};
const write=(p,value)=>{const fd=fs.openSync(p,"wx",0o600);try{fs.writeSync(fd,JSON.stringify(value,null,2)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
write(base+"/"+phase+".runtime.json",source);
const proof={status:"PASS",scope:"ROOT_ZERO_SEND_PREFLIGHT_ONLY_NOT_INDEPENDENT_GO",at:new Date().toISOString(),phase,pid:receipt.pid,start_ticks:receipt.start_ticks,pgid:+fields[2],uid:1000,
 config_sha256:hash(configBytes),process_sha256:hash(processBytes),runtime_sha256:hash(runtimeBytes),identity_sha256:hash(fs.readFileSync(base+"/"+phase+".runtime.json")),
 provider_sends:{jev:0,typellm:0},served_index_equals_completed_artifact:true};
write(base+"/"+phase+".root-zero.json",proof);console.log(JSON.stringify(proof));

