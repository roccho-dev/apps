import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact } from "../tests/runtime-acceptance.mjs";
import { observePaintedGoal, assessPaintedGoal, assessPaintedEdge } from "../tests/painted-goal.mjs";
import { gradeGraph, canonical } from "../tests/semantic-score.mjs";
import { auditReducedView } from "../tests/reduced-view-audit.mjs";
import { symbolFixtureSvg, checkPaintedSymbols } from "../tests/part-symbol-browser.mjs";

// Keyless completed-artifact mechanics only. Every upstream response below is
// synthetic, including the TypeLLM result; no model quality is asserted here.
assertNoSecretInputs();
const [root, output] = process.argv.slice(2);
assert.ok(path.isAbsolute(root) && path.isAbsolute(output));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = fs.readFileSync(path.join(root, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
loadAcceptanceArtifact({ artifactRoot: root, expectedAppsSha: manifest.sources.apps,
  expectedManifestSha256: hash(manifestBytes) });
for (const row of manifest.files) {
  const file = path.resolve(root, row.path);
  assert.ok(file.startsWith(root + path.sep));
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
}
const { default: worker } = await import(pathToFileURL(path.join(root, "worker/worker.mjs")));
const protocol = await import(pathToFileURL(path.join(root, "site/ui/semantic-map/protocol/index.js")));
const { chromium } = createRequire(import.meta.url)("playwright-core");
const site = path.join(root, "site"), key = "voice-ui.decision-log.v1";
const normalBytes = fs.readFileSync(new URL("../tests/fixtures/normal-composition/browser.jsonl", import.meta.url));
const normalFixtures = normalBytes.toString("utf8").trim().split("\n").map(JSON.parse);
const editingBytes = fs.readFileSync(new URL("../tests/fixtures/normal-composition/editing.jsonl", import.meta.url));
const editingFixtures = editingBytes.toString("utf8").trim().split("\n").map(JSON.parse);
assert.ok(editingFixtures.length > 0 && editingFixtures.length <= 8);
const recordBag = records => records.map(row => JSON.stringify(canonical(row))).sort();
assert.ok(normalFixtures.length > 0 && normalFixtures.length <= 16);
assert.ok(normalFixtures.every(item => /^[a-z][a-z0-9-]+$/.test(item.id) && item.bundle?.schema === "voice-ui.bundle/2"));
const fixtures = [
  { id: "equal-label-quantity", text: "OCIにDBを3個追加",
    nodes: [{ label: "DB", kind: "data", quantity: 3, parent: "OCI" }], flow: null },
  { id: "nested-new-names", text: "OCIに「配布領域」というグループ、その中に「配布記録」というデータ、OCIに「構築」という工程を追加して、構築から配布記録へ矢印",
    nodes: [{ label: "配布領域", kind: "group", quantity: 1, parent: "OCI" },
      { label: "配布記録", kind: "data", quantity: 1, parent: "配布領域" },
      { label: "構築", kind: "step", quantity: 1, parent: "OCI" }],
    flow: ["構築", "配布記録"] },
  { id: "existing-directed-connection", text: "OCIのSourceからTargetへ矢印を追加。Unrelatedは変更しない",
    nodes: [], flow: ["Source", "Target"], existing: true },
  ...normalFixtures, ...editingFixtures,
];
assert.equal(new Set(fixtures.map(item => item.id)).size, fixtures.length);
let fixture = null, input = null, catalogueHidden = false;
const api = [], upstream = [], frames = [], controls = [], lifecycle = [], supply = [], images = [], fixtureResults = [], reductions = [];
const syntheticAnswer = wire => {
  if (fixture.edit) return Object.fromEntries(Object.keys(wire.questions)
    .map(name => [name, fixture.edit.response[name] ?? "none"]));
  if (wire.questions.completion) return { completion: "unknown" };
  if (wire.questions.intent) return { intent: "change", labels: fixture.id === "equal-label-quantity" || fixture.existing ? "available" : "missing",
    capacity: fixture.id === "equal-label-quantity" ? "exceeded" : "within", completeness: "complete" };
  const state = input.state;
  const next = fixture.nodes.find(node => {
    const parent = state.graph.find(region => region.label === node.parent);
    return state.graph.filter(region => region.label === node.label && region.parent === parent?.id).length < node.quantity;
  });
  let choice = "none";
  if (next) {
    const offered = state.offers.parts.find(part => part.label === next.label
      && (!fixture.bundle || part.kind === next.kind)
      && !state.selected.some(item => item.key === part.key));
    assert.ok(offered, "the app really offered the required instance");
    if (state.placing === null) choice = "part:" + offered.key;
    else {
      const parent = state.graph.find(region => region.label === next.parent);
      choice = state.candidates.find(candidate => candidate.part === offered.key && candidate.parent === parent?.id)?.id;
    }
  } else if (fixture.flow) {
    const [from, to] = fixture.flow.map(label => state.graph.find(region => region.label === label)?.id);
    if (!state.edges.some(edge => edge.from === from && edge.to === to))
      choice = state.candidates.find(candidate => candidate.from === from && candidate.to === to)?.id;
  }
  assert.ok(choice && Object.hasOwn(wire.questions.delta.criteria, choice), "only actual legal options are answered");
  return { delta: choice };
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.ok(input !== null && fixture !== null, "no unbound upstream request");
  const wire = JSON.parse(init.body);
  const auth = init.headers.authorization;
  const provider = auth === "Bearer fixture-type-only" ? "typellm" : auth === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider, "only the synthetic credentials are permitted");
  assert.equal(String(url), provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.typellm.ai/v1/generate");
  assert.equal(init.method, "POST");
  // The released Jev transport omits redirect (Fetch default); TypeLLM
  // explicitly refuses redirects. Bind the actual two contracts separately.
  assert.equal(init.redirect, provider === "typellm" ? "error" : undefined);
  upstream.push({ fixture: fixture.id, provider, route: new URL(url).origin, questions: Object.keys(wire.questions) });
  if (provider === "typellm") {
    const missing = fixture.id === "equal-label-quantity" ? [{ label: "DB", kind: "data", quantity: 2 }]
      : fixture.nodes.map(({ label, kind, quantity }) => ({ label, kind, quantity }));
    return Response.json({ status: "completed", result: Object.fromEntries([1, 2, 3].map((n, index) =>
      ["missing" + n, missing[index] ? { ...missing[index], quantity: String(missing[index].quantity) }
        : { label: "", kind: "none", quantity: "0" }])) });
  }
  const picks = syntheticAnswer(wire);
  return Response.json({ model: "synthetic-browser-fixture", answers: Object.fromEntries(Object.entries(wire.questions).map(([name, q]) => {
    const choice = picks[name], choices = Object.keys(q.criteria);
    assert.ok(choices.includes(choice));
    return [name, { type: "choice", choice, confidence: .9,
      probabilities: Object.fromEntries(choices.map(option => [option, option === choice ? .9 : .1 / (choices.length - 1)])) }];
  })) });
};
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain" };
const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin", "cache-control": "no-store" };
const serverErrors = [];
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/")) {
      assert.equal(input, null, "browser API calls are sequential");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      input = JSON.parse(bytes);
      try {
        const response = await worker.fetch(new Request("http://localhost" + pathname,
          { method: req.method, headers: { "content-type": "application/json" }, body: bytes }),
          { JEV_API_KEY: "fixture-jev-only",
            ASSETS: { fetch: () => { throw new Error("unexpected Worker asset"); } } });
        const body = await response.text();
        api.push({ fixture: fixture.id, route: pathname, status: response.status, body: JSON.parse(body) });
        res.writeHead(response.status, { "content-type": "application/json", ...isolation }); res.end(body);
      } finally { input = null; }
      return;
    }
    // Explicit fixture data at the ordinary bundle URL. No app, Worker, UI,
    // protocol, storage or drawing implementation is replaced.
    if (pathname === "/data/bundle.v1.json" && fixture.bundle) {
      res.writeHead(200, { "content-type": "application/json", ...isolation });
      res.end(JSON.stringify(catalogueHidden ? { ...fixture.bundle, parts: [] } : fixture.bundle)); return;
    }
    if (pathname === "/assets/symbol-fixture.svg" && fixture.symbols) {
      res.writeHead(200, { "content-type": "image/svg+xml", ...isolation }); res.end(symbolFixtureSvg); return;
    }
    if (pathname === "/hayamimi/sherpa/data.parts.json") { res.writeHead(204, isolation); res.end(); return; }
    const file = path.resolve(site, pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
    assert.ok(file.startsWith(site + path.sep));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", ...isolation });
    res.end(fs.readFileSync(file));
  } catch (error) {
    serverErrors.push(String(error)); res.writeHead(500, { "content-type": "application/json" }); res.end("{}");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, channel: "chromium" });
fs.mkdirSync(output, { recursive: true });
const failures = [];
try {
  for (const selected of fixtures) {
    const failureStart = failures.length;
    let context = null;
    try {
    fixture = selected; catalogueHidden = false;
    const records = fixture.edit?.initialRecords ?? [{ type: "meta", schema: "semantic-map-state/1", root: "root", title: "candidate browser fixture" },
      { type: "region", id: "root", label: "World", parent: null, kind: "boundary", bounds: [0, 0, 1000, 700], summary: "" },
      { type: "region", id: "container", label: "OCI", parent: "root", kind: "group", bounds: [0, 0, 2000, 500], summary: "" },
      ...(fixture.existing ? ["Source", "Target", "Unrelated"].map((label, index) => ({ type: "region", id: label.toLowerCase(),
        label, kind: index === 1 ? "data" : "step", parent: "container", summary: "", bounds: [[12, 72, 180, 92], [420, 72, 180, 92], [216, 230, 180, 92]][index] })) : [])];
    const initial = await protocol.createDecisionLog(records, "voice-graph");
    const pin = await protocol.createDecision(initial.head,
      [{ type: "PinRegions", items: fixture.edit?.pins ?? [{ regionId: "container", bounds: [0, 0, 2000, 500] },
        ...records.filter(record => record.parent === "container").map(record => ({ regionId: record.id, bounds: record.bounds }))] }], initial.records);
    const accepted = (await protocol.appendDecision(initial.log, pin.decision)).verified;
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    // No request may leave the completed site, even if the page changes.
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(([storageKey, log]) => { if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, log); }, [key, accepted.log]);
    const settle = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending"
      && document.querySelector("#goal-cancel").hidden, null, { timeout: 180000 });
    const snapshot = () => page.evaluate(storageKey => {
      const view = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
      return { state: document.body.dataset.state, log: view?.log ?? null, records: view?.records ?? null,
        head: view?.head ?? null, view: view?.view ?? null,
        stored: localStorage.getItem(storageKey), goal: document.body.dataset.goal ? JSON.parse(document.body.dataset.goal) : null };
    }, key);
    await page.goto(origin); await settle();
    const before = await snapshot(); assert.equal(before.log, accepted.log);
    for (const node of fixture.nodes) if (node.descriptions) {
      assert.equal(node.descriptions.length, node.quantity, "one fixed description per expected instance");
    }
    const oracle = {
      expected_added_regions: fixture.nodes.flatMap(node => Array.from({ length: node.quantity }, (_, index) => ({
        label: node.label, kind: node.kind, parent: node.parent === "OCI" ? "fixture:container" : "added:" + node.parent,
        ...(node.descriptions ? { summary: JSON.stringify(node.descriptions[index]) } : {}) }))),
      expected_added_edges: fixture.flow ? [{ from: fixture.existing ? "fixture:source" : "added:" + fixture.flow[0],
        to: fixture.existing ? "fixture:target" : "added:" + fixture.flow[1], kind: "flow", label: "" }] : [],
    };
    const reduceReadback = async (stage, state, expected = oracle) => {
      // Editing has an explicit whole-record expectation, including layout,
      // rather than treating every operation as append-only new semantics.
      const exact = fixture.edit ? (["before", "undo"].includes(stage) ? accepted.records : fixture.edit.expectedRecords) : null;
      const result = await auditReducedView({ log: state.log, ui: state, initialRecords: exact ?? accepted.records,
        oracle: exact ? { expected_added_regions: [], expected_added_edges: [] } : expected, protocol });
      if (exact) {
        result.exact_expected_records = JSON.stringify(recordBag(state.records)) === JSON.stringify(recordBag(exact));
        if (!result.exact_expected_records) result.status = "RED";
        expected = { records: exact };
      }
      // The actual JSONL and reported UI state/view stay re-readable after CI,
      // including RED observations. No expected value is passed to the model.
      const name = fixture.id + "-" + stage + "-reduced.json";
      fs.writeFileSync(path.join(output, name), JSON.stringify({ source: manifest.sources.apps,
        initialRecords: accepted.records, expected, actual: state, audit: result }, null, 2) + "\n");
      reductions.push({ fixture: fixture.id, stage, file: name, ...result });
      assert.equal(result.status, "PASS", "JSONL reduce and UI readback: " + JSON.stringify(result));
    };
    const checkSymbols = async (stage, state, expected) => {
      try {
        images.push({ fixture: fixture.id, ...await checkPaintedSymbols({ page, records: state.records,
          expected, origin, stage }) });
      } catch (error) {
        // Record the unmet pixel gate and continue this fixture's independent
        // Undo/save/readback observations. The overall result remains RED.
        const failure = { fixture: fixture.id, stage, axis: "painted-symbol", status: "RED", error: String(error) };
        images.push(failure); failures.push(failure);
      }
    };
    const unchangedOracle = { expected_added_regions: [], expected_added_edges: [] };
    await reduceReadback("before", before, unchangedOracle);
    const paintRestored = async (stage, state) => {
      const regions = state.records.filter(record => record.type === "region");
      const groups = regions.filter(record => record.kind === "group");
      for (const parent of groups) {
        await page.locator("#camera-part").selectOption(parent.id); await settle();
        const observation = await page.evaluate(observePaintedGoal,
          { container: parent, records: regions.filter(record => record.parent === parent.id), identity: true });
        const assessment = assessPaintedGoal(observation);
        frames.push({ fixture: fixture.id, stage, camera: parent.id === "container" ? "named-group" : "nested-group", observation, assessment });
        if (assessment.status !== "PASS") failures.push({ fixture: fixture.id, stage, parent: parent.id, assessment });
      }
      for (const edge of state.records.filter(record => record.type === "relation")) {
        await page.locator("#camera-part").selectOption(edge.id); await settle();
        const observation = await page.evaluate(observePaintedGoal, { container: regions.find(record => record.id === "container"),
          records: [edge.from, edge.to].map(id => regions.find(record => record.id === id)), edge, identity: true });
        const assessment = assessPaintedEdge(observation);
        frames.push({ fixture: fixture.id, stage, camera: "relation", observation, assessment });
        if (assessment.status !== "PASS") failures.push({ fixture: fixture.id, stage, camera: "relation", assessment });
      }
      if (fixture.symbols) await checkSymbols(stage, state, stage === "undo" ? fixture.initialSymbols ?? [] : fixture.symbols);
      if (fixture.edit?.response.action === "place-part") {
        await page.locator("#camera-part").selectOption(fixture.edit.parent); await settle();
        const observation = await page.evaluate(observePaintedGoal, { container: regions.find(r => r.id === fixture.edit.parent),
          records: ["api", "db"].map(id => regions.find(r => r.id === id)), identity: true });
        const [mover, anchor] = observation.shapes.map(shape => shape.bounds);
        const right = mover !== null && anchor !== null && mover[0] >= anchor[0] + anchor[2];
        const shouldBeRight = !["before", "undo"].includes(stage);
        const result = { fixture: fixture.id, stage, axis: "painted-relative-placement", right, expected: shouldBeRight,
          status: right === shouldBeRight ? "PASS" : "RED" };
        frames.push(result);
        if (result.status !== "PASS") failures.push(result);
      }
      assert.deepEqual((await snapshot()).records, state.records, "restored camera preserves exact records");
    };
    const draw = async () => { await page.locator("#text").fill(fixture.text); await page.locator(fixture.edit ? "#send" : "#goal").click(); await settle(); return snapshot(); };
    const after = await draw();
    await reduceReadback("after", after);
    if (fixture.edit) assert.equal(after.state, "drafted", JSON.stringify(after));
    else assert.equal(after.goal.reason, fixture.stop ?? "none", JSON.stringify(after.goal));
    if (fixture.bundle && !fixture.edit) {
      const prepared = after.goal.inventory.prepared;
      const multiset = rows => rows.map(row => JSON.stringify([row.label, row.kind])).sort();
      assert.deepEqual(multiset(prepared), multiset(fixture.nodes.flatMap(node => Array.from({ length: node.quantity }, () => node))));
      assert.equal(new Set(prepared.map(part => part.key)).size, prepared.length);
      assert.equal(after.goal.inventory.preparations, fixture.preparations);
      assert.equal(after.goal.inventory.completions, 0);
      if (fixture.expectedMissing) assert.deepEqual(after.goal.inventory.missing, fixture.expectedMissing);
      for (const part of fixture.bundle.parts.filter(part => prepared.some(item => item.key === part.key))) {
        assert.deepEqual(prepared.find(item => item.key === part.key), part, "retained stock keeps its full identity");
      }
      supply.push({ fixture: fixture.id, status: "PASS", scope: "LITERAL_AND_SYNTHETIC_VERIFIER_ONLY",
        bundle_sha256: hash(JSON.stringify(fixture.bundle)), prepared, preparations: after.goal.inventory.preparations,
        literal_inspection: after.goal.inventory.coverage.inspection, missing: after.goal.inventory.missing });
    }
    if (!fixture.edit) assert.equal(gradeGraph(before.records, after.records, oracle).graph_exact, true);
    const regions = after.records.filter(record => record.type === "region"), added = regions.filter(record => !records.some(old => old.id === record.id));
    for (const expected of fixture.nodes) {
      const parent = regions.find(record => record.label === expected.parent);
      assert.equal(added.filter(record => record.label === expected.label && record.kind === expected.kind && record.parent === parent?.id).length, expected.quantity);
    }
    assert.equal(added.length, fixture.nodes.reduce((n, node) => n + node.quantity, 0));
    const edges = after.records.filter(record => record.type === "relation");
    if (!fixture.edit) assert.equal(edges.length, fixture.flow ? 1 : 0);
    if (fixture.flow) assert.deepEqual(edges.map(edge => [regions.find(r => r.id === edge.from)?.label, regions.find(r => r.id === edge.to)?.label]), [fixture.flow]);
    const cameraFrames = [{ name: "overview", id: "" }, { name: "named-group", id: "container" },
      ...(fixture.edit ? regions.filter(r => r.kind === "group" && r.id !== "container") : added.filter(r => r.kind === "group"))
        .map(r => ({ name: "nested-group", id: r.id }))];
    let controlArgs = null;
    for (const camera of cameraFrames) {
      await page.locator("#camera-part").selectOption(camera.id); await settle();
      if (camera.id === "") {
        frames.push({ fixture: fixture.id, camera: camera.name, role: "predeclared overview; no automatic pass from hidden descendants",
          recordsUnchanged: JSON.stringify((await snapshot()).records) === JSON.stringify(after.records) }); continue;
      }
      const parent = regions.find(r => r.id === camera.id), children = regions.filter(r => r.parent === camera.id);
      const args = { container: parent, records: children, identity: true };
      const observation = await page.evaluate(observePaintedGoal, args), assessment = assessPaintedGoal(observation);
      frames.push({ fixture: fixture.id, camera: camera.name, observation, assessment });
      if (assessment.status !== "PASS") failures.push({ fixture: fixture.id, camera: camera.name, assessment });
      assert.deepEqual((await snapshot()).records, after.records, "camera preserves records");
      if (fixture.symbols) await checkSymbols("after", after, fixture.symbols);
      if (fixture.bundle) await page.screenshot({ path: path.join(output, fixture.id + "-" + camera.name + ".png") });
      if (fixture.id === "equal-label-quantity") controlArgs = args;
    }
    if (fixture.edit) await paintRestored("after", after);
    if (controlArgs) {
      // Actual painted-DOM mutations, each restored before the next observation.
      const mutations = ["wrong-label", "hidden-label", "transparent-label", "transparent-boundary", "child-shape-outside", "clipped-shape", "duplicate-label", "clipped-label", "title-overlap", "title-outside", "sibling-overlap"];
      for (const mutation of mutations) {
        const saved = await page.evaluate(({ args, mutation }) => {
          const doc = document.querySelector("#working-surface iframe").contentDocument;
          const find = (id, role) => [...doc.querySelectorAll("[data-semantic-region-id]")]
            .find(n => n.dataset.semanticRegionId === id && n.dataset.semanticRole === role);
          const text = find(args.records[0].id, "text"), shape = find(args.records[0].id, "shape");
          const other = find(mutation.startsWith("title-") ? args.container.id : args.records[1].id, "text");
          const boundary = find(args.container.id, "shape").querySelector("path,rect,ellipse");
          const saved = { content: text.innerHTML, style: text.getAttribute("style"), otherStyle: other.getAttribute("style"),
            shapeStyle: shape.getAttribute("style"), boundaryStyle: boundary.getAttribute("style") };
          if (mutation === "wrong-label") text.querySelector("text").textContent = "wrong";
          if (mutation === "hidden-label") text.style.display = "none";
          if (mutation === "transparent-label") text.querySelector("text").style.fill = "rgba(0,0,0,0)";
          if (mutation === "transparent-boundary") boundary.style.stroke = "rgba(0,0,0,0)";
          if (mutation === "child-shape-outside") shape.style.transform = "translate(10000px,0px)";
          if (mutation === "clipped-shape") shape.style.clipPath = "inset(100%)";
          if (mutation === "title-outside") other.style.transform = "translate(10000px,0px)";
          if (mutation === "duplicate-label") text.append(text.querySelector("text").cloneNode(true));
          if (mutation === "clipped-label") text.querySelector("text").setAttribute("x", "100000");
          if (mutation === "title-overlap" || mutation === "sibling-overlap") {
            const a = text.getBoundingClientRect(), b = other.getBoundingClientRect();
            other.style.transform = "translate(" + (a.x - b.x) + "px," + (a.y - b.y) + "px)";
          }
          return saved;
        }, { args: controlArgs, mutation });
        const assessment = assessPaintedGoal(await page.evaluate(observePaintedGoal, controlArgs));
        controls.push({ fixture: fixture.id, mutation, assessment });
        assert.notEqual(assessment.status, "PASS", mutation + " must be detected");
        await page.evaluate(({ args, mutation, saved }) => {
          const doc = document.querySelector("#working-surface iframe").contentDocument;
          const find = id => [...doc.querySelectorAll('[data-semantic-role="text"]')].find(n => n.dataset.semanticRegionId === id);
          const text = find(args.records[0].id), other = find(mutation.startsWith("title-") ? args.container.id : args.records[1].id);
          const shape = [...doc.querySelectorAll('[data-semantic-role="shape"]')].find(n => n.dataset.semanticRegionId === args.records[0].id);
          const boundary = [...doc.querySelectorAll('[data-semantic-role="shape"]')].find(n => n.dataset.semanticRegionId === args.container.id).querySelector("path,rect,ellipse");
          text.innerHTML = saved.content;
          for (const [node, style] of [[text, saved.style], [other, saved.otherStyle], [shape, saved.shapeStyle], [boundary, saved.boundaryStyle]])
            if (style === null) node.removeAttribute("style"); else node.setAttribute("style", style);
        }, { args: controlArgs, mutation, saved });
      }
    }
    if (fixture.flow) {
      // Fixed relation camera; actual edge ID, direction and unrelated endpoint negatives.
      const edge = edges[0]; await page.locator("#camera-part").selectOption(edge.id); await settle();
      const args = { container: regions.find(r => r.id === "container"), records: [edge.from, edge.to].map(id => regions.find(r => r.id === id)), edge, identity: true };
      const observed = await page.evaluate(observePaintedGoal, args);
      const assessment = assessPaintedEdge(observed);
      frames.push({ fixture: fixture.id, camera: "relation", observation: observed, assessment });
      assert.equal(assessment.status, "PASS", "whole directed arrow and endpoint names in fixed relation frame");
      const reverse = await page.evaluate(observePaintedGoal, { ...args, edge: { ...edge, from: edge.to, to: edge.from } });
      assert.equal(reverse.edge.complete, false); controls.push({ fixture: fixture.id, mutation: "reverse-edge", detected: true });
      if (fixture.existing) {
        const other = regions.find(record => record.id === "unrelated");
        const records = [...args.records, other];
        const all = await page.evaluate(observePaintedGoal, { ...args, records, edge: null });
        const bounds = all.shapes[2].bounds;
        assert.ok(bounds && bounds[0] >= 0 && bounds[1] >= 0 && bounds[0] + bounds[2] <= all.viewport[2]
          && bounds[1] + bounds[3] <= all.viewport[3], "unrelated negative endpoint is actually painted in this frame");
        assert.equal((await page.evaluate(observePaintedGoal, { ...args, records, edge: { ...edge, to: other.id } })).edge.complete, false);
        controls.push({ fixture: fixture.id, mutation: "disconnected-visible-endpoint", detected: true });
      }
      const missingId = await page.evaluate(observePaintedGoal, { ...args, edge: { from: edge.from, to: edge.to } });
      assert.equal(missingId.edge.complete, false); controls.push({ fixture: fixture.id, mutation: "missing-edge-id", detected: true });
      for (const mutation of ["clipped-edge", "filtered-edge", "masked-edge"]) {
        const savedStyle = await page.evaluate(({ id, mutation }) => {
          const doc = document.querySelector("#working-surface iframe").contentDocument;
          const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')]
            .find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id));
          const saved = shape.getAttribute("style");
          if (mutation === "clipped-edge") shape.style.clipPath = "inset(100%)";
          if (mutation === "filtered-edge") shape.style.filter = "opacity(0)";
          if (mutation === "masked-edge") shape.style.maskImage = "linear-gradient(transparent,transparent)";
          return saved;
        }, { id: edge.id, mutation });
        const assessment = assessPaintedEdge(await page.evaluate(observePaintedGoal, args));
        assert.notEqual(assessment.status, "PASS"); controls.push({ fixture: fixture.id, mutation, assessment });
        await page.evaluate(({ id, savedStyle }) => {
          const doc = document.querySelector("#working-surface iframe").contentDocument;
          const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')]
            .find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id));
          if (savedStyle === null) shape.removeAttribute("style"); else shape.setAttribute("style", savedStyle);
        }, { id: edge.id, savedStyle });
      }
      await page.evaluate(id => {
        const doc = document.querySelector("#working-surface iframe").contentDocument;
        const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')]
          .find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id)); shape.style.opacity = "0";
      }, edge.id);
      assert.equal((await page.evaluate(observePaintedGoal, args)).edge.complete, false);
      controls.push({ fixture: fixture.id, mutation: "hidden-edge-ancestor", detected: true });
      await page.evaluate(id => {
        const doc = document.querySelector("#working-surface iframe").contentDocument;
        const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')]
          .find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id)); shape.style.removeProperty("opacity");
      }, edge.id);
      const saved = await page.evaluate(id => {
        const doc = document.querySelector("#working-surface iframe").contentDocument;
        const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')]
          .find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id));
        const before = shape.getAttribute("transform"); shape.setAttribute("transform", "translate(5000,5000)"); return before;
      }, edge.id);
      assert.equal((await page.evaluate(observePaintedGoal, args)).edge.complete, false);
      controls.push({ fixture: fixture.id, mutation: "moved-edge", detected: true });
      await page.evaluate(({ id, saved }) => { const doc = document.querySelector("#working-surface iframe").contentDocument;
        const shape = [...doc.querySelectorAll('[data-semantic-role="shape"][data-semantic-relation-ids]')].find(n => JSON.parse(n.dataset.semanticRelationIds).includes(id));
        if (saved === null) shape.removeAttribute("transform"); else shape.setAttribute("transform", saved); }, { id: edge.id, saved });
    }
    await page.locator("#undo").click(); await settle();
    const undone = await snapshot(); assert.equal(undone.log, before.log); assert.equal(undone.stored, before.stored);
    assert.deepEqual(undone.records, before.records); await reduceReadback("undo", undone, unchangedOracle); await paintRestored("undo", undone);
    const redone = await draw();
    if (fixture.edit) assert.equal(redone.state, "drafted");
    else assert.equal(redone.goal.reason, fixture.stop ?? "none");
    if (!fixture.edit) assert.equal(gradeGraph(before.records, redone.records, oracle).graph_exact, true, "second Goal must succeed exactly");
    await reduceReadback("redo", redone); await paintRestored("redo", redone);
    await page.locator("#apply").click(); await settle();
    const applied = await snapshot(); assert.equal(applied.stored, redone.log); await reduceReadback("apply", applied);
    catalogueHidden = !!fixture.symbols;
    await page.reload(); await settle(); const reloaded = await snapshot();
    assert.equal(reloaded.log, applied.stored);
    assert.deepEqual(reloaded.records, redone.records); await reduceReadback("reload", reloaded); await paintRestored("reload", reloaded);
    if (fixture.bundle) await page.screenshot({ path: path.join(output, fixture.id + "-reload.png") });
    const sameLog = (a, b) => typeof a === "string" && a === b;
    assert.equal(sameLog(after.log, before.log), false, "failed Undo cannot pass");
    assert.equal(sameLog(before.log, applied.stored), false, "stale reload cannot pass");
    lifecycle.push({ fixture: fixture.id, undo: "PASS", apply: "PASS", reload: "PASS", failedUndoControl: "RED", staleReloadControl: "RED" });
    assert.deepEqual(errors, []);
    } catch (error) {
      failures.push({ fixture: selected.id, error: String(error), stack: error.stack });
    } finally {
      if (context) try { await context.close(); }
      catch (error) { failures.push({ fixture: selected.id, cleanup: String(error) }); }
      // A later failed dependency must not erase earlier results or prevent
      // unrelated cases. The whole suite still fails when any case fails.
      const result = { fixture: selected.id, status: failures.length === failureStart ? "PASS" : "RED" };
      fixtureResults.push(result);
      console.log(JSON.stringify({ kind: "voice-ui.candidate-browser.case/1", ...result }));
    }
  }
  assert.deepEqual(serverErrors, []);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
}
assert.ok(upstream.every(call => call.provider === "jev"), "ordinary literal UI requires no TypeLLM key or POST");
const receipt = { schema: "voice-ui.candidate-browser/1", sources: manifest.sources, manifest_sha256: hash(manifestBytes),
  scope: "KEYLESS_FIXTURE_MECHANICS", live_provider: "NOT_RUN", live_microphone: "NOT_RUN",
  editing_fixture_sha256: hash(editingBytes), editing_scope: "ordinary Send; fixed whole records and actual painted directions; mocked judgments",
  normal_fixture_sha256: hash(normalBytes), normal_fixture_scope: "explicit bundle data; same completed app/Worker/UI; not live semantic accuracy",
  symbol_fixture_sha256: hash(symbolFixtureSvg),
  viewport: [1280, 720], deviceScaleFactor: 1, api, synthetic_upstream: upstream, frames, controls, lifecycle, supply, images, fixtureResults, reductions,
  status: failures.length ? "RED" : "PASS", failures };
fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
assert.deepEqual(failures, [], "painted frame requirements");
process.stdout.write(JSON.stringify({ kind: receipt.schema, status: receipt.status, frames: frames.length, controls: controls.length, live_provider: receipt.live_provider }) + "\n");
