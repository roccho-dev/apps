import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindReference } from "../decision-references/read.mjs";
import { referenceSettings } from "../dev/proposals.mjs";

// All committed records in this test are synthetic. No private source binding,
// actual decision bytes, credential or external provider is used by CI.
const git = process.env.VOICE_UI_REFERENCE_GIT;
if (!git || !path.isAbsolute(git)) throw new Error("existing Git binary required for source tests");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reference-source-"));
const recordPath = "decisions/synthetic-reference.jsonl";
const run = args => execFileSync(git, ["-C", root, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
    GIT_AUTHOR_NAME: "Synthetic test", GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic test", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
}).toString("utf8").trim();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const event = (id = "synthetic-raw", status = "proposed") => ({
  schema: "adr_raw_event.v1", raw_id: id, status,
  decision: { privateBody: "SYNTHETIC_BODY_MUST_NOT_ESCAPE", originalMeaning: { kind: "command" } },
});
function commit(bytes) {
  fs.writeFileSync(path.join(root, recordPath), bytes);
  run(["add", "--", recordPath]); run(["commit", "--allow-empty", "-m", "synthetic source version"]);
  return { repository: "roccho-dev/adrs", directory: root,
    revision: run(["rev-parse", "HEAD"]), path: recordPath,
    blob: run(["rev-parse", "HEAD:" + recordPath]), sha256: digest(Buffer.from(bytes)), rawId: "synthetic-raw" };
}
run(["init", "--quiet"]);
fs.mkdirSync(path.join(root, "decisions"));
const r0 = commit(JSON.stringify(event()) + "\n");
const r1 = commit(JSON.stringify(event("synthetic-raw", "accepted_for_proposal")) + "\n");
const bind = value => bindReference(JSON.stringify(value), { git });
const refuses = value => assert.throws(() => bind(value), { message: "REFERENCE_SOURCE_UNAVAILABLE" });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("exact Git bytes produce a new text citation, preserving raw provenance without private body", () => {
  const bound = bind(r0), [p] = bound.propose();
  assert.equal(p.meaning.kind, "text");
  assert.equal(p.meaning.text, p.representation);
  assert.equal(p.representation, `https://github.com/roccho-dev/adrs/blob/${r0.revision}/${recordPath}#L1`);
  assert.notEqual(p.id, r0.rawId);
  assert.deepEqual(p.meaning.source, { repository: r0.repository, revision: r0.revision,
    path: recordPath, blob: r0.blob, sha256: r0.sha256, rawId: r0.rawId, status: "proposed" });
  assert.equal(p.meaning.authority, "reference-only");
  assert.equal(JSON.stringify(p).includes("SYNTHETIC_BODY_MUST_NOT_ESCAPE"), false);
  assert.equal(JSON.stringify(p).includes(root), false);
  assert.equal(JSON.stringify(p).includes(git), false);
});
test("source commits are explicit: r0/r1 identities differ and neither follows HEAD or worktree edits", () => {
  const old = bind(r0), next = bind(r1);
  assert.notEqual(old.propose()[0].id, next.propose()[0].id);
  assert.equal(next.identity().status, "accepted_for_proposal");
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify(event("different", "changed-in-worktree")));
  assert.equal(bind(r0).identity().revision, r0.revision);
  assert.equal(old.identity().status, "proposed");
  assert.equal(next.identity().status, "accepted_for_proposal");
  // This source check is not proof that an active B input session invalidated a reply.
});
test("returned objects cannot mutate the bound source or future original Proposal", () => {
  const bound = bind(r0), [p] = bound.propose();
  p.id = "changed"; p.meaning.source.rawId = "changed";
  assert.notEqual(bound.propose()[0].id, "changed");
  assert.equal(bound.identity().rawId, r0.rawId);
});
test("wrong immutable commit/blob/hash/raw ID fail closed", () => {
  for (const changed of [{ revision: "a".repeat(40) }, { blob: "b".repeat(40) },
    { sha256: "c".repeat(64) }, { rawId: "missing" }]) refuses({ ...r0, ...changed });
});
test("a branch or Git expression is never used as the revision", () => {
  for (const revision of ["HEAD", "main", "HEAD~1", r0.revision + ":other", "--help"])
    refuses({ ...r0, revision });
});
test("foreign repository, arbitrary path, path traversal and extra configuration are refused", () => {
  for (const changed of [{ repository: "other/repo" }, { path: "policy/entry.md" },
    { path: "decisions/../secret.jsonl" }, { path: "decisions/x.jsonl:other" },
    { directory: "relative" }, { git }, { token: "synthetic-secret" }]) refuses({ ...r0, ...changed });
});
test("JSON keys are unique even when escaped", () => {
  const text = JSON.stringify(r0);
  for (const prefix of ['{"repository":"other/repo",', '{"reposit\\u006fry":"other/repo",'])
    assert.throws(() => bindReference(prefix + text.slice(1), { git }), { message: "REFERENCE_SOURCE_UNAVAILABLE" });
});
test("record duplicate IDs, duplicate keys and invalid schemas do not generate a candidate", () => {
  for (const bytes of [JSON.stringify(event()) + "\n" + JSON.stringify(event()) + "\n",
    '{"schema":"wrong","schema":"adr_raw_event.v1","raw_id":"synthetic-raw","status":"proposed"}\n',
    JSON.stringify({ ...event(), schema: "other" }) + "\n",
    JSON.stringify({ ...event(), status: "bad\nstatus" }) + "\n",
    JSON.stringify({ ...event(), raw_id: "bad\u001bID" }) + "\n"]) refuses(commit(bytes));
});
test("nested ambiguity, deep records, invalid UTF8 and oversized input are rejected", () => {
  const valid = JSON.stringify(event());
  for (const bytes of [valid.slice(0, -1) + ',"x":{"a":1,"a":2}}\n',
    valid.slice(0, -1) + ',"x":' + "[".repeat(34) + "0" + "]".repeat(34) + '}\n',
    Buffer.from([0xff]), " ".repeat(256 * 1024 + 1)]) refuses(commit(bytes));
});
test("missing local Git source yields only a bounded public error", () => {
  const value = { ...r0, directory: path.join(root, "private-location-missing") };
  assert.throws(() => bind(value), error => error.message === "REFERENCE_SOURCE_UNAVAILABLE"
    && !String(error).includes("private-location-missing"));
});
test("a locator cannot choose the executable; launch must explicitly bind the existing Git", () => {
  refuses({ ...r0, git: process.execPath });
  for (const tools of [undefined, {}, { git: "git" }, { git, command: "other" }])
    assert.throws(() => bindReference(JSON.stringify(r0), tools), { message: "REFERENCE_SOURCE_UNAVAILABLE" });
});
test("a missing promisor blob is refused locally instead of triggering Git lazy fetch", () => {
  const partial = path.join(root, "partial-source");
  run(["config", "uploadpack.allowFilter", "true"]);
  run(["clone", "--quiet", "--no-local", "--no-checkout", "--filter=blob:none", pathToFileURL(root).href, partial]);
  const before = fs.readdirSync(path.join(partial, ".git/objects/pack")).sort();
  assert.throws(() => execFileSync(git, ["--no-lazy-fetch", "-C", partial, "cat-file", "-e", r0.blob],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  refuses({ ...r0, directory: partial });
  assert.deepEqual(fs.readdirSync(path.join(partial, ".git/objects/pack")).sort(), before);
});
test("source lines are preserved for citation without turning record status into adoption", () => {
  const value = commit("\n" + JSON.stringify(event("other")) + "\n\n" + JSON.stringify(event()) + "\n");
  const [p] = bind(value).propose();
  assert.ok(p.representation.endsWith("#L4"));
  assert.equal(p.meaning.source.status, "proposed");
  assert.equal(p.meaning.authority, "reference-only");
});
test("proposer module captures one locator and cannot hot-rebind a session via environment change", async () => {
  const before = process.env.VOICE_UI_PROPOSAL_B;
  try {
    process.env.VOICE_UI_PROPOSAL_B = JSON.stringify(r0);
    const { propose } = await import("../decision-references/propose.mjs?fixed-test-session");
    const first = propose();
    process.env.VOICE_UI_PROPOSAL_B = JSON.stringify(r1);
    assert.deepEqual(propose(), first);
  } finally {
    if (before === undefined) delete process.env.VOICE_UI_PROPOSAL_B;
    else process.env.VOICE_UI_PROPOSAL_B = before;
  }
});

test("real reference admission confines the credential and cannot select another module or endpoint", () => {
  const now = 100000;
  const env = {
    VOICE_UI_REFERENCE_REAL: "1", VOICE_UI_MELTYPE_PROPOSALS: "1",
    VOICE_UI_REFERENCE_UNTIL: String(now + 1000), VOICE_UI_REFERENCE_MAX_CALLS: "2",
    VOICE_UI_REFERENCE_QUERY: "synthetic query", VOICE_UI_PROPOSAL_B: "synthetic locator",
    JEV_API_KEY: "synthetic-provider-key", GH_TOKEN: "must-not-reach-child",
    NODE_OPTIONS: "must-not-reach-child", VOICE_UI_REFERENCE_GIT: "must-not-reach-child",
  };
  const tools = { binary: process.execPath, proposer: path.resolve(root, "installed-proposer.mjs"), now: () => now };
  const settings = referenceSettings(env, tools);
  assert.deepEqual(Object.keys(settings.vars).sort(), ["JEV_API_KEY", "JEV_API_URL", "JEV_TIMEOUT_MS",
    "VOICE_UI_PROPOSAL_B", "VOICE_UI_PROPOSAL_MODULE", "VOICE_UI_PROPOSAL_TIMEOUT_MS", "VOICE_UI_SEMCMP_BIN"].sort());
  assert.equal(settings.vars.JEV_API_URL, "https://api.typesafe.ai/v1/systemone");
  assert.equal(settings.vars.VOICE_UI_PROPOSAL_MODULE, tools.proposer);
  for (const name of ["VOICE_UI_PROPOSAL_MODULE", "VOICE_UI_PROPOSAL_JEV_URL", "VOICE_UI_PROPOSAL_TEST_KEY"])
    assert.throws(() => referenceSettings({ ...env, [name]: "caller-controlled" }, tools));
  for (const changed of [{ JEV_API_KEY: "" }, { JEV_API_KEY: "bad\nkey" },
    { VOICE_UI_PROPOSAL_B: "" }, { VOICE_UI_REFERENCE_MAX_CALLS: "0" },
    { VOICE_UI_REFERENCE_MAX_CALLS: "13" }, { VOICE_UI_REFERENCE_UNTIL: String(now) },
    { VOICE_UI_REFERENCE_UNTIL: String(now + 1800001) }, { VOICE_UI_REFERENCE_QUERY: "" }])
    assert.throws(() => referenceSettings({ ...env, ...changed }, tools));
});

test("reference attempts are reserved before effects, never refunded, and stop at query/budget/deadline/failure", () => {
  let now = 100000;
  const env = {
    VOICE_UI_REFERENCE_REAL: "1", VOICE_UI_MELTYPE_PROPOSALS: "1", JEV_API_KEY: "synthetic-key",
    VOICE_UI_PROPOSAL_B: "synthetic locator", VOICE_UI_REFERENCE_QUERY: "synthetic query",
    VOICE_UI_REFERENCE_UNTIL: String(now + 1000), VOICE_UI_REFERENCE_MAX_CALLS: "2",
  };
  const make = () => referenceSettings(env, {
    binary: process.execPath, proposer: path.resolve(root, "installed-proposer.mjs"), now: () => now,
  });
  const bounded = make();
  assert.equal(bounded.reserve("another query"), false);
  assert.equal(bounded.reserve(env.VOICE_UI_REFERENCE_QUERY), true);
  assert.equal(bounded.reserve(env.VOICE_UI_REFERENCE_QUERY), true);
  assert.equal(bounded.reserve(env.VOICE_UI_REFERENCE_QUERY), false);
  const failed = make();
  assert.equal(failed.reserve(env.VOICE_UI_REFERENCE_QUERY), true);
  failed.stop();
  assert.equal(failed.reserve(env.VOICE_UI_REFERENCE_QUERY), false);
  const expired = make();
  assert.equal(expired.reserve(env.VOICE_UI_REFERENCE_QUERY), true);
  now += 1000;
  assert.equal(expired.canReturn(), false, "a late successful child cannot return an expired candidate");
  assert.equal(expired.reserve(env.VOICE_UI_REFERENCE_QUERY), false);
});
