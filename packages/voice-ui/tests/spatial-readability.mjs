import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { overviewLabels } from './camera-evidence.mjs';
import { observePaintedGoal, assessPaintedEdge } from './painted-goal.mjs';
import { auditReferenceDiagram } from './reference-diagram-audit.mjs';

const box = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  && value[2] > 0 && value[3] > 0;
const inside = (inner, outer) => box(inner) && box(outer) && inner[0] >= outer[0] && inner[1] >= outer[1]
  && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];
const overlaps = (left, right) => box(left) && box(right) && left[0] < right[0] + right[2]
  && right[0] < left[0] + left[2] && left[1] < right[1] + right[3] && right[1] < left[1] + left[3];
const points = values => Array.isArray(values) && values.length === 33 && values.every(point =>
  Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));

const intersection = (left, right) => {
  if (!left || !right) return null;
  const low = Math.max(left[0], right[0]), high = Math.min(left[1], right[1]);
  return low <= high ? [low, high] : null;
};
const linearInterval = (origin, slope, low, high) => slope === 0
  ? (origin >= low && origin <= high ? [0, 1] : null)
  : intersection([0, 1], [Math.min((low - origin) / slope, (high - origin) / slope),
    Math.max((low - origin) / slope, (high - origin) / slope)]);
const circleInterval = (a, dx, dy, square, center, radius) => {
  const x = a[0] - center[0], y = a[1] - center[1];
  const cross = x * dy - y * dx, remaining = radius * radius - cross * cross / square;
  if (remaining < 0) return null;
  const middle = -(x * dx + y * dy) / square, half = Math.sqrt(remaining / square);
  return intersection([0, 1], [middle - half, middle + half]);
};

// Integrate the exact near length of these finite sampled polylines. Each
// other segment's radius capsule is a projected strip plus its endpoint
// circles. Union their intervals on each query segment before summing length:
// partial segments count, and overlapping capsules never count twice.
// This does not infer unobserved SVG curves or general human readability.
export function nearLengthFraction(route, other, tolerance) {
  assert.ok(points(route) && points(other) && Number.isFinite(tolerance) && tolerance >= 0);
  let total = 0, shared = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], dx = route[i][0] - a[0], dy = route[i][1] - a[1];
    const square = dx * dx + dy * dy, length = Math.sqrt(square), intervals = [];
    total += length;
    if (length === 0) continue;
    for (let j = 1; j < other.length; j++) {
      const c = other[j - 1], d = other[j], vx = d[0] - c[0], vy = d[1] - c[1];
      const segmentSquare = vx * vx + vy * vy, x = a[0] - c[0], y = a[1] - c[1];
      const radiusCross = tolerance * Math.sqrt(segmentSquare);
      const strip = segmentSquare === 0 ? null : intersection(
        linearInterval(x * vx + y * vy, dx * vx + dy * vy, 0, segmentSquare),
        linearInterval(x * vy - y * vx, dx * vy - dy * vx, -radiusCross, radiusCross));
      for (const interval of [strip, circleInterval(a, dx, dy, square, c, tolerance),
        circleInterval(a, dx, dy, square, d, tolerance)]) if (interval) intervals.push(interval);
    }
    intervals.sort((left, right) => left[0] - right[0]);
    let end = 0, covered = 0;
    for (const [low, high] of intervals) if (high > end) {
      covered += high - Math.max(low, end); end = high;
    }
    shared += covered * length;
  }
  return total > 0 ? Math.max(0, Math.min(1, shared / total)) : 1;
}

// Require independently traceable paths and readable annotations, not just
// one existing shape per semantic ID. This finite sampled-route test does not
// prove arbitrary edge routing, glyph ink, occlusion or all graph sizes.
export function assessParallelRelations(expected, observations) {
  assert.ok(Array.isArray(expected) && expected.length >= 2, 'at least two expected relations');
  assert.equal(new Set(expected.map(edge => edge.id)).size, expected.length);
  assert.ok(expected.every(edge => edge.from === expected[0].from && edge.to === expected[0].to));
  const problems = [], unknown = [], routes = [], names = [], comparisons = [];
  for (const edge of expected) {
    const found = observations.filter(item => item.edge?.id === edge.id);
    if (found.length !== 1) { unknown.push(edge.id + ': missing or duplicate observation'); continue; }
    const observation = found[0], actual = observation.edge;
    if (!['id', 'from', 'to', 'kind', 'label'].every(key => actual[key] === edge[key]))
      { problems.push(edge.id + ': wrong relation identity or meaning'); continue; }
    const complete = assessPaintedEdge(observation);
    if (complete.status !== 'PASS') unknown.push(edge.id + ': single-edge visibility not established');
    const route = actual.matches?.length === 1 ? actual.matches[0].route : null;
    if (!points(route?.samples)) unknown.push(edge.id + ': route unavailable');
    else {
      const stroke = actual.matches[0].stroke;
      if (!(Number.isFinite(stroke) && stroke > 0)) unknown.push(edge.id + ': stroke width unavailable');
      routes.push({ id: edge.id, points: route.samples, stroke: Number.isFinite(stroke) && stroke > 0 ? stroke : 0 });
    }
    if (edge.label) {
      const name = actual.name;
      if (!name || name.unmet !== null || !Array.isArray(name.clips)) unknown.push(edge.id + ': annotation unavailable');
      else if (![name.svg, observation.viewport, ...name.clips].every(clip => inside(name.box, clip)))
        problems.push(edge.id + ': annotation clipped');
      else names.push({ id: edge.id, box: name.box });
    }
  }
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    const left = routes[i], right = routes[j];
    // A single far sample cannot prove two otherwise shared strokes readable.
    // Compare sampled polylines in either direction and account for stroke
    // width. Shared endpoints alone are allowed. This is a finite sampled
    // rejection rule, not a claim about arbitrary curves or human perception.
    const tolerance = Math.max(0.5, (left.stroke + right.stroke) / 2 + 0.25);
    const fractions = [nearLengthFraction(left.points, right.points, tolerance),
      nearLengthFraction(right.points, left.points, tolerance)];
    comparisons.push({ ids: [left.id, right.id], tolerance, nearLengthFractions: fractions });
    if (Math.max(...fractions) >= 0.5)
      problems.push(left.id + ' / ' + right.id + ': coincident or near-coincident painted routes over at least half the sampled length');
  }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    if (overlaps(names[i].box, names[j].box)) problems.push(names[i].id + ' / ' + names[j].id + ': overlapping annotations');
  return { status: problems.length ? 'UNMET' : unknown.length ? 'UNPROVEN' : 'PASS',
    scope: 'FIXED_PARALLEL_PATHS_AND_ANNOTATIONS', expected: expected.map(edge => ({ ...edge })), problems, unknown, comparisons };
}

export function assessWholeOverview(observation, expectedIds) {
  const result = overviewLabels(observation, expectedIds), collisions = [];
  const names = expectedIds.map(id => observation.shapes.find(shape => shape.id === id));
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    if (overlaps(names[i]?.name?.box, names[j]?.name?.box)) collisions.push([expectedIds[i], expectedIds[j]]);
  return { ...result, status: result.status === 'PASS' && collisions.length === 0 ? 'PASS' : 'UNMET', collisions };
}

const unchanged = (after, before) => {
  assert.equal(after.head, before.head); assert.equal(after.log, before.log); assert.equal(after.stored, before.stored);
  assert.deepEqual(after.records, before.records, 'presentation never changes the graph');
};
const writeEvidence = (output, shot, value) => {
  const file = shot.png.replace(/\.png$/u, '-spatial.json');
  fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return file;
};

// Actual browser size changes use the app's own resize handler. No replacement
// renderer, manufactured graph, hidden failing standard view or modified UI.
export async function checkOverviewArea({ page, snapshot, settle, saveCamera, fixture, stage, protocol, initialRecords, output }) {
  const original = await snapshot(), viewport = page.viewportSize(), results = [];
  try {
    await page.locator('#camera-part').selectOption(''); await settle();
    for (const profile of [
      { id: 'standard', width: 1280, height: 720 },
      { id: 'wide', width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize({ width: profile.width, height: profile.height });
      await page.waitForFunction(({ width, height }) => {
        const mount = document.querySelector('#working-surface');
        const runtime = mount.querySelector('iframe')?.contentWindow?.semanticMapRuntime;
        return innerWidth === width && innerHeight === height && document.body.dataset.state !== 'pending'
          && runtime?.view?.frame?.viewport?.[0] === mount.clientWidth
          && runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
      }, profile, { timeout: 180000 });
      await settle();
      const state = await snapshot(); unchanged(state, original);
      const verified = await auditReferenceDiagram({ log: state.log, ui: state, expected: fixture.reference, initialRecords, protocol, stage });
      assert.equal(verified.status, 'PASS');
      const stored = await protocol.verifyDecisionLog(state.stored);
      // The stored graph can legitimately be older before Apply; verify it,
      // but never rewrite the expected working state from that stored graph.
      assert.equal(typeof stored.head, 'string');
      const regions = state.records.filter(row => row.type === 'region' && row.parent !== null);
      const observation = await page.evaluate(observePaintedGoal, {
        container: state.records.find(row => row.id === 'aws'), records: regions, identity: true,
      });
      const assessment = assessWholeOverview(observation, regions.map(row => row.id));
      const shot = await saveCamera(stage + '-area-' + profile.id, observation);
      const value = { source: shot.source, fixture: fixture.id, stage, profile, state, expected: fixture.reference,
        initialRecords, storedHead: stored.head, reduced: verified, observation, assessment };
      results.push({ profile: profile.id, ...assessment, viewport: profile, frame: state.view.frame,
        file: writeEvidence(output, shot, value), png: shot.png, head: state.head });
    }
  } finally {
    await page.setViewportSize(viewport);
    await page.waitForFunction(({ width, height }) => {
      const mount = document.querySelector('#working-surface');
      const runtime = mount.querySelector('iframe')?.contentWindow?.semanticMapRuntime;
      return innerWidth === width && innerHeight === height && document.body.dataset.state !== 'pending'
        && runtime?.view?.frame?.viewport?.[0] === mount.clientWidth
        && runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
    }, viewport, { timeout: 180000 });
    await page.locator('#camera-part').selectOption(original.camera); await settle();
    const returned = await snapshot(); unchanged(returned, original);
    assert.deepEqual(returned.view, original.view); assert.equal(returned.camera, original.camera);
    await saveCamera(stage + '-area-returned');
  }
  return { fixture: fixture.id, stage, profiles: results, restored: true,
    scope: 'SAME_REFERENCE_SUBSET_AND_LOG; STANDARD_AND_WIDE_ARE_SEPARATE' };
}

// Observe all same-direction relations in one frame, then restore the original
// view. Missing paths/labels and overlaps remain failures after save/reload.
export async function checkParallelViews({ page, snapshot, settle, saveCamera, expectedRecords, stage, output }) {
  const original = await snapshot(), byPair = new Map(), results = [];
  for (const edge of expectedRecords.filter(row => row.type === 'relation')) {
    const key = JSON.stringify([edge.from, edge.to]);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(edge);
  }
  try {
    for (const expected of [...byPair.values()].filter(edges => edges.length > 1)) {
      await page.locator('#camera-part').selectOption(expected[0].id); await settle();
      const state = await snapshot(); unchanged(state, original);
      const observations = [];
      for (const edge of expected) {
        observations.push(await page.evaluate(observePaintedGoal, {
          container: state.records.find(row => row.id === 'container'),
          records: [edge.from, edge.to].map(id => state.records.find(row => row.type === 'region' && row.id === id)),
          edge, identity: true,
        }));
      }
      const assessment = assessParallelRelations(expected, observations);
      const shot = await saveCamera(stage + '-parallel', { observations, assessment });
      const file = writeEvidence(output, shot, { source: shot.source, stage, expected, state, observations, assessment });
      results.push({ ...assessment, head: state.head, camera: state.camera, frame: state.view.frame, file, png: shot.png });
    }
  } finally {
    await page.locator('#camera-part').selectOption(original.camera); await settle();
    const returned = await snapshot(); unchanged(returned, original);
    assert.deepEqual(returned.view, original.view);
  }
  return { stage, groups: results, restored: true, scope: 'DECLARED_SAME_DIRECTION_RELATION_GROUPS' };
}
