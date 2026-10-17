// Shared actual-SVG observation, extracted from the existing architecture proof.
export function observePaintedGoal({ container, records, edge = null, identity = false }) {
  const iframe = document.querySelector("#working-surface iframe[data-package=semantic-map]");
  const doc = iframe.contentDocument;
  const visible = node => {
    if (!node) return false;
    for (let parent = node; parent !== null; parent = parent.parentElement) {
      const style = iframe.contentWindow.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const box = node => {
    if (!node) return null;
    const r = node.getBoundingClientRect(), style = iframe.contentWindow.getComputedStyle(node);
    return [r.left, r.top, r.width, r.height].every(Number.isFinite)
      && r.width > 0 && r.height > 0 && visible(node) && style.display !== "none" && style.visibility !== "hidden"
      ? [r.left, r.top, r.width, r.height] : null;
  };
  const uniquePrimitive = geometry => geometry.length === 1 ? geometry[0] : null;
  // The one rendered node whose whole text is the label, or null.
  const owned = (record, role) => {
    const nodes = [...doc.querySelectorAll("[data-semantic-region-id]")].filter(node =>
      node.getAttribute("data-semantic-region-id") === record.id && node.getAttribute("data-semantic-role") === role);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const labelNode = record => {
    const group = identity ? owned(record, "text") : doc;
    const labels = [...(group?.querySelectorAll("svg text, svg foreignObject, text, foreignObject") ?? [])]
      .filter(node => node.textContent.trim() === record.label);
    return labels.length === 1 ? labels[0] : null;
  };
  // The full name an end shows, from that same label node: one plain, visible,
  // filled SVG text holding the whole name; its glyph-cell box (getBBox) mapped
  // by its own screen matrix; every native clip of an ancestor, read from the
  // computed clip-path as this document's own URL and fragment naming exactly
  // one clipPath of one rect in user space with no transform or nested clip,
  // mapped by the matrix of the element that references it; the padding box of
  // every HTML ancestor whose overflow clips; and the nearest SVG viewport.
  // Every matrix must be finite, axis-aligned and positive. Anything else is
  // unmet. Glyph cells are not ink, and nothing here sees what is painted over
  // the text.
  const SVG = "http://www.w3.org/2000/svg";
  const win = iframe.contentWindow;
  // Chromium's computed rgb/rgba grammar only. Unknown paint grammar is not
  // evidence of visible paint, including transparent RGB with fillOpacity 1.
  const paintedColor = value => {
    const match = /^rgba?\(([^)]+)\)$/u.exec(value ?? "");
    if (!match) return false;
    const channels = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
    return [3, 4].includes(channels.length) && channels.every(Number.isFinite)
      && channels.slice(0, 3).every(channel => channel >= 0 && channel <= 255)
      && (channels.length === 3 || channels[3] > 0 && channels[3] <= 1);
  };
  const documentUrl = doc.URL.lastIndexOf("#") > 0 ? doc.URL.slice(0, doc.URL.lastIndexOf("#")) : doc.URL;
  const axis = matrix => matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)
    && matrix.b === 0 && matrix.c === 0 && matrix.a > 0 && matrix.d > 0 ? matrix : null;
  const mapped = (matrix, [x, y, width, height]) => [matrix.a * x + matrix.e, matrix.d * y + matrix.f, matrix.a * width, matrix.d * height];
  const fragmentOf = value => {
    const url = /^url\("(.+)"\)$/u.exec(value ?? "")?.[1] ?? "";
    const at = url.lastIndexOf("#");
    return at > 0 && url.slice(0, at) === documentUrl && url.length > at + 1 ? url.slice(at + 1) : null;
  };
  // The clip's own declared shape: one rect in user space, no transform or nested clip.
  const clipGrammar = clip => {
    const untransformed = node => !node.hasAttribute("transform") && !node.hasAttribute("clip-path");
    if (clip?.localName !== "clipPath" || clip.namespaceURI !== SVG || ![null, "userSpaceOnUse"].includes(clip.getAttribute("clipPathUnits"))
      || !untransformed(clip) || clip.children.length !== 1) return null;
    const rect = clip.children[0];
    if (rect.localName !== "rect" || rect.namespaceURI !== SVG || !untransformed(rect)) return null;
    const bounds = ["x", "y", "width", "height"].map(name => Number(rect.getAttribute(name)));
    return bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0 ? bounds : null;
  };
  // And, rendered, no clip or transform of its own from style.
  const clipRectOf = clip => {
    const bounds = clipGrammar(clip);
    return bounds !== null && [clip, clip.children[0]].every(node => {
      const style = win.getComputedStyle(node);
      return style.clipPath === "none" && style.transform === "none";
    }) ? bounds : null;
  };
  const nameOf = node => {
    const unmet = reason => ({ unmet: reason, box: null, clips: [], svg: null });
    if (node === null) return unmet("no unique label with the whole name");
    const painted = win.getComputedStyle(node);
    if (!visible(node) || !paintedColor(painted.fill) || !(Number(painted.fillOpacity) > 0)) return unmet("the name is not painted visibly");
    if (node.localName !== "text" || node.namespaceURI !== SVG || node.children.length !== 0
      || [...(node.parentElement?.children ?? [])].filter(child => child.localName === "text").length !== 1) return unmet("not one plain SVG text");
    const own = axis(node.getScreenCTM());
    if (own === null) return unmet("the text's matrix is not axis-aligned and positive");
    let cells;
    try { cells = node.getBBox(); } catch { return unmet("no glyph-cell box"); }
    const box = mapped(own, [cells.x, cells.y, cells.width, cells.height]);
    const owner = node.ownerSVGElement;
    const viewport = owner?.getBoundingClientRect();
    const clips = [];
    for (let at = node; at !== null; at = at.parentElement) {
      const style = win.getComputedStyle(at);
      if (at.namespaceURI === "http://www.w3.org/1999/xhtml" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const r = at.getBoundingClientRect();
        const padding = [r.left + at.clientLeft, r.top + at.clientTop, at.clientWidth, at.clientHeight];
        if (!padding.every(Number.isFinite)) return unmet(`unsupported overflow of ${at.localName}`);
        clips.push(padding);
      }
      const value = style.clipPath;
      if (value === "none") continue;
      const id = fragmentOf(value);
      const found = id === null ? [] : [...doc.querySelectorAll("clipPath")].filter(clip => clip.id === id);
      const rect = found.length === 1 ? clipRectOf(found[0]) : null;
      const by = at.namespaceURI === SVG && typeof at.getScreenCTM === "function" ? axis(at.getScreenCTM()) : null;
      if (rect === null || by === null) return unmet(`unsupported clip ${value}`);
      clips.push(mapped(by, rect));
    }
    if (!owner || !viewport) return unmet("no nearest SVG viewport");
    return { unmet: null, box, clips, svg: [viewport.left, viewport.top, viewport.width, viewport.height] };
  };
  // Controlled refusals of the name rules, on control values and detached
  // elements only; a supported name is proven by actual rendered frames.
  const detached = (build) => { const clip = doc.createElementNS(SVG, "clipPath"); build(clip); return clip; };
  const rectIn = (clip, attributes = {}) => {
    const rect = doc.createElementNS(SVG, "rect");
    for (const [name, value] of Object.entries({ x: "0", y: "0", width: "10", height: "10", ...attributes })) rect.setAttribute(name, value);
    clip.appendChild(rect);
    return rect;
  };
  const otherText = doc.createElementNS(SVG, "foreignObject");
  const hiddenName = doc.createElementNS(SVG, "g");
  const hiddenText = doc.createElementNS(SVG, "text");
  hiddenName.style.display = "none";
  hiddenName.appendChild(hiddenText); // Detached controlled tree, not the actual graph.
  if (fragmentOf(`url("${documentUrl}#clip")`) !== "clip"
    || [`url("#clip")`, `url("http://elsewhere.invalid/#clip")`, `url("${documentUrl}#")`, "none", ""].some(value => fragmentOf(value) !== null)
    || JSON.stringify(clipGrammar(detached(clip => { rectIn(clip, { x: "2", y: "3", width: "40", height: "20" }); }))) !== "[2,3,40,20]"
    || [null, detached(clip => { rectIn(clip); rectIn(clip); }),
      detached(clip => { clip.setAttribute("clipPathUnits", "objectBoundingBox"); rectIn(clip); }),
      detached(clip => { clip.setAttribute("transform", "scale(2)"); rectIn(clip); }),
      detached(clip => { rectIn(clip, { transform: "rotate(10)" }); }),
      detached(clip => { rectIn(clip, { width: "NaN" }); }),
      detached(clip => { clip.appendChild(doc.createElementNS(SVG, "circle")); })].some(clip => clipGrammar(clip) !== null)
    || clipRectOf(null) !== null
    || [{ a: 1, b: 0.5, c: 0, d: 1, e: 0, f: 0 }, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      { a: 1, b: 0, c: 0, d: NaN, e: 0, f: 0 }, null].some(matrix => axis(matrix) !== null)
    || nameOf(null).unmet === null || nameOf(otherText).unmet === null || nameOf(hiddenText).unmet === null)
    throw new Error("name-geometry controlled refusal failed");
  const shape = (record, boundary = false) => {
    const bound = labelNode(record);
    if (bound === null) return null;
    for (let group = bound.parentElement; group?.localName === "g"; group = group.parentElement) {
      const previous = group.previousElementSibling;
      if (previous?.localName === "g" && (!identity || previous === owned(record, "shape")) && !previous.querySelector("text, foreignObject")
        && previous.querySelector("rect, path, ellipse, polygon")) {
        const geometry = [...previous.children].filter(node => {
          if (!["rect", "path", "ellipse", "polygon"].includes(node.localName)) return false;
          const style = iframe.contentWindow.getComputedStyle(node);
          if (boundary) return node.localName === "rect" && style.stroke !== "none"
            && style.strokeDasharray !== "none" && Number(style.strokeOpacity) > 0 && Number(style.opacity) > 0;
          if (!identity && node.getAttribute("pointer-events") !== "all") return false;
          return Number(style.opacity) > 0 && ((paintedColor(style.fill) && Number(style.fillOpacity) > 0)
            || (paintedColor(style.stroke) && Number(style.strokeOpacity) > 0));
        });
        const primitive = uniquePrimitive(geometry);
        return primitive !== null && primitive.namespaceURI === "http://www.w3.org/2000/svg"
          && typeof primitive.getScreenCTM === "function" && typeof primitive.getTotalLength === "function"
          && typeof primitive.getPointAtLength === "function"
          && box(primitive) !== null ? primitive : null;
      }
    }
    return null;
  };
  const frame = box(shape(container, true));
  const primitives = records.map(record => shape(record, record.kind === "group"));
  const shapes = records.map((record, i) => ({ id: record.id, rawLabel: record.label, bounds: box(primitives[i]),
    name: nameOf(labelNode(record)) }));
  const inside = bounds => frame !== null && bounds !== null && bounds[0] >= frame[0] && bounds[1] >= frame[1]
    && bounds[0] + bounds[2] <= frame[0] + frame[2] && bounds[1] + bounds[3] <= frame[1] + frame[3];
  const overlap = (a, b) => a !== null && b !== null && a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
    && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  // The pinned classic marker starts at its tip (createArrow); ConnectorShape
  // paints the stroke and this filled marker in the same cell group. Match
  // actual screen-space terminals to the unique painted node shapes. This is
  // not an inference from the logical relation or a label clip.
  // Actual points on the painted perimeter give an upper bound on its nearest
  // distance, including multiple subpaths: never connect them with fake chords.
  const outline = (node, p, isVisible = visible(node)) => {
    if (!node || !isVisible || !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) return null;
    try {
      const matrix = node.getScreenCTM(), length = node.getTotalLength();
      const ctm = matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
      const determinant = matrix && matrix.a * matrix.d - matrix.b * matrix.c;
      if (!ctm || !ctm.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0
        || !Number.isFinite(length) || length <= 0) return null;
      const n = Math.ceil(length * Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d) / 0.5);
      if (!Number.isSafeInteger(n) || n < 1 || n > 32768) return null;
      let distanceUpper = Infinity;
      for (let i = 0; i <= n; i++) {
        const point = node.getPointAtLength(length * i / n);
        const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
        const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
        if (![x, y].every(Number.isFinite)) return null;
        distanceUpper = Math.min(distanceUpper, Math.hypot(x - p[0], y - p[1]));
      }
      return { tag: node.localName, ctm, samples: n + 1, distanceUpper };
    } catch { return null; }
  };
  // Controlled refusal inputs exercise the very same measurement path, not
  // producer geometry or evidence that a real rendered node was measured.
  const probeMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const probe = { localName: "controlled", getScreenCTM: () => probeMatrix,
    getTotalLength: () => 1, getPointAtLength: length => ({ x: length, y: 0 }) };
  const hidden = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  const hiddenChild = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  hidden.style.display = "none";
  hidden.appendChild(hiddenChild); // Detached controlled tree, not the actual graph.
  const refused = [null,
    { ...probe, getScreenCTM: () => null },
    { ...probe, getScreenCTM: () => ({ ...probeMatrix, a: NaN }) },
    { ...probe, getScreenCTM: () => ({ ...probeMatrix, d: 0 }) },
    { ...probe, getScreenCTM: () => ({ a: 1e155, b: 1e155, c: 1e155, d: 1e155, e: 0, f: 0 }),
      getTotalLength: () => 1e-155 },
    { ...probe, getTotalLength: () => 0 },
    { ...probe, getTotalLength: () => Infinity },
    { ...probe, getTotalLength: () => 32768 },
    { ...probe, getPointAtLength: () => ({ x: NaN, y: 0 }) }];
  if (outline(probe, [0, 0], true)?.distanceUpper !== 0
    || refused.some(node => outline(node, [0, 0], true) !== null)
    || outline(probe, [0, 0], false) !== null || visible(hiddenChild)
    || uniquePrimitive([]) !== null || uniquePrimitive([probe, probe]) !== null)
    throw new Error("actual-outline controlled refusal failed");
  const arrows = [];
  const observedEdges = [];
  if (edge !== null) for (const group of doc.querySelectorAll("svg g")) {
    if (identity) {
      if (typeof edge.id !== "string" || edge.id.length === 0) continue;
      let ids;
      try { ids = JSON.parse(group.getAttribute("data-semantic-relation-ids")); } catch { continue; }
      if (!Array.isArray(ids) || !ids.includes(edge.id) || group.getAttribute("data-semantic-role") !== "shape") continue;
    }
    const paths = [...group.children].filter(node => {
      if (node.localName !== "path" || !visible(node)) return false;
      const r = node.getBoundingClientRect(), s = iframe.contentWindow.getComputedStyle(node);
      return [r.left, r.top, r.width, r.height].every(Number.isFinite) && (r.width > 0 || r.height > 0)
        && s.display !== "none" && s.visibility !== "hidden";
    });
    const lines = paths.filter(node => {
      const s = iframe.contentWindow.getComputedStyle(node);
      return s.fill === "none" && paintedColor(s.stroke) && Number(s.opacity) > 0 && Number(s.strokeOpacity) > 0;
    });
    const markers = paths.filter(node => {
      const s = iframe.contentWindow.getComputedStyle(node);
      return paintedColor(s.fill) && paintedColor(s.stroke) && Number(s.opacity) > 0 && Number(s.fillOpacity) > 0
        && /z\s*$/iu.test(node.getAttribute("d") ?? "");
    });
    if (lines.length !== 1 || markers.length !== 1) {
      if (paths.length > 0) observedEdges.push({ lines: lines.length, markers: markers.length,
        paths: paths.map(node => { const s = iframe.contentWindow.getComputedStyle(node);
          return { d: node.getAttribute("d"), fill: s.fill, stroke: s.stroke, opacity: s.opacity,
            fillOpacity: s.fillOpacity, strokeOpacity: s.strokeOpacity,
            parent: node.parentElement.localName, parentChildren: node.parentElement.children.length }; }) });
      continue;
    }
    const line = lines[0], marker = markers[0];
    const point = (node, length) => {
      const matrix = node.getScreenCTM();
      if (matrix === null || !Number.isFinite(length)) return null;
      const p = node.getPointAtLength(length), screen = new iframe.contentWindow.DOMPoint(p.x, p.y).matrixTransform(matrix);
      return [screen.x, screen.y].every(Number.isFinite) ? [screen.x, screen.y] : null;
    };
    const length = line.getTotalLength(), markerLength = marker.getTotalLength();
    if (!(Number.isFinite(length) && length > 0 && Number.isFinite(markerLength) && markerLength > 0)) continue;
    const start = point(line, 0), end = point(line, length), tip = point(marker, 0);
    const beforeEnd = point(line, Math.max(0, length - 1));
    const from = outline(primitives[records.findIndex(item => item.id === edge.from)], start);
    const to = outline(primitives[records.findIndex(item => item.id === edge.to)], tip);
    const matrix = marker.getScreenCTM();
    const scale = matrix === null ? NaN : Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
    const stroke = Number.parseFloat(iframe.contentWindow.getComputedStyle(marker).strokeWidth) * scale;
    // Pinned createArrow shortens the tip by 1.118 stroke widths; SVG canvas
    // serializes coordinates at finite pixel precision. No layout-size slack.
    const padding = Number.isFinite(stroke) && stroke > 0 ? 1.118 * stroke + 1 : NaN;
    const directed = end !== null && tip !== null && beforeEnd !== null
      && (end[0] - beforeEnd[0]) * (tip[0] - end[0]) + (end[1] - beforeEnd[1]) * (tip[1] - end[1]) > 0;
    observedEdges.push({ start, end, tip, stroke, padding, lineLength: length, markerLength,
      fromOutline: from, toOutline: to,
      fromConnected: from !== null && from.distanceUpper <= padding,
      toConnected: to !== null && to.distanceUpper <= padding, directed });
    if (from !== null && to !== null && from.distanceUpper <= padding && to.distanceUpper <= padding && directed)
      arrows.push({ start, end, tip, stroke, padding, lineLength: length, markerLength });
  }
  return { association: identity ? "render-owned-semantic-id" : "pinned-maxgraph-shape-before-unique-raw-label",
    title: nameOf(labelNode(container)),
    identity,
    viewport: [0, 0, iframe.clientWidth, iframe.clientHeight],
    container: { id: container.id, kind: "painted-dashed-group-boundary", bounds: frame }, shapes,
    edge: edge === null ? null : { from: edge.from, to: edge.to,
      association: "pinned-classic-marker-tip-and-stroke-in-one-cell-group", observed: observedEdges, matches: arrows,
      complete: arrows.length === 1 },
    contained: shapes.every(item => inside(item.bounds)),
    nonoverlap: shapes.every((item, i) => shapes.every((other, j) => i === j || !overlap(item.bounds, other.bounds))),
    complete: frame !== null && shapes.every(item => item.bounds !== null) };
}
// These finite glyph/box checks do not prove ink overhang or arbitrary occlusion.
export function assessPaintedGoal(observation) {
  const problems = [], unknown = [];
  const valid = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
  const inside = (a, b) => valid(a) && valid(b) && a[0] >= b[0] && a[1] >= b[1]
    && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3];
  const overlap = (a, b) => valid(a) && valid(b) && a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
    && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  const name = (value, id) => {
    if (value?.unmet) { unknown.push(id + ": " + value.unmet); return; }
    if (!valid(value?.box) || !Array.isArray(value?.clips) || !inside(value.box, value.svg)
      || !value.clips.every(clip => inside(value.box, clip)) || !inside(value.box, observation.viewport))
      problems.push(id + ": whole label is clipped or outside viewport");
  };
  if (observation.identity !== true) unknown.push("identity-bound observation required");
  if (!observation.complete) unknown.push("shape association incomplete");
  if (!observation.contained) problems.push("shape outside parent");
  if (!observation.nonoverlap) problems.push("sibling shapes overlap");
  name(observation.title, "parent-title");
  if (!inside(observation.title?.box, observation.container?.bounds)) problems.push("parent title outside own shape box");
  for (const item of observation.shapes) {
    name(item.name, item.id);
    if (!inside(item.bounds, observation.viewport)) problems.push(item.id + ": child shape outside viewport");
    if (!inside(item.name?.box, item.bounds)) problems.push(item.id + ": label outside own shape box");
    if (overlap(item.name?.box, observation.title?.box) || overlap(item.bounds, observation.title?.box))
      problems.push(item.id + ": parent title overlaps child");
    for (const other of observation.shapes) if (other.id !== item.id && overlap(item.name?.box, other.name?.box))
      problems.push(item.id + ": sibling labels overlap");
  }
  if (observation.edge !== null && !observation.edge.complete) problems.push("directed painted edge incomplete");
  return { status: unknown.length ? "UNPROVEN" : problems.length ? "UNMET" : "PASS", problems, unknown };
}

// A relation camera may cross nested groups. Check its actual endpoints on
// this frame without pretending they are siblings or requiring a parent title.
export function assessPaintedEdge(observation) {
  const problems = [], unknown = [];
  const valid = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;
  const inside = (b, a) => valid(a) && valid(b) && b[0] >= a[0] && b[1] >= a[1]
    && b[0] + b[2] <= a[0] + a[2] && b[1] + b[3] <= a[1] + a[3];
  if (observation.identity !== true || observation.shapes.length !== 2) unknown.push("two identity-bound endpoints required");
  for (const shape of observation.shapes) {
    const name = shape.name;
    if (name?.unmet) unknown.push(shape.id + ": " + name.unmet);
    else if (!Array.isArray(name?.clips) || ![observation.viewport, name.svg, shape.bounds, ...name.clips]
      .every(outer => inside(name.box, outer))) problems.push(shape.id + ": whole endpoint name clipped or outside its shape");
  }
  if (!observation.edge?.complete) problems.push("directed painted edge incomplete");
  const match = observation.edge?.matches?.length === 1 ? observation.edge.matches[0] : null;
  const pointInView = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && valid(observation.viewport)
    && p[0] >= observation.viewport[0] && p[1] >= observation.viewport[1]
    && p[0] <= observation.viewport[0] + observation.viewport[2] && p[1] <= observation.viewport[1] + observation.viewport[3];
  if (!match || !pointInView(match.start) || !pointInView(match.tip)) problems.push("arrow terminals outside frame");
  return { status: unknown.length ? "UNPROVEN" : problems.length ? "UNMET" : "PASS", problems, unknown };
}

