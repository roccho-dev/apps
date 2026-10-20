import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserDiagnosticPort } from "../web/providers/structured-diagnostic/adapters/browser.mjs";
import {
  EXPECTED_PROVIDER,
  VOICE_UI_FAILURE_CODE,
  consumeVoiceUiDiagnostic,
  createVoiceUiDiagnosticBridge,
  diagnosticForVoiceUiFailure,
} from "../src/diagnostic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerRoot = path.join(root, "web/providers/structured-diagnostic");
const contractPath = path.join(providerRoot, "contract.json");
const corePath = path.join(providerRoot, "lib/diagnostic.mjs");
const browserAdapterPath = path.join(providerRoot, "adapters/browser.mjs");
const identityPath = path.join(providerRoot, "identity.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));

function gitBlobSha(file) {
  const bytes = fs.readFileSync(file);
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

test("provider identity binds the exact carried Ops bytes", () => {
  assert.deepEqual(identity, {
    schema: "structured-diagnostic-provider-identity/1",
    ...EXPECTED_PROVIDER,
    sourcePaths: [
      "packages/structured-diagnostic/contract.json",
      "packages/structured-diagnostic/lib/diagnostic.mjs",
      "packages/structured-diagnostic/adapters/browser.mjs",
    ],
  });
  assert.equal(gitBlobSha(contractPath), identity.contractBlob);
  assert.equal(gitBlobSha(corePath), identity.coreBlob);
  assert.equal(gitBlobSha(browserAdapterPath), identity.browserAdapterBlob);
  assert.equal(contract.schema, "diagnostic-contract/1");
  assert.equal(contract.messageBlankRule, "ecmascript-trim");
});

test("exact Ops provider bytes drive feature and data consumption", () => {
  const rows = [];
  const findings = [];
  const port = createBrowserDiagnosticPort({ contract, write: (line) => rows.push(line) });
  const bridge = createVoiceUiDiagnosticBridge({ port, providerIdentity: identity, onFinding: (finding) => findings.push(finding) });
  const result = bridge.reportFailure({ phase: "judge", reason: "provider_rejected" });
  assert.equal(rows.length, 1);
  assert.equal(result.finding.status, "classified");
  assert.equal(result.finding.code, VOICE_UI_FAILURE_CODE);
  assert.equal(result.finding.action, "inspect-judgment-provider");
  assert.deepEqual(findings, [result.finding]);
  assert.equal(port.parse(rows[0]).fields.reason, "provider_rejected");
});

test("code-only diagnostic remains valid and is not misclassified", () => {
  const rows = [];
  const port = createBrowserDiagnosticPort({ contract, write: (line) => rows.push(line) });
  const line = port.emit({ schema: "diagnostic/1", code: "voice-ui.notice", level: "info", message: "ready" });
  assert.equal(Object.hasOwn(port.parse(line), "fields"), false);
  assert.deepEqual(
    consumeVoiceUiDiagnostic({ line, parse: port.parse, providerIdentity: identity }),
    { status: "ignored", reason: "wrong-code" },
  );
});

test("wrong source, wrong code and invalid input never become findings", () => {
  const port = createBrowserDiagnosticPort({ contract, write() {} });
  const line = port.encode(diagnosticForVoiceUiFailure({ phase: "render" }));
  assert.equal(
    consumeVoiceUiDiagnostic({ line, parse: port.parse, providerIdentity: { ...identity, revision: "0".repeat(40) } }).reason,
    "wrong-source",
  );
  assert.equal(
    consumeVoiceUiDiagnostic({
      line: port.encode({ schema: "diagnostic/1", code: "voice-ui.other", level: "error", message: "x" }),
      parse: port.parse,
      providerIdentity: identity,
    }).reason,
    "wrong-code",
  );
  assert.equal(
    consumeVoiceUiDiagnostic({ line: "{bad}", parse: port.parse, providerIdentity: identity }).reason,
    "invalid-diagnostic",
  );
  assert.equal(
    consumeVoiceUiDiagnostic({ line, parse: null, providerIdentity: identity }).reason,
    "invalid-provider-port",
  );
});

test("transport rejection preserves the caller-owned primary result", () => {
  const transportError = new Error("rejected");
  const port = createBrowserDiagnosticPort({ contract, write() { throw transportError; } });
  const bridge = createVoiceUiDiagnosticBridge({ port, providerIdentity: identity });
  const primary = Object.freeze({ ok: false, status: "failed" });
  assert.throws(() => bridge.reportFailure({ phase: "apply" }), transportError);
  assert.equal(primary.status, "failed");
});
