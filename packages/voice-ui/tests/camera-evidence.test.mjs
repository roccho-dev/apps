import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCameraEvidence, overviewLabels } from './camera-evidence.mjs';
const baseline = {head:'h',log:'fixed-jsonl',stored:'stored-jsonl',records:[],view:{frame:{bbox:[0,0,20,10]}}};
const setup = () => {
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'camera-evidence-'));
 const context={camera:'one',label:'nested-group',frame:structuredClone(baseline)};
 const page={evaluate:async()=>({camera:context.camera,label:context.label,outsideIds:'two',outsideText:'outside',viewport:[1280,720],deviceScaleFactor:1}),
  screenshot:async()=>Buffer.from('SYNTHETIC_UNIT_TEST_BYTES_NOT_AN_IMAGE'),locator:()=>({inputValue:async()=>context.camera})};
 return {output,context,page,snapshot:async()=>structuredClone(context.frame)};
};
test('every camera and lifecycle observation gets its own PNG and binding; equal labels cannot overwrite',async()=>{
 const s=setup();try {
  const capture=createCameraEvidence({output:s.output,source:'fixed-revision'});
  for(const [stage,camera] of [['after','one'],['after','two'],['reload','one'],['reload','two'],['after','one']]){
   s.context.camera=camera;await capture.capture({page:s.page,snapshot:s.snapshot,fixture:'same-fixture',stage});
  }
  assert.equal(capture.items.length,5);assert.equal(new Set(capture.items.map(x=>x.png)).size,5);
  assert.equal(fs.readdirSync(s.output).length,10);
  for(const row of capture.items){assert.equal(row.label,'nested-group');assert.equal(row.source,'fixed-revision');assert.equal(row.head,'h');
   assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.output,row.png.replace(/png$/,'json')))),row);
   assert.equal(row.png_sha256.length,64);
  }
 } finally {fs.rmSync(s.output,{recursive:true,force:true});}
});
test('an earlier capture cannot be silently replaced by a new collector',async()=>{
 const s=setup();try {
  const args={page:s.page,snapshot:s.snapshot,fixture:'fixed',stage:'reload'};
  const a=createCameraEvidence({output:s.output,source:'fixed-revision'});await a.capture(args);
  const before=fs.readFileSync(path.join(s.output,a.items[0].png));
  const b=createCameraEvidence({output:s.output,source:'fixed-revision'});
  await assert.rejects(()=>b.capture(args),/EEXIST/);assert.equal(b.items.length,0);
  assert.deepEqual(fs.readFileSync(path.join(s.output,a.items[0].png)),before);
 } finally {fs.rmSync(s.output,{recursive:true,force:true});}
});
for(const field of ['head','log','stored','records','view'])test('capture refuses concurrent '+field+' change',async()=>{
 const s=setup();try {
  const capture=createCameraEvidence({output:s.output,source:'fixed-revision'});
  s.page.screenshot=async()=>{s.context.frame[field]=field==='view'?{frame:{bbox:[1,1,1,1]}}:field==='records'?[{id:'other'}]:'other';return Buffer.from('test');};
  await assert.rejects(()=>capture.capture({page:s.page,snapshot:s.snapshot,fixture:'fixed',stage:'after'}));assert.equal(capture.items.length,0);
 } finally {fs.rmSync(s.output,{recursive:true,force:true});}
});
const observed = () => ({viewport:[0,0,100,100],shapes:[{id:'a',name:{unmet:null,box:[10,10,40,20],clips:[[0,0,100,100]]}}]});
test('one-screen label check requires actual visible boxes, not just records',()=>assert.equal(overviewLabels(observed(),['a']).status,'PASS'));
for(const [name,mutate] of [
 ['missing',x=>x.shapes=[]],['hidden',x=>x.shapes[0].name.unmet='hidden'],['offscreen',x=>x.shapes[0].name.box=[200,10,40,20]],
 ['clipped',x=>x.shapes[0].name.clips=[[0,0,20,20]]],['duplicate',x=>x.shapes.push(x.shapes[0])]
])test('one-screen label check rejects '+name,()=>{
 const x=observed();mutate(x);const result=overviewLabels(x,['a']);assert.equal(result.status,'UNMET');assert.deepEqual(result.unreadable,['a']);
});
test('empty or duplicate expectations cannot create a vacuous overview pass',()=>{
 assert.throws(()=>overviewLabels(observed(),[]));assert.throws(()=>overviewLabels(observed(),['a','a']));
});
