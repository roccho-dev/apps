import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact } from "../tests/runtime-acceptance.mjs";
import { observePaintedGoal, assessPaintedGoal, assessPaintedEdge } from "../tests/painted-goal.mjs";

// Repaint closed real-output logs using the normal restore path. This never
// contacts a provider and cannot turn an incorrect graph into a task success.
assertNoSecretInputs();
const [root, panel, out] = process.argv.slice(2);
assert.ok([root, panel, out].every(p => typeof p === "string" && path.isAbsolute(p)));
const hash = b => createHash("sha256").update(b).digest("hex");
const manifestBytes = fs.readFileSync(path.join(root, "manifest.json")), manifest = JSON.parse(manifestBytes);
loadAcceptanceArtifact({ artifactRoot: root, expectedAppsSha: manifest.sources.apps, expectedManifestSha256: hash(manifestBytes) });
for (const row of manifest.files) {
  const file = path.resolve(root, row.path); assert.ok(file.startsWith(root + path.sep));
  const b = fs.readFileSync(file); assert.equal(b.length, row.bytes); assert.equal(hash(b), row.sha256);
}
const protocol = await import(pathToFileURL(path.join(root, "site/ui/semantic-map/protocol/index.js")));
const site = path.join(root, "site"), requests = [], failures = [], rows = [];
const mime = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".css": "text/css", ".md": "text/plain" };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
  if (pathname.startsWith("/api/")) { requests.push(pathname); req.resume(); res.writeHead(503, headers); res.end("{}"); return; }
  if (pathname === "/hayamimi/sherpa/data.parts.json") { res.writeHead(204, headers); res.end(); return; }
  const file = path.resolve(site, pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, headers); res.end(); return;
  }
  res.writeHead(200, { ...headers, "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const { chromium } = createRequire(import.meta.url)("playwright-core");
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const names = fs.readdirSync(panel).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]*-[ABC][.]json$/.test(name)).sort();
  assert.ok(names.length > 0, "no empty panel can pass");
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(panel, name)), raw = JSON.parse(bytes);
    assert.equal(name, raw.id + "-" + raw.arm + ".json");
    const checked = await protocol.verifyDecisionLog(raw.final_log);
    assert.equal(checked.head, raw.final_head); assert.deepEqual(checked.records, raw.final_records);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(log => localStorage.setItem("voice-ui.decision-log.v1", log), raw.final_log);
    await page.goto(origin);
    const settle = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending",
      null, { timeout: 120000 });
    const snapshot = () => page.evaluate(() => {
      const runtime = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
      return { log: runtime?.log ?? null, records: runtime?.records ?? null, stored: localStorage.getItem("voice-ui.decision-log.v1") };
    });
    await settle(); const restored = await snapshot();
    assert.equal(restored.log, raw.final_log); assert.equal(restored.stored, raw.final_log); assert.deepEqual(restored.records, checked.records);
    const regions = checked.records.filter(r => r.type === "region"), edges = checked.records.filter(r => r.type === "relation");
    const frames = [{ camera: "overview", scope: "semantic equality and unchanged restore only; hidden descendants do not count as visible" }];
    for (const container of regions.filter(r => r.kind === "group" && r.parent !== null)) {
      await page.locator("#camera-part").selectOption(container.id); await settle();
      const observation = await page.evaluate(observePaintedGoal,
        { container, records: regions.filter(r => r.parent === container.id), identity: true });
      const assessment = assessPaintedGoal(observation);
      frames.push({ camera: container.id, observation, assessment });
      if (assessment.status !== "PASS") failures.push({ id: raw.id, arm: raw.arm, camera: container.id, assessment });
    }
    for (const edge of edges) {
      await page.locator("#camera-part").selectOption(edge.id); await settle();
      const observation = await page.evaluate(observePaintedGoal, { container: regions.find(r => r.kind === "group"),
        records: [edge.from, edge.to].map(id => regions.find(r => r.id === id)), edge, identity: true });
      const assessment = assessPaintedEdge(observation);
      frames.push({ camera: edge.id, observation, assessment });
      if (assessment.status !== "PASS") failures.push({ id: raw.id, arm: raw.arm, camera: edge.id, assessment });
      const reverse = await page.evaluate(observePaintedGoal, { container: regions.find(r => r.kind === "group"),
        records: [edge.from, edge.to].map(id => regions.find(r => r.id === id)),
        edge: { ...edge, from: edge.to, to: edge.from }, identity: true });
      assert.equal(reverse.edge.complete, false, "actual directed pair must reject reversed endpoints");
    }
    assert.deepEqual(await snapshot(), restored, "all camera frames preserve the exact restored graph/storage");
    assert.deepEqual(errors, []);
    rows.push({ id: raw.id, arm: raw.arm, raw_sha256: hash(bytes), log_sha256: hash(raw.final_log), frames });
    await context.close();
  }
  assert.deepEqual(requests, [], "closed replay must make no model API calls");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
const receipt = { schema: "voice-ui.closed-live-log-browser/1", artifact_sources: manifest.sources,
  artifact_manifest_sha256: hash(manifestBytes), scope: "KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY",
  ci_live_execution: "UNPROVEN", viewport: [1280, 720], deviceScaleFactor: 1,
  status: failures.length ? "UNMET" : "PASS", failures, rows };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ schema: receipt.schema, status: receipt.status, rows: rows.length, failures: failures.length }) + "\n");
// A red product result is preserved as UNMET evidence; the evidence verifier
// must check it. It must never be promoted by this process's successful exit.

