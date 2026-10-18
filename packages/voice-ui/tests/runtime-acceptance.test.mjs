import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FORBIDDEN_RUNTIME_INPUTS,
  assertExactSha,
  assertCompactVerifierWire,
  assertNoSecretInputs,
  assertSha256,
  loadAcceptanceArtifact,
  normalizeTarget,
  runAcceptance,
} from "./runtime-acceptance.mjs";

const APPS_SHA = "1".repeat(40);

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function makeArtifact() {
  const root = mkdtempSync(path.join(tmpdir(), "voice-ui-acceptance-test-"));
  const files = new Map([
    ["e2e/runtime-acceptance.mjs", "runtime\n"],
    ["e2e/public-e2e.mjs", "public\n"],
    ["e2e/fixtures/voice-add-edge-en.wav", "wav"],
    ["e2e/fixtures/voice-add-edge-en.golden.json", "{}\n"],
  ]);
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const manifest = {
    schema: "voice-ui-dist/2",
    sources: { apps: APPS_SHA },
    e2e: {
      runtime_entrypoint: "e2e/runtime-acceptance.mjs",
      public_entrypoint: "e2e/public-e2e.mjs",
      wav: "e2e/fixtures/voice-add-edge-en.wav",
      golden: "e2e/fixtures/voice-add-edge-en.golden.json",
    },
    files: [...files].map(([relative, content]) => ({
      path: relative,
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
    })),
  };
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return {
    root,
    manifestDigest: digest(readFileSync(manifestPath)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("exact identities reject branch names and malformed digests", () => {
  assert.equal(assertExactSha(APPS_SHA), APPS_SHA);
  assert.equal(assertSha256("a".repeat(64)), "a".repeat(64));
  assert.throws(() => assertExactSha("proposals"), /exact 40-character/);
  assert.throws(() => assertSha256("sha256:abc"), /sha256 digest/);
});

test("runtime target accepts HTTPS and localhost HTTP only", () => {
  assert.equal(normalizeTarget("https://voice-ui.example.test/#fragment"), "https://voice-ui.example.test/");
  assert.equal(normalizeTarget("http://127.0.0.1:4173/"), "http://127.0.0.1:4173/");
  assert.equal(normalizeTarget("http://localhost:4173/"), "http://localhost:4173/");
  assert.throws(() => normalizeTarget("http://voice-ui.example.test/"), /must use https/);
  assert.throws(() => normalizeTarget("ftp://localhost/runtime"), /must use https/);
});

test("known secret-bearing inputs are rejected instead of ignored", () => {
  for (const name of FORBIDDEN_RUNTIME_INPUTS) {
    assert.throws(() => assertNoSecretInputs({ [name]: "present" }), new RegExp(name));
  }
  assert.doesNotThrow(() => assertNoSecretInputs({ PATH: "/bin" }));
});

test("artifact admission binds exact apps SHA, manifest and acceptance files", () => {
  const fixture = makeArtifact();
  try {
    const artifact = loadAcceptanceArtifact({
      artifactRoot: fixture.root,
      expectedAppsSha: APPS_SHA,
      expectedManifestSha256: fixture.manifestDigest,
    });
    assert.equal(artifact.manifest.sources.apps, APPS_SHA);
    assert.equal(artifact.runtimeEntrypoint, "e2e/runtime-acceptance.mjs");

    assert.throws(() => loadAcceptanceArtifact({
      artifactRoot: fixture.root,
      expectedAppsSha: "2".repeat(40),
      expectedManifestSha256: fixture.manifestDigest,
    }), /apps SHA mismatch/);

    writeFileSync(path.join(fixture.root, "e2e/public-e2e.mjs"), "tampered\n");
    assert.throws(() => loadAcceptanceArtifact({
      artifactRoot: fixture.root,
      expectedAppsSha: APPS_SHA,
      expectedManifestSha256: fixture.manifestDigest,
    }), /artifact file mismatch/);
  } finally {
    fixture.cleanup();
  }
});

test("a new process PASS produces only a non-secret application receipt", () => {
  const fixture = makeArtifact();
  try {
    const receiptPath = path.join(fixture.root, "evidence", "receipt.json");
    const result = runAcceptance({
      artifactRoot: fixture.root,
      targetUrl: "https://voice-ui.example.test/",
      expectedAppsSha: APPS_SHA,
      expectedManifestSha256: fixture.manifestDigest,
      handoffId: "dev/jev-api/run-1",
      receiptPath,
      env: { PATH: process.env.PATH ?? "" },
      spawn: (_command, _args, options) => {
        assert.equal(options.env.JEV_API_KEY, undefined);
        assert.ok(options.env.VOICE_WAV.endsWith("voice-add-edge-en.wav"));
        assert.ok(options.env.VOICE_GOLDEN.endsWith("voice-add-edge-en.golden.json"));
        return { status: 0, stdout: "public-e2e: PASS\n", stderr: "" };
      },
      completedAt: "2026-09-28T00:00:00.000Z",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.receipt.status, "PASS");
    assert.deepEqual(result.receipt.limits, { scope: "application-e2e", providerIdentity: "NOT_PROVEN", providerAuthentication: "NOT_PROVEN", liveMicrophone: "NOT_RUN" });
    assert.deepEqual(result.receipt.dependencies, { envsRuntime: [], secretInputs: [] });
    assert.equal(result.receipt.sources.apps, APPS_SHA);
    assert.equal(result.receipt.handoffId, "dev/jev-api/run-1");

    const serialized = readFileSync(receiptPath, "utf8");
    for (const forbidden of FORBIDDEN_RUNTIME_INPUTS) assert.equal(serialized.includes(forbidden), false);
    assert.equal(serialized.includes("AGE-SECRET-KEY-"), false);
  } finally {
    fixture.cleanup();
  }
});

test("application failure is RED and never promoted from an executed receipt", () => {
  const fixture = makeArtifact();
  try {
    const receiptPath = path.join(fixture.root, "receipt.json");
    const result = runAcceptance({
      artifactRoot: fixture.root,
      targetUrl: "https://voice-ui.example.test/",
      expectedAppsSha: APPS_SHA,
      expectedManifestSha256: fixture.manifestDigest,
      handoffId: "dev/jev-api/run-red",
      receiptPath,
      env: { PATH: process.env.PATH ?? "" },
      spawn: () => ({ status: 7, stdout: "", stderr: "provider refused\n" }),
      completedAt: "2026-09-28T00:00:00.000Z",
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.receipt.status, "RED");
    assert.deepEqual(result.receipt.limits, { scope: "application-e2e", providerIdentity: "NOT_PROVEN", providerAuthentication: "NOT_PROVEN", liveMicrophone: "NOT_RUN" });
    assert.equal(result.receipt.stage, "application-e2e");
    assert.equal(result.receipt.checks.at(-1).status, "RED");
  } finally {
    fixture.cleanup();
  }
});

test("compact V wire permits only the registered question scalars and exact serialized bytes", () => {
  const wire = { model: "fixture", state: { required: [{ label: "API", kind: "step", quantity: 2 }] },
    questions: { intent: { type: "choice", criteria: { change: "fixed" } },
      completeness: { type: "choice", criteria: { complete: "previous complete", incomplete: "previous incomplete" }, instructions: "previous" } } };
  const previous = { provider: "jev", method: "POST", content_type: "application/json", wire, body_utf8: JSON.stringify(wire) };
  const current = structuredClone(previous);
  current.wire.questions.completeness = {"type":"choice","criteria":{"complete":"要求された新規部品の表示名・種類・総個数が全て一致し、余分も未確定もありません。","incomplete":"表示名・種類・総個数に誤り、欠落、余分、または一意に決まらないものがあります。"},"instructions":"state.requiredは、新規追加部品の未検証候補です。原文と部品定義から一意に決まる（表示名・種類・総個数）の集合と、過不足なく一致していますか。既存の親や接続先は新規部品ではなく、親・矢印の割当と在庫数はこの一覧の照合対象外です。"};
  current.body_utf8 = JSON.stringify(current.wire);
  assertCompactVerifierWire(previous, current);
  for (const change of [
    x => { x.wire.state.required[0].quantity = 1; },
    x => { x.wire.questions.intent.criteria.change = "changed"; },
    x => { x.wire.model = "other"; },
    x => { x.method = "GET"; },
    x => { x.wire.questions.completeness.type = "other"; },
    x => { x.wire.questions.completeness.instructions = "unregistered question"; },
    x => { x.wire.questions.completeness.criteria.extra = "extra"; },
    x => { x.wire.questions.completeness.criteria.complete = "unregistered criterion"; },
  ]) {
    const bad = structuredClone(current); change(bad); bad.body_utf8 = JSON.stringify(bad.wire);
    assert.throws(() => assertCompactVerifierWire(previous, bad));
  }
  const bad = structuredClone(current); bad.body_utf8 += " ";
  assert.throws(() => assertCompactVerifierWire(previous, bad));
  assert.equal(previous.wire.questions.completeness.instructions, "previous");
});
