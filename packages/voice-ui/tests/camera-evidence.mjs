import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Files are immutable per observation, not per human camera label. Several
// nested groups and repeated lifecycle stages must never replace one another.
export function createCameraEvidence({ output, source }) {
  const items = [];
  return { items, async capture({ page, fixture, stage, snapshot, observation = null }) {
    const before = await snapshot();
    const display = await page.evaluate(() => {
      const menu = document.querySelector('#camera-part');
      const outside = document.querySelector('#out-of-view');
      return { camera: menu.value, label: menu.selectedOptions[0]?.textContent ?? '',
        outsideIds: outside.dataset.parts, outsideText: outside.textContent,
        viewport: [innerWidth, innerHeight], deviceScaleFactor: devicePixelRatio };
    });
    const identity = {fixture,stage,camera:display.camera,sequence:items.length+1};
    const name = `camera-${String(identity.sequence).padStart(4,'0')}-${hash(JSON.stringify(identity)).slice(0,24)}`;
    const png = await page.screenshot();
    const after = await snapshot();
    assert.equal(after.head,before.head,'capturing pixels must not change the reduced head');
    assert.equal(after.log,before.log);assert.equal(after.stored,before.stored);
    assert.ok(same(after.records,before.records) && same(after.view,before.view),'camera must stay fixed during capture');
    const currentCamera = await page.locator('#camera-part').inputValue();
    assert.equal(currentCamera,display.camera);
    const record = {schema:'voice-ui.camera-evidence/1',source,...identity,...display,
      head:before.head,log_sha256:hash(before.log),stored_sha256:typeof before.stored==='string'?hash(before.stored):null,
      frame:before.view?.frame??null,records_sha256:hash(JSON.stringify(before.records)),
      png:name+'.png',png_sha256:hash(png),observation};
    fs.writeFileSync(path.join(output,record.png),png,{flag:'wx'});
    fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    items.push(record);
    return record;
  } };
}

// An overview is not readable merely because every canonical record exists.
// Check all declared labels against actual glyph boxes and clipping rectangles.
export function overviewLabels(observation, expectedIds) {
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length)
    throw new TypeError("overview requires distinct expected IDs");
  const inside = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length===4 && b.length===4
    && [...a,...b].every(Number.isFinite) && a[2]>0 && a[3]>0 && b[2]>0 && b[3]>0
    && a[0]>=b[0] && a[1]>=b[1] && a[0]+a[2]<=b[0]+b[2] && a[1]+a[3]<=b[1]+b[3];
  const readable = [], unreadable = [];
  for(const id of expectedIds) {
    const matches=(observation.shapes??[]).filter(shape=>shape.id===id);
    const name=matches.length===1?matches[0].name:null;
    (name?.unmet===null && inside(name.box,name.svg) && inside(name.box,observation.viewport)
      && Array.isArray(name.clips) && name.clips.every(clip=>inside(name.box,clip))?readable:unreadable).push(id);
  }
  return {status:unreadable.length?'UNMET':'PASS',scope:'DECLARED_LABELS_IN_ONE_OVERVIEW_ONLY',expected:expectedIds.length,readable,unreadable};
}
