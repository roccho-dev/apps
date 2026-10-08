// Dev-only Proposal acquisition. Import has no I/O.
import { spawn } from "node:child_process";
import path from "node:path";

export class ProposalFailure extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const exact = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));

export function createAcquisition({ binary, proposer, url, controlledEnv, timeoutMs = 5000, spawnImpl = spawn }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new ProposalFailure("PROPOSAL_CONFIG_INVALID", 503); }
  // First slice: no external JEV endpoint or inherited Worker credential.
  if (typeof binary !== "string" || !path.isAbsolute(binary)
    || typeof proposer !== "string" || !path.isAbsolute(proposer)
    || controlledEnv === null || typeof controlledEnv !== "object" || Array.isArray(controlledEnv)
    || Object.keys(controlledEnv).length !== 3
    || !Object.values(controlledEnv).every(x => typeof x === "string" && x.length > 0)
    || endpoint.protocol !== "http:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new ProposalFailure("PROPOSAL_CONFIG_INVALID", 503);

  return async query => {
    if (!exact(query, ["input", "state", "focus"]))
      throw new ProposalFailure("INVALID_QUERY", 400);
    let input;
    try { input = JSON.stringify({ query }); }
    catch { throw new ProposalFailure("INVALID_QUERY", 400); }
    if (!input || Buffer.byteLength(input) > 32768)
      throw new ProposalFailure("INVALID_QUERY", 413);
    const output = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(binary, ["--propose", proposer], {
          cwd: "/", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
          // Credential ownership and endpoint policy are at the existing host.
          // The acquisition adapter receives only that host's explicit three-key
          // child environment; it never imports ambient process.env.
          env: { ...controlledEnv },
        });
      } catch { reject(new ProposalFailure("PROPOSAL_UNAVAILABLE", 503)); return; }
      let stdout = "", bytes = 0, oversize = false, timedOut = false, done = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 131072) { oversize = true; child.kill("SIGKILL"); }
        else stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {}); // never expose private CLI/provider diagnostics
      child.on("error", () => finish(new ProposalFailure("PROPOSAL_UNAVAILABLE", 503)));
      child.on("close", code => {
        if (timedOut) return finish(new ProposalFailure("PROPOSAL_TIMEOUT", 504));
        if (oversize || code !== 0) return finish(new ProposalFailure("PROPOSAL_FAILED"));
        finish(null, stdout);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    let value;
    try { value = JSON.parse(output); } catch { throw new ProposalFailure("PROPOSAL_FAILED"); }
    if (!exact(value.query, ["input", "state", "focus"])
      || JSON.stringify(value.query) !== JSON.stringify(query)
      || !Array.isArray(value.proposals) || value.proposals.length > 64)
      throw new ProposalFailure("PROPOSAL_FAILED");
    const ids = new Set();
    for (const p of value.proposals) {
      if (!exact(p, ["id", "meaning", "representation", "evidence"])
        || typeof p.id !== "string" || !p.id.trim() || ids.has(p.id)
        || typeof p.representation !== "string" || !p.representation.trim()
        || p.meaning === undefined || !exact(p.evidence, ["theme", "noul"])
        || p.evidence.theme !== "intent-fit"
        || !Number.isFinite(p.evidence.noul) || p.evidence.noul < 0 || p.evidence.noul > 1)
        throw new ProposalFailure("PROPOSAL_FAILED");
      ids.add(p.id);
    }
    return { query: value.query, proposals: value.proposals };
  };
}

// Pure boundary except reading the already supplied HTTP request and invoking acquisition.
export async function proposalHttp(request, acquisition) {
  if (request.method !== "POST")
    return { status: 405, body: { error: "METHOD_NOT_ALLOWED" } };
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    return { status: 415, body: { error: "INVALID_CONTENT_TYPE" } };
  let value;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32768) return { status: 413, body: { error: "INVALID_QUERY" } };
      chunks.push(chunk);
    }
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return { status: 400, body: { error: "INVALID_QUERY" } }; }
  if (!exact(value, ["query"]))
    return { status: 400, body: { error: "INVALID_QUERY" } };
  try { return { status: 200, body: await acquisition(value.query) }; }
  catch (err) {
    const e = err instanceof ProposalFailure ? err : new ProposalFailure("PROPOSAL_FAILED");
    return { status: e.status, body: { error: e.code } };
  }
}
