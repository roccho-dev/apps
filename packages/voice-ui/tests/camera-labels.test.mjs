import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = process.env.CAMERA_SOURCE_ROOT ?? new URL('..', import.meta.url).pathname;
const render = await import(pathToFileURL(path.join(base, 'src/render.mjs')));
const source = fs.readFileSync(path.join(base, 'web/app.mjs'), 'utf8');
const begin = source.indexOf('const showLists = () => {');
const end = source.indexOf('// The architecture page', begin);
assert.ok(begin >= 0 && end > begin);
// Execute the actual product menu function with a DOM port double. This is
// not a browser/paint test; the completed-artifact CI tests that separately.
const optionsOf = records => {
  const menu = { items: [], replaceChildren() { menu.items = []; }, append(item) { menu.items.push(item); } };
  const globals = { session: { working: {records}, draft: [] }, camera: null, bundle: {}, cameraPart: menu,
    draftList: {}, draftCount: {}, contextList: {}, contextSkipped: {},
    renderDraft() {}, renderContext() {}, draftUsed: () => 0, recentConversation: () => [], architectureReady: () => false,
    workingLayout: () => ({bounds: Object.fromEntries(records.filter(r => r.type === 'region').map(r => [r.id, [0,0,200,100]]))}),
    cameraLabels: render.cameraLabels, document: {createElement: () => ({})} };
  vm.runInNewContext(source.slice(begin, end) + '\nshowLists();', globals);
  return menu.items.map(item => ({id: item.value, label: item.textContent}));
};
const r = (id,label,parent='root') => ({type:'region',id,label,parent,kind:parent===null?'boundary':'group',summary:''});
const e = (id,from,to,kind='flow',label='') => ({type:'relation',id,from,to,kind,label});
const fixed = [r('root','World',null),r('a','Private Subnet 1'),r('b','Private Subnet 2'),
  r('alb','ALB'),r('one','Fargate Task','a'),r('two','Fargate Task','b'),e('branch1','alb','one'),e('branch2','alb','two')];
const index = rows => new Map(rows.map(row=>[row.id,row.label]));

test('same task name in distinct parents is selectable without guessing its identity',()=>{
 const names=index(optionsOf(fixed));
 assert.equal(names.get('one'),'Private Subnet 1 / Fargate Task');
 assert.equal(names.get('two'),'Private Subnet 2 / Fargate Task');
 assert.notEqual(names.get('one'),names.get('two'));
});
test('branched arrows with equal endpoint names have distinct camera labels',()=>{
 const names=index(optionsOf(fixed));
 assert.equal(names.get('branch1'),'矢印: ALB → Private Subnet 1 / Fargate Task');
 assert.equal(names.get('branch2'),'矢印: ALB → Private Subnet 2 / Fargate Task');
});
test('outside warning identifies the actual offscreen record without hiding its ID',()=>{
 const notice={dataset:{}};
 const names=new Map(optionsOf(fixed).map(row=>[row.id,row.label]));
 render.renderOutOfView(notice,{outside:['one'],labels:names});
 assert.equal(notice.dataset.parts,'one');assert.ok(notice.textContent.includes('one「Private Subnet 1 / Fargate Task」'));
 assert.ok(!notice.textContent.includes('Private Subnet 2'));
});
if (!process.env.CAMERA_BASELINE_ONLY) {
 test('unique pre-existing labels and ordinary arrow camera stay unchanged',()=>{
  assert.deepEqual(optionsOf([r('root','World',null),r('s','Source'),r('t','Target'),e('link','s','t')]),[
   {id:'',label:'全体の概要'},{id:'s',label:'Source'},{id:'t',label:'Target'},{id:'link',label:'矢印: Source → Target'}]);
 });
 test('same-parent repeated names keep distinct existing IDs',()=>{
  const names=index(optionsOf([r('root','World',null),r('s','SQL'),r('t','SQL')]));
  assert.equal(names.get('s'),'SQL [s]');assert.equal(names.get('t'),'SQL [t]');
 });
 test('nested equal group names are qualified to the first differing ancestor',()=>{
  const rows=[r('root','World',null),r('a','East'),r('b','West'),r('p','Private','a'),r('q','Private','b'),r('x','Task','p'),r('y','Task','q')];
  const names=index(optionsOf(rows));assert.equal(names.get('x'),'East / Private / Task');assert.equal(names.get('y'),'West / Private / Task');
 });
 test('typed and annotated arrows expose their meaning without changing endpoints',()=>{
  const rows=[r('root','World',null),r('s','API'),r('t','DB'),e('read','s','t','reads','query'),e('write','s','t','writes','save')];
  const names=index(optionsOf(rows));assert.equal(names.get('read'),'矢印: API → DB (reads: query)');assert.equal(names.get('write'),'矢印: API → DB (writes: save)');
 });
 test('parallel same-meaning relations are disambiguated by exact IDs',()=>{
  const names=index(optionsOf([r('root','World',null),r('s','API'),r('t','DB'),e('x','s','t'),e('y','s','t')]));
  assert.equal(names.get('x'),'矢印: API → DB [x]');assert.equal(names.get('y'),'矢印: API → DB [y]');
 });
 test('camera naming never changes records, names, kinds, purposes or image declarations',()=>{
  const rows=structuredClone(fixed);rows[4].summary='{"schema":"voice-ui.part-description/2","key":"task-a","purpose":"first task"}';
  const before=JSON.stringify(rows);optionsOf(rows);assert.equal(JSON.stringify(rows),before);
 });
 test('menu uses text, not HTML interpretation',()=>{
  const label='<img src=x onerror=bad()>',names=index(optionsOf([r('root','World',null),r('x',label)]));assert.equal(names.get('x'),label);
 });
 test('record order never chooses a different label for the same camera ID',()=>{
  const left=index(optionsOf(fixed)),right=index(optionsOf([...fixed].reverse()));
  for(const [id,name] of left)assert.equal(right.get(id),name);
 });
 test('unknown frame remains unverified, and an empty outside list is not a pixel visibility claim',()=>{
  const notice={dataset:{}};render.renderOutOfView(notice,{outside:null,labels:render.cameraLabels(fixed)});
  assert.ok(notice.textContent.includes('確かめられません'));render.renderOutOfView(notice,{outside:[],labels:render.cameraLabels(fixed)});assert.equal(notice.textContent,'');
 });
 test('old out-of-view callers retain exact behavior when labels are omitted',()=>{
  const notice={dataset:{}};render.renderOutOfView(notice,{outside:['x','y']});
  assert.equal(notice.dataset.parts,'x y');assert.equal(notice.textContent,'表示に収まっていない部品: x, y（作業図には残っています。表示の外か、一部しか見えていません）');
 });
 test('cyclic ancestry cannot hang naming',()=>assert.throws(()=>render.cameraLabels([r('a','A','b'),r('b','B','a')])));
}
