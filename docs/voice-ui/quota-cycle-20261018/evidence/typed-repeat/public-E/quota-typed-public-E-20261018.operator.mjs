import fs from'node:fs';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const b='/work/repos/voice-ui-typellm-20261016',phase='quota-typed-public-E-20261018',node='/nix/store/785jidgnryzj566s25s3rb262d4g5znb-nodejs-24.14.1/bin/node',configFile=b+'/'+phase+'.config.json',config=JSON.parse(fs.readFileSync(configFile)),rt=JSON.parse(fs.readFileSync(config.runtime_file)),p=JSON.parse(fs.readFileSync(b+'/'+phase+'.process.json')),hash=x=>createHash('sha256').update(x).digest('hex');
const write=(f,v)=>{const fd=fs.openSync(f,'wx',0o600);try{fs.writeSync(fd,Buffer.isBuffer(v)?v:JSON.stringify(v,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
let out,err,execution={exit:null},stop={status:'NOT_ATTEMPTED'};const began=new Date().toISOString();
try{
assert.equal(config.heads.apps,rt.apps_sha);assert.deepEqual(config.allowances,{jev:19,typellm:1});assert.equal(config.repeat_profile,'typed-ordinary-E-20261018');
assert.equal(hash(fs.readFileSync(config.input_file)),config.input_sha256);
const f=fs.readFileSync('/proc/'+p.pid+'/stat','utf8').split(') ').at(-1).trim().split(/\s+/);assert.equal(f[19],p.start_ticks);assert.equal(+f[2],p.pid);assert.notEqual(f[0],'Z');
assert.equal(fs.readFileSync(p.stderr,'utf8').split('\n').filter(l=>l.startsWith('provider-send:')).length,0);
const id=JSON.parse(fs.readFileSync(b+'/'+phase+'.runtime.json'));assert.equal(id.launcher.pid,p.pid);assert.equal(id.launcher.start_ticks,p.start_ticks);assert.equal(id.sealed_inputs_sha256,config.commitment_sha256);assert.equal(id.repeat_profile,config.repeat_profile);
out=fs.openSync(b+'/'+phase+'.driver.stdout.log','wx',0o600);err=fs.openSync(b+'/'+phase+'.driver.stderr.log','wx',0o600);
execFileSync(rt.acceptance_runtime+'/bin/voice-ui-acceptance-node',[config.driver,'--inputs',config.input_file,'--origin','http://127.0.0.1:18845','--semantic-map',rt.semantic_map.root,'--identities',b+'/'+phase+'.runtime.json','--out',b+'/'+phase+'.raw','--artifact',rt.artifact_root],{cwd:b,env:{PATH:node.slice(0,node.lastIndexOf('/'))},stdio:['ignore',out,err],timeout:2500000});execution={exit:0};
}catch(e){execution={exit:e.status??null,error:e.code??'driver_failed',signal:e.signal??null};}
finally{for(const fd of[out,err])if(fd!==undefined){fs.fsyncSync(fd);fs.closeSync(fd);}try{stop={status:'STOPPED_RECONCILED',result:JSON.parse(execFileSync(node,[b+'/run-manager-v3-bootstrap-ca.mjs','stop',configFile],{encoding:'utf8',timeout:25000,maxBuffer:2000000}))};}catch(e){stop={status:'STOP_FAILED',exit:e.status??null,error:e.code??'stop_failed'};}write(b+'/'+phase+'.journal.jsonl',fs.readFileSync(b+'/provider-events.jsonl'));write(b+'/'+phase+'.orchestration.json',{phase,began,finished:new Date().toISOString(),execution,stop});}
console.log(JSON.stringify({phase,execution,stop}));if(stop.status!=='STOPPED_RECONCILED'||execution.exit!==0)process.exitCode=1;
