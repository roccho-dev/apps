// The development-only acquisition CLI. Importing this module performs no I/O.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const exact = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const refuse = (code, status = 502) => ({ status, body: { error: code } });
const MAX_INPUT = 32768;
const MAX_OUTPUT = 131072;
const MAX_PROPOSALS = 64;

// The target-owned launcher admits one bounded reference-input session. Unlike
// the controlled caller, this session never imports an operator-selected module
// or forwards its credential to a caller-selected endpoint.
export function referenceSettings(env, { binary, proposer, now = Date.now } = {}) {
  const until = Number(env.VOICE_UI_REFERENCE_UNTIL);
  const maximum = Number(env.VOICE_UI_REFERENCE_MAX_CALLS);
  const query = env.VOICE_UI_REFERENCE_QUERY;
  if (env.VOICE_UI_REFERENCE_REAL !== "1" || env.VOICE_UI_MELTYPE_PROPOSALS !== "1"
    || !path.isAbsolute(binary ?? "") || !path.isAbsolute(proposer ?? "")
    || ["VOICE_UI_PROPOSAL_MODULE", "VOICE_UI_PROPOSAL_JEV_URL", "VOICE_UI_PROPOSAL_TEST_KEY"]
      .some(name => env[name])
    || typeof env.JEV_API_KEY !== "string" || !env.JEV_API_KEY.trim()
    || env.JEV_API_KEY.length > 4096 || /[\r\n]/u.test(env.JEV_API_KEY)
    || typeof env.VOICE_UI_PROPOSAL_B !== "string" || !env.VOICE_UI_PROPOSAL_B
    || Buffer.byteLength(env.VOICE_UI_PROPOSAL_B) > 4096
    || typeof query !== "string" || !query || Buffer.byteLength(query) > 8192
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 12
    || !Number.isSafeInteger(until) || until <= now() || until - now() > 1800000)
    throw new Error("reference session configuration unavailable");
  let reserved = 0, stopped = false;
  return {
    entry: fileURLToPath(import.meta.url), referenceOnly: true,
    vars: {
      VOICE_UI_SEMCMP_BIN: binary, VOICE_UI_PROPOSAL_MODULE: proposer,
      VOICE_UI_PROPOSAL_B: env.VOICE_UI_PROPOSAL_B,
      JEV_API_KEY: env.JEV_API_KEY, JEV_API_URL: "https://api.typesafe.ai/v1/systemone",
      JEV_TIMEOUT_MS: "3000", VOICE_UI_PROPOSAL_TIMEOUT_MS: "5000",
    },
    reserve(raw) {
      if (stopped || raw !== query || now() >= until || reserved >= maximum) return false;
      reserved++; // Reserve before spawning; failure/unknown never refunds an attempt.
      return true;
    },
    canReturn() {
      if (now() >= until) stopped = true;
      return !stopped;
    },
    stop() { stopped = true; },
  };
}

async function inputOf(stream) {
  let length = 0;
  const chunks = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > MAX_INPUT) return { error: refuse("INVALID_QUERY", 413) };
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return { error: refuse("INVALID_QUERY", 400) }; }
  if (!exact(request, ["query"]) || !exact(request.query, ["input", "state", "focus"]))
    return { error: refuse("INVALID_QUERY", 400) };
  return { query: request.query };
}

function runInstalled(query) {
  const binary = process.env.VOICE_UI_SEMCMP_BIN;
  const proposer = process.env.VOICE_UI_PROPOSAL_MODULE;
  if (typeof binary !== "string" || !path.isAbsolute(binary)
    || typeof proposer !== "string" || !path.isAbsolute(proposer))
    return Promise.resolve({ error: refuse("PROPOSAL_UNAVAILABLE", 503) });
  const stdin = JSON.stringify({ query });
  const configuredTimeout = Number(process.env.VOICE_UI_PROPOSAL_TIMEOUT_MS || "5000");
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 1 || configuredTimeout > 15000)
    return Promise.resolve({ error: refuse("PROPOSAL_UNAVAILABLE", 503) });
  const timeoutMs = configuredTimeout;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(binary, ["--propose", proposer], {
        cwd: "/", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        // The existing host supplied an explicit minimal environment.
        env: process.env,
      });
    } catch { resolve({ error: refuse("PROPOSAL_UNAVAILABLE", 503) }); return; }
    const outputChunks = [];
    let size = 0, expired = false, exceeded = false, finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { exceeded = true; child.kill("SIGKILL"); }
      else outputChunks.push(chunk);
    });
    child.stderr.on("data", () => {}); // Never surface upstream details.
    child.stdin.on("error", () => {});
    child.on("error", () => done({ error: refuse("PROPOSAL_UNAVAILABLE", 503) }));
    child.on("close", code => {
      if (expired) return done({ error: refuse("PROPOSAL_TIMEOUT", 504) });
      if (exceeded || code !== 0) return done({ error: refuse("PROPOSAL_FAILED") });
      done({ output: Buffer.concat(outputChunks).toString("utf8") });
    });
    child.stdin.end(stdin);
  });
}

function verified(output, query) {
  let value;
  try { value = JSON.parse(output); }
  catch { return refuse("PROPOSAL_FAILED"); }
  if (!exact(value.query, ["input", "state", "focus"])
    || JSON.stringify(value.query) !== JSON.stringify(query)
    || !Array.isArray(value.proposals) || value.proposals.length > MAX_PROPOSALS)
    return refuse("PROPOSAL_FAILED");
  const ids = new Set();
  for (const p of value.proposals) {
    if (!exact(p, ["id", "meaning", "representation", "evidence"])
      || typeof p.id !== "string" || !p.id.trim() || ids.has(p.id)
      || typeof p.representation !== "string" || !p.representation.trim()
      || p.meaning === undefined
      || !exact(p.evidence, ["theme", "noul"])
      || p.evidence.theme !== "intent-fit" || !Number.isFinite(p.evidence.noul)
      || p.evidence.noul < 0 || p.evidence.noul > 1)
      return refuse("PROPOSAL_FAILED");
    ids.add(p.id);
  }
  return { status: 200, body: { query: value.query, proposals: value.proposals } };
}

async function acquire() {
  const input = await inputOf(process.stdin);
  if (input.error) return input.error;
  const result = await runInstalled(input.query);
  return result.error ?? verified(result.output, input.query);
}

// Standalone process invocation, never a named-export or import-side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acquire().then(result => {
    process.stdout.write(JSON.stringify(result));
  }).catch(() => {
    process.stdout.write(JSON.stringify(refuse("PROPOSAL_FAILED")));
  });
}
