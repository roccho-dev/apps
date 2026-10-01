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
