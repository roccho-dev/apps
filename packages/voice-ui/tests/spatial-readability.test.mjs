import assert from 'node:assert/strict';
import test from 'node:test';
import { assessParallelRelations, assessWholeOverview } from './spatial-readability.mjs';
import { assessPaintedEdge } from './painted-goal.mjs';

const expected = [
  { id: 'metrics', from: 'source', to: 'target', kind: 'metrics', label: 'RPS' },
  { id: 'control', from: 'source', to: 'target', kind: 'control', label: 'scale' },
];
const name = bounds => ({ unmet: null, box: bounds, svg: [0,0,400,240], clips: [[0,0,400,240]] });
const observation = (edge, offset = 0) => ({
  identity: true, viewport: [0,0,400,240],
  shapes: [
    { id:'source', bounds:[0,0,50,50], name:name([5,5,20,12]) },
    { id:'target', bounds:[300,0,50,50], name:name([305,5,20,12]) },
  ],
  edge: { ...edge, complete:true, unsupported:[], name:name([90,60+offset,40,12]),
    matches:[{ start:[50,25], tip:[300,25], route:{ d:'fixed-test-path',
      samples:Array.from({length:33},(_,i)=>[50+250*i/32,25+offset*Math.sin(Math.PI*i/32)]) } }],
  },
});
const observations = () => expected.map((edge,i)=>observation(edge,i*40));
const grade = rows => assessParallelRelations(expected,rows);

test('two separately traceable routes with separate complete annotations pass this finite audit',()=>{
  const rows=observations(); assert.ok(rows.every(row=>assessPaintedEdge(row).status==='PASS'));
  assert.equal(grade(rows).status,'PASS');
});
test('old individual-edge pass does not authorize coincident parallel routes',()=>{
  const rows=expected.map(edge=>observation(edge));
  assert.ok(rows.every(row=>assessPaintedEdge(row).status==='PASS'));
  const result=grade(rows);assert.equal(result.status,'UNMET');
  assert.ok(result.problems.some(value=>value.includes('coincident')));
});
test('route serialization in reverse order cannot disguise an overlapping line',()=>{
  const rows=expected.map(edge=>observation(edge));rows[1].edge.matches[0].route.samples.reverse();
  assert.equal(grade(rows).status,'UNMET');
});
test('different command strings alone do not prove distinct rendered geometry',()=>{
  const rows=expected.map(edge=>observation(edge));rows[1].edge.matches[0].route.d='other-svg-transform';
  assert.equal(grade(rows).status,'UNMET');
});
test('subpixel sampling variation cannot turn coincident paths into a pass',()=>{
  const rows=expected.map(edge=>observation(edge));rows[1].edge.matches[0].route.samples.forEach(p=>{p[1]+=.1;});
  assert.equal(grade(rows).status,'UNMET');
});
test('separate paths with colliding annotations still fail',()=>{
  const rows=observations();rows[1].edge.name=structuredClone(rows[0].edge.name);
  const result=grade(rows);assert.equal(result.status,'UNMET');assert.ok(result.problems.some(p=>p.includes('annotations')));
});
for(const [id,mutate] of [
  ['missing observation',rows=>rows.pop()],['duplicate observation',rows=>rows.push(rows[0])],
  ['missing samples',rows=>delete rows[0].edge.matches[0].route],
  ['nonfinite samples',rows=>rows[0].edge.matches[0].route.samples[1][0]=NaN],
  ['incomplete edge',rows=>rows[0].edge.complete=false],
  ['unsupported edge paint',rows=>rows[0].edge.unsupported=['unverified mask']],
  ['missing annotation',rows=>rows[0].edge.name=null],
  ['hidden annotation',rows=>rows[0].edge.name.unmet='hidden'],
])test('unknown is not a pass: '+id,()=>{const rows=observations();mutate(rows);assert.notEqual(grade(rows).status,'PASS');});
for(const [key,value] of [['kind','other'],['label','wrong'],['from','target'],['to','source']])
  test('wrong expected '+key+' is not accepted',()=>{const rows=observations();rows[0].edge[key]=value;assert.equal(grade(rows).status,'UNMET');});
for(const field of ['svg','clips'])test('clipped annotation is rejected: '+field,()=>{
  const rows=observations();rows[0].edge.name[field]=field==='svg'?[0,0,10,10]:[[0,0,10,10]];
  assert.equal(grade(rows).status,'UNMET');
});
test('the schema forbids a vacuous or duplicate relation expectation',()=>{
  assert.throws(()=>assessParallelRelations([],[]));
  assert.throws(()=>assessParallelRelations([expected[0],expected[0]],observations()));
});
const overview = () => ({viewport:[0,0,400,240],shapes:[{id:'a',name:name([10,10,70,15])},{id:'b',name:name([100,10,70,15])}]});
test('all declared overview names must be readable without colliding',()=>{
  assert.equal(assessWholeOverview(overview(),['a','b']).status,'PASS');
});
test('valid per-name bounds can still overlap another expected name',()=>{
  const value=overview();value.shapes[1].name.box=[30,10,70,15];
  const result=assessWholeOverview(value,['a','b']);assert.equal(result.status,'UNMET');assert.deepEqual(result.collisions,[['a','b']]);
});
for(const [id,mutate] of [
  ['own SVG',value=>value.shapes[0].name.svg=[0,0,20,20]],
  ['missing name',value=>value.shapes.pop()],
  ['outer clip',value=>value.shapes[0].name.clips=[[0,0,20,20]]],
  ['no visible glyph',value=>value.shapes[0].name.unmet='no glyph'],
])test('overview retains prior fail-closed boundary: '+id,()=>{
  const value=overview();mutate(value);assert.equal(assessWholeOverview(value,['a','b']).status,'UNMET');
});
