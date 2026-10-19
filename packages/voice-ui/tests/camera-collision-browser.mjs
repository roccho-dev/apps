import assert from 'node:assert/strict';
import {observePaintedGoal,assessPaintedEdge} from './painted-goal.mjs';
import {overviewLabels} from './camera-evidence.mjs';

// Exercise each actual menu option for this one adversarial fixture. Other
// fixtures retain their declared observation cameras, not an all-menu claim.
export async function checkCollisionCameras({page,snapshot,settle,saveCamera,stage}) {
  const entry=await snapshot();
  const menu=page.locator('#camera-part');
  const selected=await menu.inputValue();
  const options=await page.locator('#camera-part option').evaluateAll(items=>items.map(x=>({id:x.value,label:x.textContent})));
  const targets=entry.records.filter(x=>x.type==='relation'||x.type==='region'&&x.parent!==null);
  assert.deepEqual(options.map(x=>x.id).sort(),['',...targets.map(x=>x.id)].sort(),'no real camera target is dropped');
  assert.equal(new Set(options.map(x=>x.label)).size,options.length,'all actual option captions distinguish their subjects');
  const results=[];
  try {
    for(const option of options) {
      await menu.selectOption(option.id);await settle();
      const current=await snapshot();
      assert.equal(current.head,entry.head);assert.equal(current.log,entry.log);assert.equal(current.stored,entry.stored);
      assert.deepEqual(current.records,entry.records);assert.equal(current.camera,option.id);
      if(option.id===''){await saveCamera(stage+'-all-menu-overview');continue;}
      const target=targets.find(x=>x.id===option.id);
      let observation,assessment;
      if(target.type==='relation') {
        observation=await page.evaluate(observePaintedGoal,{container:entry.records.find(x=>x.id==='container'),
          records:[target.from,target.to].map(id=>entry.records.find(x=>x.id===id)),edge:target,identity:true});
        assessment=assessPaintedEdge(observation);
      } else {
        assert.ok(option.label.includes(target.label),'the displayed identity retains its actual name');
        observation=await page.evaluate(observePaintedGoal,{container:entry.records.find(x=>x.id==='container'),records:[target],identity:true});
        assessment=overviewLabels(observation,[target.id]);
      }
      await saveCamera(stage+'-all-menu',observation);
      results.push({id:target.id,label:option.label,status:assessment.status});
      assert.equal(assessment.status,'PASS','selected subject is actually readable: '+JSON.stringify(results.at(-1)));
    }
    // Actual DOM negative, not an invented observation: shrink the selected
    // SVG viewport while leaving the glyph and the application state intact.
    const target=targets.find(x=>x.type==='region'&&x.label==='Task');
    assert.ok(target);await menu.selectOption(target.id);await settle();
    const args={container:entry.records.find(x=>x.id==='container'),records:[target],identity:true};
    const unclipped=await page.evaluate(observePaintedGoal,args);
    assert.equal(overviewLabels(unclipped,[target.id]).status,'PASS','negative starts with the actual readable target');
    const style=await page.evaluate(id=>{
      const doc=document.querySelector('#working-surface iframe').contentDocument;
      const text=[...doc.querySelectorAll('[data-semantic-role="text"]')].find(x=>x.dataset.semanticRegionId===id);
      const svg=text.closest('svg'),saved=svg.getAttribute('style');
      // The fixed renderer sets min-width/min-height to the whole scene.
      // A width alone does not clip it; keep the glyph fixed and bound the SVG.
      for(const [name,value] of [['min-width','0px'],['min-height','0px'],['max-width','1px'],['max-height','1px'],
        ['width','1px'],['height','1px'],['overflow','hidden']]) svg.style.setProperty(name,value,'important');
      return saved;
    },target.id);
    try {
      const observation=await page.evaluate(observePaintedGoal,args);
      const assessment=overviewLabels(observation,[target.id]);
      await saveCamera(stage+'-negative-svg-clipped',observation);
      const beforeName=unclipped.shapes[0].name,afterName=observation.shapes[0].name;
      assert.equal(afterName.unmet,null,'control must not merely hide or invalidate the text');
      assert.deepEqual(afterName.box,beforeName.box,'control keeps the real glyph position and size');
      assert.deepEqual(afterName.clips,beforeName.clips,'control changes no outer clip');
      assert.deepEqual(observation.viewport,unclipped.viewport);
      assert.ok(afterName.svg[2]>0&&afterName.svg[2]<=1&&afterName.svg[3]>0&&afterName.svg[3]<=1,
        'the actual own-SVG viewport, not just requested CSS, must shrink');
      assert.equal(assessment.status,'UNMET','SVG-clipped glyph must never pass');
      results.push({id:target.id,control:'svg-clipped',status:'DETECTED',beforeSvg:beforeName.svg,afterSvg:afterName.svg});
    } finally {
      await page.evaluate(({id,style})=>{
        const doc=document.querySelector('#working-surface iframe').contentDocument;
        const text=[...doc.querySelectorAll('[data-semantic-role="text"]')].find(x=>x.dataset.semanticRegionId===id);
        const svg=text.closest('svg');if(style===null)svg.removeAttribute('style');else svg.setAttribute('style',style);
      },{id:target.id,style});
      const returned=await page.evaluate(observePaintedGoal,args);
      assert.deepEqual(returned.shapes[0].name,unclipped.shapes[0].name,'restore the original SVG and glyph after the control');
      assert.equal(overviewLabels(returned,[target.id]).status,'PASS');
    }
  } finally {
    await menu.selectOption(selected);await settle();
    const restored=await snapshot();assert.equal(restored.head,entry.head);assert.equal(restored.log,entry.log);
    assert.equal(restored.stored,entry.stored);assert.deepEqual(restored.records,entry.records);assert.deepEqual(restored.view,entry.view);
  }
  return {stage,status:'PASS',scope:'THIS_FIXTURE_ALL_MENU_OPTIONS_AND_SVG_NEGATIVE',options,results};
}
