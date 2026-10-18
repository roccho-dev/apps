import os from 'node:os';
import {createHash} from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
async function measure(root, variant, cases) {
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const c=await load('site/app/src/contract.mjs');
const {questionsFor}=await load('site/app/src/judgment.mjs');
const {runGoal}=await load('site/app/src/goal.mjs');
const {createSession,undo}=await load('site/app/src/session.mjs');
const {MAP_ID,STATE_SCHEMA}=await load('site/app/src/log.mjs');
const protocol=await load('site/ui/semantic-map/protocol/index.js');
globalThis.fetch=async()=>{throw Error('network forbidden in controlled test');};
const results=[];
const matches = (nodes, edges, parts, expected) => {
 const actual = nodes.map(n=>[n.label,n.kind,n.parent]).sort((a,b)=>a[0].localeCompare(b[0]));
 const wanted = parts.map(p=>[p.label,p.kind,'container']).sort((a,b)=>a[0].localeCompare(b[0]));
 if(nodes.length!==expected.new_regions||edges.length!==expected.new_edges||JSON.stringify(actual)!==JSON.stringify(wanted))return false;
 if(!expected.new_edges)return true;
 const from=nodes.find(n=>n.label===parts[0].label),to=nodes.find(n=>n.label===parts[1].label);
 return edges.length===1&&edges[0].from===from.id&&edges[0].to===to.id&&edges[0].kind==='flow'&&edges[0].label==='';
};
const beforeEach=async()=>{
 const graph=await protocol.createDecisionLog([
  {type:'meta',schema:STATE_SCHEMA,root:'root',title:'one-choice controlled comparison'},
  {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:[0,0,3000,2000],summary:''},
  {type:'region',id:'container',parent:'root',label:'Cloud',kind:'group',bounds:[0,0,1000,300],summary:''},
 ],MAP_ID);
 const p=await protocol.createDecision(graph.head,[{type:'PinRegions',items:[{regionId:'container',bounds:[0,0,2400,800]}]}],graph.records);
 const prepared=(await protocol.appendDecision(graph.log,p.decision)).verified;
 return createSession({accepted:prepared,stored:prepared.log});
};
for(const goal of cases){
 const before=await beforeEach();let session=before;let terminal=0;
 const bundle={parts:Array.from({length:goal.parts},(_,i)=>({key:`node${i}`,label:`node${i}`,kind:'step',purpose:`one node${i}`})),diagrams:[]};
 const choice=key=>({kind:'answered',decision:{answers:{delta:{type:'choice',choice:key,confidence:1}}}});
 const result=await runGoal({utterance:`Cloud内に${bundle.parts.map(p=>p.label).join('、')}を各1つ追加。${goal.connect?'node0からnode1へ矢印。':''}他は変えない。`,bundle,protocol,current:()=>session,cancelled:()=>false,adopt:async next=>{session=next;},
 ask:async req=>{
  assert.equal(c.isRequest(req),true,'actual candidate request matches its own contract');
  const slots=req.kind===c.GOAL_COMPLETION_KIND?c.goalCompletionSlots():c.slotsFor(req.state);
  const questions=questionsFor(req.state,slots,{kind:req.kind});
  for(const [name,options] of Object.entries(slots)) assert.deepEqual(Object.keys(questions[name].options),options,'each option has exactly one description');
  if(req.kind===c.GOAL_COMPLETION_KIND){terminal++;return {kind:'answered',decision:{answers:{completion:{type:'choice',choice:'complete',confidence:1}}}};}
  const s=req.state;
  if(variant==='baseline'&&s.placing!==null)return choice(s.candidates.find(x=>x.part===s.placing&&x.parent==='container').id);
  if(s.selected.length<goal.parts){const key=bundle.parts[s.selected.length].key;return choice(variant==='baseline'?`part:${key}`:s.candidates.find(x=>x.part===key&&x.parent==='container').id);}
  if(goal.connect&&!s.edges.length)return choice(s.candidates.find(x=>x.from===s.selected[0].region&&x.to===s.selected[1].region).id);
  return choice(c.NONE);
 }});
 const additions=session.working.records.filter(r=>r.type==='region'&&!before.working.records.some(old=>old.type==='region'&&old.id===r.id));
 const edges=session.working.records.filter(r=>r.type==='relation');
 const graphMet=matches(additions,edges,bundle.parts,goal.expected);
 if(graphMet){
  assert.equal(matches(additions.map((n,i)=>i? n:{...n,label:'wrong-name'}),edges,bundle.parts,goal.expected),false);
  assert.equal(matches(additions.map((n,i)=>i? n:{...n,kind:'data'}),edges,bundle.parts,goal.expected),false);
  assert.equal(matches(additions.map((n,i)=>i? n:{...n,parent:'root'}),edges,bundle.parts,goal.expected),false);
  if(edges.length)assert.equal(matches(additions,[{...edges[0],from:edges[0].to,to:edges[0].from}],bundle.parts,goal.expected),false);
 }
 const unchangedBefore=before.working.records.every(old=>session.working.records.some(r=>JSON.stringify(r)===JSON.stringify(old)));
 const undone=await undo(session,{verifyDecisionLog:protocol.verifyDecisionLog});
 assert.deepEqual(undone.working.records,before.working.records);
 assert.equal(session.stored,before.stored);assert.equal(unchangedBefore,true);assert.ok(result.requests<=8);
 results.push({id:goal.id,variant,graph_met:graphMet,new_regions:additions.length,new_edges:edges.length,requests:result.requests,reason:result.reason,completion:result.completion.status,terminal_calls:terminal,original_records_preserved:unchangedBefore,undo:true,persistent_store_unchanged:true,live_calls:0,evidence:'synthetic-perfect-selector/actual-module-state-transition'});
}
// Negative controls exercise state guards, not semantic quality.
for(const mode of ['weak','stale','cancelled']){
 const before=await beforeEach();let session=before,cancelled=false;
 const bundle={parts:[{key:'node',label:'node',kind:'step',purpose:'one node'}],diagrams:[]};
 const result=await runGoal({utterance:'Cloud内にnodeを1つ追加',bundle,protocol,current:()=>session,cancelled:()=>cancelled,adopt:async()=>assert.fail('negative guard must not adopt'),ask:async req=>{
  if(mode==='stale')session={...session};if(mode==='cancelled')cancelled=true;
  const key=variant==='baseline'?'part:node':req.state.candidates.find(x=>x.part==='node'&&x.parent==='container').id;
  return {kind:'answered',decision:{answers:{delta:{type:'choice',choice:key,confidence:mode==='weak'?.49:1}}}};
 }});
 assert.deepEqual(session.working.records,before.working.records);assert.equal(result.completion.status,'unknown');
 results.push({id:`guard-${mode}`,variant,graph_unchanged:true,completion:result.completion.status,reason:result.reason,live_calls:0,evidence:'controlled-guard'});
}
return results;
}

const [artifactArg,casesArg]=process.argv.slice(2);
if(!artifactArg||!casesArg)throw Error('usage: node compare-one-choice.mjs <unpacked-PR118-artifact> <controlled-goals.jsonl>');
const artifact=path.resolve(artifactArg), casesText=await fs.readFile(casesArg,'utf8');
const cases=casesText.trim().split('\n').map(JSON.parse);
if(!cases.length||cases.length>20||new Set(cases.map(x=>x.id)).size!==cases.length||cases.some(x=>
 !x||Object.keys(x).sort().join(',')!=='connect,expected,id,parts'||typeof x.id!=='string'||!x.id||!Number.isSafeInteger(x.parts)||x.parts<1||x.parts>5||typeof x.connect!=='boolean'||
 x.connect&&x.parts<2||!x.expected||Object.keys(x.expected).sort().join(',')!=='new_edges,new_regions'||x.expected.new_regions!==x.parts||x.expected.new_edges!==Number(x.connect)))throw Error('invalid controlled case set');
const manifestText=await fs.readFile(path.join(artifact,'manifest.json'),'utf8');
assert.equal(hash(manifestText),'ccce1f694b8fc9e0fed8d934ab181fc7b758f7e0833434c55fe280ec1f376fd4');
const manifest=JSON.parse(manifestText);
assert.equal(manifest.sources.apps,'32c57b155d841e7cb1200aae049b8dd12d254c62');
for(const file of manifest.files){
 const filePath=path.resolve(artifact,file.path);assert.ok(filePath.startsWith(artifact+path.sep));
 const bytes=await fs.readFile(filePath);assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256,file.path);
}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'voice-one-choice-'));
try{
 const src=path.join(temp,'site/app/src');await fs.mkdir(src,{recursive:true});
 await fs.cp(path.join(artifact,'site/app/src'),src,{recursive:true});
 await fs.symlink(path.join(artifact,'site/ui'),path.join(temp,'site/ui'),'dir');
 const expected={
  'contract.mjs':'75f159a0a2d681f21cfc5f23e16a1d540937269ff125b38dc2d23fcc7c6d790f',
  'goal.mjs':'2ba258d5d1911270a160694c12989fc57a4ab7784251c45c5f5256c910239c77',
  'judgment.mjs':'95271a0088876aa9f67f3095fb8ad6a32a9a8d856e32cf693982b5020aa8469c',
 };
 const changed=[];
 for(const name of Object.keys(expected)){
  let text=await fs.readFile(path.join(src,name),'utf8');assert.equal(hash(text),expected[name]);
  if(name==='contract.mjs'){
   text=text.replace('voice-ui.judge.goal-local-delta.v7','voice-ui.judge.goal-local-delta.v8-experiment');
   const a=text.indexOf('// A Goal step is asked in up to two frames');
   const end=text.indexOf('\n\nconst validGoalRequest',a);assert.ok(a>=0&&end>a);
   text=text.slice(0,a)+'// Every option names one complete held executable delta.\nconst goalOptions = state => state.candidates.map(candidate => candidate.id);'+text.slice(end);
   text=text.replace(', "scope", "placing"]',', "scope"]');
   text=text.replace('  if (state.placing !== null && !state.candidates.some(candidate => candidate.action === ACTION_ADD_PART && candidate.part === state.placing)) return false;\n','');
   text=text.replace('  // A bound part is one this request holds an addition for, and a slot never\n  // repeats a key: an arrow whose id is a derived part alternative is refused.','  // Held candidate IDs remain unique.');
  }else if(name==='goal.mjs'){
   text=text.replace('partOption, readAnswers','readAnswers');
   const a=text.indexOf('    // One counted judgment per frame'), end=text.indexOf('      if (!isRequest(request))',a);assert.ok(a>=0&&end>a);
   text=text.slice(0,a)+'    // One counted judgment selects an already complete held delta.\n    const frame = async () => {\n      const request = { kind: GOAL_REQUEST_KIND, state };\n'+text.slice(end);
   text=text.replace('await frame(null)','await frame()');
   const p=text.indexOf('    let { choice, confidence } = what;'), q=text.indexOf('    const candidate = held.candidates.find',p);assert.ok(p>=0&&q>p);
   text=text.slice(0,p)+'    const { choice, confidence } = what;\n'+text.slice(q);
  }else{
   const a=text.indexOf('// A Goal step is asked in up to two frames'),b=text.indexOf('// A Goal\'s scope is checked',a);assert.ok(a>=0&&b>a);
   text=text.slice(0,a)+text.slice(b);text=text.replace('partOption, relationSlot','relationSlot');
   const p=text.indexOf('    const placing = state.placing === null'),q=text.indexOf('\n  if (context.kind === ARCHITECTURE_LOCATE_KIND)',p);assert.ok(p>=0&&q>p);
   text=text.slice(0,p)+`    return { delta: {
      instruction: "Choose the next complete executable change toward the utterance's goal. Each option already binds the part and its direct parent, or a directed connection. Preserve requested names and counts, use the current graph and edges to find the missing change, and do not add an unrequested change. Choose none when no offered change is clearly needed or the request is ambiguous."
        + GOAL_CONTEXT_NOTE + (state.scope === null ? "" : SCOPE_NOTE),
      options: criteria(slots.delta, key => {
        if (key === NONE) return "no offered executable change is clearly requested, or the requested changes are already present";
        const candidate = state.candidates.find(item => item.id === key);
        if (candidate.action === ACTION_ADD_EDGE) return 'directed flow arrow from ' + label(labels.get(candidate.from)) + ' (' + named(candidate.from) + ') to ' + label(labels.get(candidate.to)) + ' (' + named(candidate.to) + ')';
        return 'add one new part ' + partOf(offered.get(candidate.part)) + ' directly inside ' + label(parents.get(candidate.parent).label) + ' (' + named(candidate.parent) + ')';
      }),
    } };
  }`+text.slice(q);
  }
  await fs.writeFile(path.join(src,name),text);changed.push({path:'packages/voice-ui/src/'+name,before:expected[name],after:hash(text)});
 }
 const rows=[...await measure(artifact,'baseline',cases),...await measure(temp,'one-choice',cases)];
 console.log(JSON.stringify({schema:'voice-ui.one-choice-controlled/1',base:manifest.sources.apps,cases_sha256:hash(casesText),candidate_files:changed,live_calls:0,browser:'NOT_RUN',microphone:'NOT_RUN',latency:'NOT_MEASURED',semantic_accuracy:'NOT_MEASURED',production_modified:false,promotion:'NOT_APPROVED'}));
 for(const row of rows)console.log(JSON.stringify(row));
}finally{await fs.rm(temp,{recursive:true,force:true});}
