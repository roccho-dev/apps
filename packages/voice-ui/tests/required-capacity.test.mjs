import assert from 'node:assert/strict';
import test from 'node:test';
import {readRequired, requiredRequest, flatRequiredRequest, readRequiredSlots, readFlatRequiredSlots, requiredDifference} from '../src/completion.mjs';
test('explicit extraction capacity 4..16, default three and malformed cases',()=>{
 const context={utterance:'A B C D E F G H I J K L M N O P',regions:[],parts:[]};
 for(const max of [3,4,16]){
  const rows=Array.from({length:max},(_,i)=>({label:String.fromCharCode(65+i),kind:'step',quantity:1}));
  assert.deepEqual(readRequired(rows,{max}),rows);assert.equal(readRequired([...rows,{label:'extra',kind:'step',quantity:1}],{max}),null);
  const req=requiredRequest(context,{max});assert.equal(Object.keys(req.questions).length,max);
  const flat=flatRequiredRequest(context,{max});assert.equal(Object.keys(flat.questions).length,max*3);
  const slots=Object.fromEntries(rows.map((r,i)=>['required'+(i+1),{...r,quantity:'1'}]));assert.deepEqual(readRequiredSlots(slots,{max}),rows);
  const scalars=Object.fromEntries(Object.entries(slots).flatMap(([k,r])=>Object.entries(r).map(([f,v])=>[k+'_'+f,v])));
  assert.deepEqual(readFlatRequiredSlots(scalars,{max}).required,rows);
  assert.equal(readFlatRequiredSlots({...scalars,unexpected:1},{max}),null);
  assert.equal(readRequired([...rows.slice(1),rows[1]],{max}),null);
 }
 assert.equal(readRequired(Array.from({length:4},(_,i)=>({label:String(i),kind:'step',quantity:1}))),null);
 for(const max of [0,17,Infinity,NaN,1.5,'4'])assert.throws(()=>requiredRequest(context,{max}));
 assert.deepEqual(requiredDifference([{label:'A',kind:'step',quantity:2}],[{key:'a',label:'A',kind:'step'}]),[{label:'A',kind:'step',occurrence:1}]);
});
