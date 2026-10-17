import assert from "node:assert/strict";
import test from "node:test";
import { assessPaintedGoal, assessPaintedEdge } from "./painted-goal.mjs";

const name = box => ({ unmet: null, box, clips: [[0, 0, 600, 400]], svg: [0, 0, 600, 400] });
const observation = () => ({ identity: true, viewport: [0, 0, 600, 400], complete: true,
  contained: true, nonoverlap: true, container: { bounds: [0, 0, 400, 200] }, title: name([10, 10, 60, 16]), edge: null,
  shapes: [{ id: "a", bounds: [10, 40, 140, 70], name: name([20, 60, 80, 16]) },
    { id: "b", bounds: [170, 40, 140, 70], name: name([180, 60, 80, 16]) }] });
test("finite painted acceptance separates unsupported association from known clipping/overlap", () => {
  assert.equal(assessPaintedGoal(observation()).status, "PASS");
  for (const change of [x => { x.identity = false; }, x => { x.shapes[0].name.unmet = "unsupported clip"; }]) {
    const x = observation(); change(x); assert.equal(assessPaintedGoal(x).status, "UNPROVEN");
  }
  for (const change of [x => { x.title.box = [20, 60, 80, 16]; },
    x => { x.shapes[0].name.clips = [[0, 0, 30, 400]]; },
    x => { x.shapes[0].name.box = [0, 60, 80, 16]; },
    x => { x.shapes[1].name.box = x.shapes[0].name.box; },
    x => { x.title.box = [410, 10, 60, 16]; },
    x => { x.edge = { complete: false }; }]) {
    const x = observation(); change(x); assert.notEqual(assessPaintedGoal(x).status, "PASS");
  }
});
test("relation frame checks whole names against actual clips and arrow terminals", () => {
  const edge = () => ({ ...observation(), edge: { complete: true, matches: [{ start: [150, 70], tip: [170, 70] }] } });
  assert.equal(assessPaintedEdge(edge()).status, "PASS");
  for (const change of [x => { x.shapes[0].name.clips = [[0, 0, 25, 400]]; },
    x => { x.edge.matches[0].tip = [-10, 70]; }, x => { x.shapes[0].bounds = [0, 0, 20, 20]; }]) {
    const value = edge(); change(value); assert.notEqual(assessPaintedEdge(value).status, "PASS");
  }
});
