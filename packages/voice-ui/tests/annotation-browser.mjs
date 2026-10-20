import assert from 'node:assert/strict';
import { observePaintedGoal } from './painted-goal.mjs';

// Exact text and measured glyph visibility. A logical label, menu caption or
// a new head alone is not evidence that the rendered edge annotation changed.
export function assessAnnotation(expected, captions, name, viewport) {
  const problems = [];
  const inside = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
    && [...a,...b].every(Number.isFinite) && a[2]>0 && a[3]>0 && b[2]>0 && b[3]>0
    && a[0]>=b[0] && a[1]>=b[1] && a[0]+a[2]<=b[0]+b[2] && a[1]+a[3]<=b[1]+b[3];
  if (!Array.isArray(captions) || captions.some(value => typeof value !== 'string')) return {status:'UNPROVEN',problems:['caption unavailable']};
  if (expected === '') {
    if (captions.some(value => value !== '')) problems.push('old annotation still painted');
  } else {
    if (captions.length !== 1 || captions[0] !== expected) problems.push('annotation differs from the fixed expectation');
    if (!name || name.unmet !== null || !Array.isArray(name.clips)
      || ![viewport,name.svg,...(name.clips??[])].every(bounds => inside(name.box,bounds))) problems.push('whole annotation is not visibly contained');
  }
  return {status:problems.length?'UNMET':'PASS',scope:'ONE_EXACT_EDGE_ANNOTATION',problems};
}

export async function checkAnnotationView({ page, snapshot, settle, saveCamera, expected, stage }) {
  const before = await snapshot();
  let result;
  try {
    assert.deepEqual(before.records.find(row=>row.type==='relation'&&row.id===expected.id),expected);
    await page.locator('#camera-part').selectOption(expected.id); await settle();
    const state = await snapshot();
    const observation = await page.evaluate(observePaintedGoal, {
      container:state.records.find(row=>row.id==='container'),
      records:[expected.from,expected.to].map(id=>state.records.find(row=>row.type==='region'&&row.id===id)),
      edge:expected,identity:true,
    });
    const captions = await page.evaluate(id => {
      const doc = document.querySelector('#working-surface iframe[data-package=semantic-map]').contentDocument;
      return [...doc.querySelectorAll('[data-semantic-role="text"][data-semantic-relation-ids]')].filter(node=>{
        try { const ids=JSON.parse(node.dataset.semanticRelationIds); return ids.length===1&&ids[0]===id; } catch { return false; }
      }).flatMap(node=>[...node.querySelectorAll('text,foreignObject')].map(text=>text.textContent));
    },expected.id);
    const assessment = assessAnnotation(expected.label,captions,observation.edge.name,observation.viewport);
    const shot = await saveCamera(stage+'-annotation',{expected,captions,observation,assessment});
    result={stage,expected,captions,head:state.head,png:shot.png,assessment};
    assert.equal(assessment.status,'PASS',JSON.stringify(result));
  } finally {
    await page.locator('#camera-part').selectOption(before.camera);await settle();
    const after=await snapshot();
    for(const field of ['head','log','stored','camera'])assert.equal(after[field],before[field]);
    assert.deepEqual(after.records,before.records);assert.deepEqual(after.view,before.view);
  }
  return result;
}
