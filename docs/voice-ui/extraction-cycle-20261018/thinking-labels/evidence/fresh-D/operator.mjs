import fs from "node:fs";import assert from "node:assert/strict";import {execFileSync} from "node:child_process";
const base="/work/repos/voice-ui-typellm-20261016",phase="thinking-fresh-D-20261018",node="/nix/store/785jidgnryzj566s25s3rb262d4g5znb-nodejs-24.14.1/bin/node";
const configFile=base+"/"+phase+".config.json",config=JSON.parse(fs.readFileSync(configFile)),rt=JSON.parse(fs.readFileSync(config.runtime_file));
const receipt=JSON.parse(fs.readFileSync(base+"/"+phase+".process.json"));
const write=(p,v)=>{const fd=fs.openSync(p,"wx",0o600);try{fs.writeSync(fd,Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
let out,err,execution={exit:null},stop={status:"NOT_ATTEMPTED"};const began=new Date().toISOString();
try{
  assert.equal(config.heads.apps,rt.apps_sha);assert.deepEqual(config.allowances,{jev:0,typellm:8});
  const stat=fs.readFileSync("/proc/"+receipt.pid+"/stat","utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
  assert.equal(fields[19],receipt.start_ticks);assert.equal(+fields[2],receipt.pid);assert.notEqual(fields[0],"Z");
  assert.equal(fs.readFileSync(receipt.stderr,"utf8").split("\n").filter(l=>l.startsWith("provider-send:")).length,0);
  out=fs.openSync(base+"/"+phase+".driver.stdout.log","wx",0o600);err=fs.openSync(base+"/"+phase+".driver.stderr.log","wx",0o600);
  execFileSync(rt.acceptance_runtime+"/bin/voice-ui-acceptance-node",[config.driver,"run",config.public_plan,config.runtime_file,
    "http://127.0.0.1:18845",base+"/"+phase+".raw",config.wire_file],
    {cwd:base,env:{PATH:node.slice(0,node.lastIndexOf("/"))},stdio:["ignore",out,err],timeout:900000});
  execution={exit:0};
}catch(e){execution={exit:e.status??null,error:e.code??"driver_failed",signal:e.signal??null};}
finally{
  for(const fd of[out,err])if(fd!==undefined){fs.fsyncSync(fd);fs.closeSync(fd);}
  try{stop={status:"STOPPED_RECONCILED",result:JSON.parse(execFileSync(node,[base+"/run-manager-v3-bootstrap-ca.mjs","stop",configFile],{encoding:"utf8",timeout:25000,maxBuffer:2000000}))};}
  catch(e){stop={status:"STOP_FAILED",exit:e.status??null,error:e.code??"stop_failed"};}
  write(base+"/"+phase+".journal.jsonl",fs.readFileSync(base+"/provider-events.jsonl"));
  write(base+"/"+phase+".orchestration.json",{phase,began,finished:new Date().toISOString(),execution,stop});
}
console.log(JSON.stringify({phase,execution,stop}));if(stop.status!=="STOPPED_RECONCILED"||execution.exit!==0)process.exitCode=1;
