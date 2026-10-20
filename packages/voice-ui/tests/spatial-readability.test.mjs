import assert from 'node:assert/strict';
import test from 'node:test';
import { assessParallelRelations, assessWholeOverview, nearLengthFraction } from './spatial-readability.mjs';
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
    matches:[{ start:[50,25], tip:[300,25], stroke:1.14, route:{ d:'fixed-test-path',
      samples:Array.from({length:33},(_,i)=>[50+250*i/32,25+offset*Math.sin(Math.PI*i/32)]) } }],
  },
});
const observations = () => expected.map((edge,i)=>observation(edge,i*40));
const grade = rows => assessParallelRelations(expected,rows);

test('two separately traceable routes with separate complete annotations pass this finite audit',()=>{
  const rows=observations(); assert.ok(rows.every(row=>assessPaintedEdge(row).status==='PASS'));
  assert.equal(grade(rows).status,'PASS');
});

test('a present annotation hidden by an endpoint is not readable',()=>{
  const row=observation(expected[0]);row.edge.name=name([20,20,40,12]);
  const result=assessPaintedEdge(row);
  assert.equal(result.status,'UNMET');
  assert.ok(result.problems.includes('annotation overlaps a painted endpoint'));
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

test('0.3px separation below the stroke width is not independently traceable',()=>{
  const rows=[observation(expected[0]),observation(expected[1],.3)];
  rows[1].edge.name=name([90,120,40,12]);
  assert.equal(grade(rows).status,'UNMET');
});

test('one 4px excursion cannot disguise 32 of 33 coincident samples',()=>{
  const rows=expected.map(edge=>observation(edge));
  rows[1].edge.name=name([90,120,40,12]);
  rows[1].edge.matches[0].route.samples[16][1]+=4;
  assert.equal(grade(rows).status,'UNMET');
});

test('R1-S1 alternating 1.5px offsets count partial near-segment lengths',()=>{
  const rows=expected.map(edge=>observation(edge));rows[1].edge.name=name([90,120,40,12]);
  rows[1].edge.matches[0].route.samples.forEach((p,i)=>{p[1]+=(i%2)*1.5;});
  assert.ok(rows.every(row=>assessPaintedEdge(row).status==='PASS'));
  const result=grade(rows);assert.equal(result.status,'UNMET');
  assert.equal(result.comparisons[0].tolerance,1.39);
  assert.ok(result.comparisons[0].nearLengthFractions[0]>.94);
  assert.ok(Math.abs(result.comparisons[0].nearLengthFractions[1]-1.39/1.5)<1e-12);
});

const line=(a,b,power=1)=>Array.from({length:33},(_,i)=>a.map((v,k)=>v+(b[k]-v)*(i/32)**power));
test('a short interior crossing counts even when neither endpoint is near',()=>{
  // One long horizontal segment crosses a vertical polyline. Near length is
  // exactly 2r/length; repeated query vertices must not affect that measure.
  const route=[[0,0],...Array.from({length:32},()=>[10,0])],other=line([5,-10],[5,10]);
  assert.ok(Math.abs(nearLengthFraction(route,other,1)-.2)<1e-12);
});

test('endpoint circles count the curved capsule caps without double counting',()=>{
  const route=line([-2,.5],[2,.5]),other=Array.from({length:33},()=>[0,0]);
  assert.ok(Math.abs(nearLengthFraction(route,other,1)-Math.sqrt(.75)/2)<1e-12);
});

test('collinear subdivision, reversed ordering and zero-length segments preserve exact near length',()=>{
  const route=line([-5,0],[15,0]),other=line([0,0],[10,0]);
  for(const first of [route,[...route].reverse(),line([-5,0],[15,0],3)])
    for(const second of [other,[...other].reverse(),line([0,0],[10,0],2)])
      assert.ok(Math.abs(nearLengthFraction(first,second,1)-.6)<1e-12);
});

test('separated routes keep their positive result after partial-length integration',()=>{
  const rows=observations(),result=grade(rows);
  assert.equal(result.status,'PASS');assert.ok(result.comparisons[0].nearLengthFractions.every(v=>v<.5));
});

test('unknown stroke width does not authorize a readability pass',()=>{
  const rows=observations();delete rows[0].edge.matches[0].stroke;
  assert.equal(grade(rows).status,'UNPROVEN');
});

test('reversed and differently sampled polylines retain the near-overlap rejection',()=>{
  const rows=expected.map(edge=>observation(edge));
  rows[1].edge.name=name([90,120,40,12]);
  rows[1].edge.matches[0].route.samples.forEach((point,i)=>{point[0]+=(i>0&&i<32)?.1:0;point[1]+=.3;});
  rows[1].edge.matches[0].route.samples.reverse();
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
