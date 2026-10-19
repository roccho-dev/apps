import assert from 'node:assert/strict';
import {auditReducedView} from './reduced-view-audit.mjs';

const bag=rows=>rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort();
// Existing controls only: no UI/renderer replacement, page internals or model
// success verdicts. Expectations are fixed here; only the provider answers are
// synthetic. The whole suite must remain RED for the existing image failure.
export async function checkStoredEdgeEdits({page,snapshot,settle,protocol,initialRecords,setEdit,save,paint}) {
  const requests=[
    {id:'reverse',action:'reverse-edge',edge:'voice-source-to-target',text:'SourceからTargetへの矢印を反転。他は変えない。',
      edges:[{type:'relation',id:'voice-target-to-source',from:'target',to:'source',kind:'flow',label:''}]},
    {id:'remove',action:'remove-edge',edge:'voice-target-to-source',text:'TargetからSourceへの矢印を削除。他は変えない。',edges:[]},
  ];
  const rootRecords=initialRecords.filter(r=>r.type!=='relation');
  const initialEdges=[{type:'relation',id:'voice-source-to-target',from:'source',to:'target',kind:'flow',label:''}];
  let priorEdges=initialEdges;
  const audit=async(stage,expectedEdges)=>{
    const ui=await snapshot(),expectedRecords=[...rootRecords,...expectedEdges];
    // For an exact-state check the complete independent target is the baseline
    // with an empty expected delta. This also checks every retained symbol.
    const reduced=await protocol.verifyDecisionLog(ui.log);
    const result=await auditReducedView({log:ui.log,ui,initialRecords:expectedRecords,
      oracle:{expected_added_regions:[],expected_added_edges:[]},protocol});
    const exact=JSON.stringify(bag(reduced.records))===JSON.stringify(bag(expectedRecords));
    await save({stage,expectedRecords,actual:ui,audit:{...result,exact_records:exact}});
    assert.equal(result.status,'PASS');assert.equal(exact,true,'independent complete state after an edit');
    await paint(stage,ui);
    return ui;
  };
  try {
    await audit('edit-initial',initialEdges);
    for(const row of requests){
      const before=await snapshot();setEdit({action:row.action,edge:row.edge});
      const send=async()=>{await page.locator('#text').fill(row.text);await page.locator('#send').click();await settle();};
      await send();const after=await audit('edit-'+row.id,row.edges);
      assert.notEqual(after.log,before.log,'the editing action must actually change state');assert.equal(after.stored,before.stored);
      await page.locator('#undo').click();await settle();
      const undone=await audit('edit-'+row.id+'-undo',priorEdges);assert.equal(undone.log,before.log);
      await send();const redone=await audit('edit-'+row.id+'-redo',row.edges);
      await page.locator('#apply').click();await settle();
      const applied=await audit('edit-'+row.id+'-apply',row.edges);assert.equal(applied.stored,redone.log);
      await page.reload();await settle();const restored=await audit('edit-'+row.id+'-reload',row.edges);
      assert.equal(restored.log,applied.stored);priorEdges=row.edges;
    }
    // Inverse of the last saved removal, then Undo, then save and reopen that
    // inverse. Uses the app's history button, not a fabricated working graph.
    setEdit(null);
    const removed=await snapshot();
    const inverse=async()=>{await page.locator('#history button[data-revert]').last().click();await settle();};
    await inverse();await audit('history-inverse',requests[0].edges);
    await page.locator('#undo').click();await settle();
    const undone=await audit('history-inverse-undo',[]);assert.equal(undone.log,removed.log);
    await inverse();const restored=await audit('history-inverse-redo',requests[0].edges);
    await page.locator('#apply').click();await settle();const applied=await audit('history-inverse-apply',requests[0].edges);
    assert.equal(applied.stored,restored.log);
    await page.reload();await settle();const reloaded=await audit('history-inverse-reload',requests[0].edges);
    assert.equal(reloaded.log,applied.stored);
  } finally {setEdit(null);}
}

// Undoing an entry that has already been saved is a new, uncommitted inverse.
// The fixed pre-edit records are its expectation, not a model verdict.
export async function checkStoredHistoryInverse({page,snapshot,settle,protocol,beforeRecords,save,paint}) {
  const edited = await snapshot();
  const audit = async(stage,records) => {
    const ui = await snapshot();
    const reduced = await protocol.verifyDecisionLog(ui.log);
    const result = await auditReducedView({log:ui.log,ui,initialRecords:records,
      oracle:{expected_added_regions:[],expected_added_edges:[]},protocol});
    const exact = JSON.stringify(bag(reduced.records)) === JSON.stringify(bag(records));
    await save({stage,expectedRecords:records,actual:ui,audit:{...result,exact_records:exact}});
    assert.equal(result.status,'PASS');assert.equal(exact,true);
    await paint(stage,ui);
    return ui;
  };
  const inverse = async()=>{await page.locator('#history button[data-revert]').last().click();await settle();};
  await inverse();const first=await audit('saved-history-inverse',beforeRecords);
  assert.notEqual(first.log,edited.log);assert.equal(first.stored,edited.stored);
  await page.locator('#undo').click();await settle();
  const undone=await audit('saved-history-inverse-undo',edited.records);assert.equal(undone.log,edited.log);
  await inverse();const redone=await audit('saved-history-inverse-redo',beforeRecords);
  await page.locator('#apply').click();await settle();
  const applied=await audit('saved-history-inverse-apply',beforeRecords);assert.equal(applied.stored,redone.log);
  await page.reload();await settle();
  const reopened=await audit('saved-history-inverse-reload',beforeRecords);assert.equal(reopened.log,applied.stored);
}
