#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envName = (...parts) => parts.join("");

export const FORBIDDEN_RUNTIME_INPUTS = Object.freeze([
  "JEV_API_KEY",
  "SOURCE_JEV_API_KEY",
  envName("CLOUDFLARE", "_API_TOKEN"),
  envName("CLOUDFLARE", "_ACCOUNT_ID"),
  "SOPS_AGE_KEY",
  "AGE_KEY_FILE",
  "ENVCTL_AUTH_BUNDLE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function assertExactSha(value, label = "SHA") {
  if (!SHA40.test(value ?? "")) throw new Error(`${label} must be an exact 40-character lowercase SHA`);
  return value;
}

export function assertSha256(value, label = "digest") {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a lowercase sha256 digest`);
  return value;
}

export function assertNoSecretInputs(env = process.env) {
  const present = FORBIDDEN_RUNTIME_INPUTS.filter(name => typeof env[name] === "string" && env[name].length > 0);
  if (present.length > 0) {
    throw new Error(`runtime acceptance must not receive secret inputs: ${present.join(",")}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

export function normalizeTarget(value) {
  const parsed = new URL(requiredString(value, "target URL"));
  const localhost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const allowed = parsed.protocol === "https:" || (localhost && parsed.protocol === "http:");
  if (!allowed) throw new Error("target URL must use https outside localhost and http/https on localhost");
  parsed.hash = "";
  return parsed.href;
}

function resolveInside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requiredString(relative, label));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes artifact root`);
  }
  return resolved;
}

function manifestRow(manifest, relative) {
  const row = manifest.files?.find(value => value?.path === relative);
  if (!row || !Number.isSafeInteger(row.bytes) || !SHA256.test(row.sha256 ?? "")) {
    throw new Error(`manifest row missing or invalid: ${relative}`);
  }
  return row;
}

function verifyManifestFile(root, manifest, relative) {
  const file = resolveInside(root, relative, "artifact path");
  const row = manifestRow(manifest, relative);
  const actual = readFileSync(file);
  if (actual.byteLength !== row.bytes || createHash("sha256").update(actual).digest("hex") !== row.sha256) {
    throw new Error(`artifact file mismatch: ${relative}`);
  }
  return { file, row };
}

export function loadAcceptanceArtifact({ artifactRoot, expectedAppsSha, expectedManifestSha256 }) {
  const root = path.resolve(requiredString(artifactRoot, "artifact root"));
  const manifestPath = path.join(root, "manifest.json");
  const manifestDigest = sha256File(manifestPath);
  assertSha256(expectedManifestSha256, "expected manifest digest");
  if (manifestDigest !== expectedManifestSha256) throw new Error("artifact manifest digest mismatch");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== "voice-ui-dist/2") throw new Error("artifact manifest schema mismatch");
  assertExactSha(expectedAppsSha, "expected apps SHA");
  if (manifest.sources?.apps !== expectedAppsSha) throw new Error("artifact apps SHA mismatch");

  const runtimeEntrypoint = requiredString(manifest.e2e?.runtime_entrypoint, "runtime acceptance entrypoint");
  const publicEntrypoint = requiredString(manifest.e2e?.public_entrypoint, "public E2E entrypoint");
  const wav = requiredString(manifest.e2e?.wav, "voice fixture");
  const golden = requiredString(manifest.e2e?.golden, "voice golden fixture");

  const runtime = verifyManifestFile(root, manifest, runtimeEntrypoint);
  const publicE2e = verifyManifestFile(root, manifest, publicEntrypoint);
  const wavFixture = verifyManifestFile(root, manifest, wav);
  const goldenFixture = verifyManifestFile(root, manifest, golden);

  return {
    root,
    manifest,
    manifestDigest,
    runtimeEntrypoint,
    publicEntrypoint,
    runtime,
    publicE2e,
    wavFixture,
    goldenFixture,
  };
}

function atomicJson(pathname, value) {
  const target = path.resolve(pathname);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporaryDirectory = mkdtempSync(path.join(directory, ".voice-ui-runtime-receipt-"));
  const temporary = path.join(temporaryDirectory, "receipt.json");
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function buildReceipt({
  status,
  stage,
  targetUrl,
  handoffId,
  expectedAppsSha,
  artifact,
  exitCode,
  completedAt = new Date().toISOString(),
}) {
  if (status !== "PASS" && status !== "RED") throw new Error("receipt status must be PASS or RED");
  if (!HANDOFF_ID.test(handoffId)) throw new Error("handoff id is invalid");
  return {
    kind: "voice-ui.runtimeAcceptanceReceipt.v1",
    limits: {
      scope: "application-e2e",
      providerIdentity: "NOT_PROVEN",
      providerAuthentication: "NOT_PROVEN",
      liveMicrophone: "NOT_RUN",
    },
    status,
    stage,
    target: { url: targetUrl },
    handoffId,
    sources: {
      apps: expectedAppsSha,
      artifactManifestSha256: artifact.manifestDigest,
    },
    acceptance: {
      entrypoint: artifact.runtimeEntrypoint,
      sha256: artifact.runtime.row.sha256,
      publicEntrypoint: artifact.publicEntrypoint,
      publicEntrypointSha256: artifact.publicE2e.row.sha256,
    },
    scenario: {
      id: "voice-add-edge-en",
      wavSha256: artifact.wavFixture.row.sha256,
      goldenSha256: artifact.goldenFixture.row.sha256,
    },
    checks: [
      { id: "artifact-admission", status: "PASS" },
      { id: "secret-free-runtime", status: "PASS" },
      { id: "public-application-e2e", status },
    ],
    dependencies: {
      envsRuntime: [],
      secretInputs: [],
    },
    process: {
      exitCode,
      independentProcess: true,
    },
    completedAt,
  };
}

export function runAcceptance({
  artifactRoot,
  targetUrl,
  expectedAppsSha,
  expectedManifestSha256,
  handoffId,
  receiptPath,
  env = process.env,
  spawn = spawnSync,
  completedAt,
}) {
  assertNoSecretInputs(env);
  const normalizedTarget = normalizeTarget(targetUrl);
  if (!HANDOFF_ID.test(handoffId ?? "")) throw new Error("handoff id is required and must be opaque ASCII");
  requiredString(receiptPath, "receipt path");

  const artifact = loadAcceptanceArtifact({ artifactRoot, expectedAppsSha, expectedManifestSha256 });
  const childEnv = { ...env };
  for (const name of FORBIDDEN_RUNTIME_INPUTS) delete childEnv[name];
  childEnv.VOICE_WAV = artifact.wavFixture.file;
  childEnv.VOICE_GOLDEN = artifact.goldenFixture.file;

  const result = spawn(process.execPath, [artifact.publicE2e.file, normalizedTarget], {
    cwd: artifact.root,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const status = exitCode === 0 ? "PASS" : "RED";
  const receipt = buildReceipt({
    status,
    stage: exitCode === 0 ? "complete" : "application-e2e",
    targetUrl: normalizedTarget,
    handoffId,
    expectedAppsSha,
    artifact,
    exitCode,
    completedAt,
  });
  atomicJson(receiptPath, receipt);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { exitCode, receipt };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return {
    artifactRoot: values["artifact-root"],
    targetUrl: values.url,
    expectedAppsSha: values["expected-apps-sha"],
    expectedManifestSha256: values["expected-manifest-sha256"],
    handoffId: values["handoff-id"],
    receiptPath: values.receipt,
  };
}

async function main() {
  try {
    const result = runAcceptance(parseArgs(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`runtime-acceptance: ${error.message}\n`);
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
