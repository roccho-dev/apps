import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const [root] = process.argv.slice(2);
assert.ok(path.isAbsolute(root), "artifact root must be absolute");
const site = path.join(root, "site");
const manifestBytes = readFileSync(path.join(root, "manifest.json"));
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const expectedRevision = "ccefaf70f327f1b0c7d998cb67acca6cc915e622";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);
const HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

function fileFor(pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(site, relative);
  if (!resolved.startsWith(`${site}${path.sep}`)) return null;
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

const requests = [];
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  requests.push(pathname);
  const file = fileFor(pathname);
  if (file === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...HEADERS });
    response.end("not found");
    return;
  }
  const body = readFileSync(file);
  response.writeHead(200, {
    "content-type": TYPES.get(path.extname(file)) ?? "application/octet-stream",
    "content-length": body.byteLength,
    ...HEADERS,
  });
  response.end(body);
});

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`${origin}/diagnostic-proof.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.result !== "PENDING");
  const observed = await page.evaluate(() => ({
    result: document.body.dataset.result,
    action: document.body.dataset.action,
    providerRevision: document.body.dataset.providerRevision,
    report: JSON.parse(document.querySelector("#result").textContent),
  }));
  assert.equal(observed.result, "PASS");
  assert.equal(observed.action, "inspect-judgment-provider");
  assert.equal(observed.providerRevision, expectedRevision);
  assert.equal(observed.report.status, "PASS");
  assert.equal(observed.report.finding.code, "voice-ui.operation-failed");
  assert.equal(observed.report.finding.action, "inspect-judgment-provider");
  assert.deepEqual(observed.report.controls, [
    "wrong-source",
    "wrong-code",
    "invalid-diagnostic",
    "transport-preserved-primary",
  ]);
  assert.equal(observed.report.providerIdentity.revision, expectedRevision);
  for (const required of [
    "/diagnostic-proof.html",
    "/diagnostic-proof.mjs",
    "/diagnostic-host.mjs",
    "/providers/structured-diagnostic/contract.json",
    "/providers/structured-diagnostic/identity.json",
    "/providers/structured-diagnostic/adapters/browser.mjs",
    "/providers/structured-diagnostic/lib/diagnostic.mjs",
    "/app/src/diagnostic.mjs",
  ]) {
    assert.ok(requests.includes(required), `browser did not load ${required}`);
  }
  process.stdout.write(`${JSON.stringify({
    schema: "voice-ui.browser-diagnostic-proof/1",
    status: "PASS",
    authority: false,
    artifactManifestSha256: manifestSha256,
    providerRevision: expectedRevision,
    action: observed.action,
    controls: observed.report.controls,
    requests: [...new Set(requests)].sort(),
  })}\n`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
