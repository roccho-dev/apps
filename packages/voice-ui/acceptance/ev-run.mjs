import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoSecretInputs } from "../tests/runtime-acceptance.mjs";

// EV runner (apps#94 plan v2.1, comments 6337264972 and 6337290845). It drives one
// completed distribution through its ordinary UI: each script line is typed into
// #text and run as one Goal, then Apply and Reload. It records the saved JSONL,
// screenshots at the normal and wide viewports, every upstream request and the
// stop reason. It grades nothing; R judges from these files (§8-12).
//
// node ev-run.mjs --dist <dir> --script <json> --out <dir> --mode offline|live
//   [--target http://127.0.0.1:<port>] [--stock <json>] [--max-steps N] [--max-jev N] [--max-typellm N] [--minutes N]
//
// offline: this runner serves the dist and answers every upstream request synthetically.
// live (User, apps#94 comment 6337736268): the runner never holds a credential. It drives
// the page an already running credential holder serves at a loopback --target (the
// existing envs route, `voice-ui-typed-dev`, which decrypts in its own child and
// enforces its own Jev/TypeLLM allowances and journal). --dist is the same SHA's dist,
// used only for the protocol module, the bundle and the manifest identity.

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  index % 2 === 0 ? [...pairs, [value.replace(/^--/u, ""), all[index + 1]]] : pairs, []));
for (const name of ["dist", "script", "out", "mode"]) assert.ok(typeof args[name] === "string", `--${name} is required`);
assert.ok(["offline", "live"].includes(args.mode), "mode is offline|live");
const live = args.mode === "live";
assert.equal(live, typeof args.target === "string", "--target is given exactly in live mode");
if (live) {
  const target = new URL(args.target);
  assert.ok(target.protocol === "http:" && target.hostname === "127.0.0.1" && target.pathname === "/" && target.origin + "/" === args.target.replace(/\/?$/u, "/"),
    "--target is a loopback origin");
}
// Neither mode receives a provider credential in this process.
assertNoSecretInputs();
for (const name of ["dist", "script", "out", ...(args.stock ? ["stock"] : [])]) assert.ok(path.isAbsolute(args[name]), `--${name} is absolute`);
const limit = (name, fallback) => {
  const value = args[name] === undefined ? fallback : Number(args[name]);
  assert.ok(Number.isInteger(value) && value > 0, `--${name} is a positive integer`);
  return value;
};

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = args.dist, out = args.out;
const scriptBytes = fs.readFileSync(args.script), script = JSON.parse(scriptBytes);
assert.equal(script.schema, "voice-ui.ev-run.script/1");
assert.ok(["T0", "T1", "B"].includes(script.condition), "condition is T0|T1|B");
assert.ok(typeof script.set === "string" && typeof script.canvas === "string" && script.canvas.length > 0);
assert.ok(Array.isArray(script.utterances) && script.utterances.length > 0 && script.utterances.every(line => typeof line === "string" && line.length > 0));
assert.equal(script.condition === "B", !!args.stock, "B, and only B, is given the fixed stock");
const caps = { steps: limit("max-steps", script.limits?.steps ?? 52), jev: limit("max-jev", script.limits?.jev ?? 208),
  typellm: limit("max-typellm", script.limits?.typellm ?? 10), minutes: limit("minutes", 30) };

// The distribution is read only through its own manifest.
const manifestBytes = fs.readFileSync(path.join(root, "manifest.json")), manifest = JSON.parse(manifestBytes);
for (const row of manifest.files) {
  const file = path.resolve(root, row.path);
  assert.ok(file.startsWith(root + path.sep));
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256, row.path);
}
const site = path.join(root, "site"), key = "voice-ui.decision-log.v1";
const bundleBytes = fs.readFileSync(path.join(site, "data/bundle.v1.json")), bundle = JSON.parse(bundleBytes);
// B: the same names and kinds for both arms, nothing about parents or relations.
const stockBytes = args.stock ? fs.readFileSync(args.stock) : null;
const stock = stockBytes ? JSON.parse(stockBytes) : null;
if (stock) {
  assert.equal(stock.schema, "voice-ui.ev-run.stock/1");
  assert.ok(Array.isArray(stock.parts) && stock.parts.every(part => Object.keys(part).sort().join() === "kind,label"), "stock rows are {label, kind} only");
}
const servedBundle = stock ? Buffer.from(JSON.stringify({ ...bundle, parts: stock.parts.map((part, index) =>
  ({ key: `ev-${index + 1}`, purpose: `a part named ${part.label}`, label: part.label, kind: part.kind })) })) : bundleBytes;

const { default: worker } = await import(pathToFileURL(path.join(root, "worker/worker.mjs")));
const protocol = await import(pathToFileURL(path.join(site, "ui/semantic-map/protocol/index.js")));
const { chromium } = createRequire(import.meta.url)("playwright-core");

// Offline answers: every delta question answers "none" and every other choice
// takes "unknown" when offered, else its first option. This exercises the
// mechanics (lines, stops, saving, budget) and nothing about model quality.
const upstream = [], api = [];
let line = null, input = null;
const syntheticChoice = (name, criteria) => {
  const options = Object.keys(criteria);
  if (name === "delta" && options.includes("none")) return "none";
  return options.includes("unknown") ? "unknown" : options[0];
};
const originalFetch = globalThis.fetch;
if (!live) globalThis.fetch = async (url, init) => {
  assert.ok(input !== null, "no unbound upstream request");
  const wire = JSON.parse(init.body), auth = init.headers.authorization;
  const provider = auth === "Bearer fixture-type-only" ? "typellm" : auth === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider, "only the synthetic credentials are permitted");
  upstream.push({ line, provider, route: new URL(url).origin, body_sha256: hash(init.body), questions: Object.keys(wire.questions ?? {}) });
  if (provider === "typellm") return Response.json({ status: "completed", result: Object.fromEntries([1, 2, 3].map(n =>
    ["missing" + n, { label: "", kind: "none", quantity: "0" }])) });
  return Response.json({ model: "synthetic-ev-offline", answers: Object.fromEntries(Object.entries(wire.questions).map(([name, q]) => {
    const choices = Object.keys(q.criteria), choice = syntheticChoice(name, q.criteria);
    return [name, { type: "choice", choice, confidence: .9,
      probabilities: Object.fromEntries(choices.map(option => [option, option === choice ? .9 : .1 / Math.max(1, choices.length - 1)])) }];
  })) });
};

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain", ".svg": "image/svg+xml" };
const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin", "cache-control": "no-store" };
const serverErrors = [];
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      // The page's own request bytes are kept, so a provider question can be rebuilt from them later (R 10).
      write(`api-request-${String(api.length).padStart(4, "0")}.json`, bytes);
      input = JSON.parse(bytes);
      try {
        const response = await worker.fetch(new Request("http://localhost" + pathname + new URL(req.url, "http://127.0.0.1").search,
          { method: req.method, headers: { "content-type": "application/json" }, body: bytes }),
          { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only",
            ASSETS: { fetch: () => { throw new Error("unexpected Worker asset"); } } });
        const body = await response.text();
        api.push({ line, route: pathname, status: response.status, body_sha256: hash(body) });
        res.writeHead(response.status, { "content-type": "application/json", ...isolation }); res.end(body);
      } finally { input = null; }
      return;
    }
    if (pathname === "/data/bundle.v1.json") { res.writeHead(200, { "content-type": "application/json", ...isolation }); res.end(servedBundle); return; }
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

fs.mkdirSync(out, { recursive: true });
const files = [];
const write = (name, bytes) => { fs.writeFileSync(path.join(out, name), bytes); files.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }); };
if (!live) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = live ? new URL(args.target).origin : "http://127.0.0.1:" + server.address().port;
// The served page must be the --dist SHA's site (R 2/200, apps#157): every byte the page loads is compared with
// the dist manifest row of the same site path, and in live mode a preflight first fetches the core files
// from the target. A difference refuses the run, so no result is bound to a different arm.
const manifestRows = new Map(manifest.files.map(row => [row.path, row]));
const siteRow = pathname => manifestRows.get("site/" + (pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1))));
const served = [], servedMismatch = [];
const checkServed = (phase, pathname, status, body) => {
  const row = siteRow(pathname), sha256 = hash(body);
  const entry = { phase, pathname, status, sha256, manifest_sha256: row?.sha256 ?? null, equal: row?.sha256 === sha256 };
  served.push(entry);
  if (status === 200 && !entry.equal) servedMismatch.push(entry);
};
if (live) {
  const core = manifest.files.map(row => row.path).filter(file => ["site/index.html", "site/app.mjs", "site/ui/semantic-map/protocol/index.js"].includes(file)
    || ["site/data/", "site/app/src/", "site/adapters/"].some(prefix => file.startsWith(prefix)));
  assert.ok(core.includes("site/index.html") && core.includes("site/app.mjs") && core.some(file => file.startsWith("site/app/src/")), "the dist lists its core site files");
  for (const file of core) {
    const pathname = file === "site/index.html" ? "/" : "/" + file.slice("site/".length);
    const response = await originalFetch(origin + pathname, { cache: "no-store" });
    checkServed("preflight", pathname, response.status, Buffer.from(await response.arrayBuffer()));
    if (response.status !== 200) servedMismatch.push({ phase: "preflight", pathname, status: response.status, equal: false });
  }
  if (servedMismatch.length) {
    fs.writeFileSync(path.join(out, "served-identity.json"), JSON.stringify({ target: origin, sources: manifest.sources, served, servedMismatch }, null, 2) + "\n");
    assert.fail(`the target does not serve the --dist SHA ${manifest.sources.apps}: ${servedMismatch.length} differing file(s), see served-identity.json`);
  }
}
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const started = Date.now(), lines = [];
let stop = { reason: "script-complete" }, final = null, reloaded = null, applyState = null;
try {
  // One canvas group under the root: the product adds parts only inside existing named groups.
  const initial = await protocol.createDecisionLog([{ type: "meta", schema: "semantic-map-state/1", root: "root", title: `EV ${script.set} ${script.condition}` },
    { type: "region", id: "root", label: "World", parent: null, kind: "boundary", bounds: [0, 0, 2400, 1600], summary: "" },
    { type: "region", id: "canvas", label: script.canvas, parent: "root", kind: "group", bounds: [0, 0, 2400, 1600], summary: "" }], "voice-graph");
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    // B in live mode: the same fixed stock is served at the ordinary bundle URL.
    if (live && url.pathname === "/data/bundle.v1.json" && stock)
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: servedBundle });
    return route.continue();
  });
  // Every site file the page loads is checked against the dist; in live mode every product API call
  // and its response body are kept, as the page saw them.
  page.on("response", async response => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    if (!url.pathname.startsWith("/api/")) {
      // The fixed B stock is this runner's own route, not the target's bytes.
      if (stock && url.pathname === "/data/bundle.v1.json") return;
      // Some bodies (an iframe document, a stylesheet) are not readable from the page's response;
      // those are fetched again from the same origin and path, and the phase says so.
      const read = await response.body().then(body => ({ body, phase: "page" }), () => null);
      const again = read ?? await originalFetch(origin + url.pathname, { cache: "no-store" })
        .then(async fetched => ({ body: Buffer.from(await fetched.arrayBuffer()), phase: "page-refetched" }));
      checkServed(again.phase, url.pathname, response.status(), again.body);
      return;
    }
    if (!live) return;
    // The script line is taken when the response arrives, before its body is read.
    const entry = { line, route: url.pathname + url.search, status: response.status(), file: `api-${String(api.length).padStart(4, "0")}.json` };
    api.push(entry);
    // The page's own request bytes are kept beside the answer, so a provider question can be rebuilt from them
    // without touching the page's request (R 10). An unreadable answer body is said so, not saved as empty.
    write(entry.file.replace("api-", "api-request-"), response.request().postDataBuffer() ?? Buffer.alloc(0));
    const body = await response.body().catch(() => null);
    entry.body_readable = body !== null;
    entry.body_sha256 = body === null ? null : hash(body);
    if (body !== null) write(entry.file, body);
  });
  await page.addInitScript(([storageKey, log]) => { if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, log); }, [key, initial.log]);
  const settle = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending"
    && document.querySelector("#goal-cancel").hidden, null, { timeout: caps.minutes * 60000 });
  const snapshot = () => page.evaluate(storageKey => {
    const view = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
    return { state: document.body.dataset.state, log: view?.log ?? null, records: view?.records ?? null, head: view?.head ?? null,
      stored: localStorage.getItem(storageKey), goal: document.body.dataset.goal ? JSON.parse(document.body.dataset.goal) : null,
      status: document.querySelector("#status")?.textContent ?? null };
  }, key);
  const shoot = async stage => {
    for (const [name, width, height] of [["normal", 1280, 720], ["wide", 2560, 1440]]) {
      await page.setViewportSize({ width, height }); await settle();
      write(`${stage}-${name}.png`, await page.screenshot());
    }
    await page.setViewportSize({ width: 1280, height: 720 }); await settle();
  };
  await page.goto(origin); await settle();
  await shoot("initial");
  const logLines = log => (log ?? "").split("\n").filter(Boolean).length;
  let steps = 0;
  for (const [index, utterance] of script.utterances.entries()) {
    const counts = provider => upstream.filter(call => call.provider === provider).length;
    if (steps >= caps.steps) { stop = { reason: "limit-steps", line: index }; break; }
    if (counts("jev") >= caps.jev) { stop = { reason: "limit-jev", line: index }; break; }
    if (counts("typellm") >= caps.typellm) { stop = { reason: "limit-typellm", line: index }; break; }
    if (Date.now() - started > caps.minutes * 60000) { stop = { reason: "limit-time", line: index }; break; }
    line = index;
    const before = await snapshot();
    await page.locator("#text").fill(utterance);
    try { await page.locator("#goal").click(); await settle(); }
    catch (error) { stop = { reason: "UNKNOWN", line: index, error: String(error) }; break; }
    const after = await snapshot();
    const added = logLines(after.log) - logLines(before.log);
    steps += Math.max(0, added);
    lines.push({ index, utterance, state: after.state, status: after.status, goal: after.goal, added_log_lines: added,
      jev: counts("jev"), typellm: counts("typellm") });
  }
  line = null;
  final = await snapshot();
  await shoot("final");
  // Apply exists only when something was drafted; an empty run records that it had nothing to apply.
  applyState = await page.locator("#apply").isEnabled() ? "applied" : "nothing-drafted";
  if (applyState === "applied") { await page.locator("#apply").click(); await settle(); }
  const applied = await snapshot();
  await page.reload(); await settle();
  reloaded = await snapshot();
  await shoot("reload");
  write("saved.jsonl", reloaded.stored ?? "");
  write("final-records.json", JSON.stringify({ final: final.records, applied_stored_equals_final_log: applied.stored === final.log,
    reload_log_equals_applied: reloaded.log === applied.stored, reload_records: reloaded.records }, null, 2) + "\n");
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close(); if (!live) await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
}
assert.deepEqual(serverErrors, []);
const receipt = { schema: "voice-ui.ev-run/1", mode: args.mode, target: live ? origin : null,
  live_provider: live ? "VIA_TARGET (provider sends are the credential holder's journal, not counted here)" : "NOT_RUN",
  scope: live ? "LIVE_PRODUCT_RUN_UNGRADED" : "SYNTHETIC_MECHANICS_ONLY",
  sources: manifest.sources, manifest_sha256: hash(manifestBytes), apply: applyState,
  script: { set: script.set, condition: script.condition, lines: script.utterances.length, sha256: hash(scriptBytes) },
  stock_sha256: stockBytes ? hash(stockBytes) : null, served_bundle_sha256: hash(servedBundle), caps, stop,
  // Caps are checked between script lines only; one line's Goal may run up to its own request limit past a cap (R 2/12).
  cap_check: "between-lines; a single Goal may overshoot a cap by up to its own per-Goal request limit",
  elapsed_ms: Date.now() - started, lines, calls: { jev: upstream.filter(c => c.provider === "jev").length,
    typellm: upstream.filter(c => c.provider === "typellm").length }, api, upstream, files,
  served_identity: { apps: manifest.sources.apps, checked: served.length, mismatches: servedMismatch, served } };
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
assert.deepEqual(servedMismatch, [], "every site byte the page loaded is the --dist SHA's");
console.log(JSON.stringify({ status: "DONE", mode: args.mode, set: script.set, condition: script.condition, stop, lines: lines.length,
  calls: receipt.calls, files: files.length }));
