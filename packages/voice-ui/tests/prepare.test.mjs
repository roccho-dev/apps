import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The preparation as it runs in the build: its own process, the one flag that
// makes the platform's module parser available, and nothing else.
const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(here, "..");
const PREPARE = path.join(PACKAGE, "architecture/prepare.mjs");
const SCOPE = path.join(PACKAGE, "architecture/scope.v1.json");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "voice-ui-prepare-"));
const run = ({ scope = SCOPE, root = PACKAGE, commit = COMMIT, flag = true } = {}) => {
  const out = path.join(scratch(), "out");
  const result = spawnSync(process.execPath, [
    ...(flag ? ["--experimental-vm-modules"] : []),
    PREPARE, "--scope", scope, "--root", root, "--commit", commit, "--out", out,
  ], { encoding: "utf8" });
  const readOut = name => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  return {
    status: result.status,
    stderr: result.stderr,
    out,
    manifest: result.status === 0 ? readOut("manifest.json") : null,
    evidence: result.status === 0 ? readOut("evidence.json") : null,
    bytes: result.status === 0 ? fs.readFileSync(path.join(out, "manifest.json"), "utf8") + fs.readFileSync(path.join(out, "evidence.json"), "utf8") : null,
  };
};

test("without an exact commit the source is unavailable, with the reason, and nothing is read into it", () => {
  const prepared = run({ commit: "" });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(Object.keys(prepared.manifest).sort(), ["reason", "schema", "status"]);
  assert.equal(prepared.manifest.status, "unavailable");
  assert.match(prepared.manifest.reason, /no exact commit/u);
  assert.equal(prepared.evidence.status, "unavailable");
  assert.equal(prepared.evidence.files, undefined);
});

test("this package prepares deterministically: every file classified, text only in the private evidence", () => {
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.bytes, second.bytes, "the same snapshot prepares to the same bytes");

  const { manifest, evidence } = first;
  assert.equal(manifest.status, "available");
  assert.deepEqual(manifest.source, { handle: "apps-voice-ui", commit: COMMIT });
  const scope = JSON.parse(fs.readFileSync(SCOPE, "utf8"));
  const walk = directory => fs.readdirSync(path.join(PACKAGE, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(relative) : [relative];
  });
  assert.deepEqual(manifest.files.map(file => file.path).sort(), walk("").sort(), "every file is in the manifest");
  assert.ok(manifest.files.every(file => /^[0-9a-f]{40}$/u.test(file.blob)));

  // The private evidence holds exactly the admitted files, and the public
  // manifest holds none of their text.
  assert.deepEqual(Object.keys(evidence.files).sort(), scope.admitted.map(entry => entry.entity).sort());
  for (const entry of scope.admitted) {
    assert.equal(evidence.files[entry.entity], fs.readFileSync(path.join(PACKAGE, entry.path), "utf8"));
  }
  const publicText = JSON.stringify(manifest);
  for (const excluded of scope.excluded) {
    const body = fs.readFileSync(path.join(PACKAGE, excluded.path), "utf8");
    assert.ok(!JSON.stringify(evidence).includes(body.slice(0, 200)) || body.length === 0, `${excluded.path} is not evidence`);
  }
  assert.equal(publicText.includes(evidence.files["jev-function"].slice(0, 300)), false, "no file text is public");

  // Static imports as written, resolved through the declared URL mapping.
  const importPairs = new Set(manifest.imports.map(edge => `${edge.from}->${edge.to}`));
  for (const pair of ["browser-app->jev-contract", "browser-app->decision-log", "browser-app->architecture-document",
    "jev-function->jev-contract", "jev-function->architecture-builder", "worker->jev-function", "browser-app->semantic-map", "browser-app->hayamimi"]) {
    assert.ok(importPairs.has(pair), `import ${pair}`);
  }
  // An import into a file that is not admitted is listed, not drawn.
  assert.ok(manifest.coverage.skipped.some(entry => entry.specifier === "/app/src/turn.mjs" && /not admitted/u.test(entry.reason)));
  assert.ok(manifest.coverage.unsupported.some(entry => entry.path === "web/index.html"));

  // A declared identifier in a file's text makes a candidate, and says so.
  const credential = manifest.candidates.find(candidate => candidate.from === "jev-function" && candidate.to === "jev-credential");
  assert.deepEqual(credential?.reasons, ["cooccurrence:JEV_API_KEY"]);

  // Declared facts, read at exact pointers.
  assert.deepEqual(manifest.facts.find(fact => fact.id === "architecture-key"),
    { id: "architecture-key", entity: "architecture-config", path: "dev/architecture-config.v1.json", pointer: "/persistence/key", value: "voice-ui.architecture-document.v1" });
});

// A small source of its own: a real import, the same words in a comment and a
// string, a file the parser rejects, a JSON file and an excluded secret-like file.
const fixture = ({ unclassified = false } = {}) => {
  const root = scratch();
  const put = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  put("a.mjs", [
    "// import fromComment from \"./d.mjs\";",
    "const text = 'import fromString from \"./e.mjs\"';",
    "import { value } from \"./d.mjs\";",
    "export const used = value + text + \"TOKEN_NAME\";",
  ].join("\n"));
  put("d.mjs", "export const value = 1;\n");
  put("e.mjs", "export const = broken;\n");
  put("f.json", "{\"store\": {\"key\": \"k1\"}}\n");
  put("secret.env", "TOKEN_NAME=never-in-evidence\n");
  if (unclassified) put("stray.mjs", "export {};\n");
  const scope = {
    schema: "voice-ui.architecture-scope/1",
    handle: "fixture",
    root: "fixture",
    urls: [],
    admitted: [
      { path: "a.mjs", entity: "a", label: "A" },
      { path: "d.mjs", entity: "d", label: "D" },
      { path: "e.mjs", entity: "e", label: "E" },
      { path: "f.json", entity: "f", label: "F" },
    ],
    excluded: [{ path: "secret.env", reason: "secret" }],
    external: [{ entity: "token", label: "Token", urls: [], identifiers: ["TOKEN_NAME"] }],
    facts: [{ id: "store-key", path: "f.json", pointer: "/store/key" }],
    roles: [{ key: "data", purpose: "holds data" }],
    relations: [{ key: "calls", purpose: "calls it" }],
    notAnalyzed: ["dynamic import() is not analyzed"],
  };
  const scopeFile = path.join(scratch(), "scope.json");
  fs.writeFileSync(scopeFile, JSON.stringify(scope));
  return { root, scopeFile };
};

test("imports come from the parser only: words in comments and strings are no import, a broken file is unsupported", () => {
  const { root, scopeFile } = fixture();
  const prepared = run({ scope: scopeFile, root });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(prepared.manifest.imports, [{ from: "a", to: "d", path: "a.mjs", specifier: "./d.mjs" }]);
  assert.deepEqual(prepared.manifest.coverage.unsupported.map(entry => entry.path).sort(), ["e.mjs", "f.json"]);
  assert.match(prepared.manifest.coverage.unsupported.find(entry => entry.path === "e.mjs").reason, /not parsed/u);
  assert.deepEqual(prepared.manifest.candidates.map(candidate => [candidate.id, candidate.reasons]), [
    ["c-a--d", ["import"]],
    ["c-a--token", ["cooccurrence:TOKEN_NAME"]],
  ]);
  assert.deepEqual(prepared.manifest.facts, [{ id: "store-key", entity: "f", path: "f.json", pointer: "/store/key", value: "k1" }]);
  assert.equal(prepared.bytes.includes("never-in-evidence"), false, "an excluded file is read for its identity only");
});

test("a file neither admitted nor excluded, or a missing platform parser, stops the preparation", () => {
  const { root, scopeFile } = fixture({ unclassified: true });
  const stray = run({ scope: scopeFile, root });
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /neither admitted nor excluded: stray\.mjs/u);
  assert.equal(fs.existsSync(path.join(stray.out, "manifest.json")), false, "nothing is written");

  const clean = fixture();
  const noFlag = run({ scope: clean.scopeFile, root: clean.root, flag: false });
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /unavailable: node:vm SourceTextModule is missing/u);
});
