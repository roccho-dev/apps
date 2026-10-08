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
