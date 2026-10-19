import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.CAMERA_SOURCE_ROOT??fileURLToPath(new URL('..',import.meta.url));
const {cameraLabels}=await import(pathToFileURL(path.join(root,'src/render.mjs')));
const {overviewLabels}=await import(pathToFileURL(path.join(root,'tests/camera-evidence.mjs')));
const r=(id,label,parent='root')=>({type:'region',id,label,parent,kind:parent===null?'boundary':'step',summary:''});
const e=(id,from,to)=>({type:'relation',id,from,to,kind:'flow',label:''});
const initial=[r('root','World',null)];
const taskCollision=[...initial,r('part-1','Task'),r('part-2','Task'),r('part-3','Task [part-1]')];
const crossCollision=[...initial,r('s','S'),r('t','T'),r('impostor','矢印: S → T'),e('link','s','t')];
const assertDistinct=rows=>{
 const labels=cameraLabels(rows);assert.equal(labels.size,rows.length);
 assert.equal(new Set(labels.values()).size,labels.size,'distinct subjects need distinct displayed choices');
 for(const row of rows.filter(x=>x.type==='region'))assert.ok(labels.get(row.id).includes(row.label));
 return labels;
};
const observed=()=>({viewport:[0,0,100,100],shapes:[{id:'part-1',name:{unmet:null,box:[10,10,40,20],svg:[0,0,100,100],clips:[[0,0,100,100]]}}]});

test('R1a generated ID suffix cannot alias an actual Task name',()=>assertDistinct(taskCollision));
test('R1b a part name cannot alias a relation menu caption',()=>assertDistinct(crossCollision));
test('R2 glyph clipped by its own SVG is not readable',()=>{
 const value=observed();value.shapes[0].name.svg=[0,0,20,20];
 assert.equal(overviewLabels(value,['part-1']).status,'UNMET');
});
if(!process.env.CAMERA_REBUTTAL_BASELINE_ONLY){
 test('overview option remains distinguishable from a part named as the overview',()=>{
  const labels=assertDistinct([...initial,r('x','全体の概要')]);assert.notEqual(labels.get('x'),'全体の概要');
 });
 test('literal suffix chains cannot capture the next generated choice',()=>{
  const rows=[...taskCollision,...Array.from({length:24},(_,i)=>r('literal-'+i,`Task [part-1] (${i+1})`))];
  const labels=assertDistinct(rows);assert.ok(labels.get('part-1').includes('[part-1]'));
 });
 test('qualification is deterministic when record order changes',()=>{
  const rows=[...taskCollision,...crossCollision.slice(1)];const first=assertDistinct(rows),reverse=assertDistinct([...rows].reverse());
  assert.deepEqual([...first].sort(),[...reverse].sort());
 });
 test('real names, parents and records never change during naming',()=>{
  const rows=structuredClone(taskCollision),before=JSON.stringify(rows);assertDistinct(rows);assert.equal(JSON.stringify(rows),before);
 });
 test('duplicate actual IDs fail instead of overwriting a menu subject',()=>{
  assert.throws(()=>cameraLabels([...initial,r('x','X'),r('x','Y')]));
  assert.throws(()=>cameraLabels([...initial,r('s','S'),r('t','T'),e('s','s','t')]));
 });
 test('part and relation collisions are solved together, including forged fallback strings',()=>{
  assertDistinct([...crossCollision,r('fake-suffix','矢印: S → T [link]'),r('second-suffix','矢印: S → T [link] (1)')]);
 });
 test('public showLists emits actual IDs and globally distinct plain-text options',()=>{
  const source=fs.readFileSync(path.join(root,'web/app.mjs'),'utf8');
  const start=source.indexOf('const showLists = () => {'),end=source.indexOf('// The architecture page',start);assert.ok(start>=0&&end>start);
  const records=[...taskCollision,...crossCollision.slice(1),r('overview-name','全体の概要')];
  const menu={items:[],replaceChildren(){this.items=[];},append(item){this.items.push(item);}};
  const context={session:{working:{records},draft:[]},camera:null,bundle:{},cameraPart:menu,draftList:{},draftCount:{},contextList:{},contextSkipped:{},
   renderDraft(){},renderContext(){},draftUsed:()=>0,recentConversation:()=>[],architectureReady:()=>false,cameraLabels,
   workingLayout:()=>({bounds:Object.fromEntries(records.filter(x=>x.type==='region').map(x=>[x.id,[0,0,100,100]]))}),document:{createElement:()=>({})}};
  vm.runInNewContext(source.slice(start,end)+'\nshowLists();',context);
  assert.equal(menu.items.length,records.length);
  assert.equal(new Set(menu.items.map(x=>x.textContent)).size,menu.items.length);
  assert.deepEqual(menu.items.map(x=>x.value).sort(),['',...records.filter(x=>x.id!=='root').map(x=>x.id)].sort());
 });
 for(const [name,svg] of [['missing',undefined],['null',null],['zero',[0,0,0,20]],['negative',[0,0,-20,100]],['invalid',[0,0,NaN,100]],['shifted',[40,0,60,100]]])test('unknown or excluding SVG bounds are not readable / '+name,()=>{
  const value=observed();value.shapes[0].name.svg=svg;assert.equal(overviewLabels(value,['part-1']).status,'UNMET');
 });
 test('glyph inside SVG, outer viewport and every clip remains readable',()=>assert.equal(overviewLabels(observed(),['part-1']).status,'PASS'));
 test('fitting SVG alone never bypasses an outer clip',()=>{
  const value=observed();value.shapes[0].name.clips=[[0,0,20,20]];assert.equal(overviewLabels(value,['part-1']).status,'UNMET');
 });
 test('finite adversarial name families are distinct without changing input order',()=>{
  for(let n=1;n<=32;n++){
   const rows=[...initial,...Array.from({length:n},(_,i)=>r('p-'+i,i%3===0?'Task':i%3===1?`Task [p-${i-1}]`:'矢印: S → T')),r('s','S'),r('t','T'),e('edge','s','t')];
   assertDistinct(rows);
  }
 });
}
