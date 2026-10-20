import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAnnotation } from './annotation-browser.mjs';
const name=()=>({unmet:null,box:[10,10,40,20],svg:[0,0,100,100],clips:[[0,0,100,100]]});
const view=[0,0,100,100];
test('new exact annotation is visible without relying on state or menu text',()=>assert.equal(assessAnnotation('new',['new'],name(),view).status,'PASS'));
for(const [id,captions,n,viewport] of [
 ['old caption',['old'],name(),view],['missing',[],name(),view],['duplicate',['new','new'],name(),view],
 ['own SVG',['new'],{...name(),svg:[0,0,20,20]},view],['outer clip',['new'],{...name(),clips:[[0,0,20,20]]},view],
 ['viewport',['new'],name(),[0,0,20,20]],['hidden',['new'],{...name(),unmet:'hidden'},view],
 ['unmeasured',['new'],null,view],['unbound capture',null,name(),view],
])test('annotation does not pass / '+id,()=>assert.notEqual(assessAnnotation('new',captions,n,viewport).status,'PASS'));
test('explicit cleared label requires old text to disappear',()=>{
 assert.equal(assessAnnotation('',[],null,view).status,'PASS');
 assert.equal(assessAnnotation('',[''],null,view).status,'PASS');
 assert.equal(assessAnnotation('',['old'],null,view).status,'UNMET');
});
