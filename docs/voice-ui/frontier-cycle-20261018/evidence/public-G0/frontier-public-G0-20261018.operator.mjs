// Run-local single phase operator. Invoke only after independent exact-runtime/zero-send admission.
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const base="/work/repos/voice-ui-typellm-20261016",node="/nix/store/785jidgnryzj566s25s3rb262d4g5znb-nodejs-24.14.1/bin/node";
const phase="frontier-public-G0-20261018",configFile=base+"/"+phase+".config.json";
const rt=JSON.parse(fs.readFileSync(base+"/runtime-candidate-frontier-admission-2cc4890b.json"));
const config=JSON.parse(fs.readFileSync(configFile)), processReceipt=JSON.parse(fs.readFileSync(base+"/"+phase+".process.json"));
const raw=base+"/"+phase+".raw",identity=base+"/"+phase+".runtime.json";
const hash=b=>createHash("sha256").update(b).digest("hex");
const input=rt.source_path+"/docs/voice-ui/frontier-cycle-20261018/preregistered/frontier-cycle-public-G0-10.inputs.json";
const write=(file,value)=>{const fd=fs.openSync(file,"wx",0o600);try{fs.writeSync(fd,typeof value==="string"||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
let stdout=null,err=null,execution={exit:null,error:null},stop={status:"NOT_ATTEMPTED"},began=new Date().toISOString();
try{
  assert.equal(rt.apps_sha,config.heads.apps);assert.equal(config.input_sha256,"560b9126d385c9cfa1a48431fc6c78355b9f811e92b7a2f9736684a2c7f91c0f");
  const info=fs.readFileSync("/proc/"+processReceipt.pid+"/stat","utf8"),fields=info.slice(info.lastIndexOf(")")+2).trim().split(/\s+/);
  assert.equal(fields[19],processReceipt.start_ticks);assert.equal(+fields[2],processReceipt.pid);assert.notEqual(fields[0],"Z");
  const stderr=fs.readFileSync(processReceipt.stderr,"utf8");assert.equal(stderr.split("\n").filter(l=>l.startsWith("provider-send:")).length,0);
  const id=JSON.parse(fs.readFileSync(identity));assert.equal(id.launcher.pid,processReceipt.pid);assert.equal(id.launcher.start_ticks,processReceipt.start_ticks);
  assert.equal(id.heads.apps,rt.apps_sha);assert.equal(id.sealed_inputs_sha256,"e95bfeeb45edf03e6fd43c0fbc7ca839f3584878092e6e5d18cf181a25af9eae");
  assert.equal(hash(fs.readFileSync(input)),config.input_sha256);
  stdout=fs.openSync(base+"/"+phase+".driver.stdout.log","wx",0o600);err=fs.openSync(base+"/"+phase+".driver.stderr.log","wx",0o600);
  execFileSync(rt.acceptance_runtime+"/bin/voice-ui-acceptance-node",[rt.source_path+"/packages/voice-ui/tests/frontier-cycle-eval.mjs",
    "--inputs",input,"--origin","http://127.0.0.1:18845","--semantic-map",rt.semantic_map.root,
    "--identities",identity,"--out",raw,"--artifact",rt.artifact_root],
    {cwd:base,env:{...process.env,PATH:node.slice(0,node.lastIndexOf("/"))+":/bin"},stdio:["ignore",stdout,err],timeout:600000,maxBuffer:8000000});
  execution.exit=0;
}catch(e){execution={exit:e.status??null,error:e.code??"driver_failed",signal:e.signal??null};}
finally{
  for(const fd of [stdout,err])if(fd!==null){fs.fsyncSync(fd);fs.closeSync(fd);}
  try{const text=execFileSync(node,[base+"/run-manager-v2.mjs","stop",configFile],{encoding:"utf8",timeout:25000,maxBuffer:2000000});
    stop={status:"STOPPED_RECONCILED",result:JSON.parse(text)};}
  catch(e){stop={status:"STOP_FAILED",exit:e.status??null,code:e.code??"stop_failed",stderr_tail:String(e.stderr??"").slice(-500)};}
  write(base+"/"+phase+".journal.jsonl",fs.readFileSync(base+"/provider-events.jsonl"));
  write(base+"/"+phase+".orchestration.json",{phase,began,finished:new Date().toISOString(),execution,stop,raw,
    driver_stdout:base+"/"+phase+".driver.stdout.log",driver_stderr:base+"/"+phase+".driver.stderr.log"});
}
console.log(JSON.stringify({phase,execution,stop}));
if(stop.status!=="STOPPED_RECONCILED"||execution.exit!==0)process.exitCode=1;


