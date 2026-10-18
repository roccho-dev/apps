// Read-only citation projection for an operator-bound existing Git record.
// No source snapshot, credential, network client, ranker or state writer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const repo = "roccho-dev/adrs";
const hex40 = /^[a-f0-9]{40}$/u, hex64 = /^[a-f0-9]{64}$/u;
const maxBytes = 256 * 1024;
const fail = () => { throw new Error("REFERENCE_SOURCE_UNAVAILABLE"); };
const exact = (v, keys) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const safeText = (s, n) => typeof s === "string" && s.length > 0 && s.length <= n
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(s);
const sha256 = b => createHash("sha256").update(b).digest("hex");

// JSON.parse validates syntax; the second pass rejects ambiguous duplicate keys
// (including escaped spellings) and bounds nesting before any field is used.
function uniqueJSON(text) {
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^{}\[\]:,\s]+/gu) ?? [];
  let i = 0;
  function visit(depth) {
    if (depth > 32) fail();
    const token = tokens[i++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[i] !== "}") {
        const key = JSON.parse(tokens[i++]);
        if (keys.has(key)) fail();
        keys.add(key); i++; // validated colon
        visit(depth + 1);
        if (tokens[i] === ",") i++;
      }
      i++;
    } else if (token === "[") {
      while (tokens[i] !== "]") {
        visit(depth + 1);
        if (tokens[i] === ",") i++;
      }
      i++;
    }
  }
  visit(0);
  return value;
}

export function bindReference(locator, tools) {
  try {
    if (typeof locator !== "string" || Buffer.byteLength(locator) > 4096) fail();
    const input = uniqueJSON(locator);
    if (!exact(input, ["repository", "directory", "revision", "path", "blob", "sha256", "rawId"])
      || !exact(tools, ["git"]) || typeof tools.git !== "string" || !path.isAbsolute(tools.git)
      || input.repository !== repo || !path.isAbsolute(input.directory)
      || !hex40.test(input.revision) || !hex40.test(input.blob) || !hex64.test(input.sha256)
      || typeof input.path !== "string" || !/^decisions\/[a-z0-9][a-z0-9-]{0,190}\.jsonl$/u.test(input.path)
      || !safeText(input.rawId, 512)) fail();
    const fixed = Object.freeze({ ...input });
    const git = args => execFileSync(tools.git,
      ["--no-optional-locks", "--no-lazy-fetch", "-C", fixed.directory, ...args], {
        windowsHide: true, timeout: 1000, maxBuffer: maxBytes + 1,
        stdio: ["ignore", "pipe", "pipe"],
        // No ambient Git override, credential, proxy, replacement object or hook.
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
          GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" },
      });
    // No branch/current lookup or network fetch. A mutable checkout is not read.
    const object = fixed.revision + ":" + fixed.path;
    const blob = git(["rev-parse", "--verify", object]).toString("ascii").trim();
    if (blob !== fixed.blob) fail();
    const bytes = git(["cat-file", "blob", object]);
    if (bytes.length === 0 || bytes.length > maxBytes || sha256(bytes) !== fixed.sha256
      || createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex") !== fixed.blob) fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const rows = text.split(/\r?\n/u).map((line, index) => ({ line, index })).filter(x => x.line.trim());
    if (!rows.length || rows.length > 64) fail();
    const seen = new Set();
    const matches = [];
    for (const { line, index } of rows) {
      const record = uniqueJSON(line);
      if (record?.schema !== "adr_raw_event.v1" || !safeText(record.raw_id, 512)
        || !safeText(record.status, 128) || seen.has(record.raw_id)) fail();
      seen.add(record.raw_id);
      if (record.raw_id === fixed.rawId) matches.push({ record, line: index + 1 });
    }
    if (matches.length !== 1) fail();
    const { record, line } = matches[0];
    const reference = `https://github.com/${repo}/blob/${fixed.revision}/${fixed.path}#L${line}`;
    const source = Object.freeze({ repository: repo, revision: fixed.revision, path: fixed.path,
      blob: fixed.blob, sha256: fixed.sha256, rawId: record.raw_id, status: record.status });
    const id = "reference-input:" + sha256(Buffer.from(JSON.stringify(source)));
    // These runtime metadata are private source information too. Callers must
    // establish permission before putting the Proposal/query through a provider.
    const proposal = Object.freeze({ id, representation: reference,
      meaning: Object.freeze({ kind: "text", text: reference,
        source, authority: "reference-only" }) });
    return Object.freeze({
      propose: () => [structuredClone(proposal)],
      identity: () => structuredClone(source),
    });
  } catch {
    fail(); // Never expose private record bytes, paths, raw IDs or Git stderr.
  }
}
