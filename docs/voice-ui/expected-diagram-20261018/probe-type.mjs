import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]);const load=p=>import(pathToFileURL(path.join(root,p)).href);
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.sources.apps,'f43fc51e6ba37c9948cf7df610b95a9780ed2ab9');
for(const f of manifest.files){const bytes=await fs.readFile(path.join(root,f.path));assert.equal(bytes.length,f.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);}
const {readBundle}=await load('site/app/src/bundle.mjs');
const {readRequired,requiredLabelsGrounded}=await load('site/app/src/completion.mjs');
const p=i=>({key:`p${i}`,purpose:`one p${i}`,label:`p${i}`,kind:'step'});
const read=parts=>readBundle({schema:'voice-ui.bundle/1',version:'reference-readiness',parts,diagrams:[]});
const results=[
 {id:'plain-part',goal_met:read([p(0)]).parts!==null},
 {id:'four-required',goal_met:readRequired(Array.from({length:4},(_,i)=>({label:`p${i}`,kind:'step',quantity:1})))!==null},
 {id:'nine-catalogue',goal_met:read(Array.from({length:9},(_,i)=>p(i))).parts!==null},
 {id:'explicit-symbol',goal_met:read([{...p(0),icon:'aws:ecs'}]).parts!==null},
 {id:'ungrounded-name-still-rejected',goal_met:!requiredLabelsGrounded([{label:'Invented',kind:'step',quantity:1}],{utterance:'p0を追加',parts:[p(0)]})},
];
console.log(JSON.stringify({schema:'voice-ui.expected-diagram-type-baseline/1',source:manifest.sources.apps,artifact_id:12134800177,files_verified:manifest.files.length,live_calls:0,cases:5,met:results.filter(x=>x.goal_met).length,unmet:results.filter(x=>!x.goal_met).length,product_modified:false}));for(const r of results)console.log(JSON.stringify(r));
