// Overview crossing count used by the apps tests. Geometry is the generic
// three-column overview: one column per area (presentation order), entities
// stacked by `order` within their area, drawn relations (visible !== false; containment is drawn as
// nesting, not as a line)
// as straight segments between columns and as arcs inside one column.
// Pairs sharing an endpoint never count. This mirrors ui tests/fixtures/
// atlas-crossings.mjs by construction, not by import (no ui dependency here).
const key = value => JSON.stringify([value.space, value.kind, value.id]);
const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

export const frameCrossings = (world, frame) => {
  const column = new Map(world.presentation.areas.map(area => [area.id, area.order]));
  const point = new Map();
  for (const area of world.presentation.areas)
    frame.entities.filter(value => value.area === area.id && value.visible !== false).sort((a, b) => a.order - b.order)
      .forEach((value, rank) => point.set(key(value.ref), [column.get(area.id), rank]));
  const lines = frame.relations.filter(value => value.visible !== false && !value.containment && point.has(key(value.from)) && point.has(key(value.to)))
    .map(value => ({ id: value.ref.id, ends: [key(value.from), key(value.to)], a: point.get(key(value.from)), b: point.get(key(value.to)) }));
  const crossings = [];
  for (let i = 0; i < lines.length; i += 1) for (let j = i + 1; j < lines.length; j += 1) {
    const p = lines[i], q = lines[j];
    if (p.ends.some(end => q.ends.includes(end))) continue;
    const pIn = p.a[0] === p.b[0], qIn = q.a[0] === q.b[0];
    let cross = false;
    if (pIn && qIn) {
      if (p.a[0] === q.a[0]) {
        const [p1, p2] = [p.a[1], p.b[1]].sort((x, y) => x - y), [q1, q2] = [q.a[1], q.b[1]].sort((x, y) => x - y);
        cross = (p1 < q1 && q1 < p2 && p2 < q2) || (q1 < p1 && p1 < q2 && q2 < p2);
      }
    } else if (!pIn && !qIn) {
      cross = side(p.a, p.b, q.a) * side(p.a, p.b, q.b) < 0 && side(q.a, q.b, p.a) * side(q.a, q.b, p.b) < 0;
    }
    if (cross) crossings.push([p.id, q.id]);
  }
  return crossings;
};
export const worldCrossings = world => world.frames.map(frame => ({ id: frame.id, crossings: frameCrossings(world, frame).length }));
