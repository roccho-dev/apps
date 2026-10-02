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
  const walk = directory => fs.readdirSync(path.join(PACKAGE, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(relative) : [relative];
  });
  assert.deepEqual(manifest.files.map(file => file.path).sort(), walk("").sort(), "every file is in the manifest");
  assert.ok(manifest.files.every(file => /^[0-9a-f]{40}$/u.test(file.blob)));

  // Admitted by class: everything the app runs or declares, the modules it
  // only uses inside included; tests, the harness, packaging and this
  // preparation excluded, each with its class's reason.
  const admitted = manifest.files.filter(file => file.class === "admitted").map(file => file.path);
  for (const file of ["src/turn.mjs", "src/render.mjs", "src/bundle.mjs", "web/data/bundle.v1.json", "artifact.jsonl", "dev/serve.mjs", "web/app.mjs"]) {
    assert.ok(admitted.includes(file), `${file} is admitted`);
  }
  assert.ok(admitted.every(file => /^(src|web|functions|dev)\//u.test(file) || file === "artifact.jsonl"));
  assert.ok(manifest.files.filter(file => file.class === "excluded").every(file => /^(tests|acceptance|architecture)\//u.test(file.path) || file.path === "dist.py"));
  assert.ok(manifest.files.filter(file => file.class === "excluded").every(file => file.reason.length > 0));

  // Every admitted file is one entity, named and labelled by its own path.
  const files = manifest.entities.filter(entity => entity.kind === "file");
  assert.deepEqual(files.map(entity => entity.path).sort(), admitted.sort());
  assert.ok(files.every(entity => entity.label === entity.path));
  assert.equal(files.find(entity => entity.path === "web/app.mjs").id, "web-app-mjs");
  assert.deepEqual(manifest.entities.filter(entity => entity.kind === "external").map(entity => [entity.id, entity.label]), [
    ["ext-voice-ui-judge-provider", "voice-ui-judge-provider"], ["ext-jev-api-key", "JEV_API_KEY"], ["ext-localstorage", "localStorage"],
    ["ext-ui", "/ui/"], ["ext-hayamimi", "/hayamimi/"],
  ]);

  // The private evidence holds exactly the admitted files, and the public
  // manifest holds none of their text.
  assert.deepEqual(Object.keys(evidence.files).sort(), files.map(entity => entity.id).sort());
  for (const entity of files) assert.equal(evidence.files[entity.id], fs.readFileSync(path.join(PACKAGE, entity.path), "utf8"));
  for (const excluded of manifest.files.filter(file => file.class === "excluded")) {
    const body = fs.readFileSync(path.join(PACKAGE, excluded.path), "utf8");
    assert.ok(!JSON.stringify(evidence).includes(body.slice(0, 200)) || body.length === 0, `${excluded.path} is not evidence`);
  }
  assert.equal(JSON.stringify(manifest).includes(evidence.files["functions-api-judge-mjs"].slice(0, 300)), false, "no file text is public");

  // Static imports as written, and what each resolution rests on.
  const importOf = (from, to) => manifest.imports.find(edge => edge.from === from && edge.to === to);
  assert.equal(importOf("functions-pages-worker-mjs", "functions-api-judge-mjs")?.resolution, "relative");
  assert.equal(importOf("web-app-mjs", "src-contract-mjs")?.resolution, "scope-url-map");
  assert.equal(importOf("web-app-mjs", "src-turn-mjs")?.resolution, "scope-url-map");
  assert.equal(importOf("web-app-mjs", "ext-ui")?.resolution, "scope-external-url");
  assert.ok(importOf("functions-api-judge-mjs", "src-architecture-mjs"));
  assert.ok(manifest.coverage.skipped.every(entry => entry.reason === "platform import"
    || (entry.path === "functions/pages-worker.mjs" && entry.specifier === "voice-ui-judge-provider" && entry.reason === "unresolved bare import")),
  "platform imports and the non-admitted provider alias are left undrawn");
  assert.ok(manifest.coverage.unsupported.some(entry => entry.path === "web/index.html"));

  // An identifier in a file's text makes a candidate, and says which: the
  // credential's name in both files that hold it; the Worker's route in the
  // page that calls it; nothing between files that merely share an import.
  const reasonsOf = (from, to) => manifest.candidates.find(candidate => candidate.from === from && candidate.to === to)?.reasons;
  assert.deepEqual(reasonsOf("functions-pages-worker-mjs", "ext-jev-api-key"), ["identifier:JEV_API_KEY"]);
  assert.deepEqual(reasonsOf("dev-serve-mjs", "ext-jev-api-key"), ["identifier:JEV_API_KEY"]);
  assert.deepEqual(reasonsOf("web-adapters-judgment-mjs", "functions-pages-worker-mjs"), ["identifier:/api/judge"]);
  assert.deepEqual(reasonsOf("web-app-mjs", "ext-localstorage"), ["identifier:localStorage"]);
  assert.deepEqual(reasonsOf("web-adapters-transcription-mjs", "ext-hayamimi"), ["identifier:/hayamimi/"], "dynamic provider URLs are literal candidates, not static imports");
  assert.equal(importOf("web-adapters-transcription-mjs", "ext-hayamimi"), undefined);
  assert.deepEqual(reasonsOf("functions-pages-worker-mjs", "ext-voice-ui-judge-provider"), ["identifier:voice-ui-judge-provider"]);
  assert.equal(reasonsOf("web-app-mjs", "functions-api-judge-mjs"), undefined, "a shared import is no candidate");
  assert.ok(manifest.candidates.every(candidate => candidate.reasons.every(reason => /^(import|identifier):./u.test(reason))));

  // Declared facts, read at exact pointers - of a JSON file, or of one row of a JSONL file.
  assert.deepEqual(manifest.facts.find(fact => fact.id === "architecture-key"),
    { id: "architecture-key", entity: "dev-architecture-config-v1-json", path: "dev/architecture-config.v1.json", pointer: "/persistence/key", value: "voice-ui.architecture-document.v1" });
  assert.deepEqual(manifest.facts.find(fact => fact.id === "required-capabilities"),
    { id: "required-capabilities", entity: "artifact-jsonl", path: "artifact.jsonl", row: 1, pointer: "/requiredCapabilities", value: ["jev-api"] });
  assert.deepEqual(manifest.facts.find(fact => fact.id === "normal-mechanism")?.value, "localStorage");
});

// A small source of its own: a real import, the same words in a comment and a
// string, a file the parser rejects, a JSON and a JSONL file, a route another
// file names, and an excluded secret-like file.
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
    "export const used = value + text + \"TOKEN_NAME\" + \"/api/x\";",
  ].join("\n"));
  put("d.mjs", "export const value = 1;\n");
  put("e.mjs", "export const = broken;\n");
  put("f.json", "{\"store\": {\"key\": \"k1\"}}\n");
  put("g.jsonl", "{\"first\": true}\n{\"needs\": [\"x\", \"y\"]}\n");
  put("h.mjs", "export const route = \"/api/x\";\n");
  put("secret.env", "TOKEN_NAME=never-in-evidence\n");
  if (unclassified) put("stray.mjs", "export {};\n");
  const scope = {
    schema: "voice-ui.architecture-scope/2",
    handle: "fixture",
    root: "fixture",
    urls: [],
    classes: [
      ...["a.mjs", "d.mjs", "e.mjs", "f.json", "g.jsonl", "h.mjs"].map(match => ({ match, class: "admitted" })),
      { match: "secret.env", class: "excluded", reason: "secret" },
    ],
    external: [{ identifier: "TOKEN_NAME" }],
    shared: [{ identifier: "/api/x", declaredBy: "h.mjs" }],
    facts: [{ id: "store-key", path: "f.json", pointer: "/store/key" }, { id: "needs", path: "g.jsonl", row: 2, pointer: "/needs" }],
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
  assert.deepEqual(prepared.manifest.imports, [{ from: "a-mjs", to: "d-mjs", path: "a.mjs", specifier: "./d.mjs", resolution: "relative" }]);
  assert.deepEqual(prepared.manifest.coverage.unsupported.map(entry => entry.path).sort(), ["e.mjs", "f.json", "g.jsonl"]);
  assert.match(prepared.manifest.coverage.unsupported.find(entry => entry.path === "e.mjs").reason, /not parsed/u);
  assert.deepEqual(prepared.manifest.candidates.map(candidate => [candidate.id, candidate.reasons]), [
    ["c-a-mjs--d-mjs", ["import:./d.mjs"]],
    ["c-a-mjs--ext-token-name", ["identifier:TOKEN_NAME"]],
    ["c-a-mjs--h-mjs", ["identifier:/api/x"]],
  ]);
  assert.deepEqual(prepared.manifest.facts, [
    { id: "store-key", entity: "f-json", path: "f.json", pointer: "/store/key", value: "k1" },
    { id: "needs", entity: "g-jsonl", path: "g.jsonl", row: 2, pointer: "/needs", value: ["x", "y"] },
  ]);
  assert.equal(prepared.bytes.includes("never-in-evidence"), false, "an excluded file is read for its identity only");
});

test("a symbolic link is never followed or read, whether it points at a file or a directory", () => {
  const { root, scopeFile } = fixture();
  const outside = scratch();
  fs.writeFileSync(path.join(outside, "elsewhere.mjs"), "export const marker = \"OUTSIDE_THE_SOURCE\";\n");
  fs.symlinkSync(path.join(outside, "elsewhere.mjs"), path.join(root, "link.mjs"));
  fs.symlinkSync(outside, path.join(root, "linked"));
  const prepared = run({ scope: scopeFile, root });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.bytes.includes("OUTSIDE_THE_SOURCE"), false, "nothing behind a link is read");
  assert.deepEqual(prepared.manifest.files.map(file => file.path).filter(file => file.startsWith("link")), []);
  const refused = prepared.manifest.coverage.unsupported.filter(entry => /not a regular file/u.test(entry.reason)).map(entry => entry.path);
  assert.deepEqual(refused, ["link.mjs", "linked"], "each is listed as what it is");
});

test("a file in no class, or a missing platform parser, stops the preparation", () => {
  const { root, scopeFile } = fixture({ unclassified: true });
  const stray = run({ scope: scopeFile, root });
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /stray\.mjs falls in no class/u);
  assert.equal(fs.existsSync(path.join(stray.out, "manifest.json")), false, "nothing is written");

  const clean = fixture();
  const noFlag = run({ scope: clean.scopeFile, root: clean.root, flag: false });
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /unavailable: node:vm SourceTextModule is missing/u);
});

test("JSON syntax is required for every admitted original whole text, regardless of extension or value", () => {
  const { root, scopeFile } = fixture();
  const bodies = {
    "object.txt": "{\"key\":1}\n", "array.mjs": "[1,true,null]",
    "string.bin": "\"store\"", "number.data": "42", "boolean.js": "true", "null.jsonl": "null",
    "space.txt": " \nnull\t", "bom.txt": "\uFEFFnull",
    "trailing.json": "{} trailing", "rows.jsonl": "{}\n{}", "expression.mjs": "({key:1})",
  };
  const scope = JSON.parse(fs.readFileSync(scopeFile, "utf8"));
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(root, name), body);
    scope.classes.push({ match: name, class: "admitted" });
  }
  fs.writeFileSync(scopeFile, JSON.stringify(scope));
  const prepared = run({ scope: scopeFile, root });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.manifest.schema, "voice-ui.architecture-source/2");
  for (const file of prepared.manifest.files.filter(file => file.class === "admitted")) {
    const original = fs.readFileSync(path.join(root, file.path), "utf8");
    let positive = false;
    try { JSON.parse(original); positive = true; } catch {}
    assert.equal(file.jsonSyntax, positive, file.path);
    assert.equal(prepared.evidence.files[file.entity], original, "original bytes are not cleaned or reserialized");
  }
  assert.ok(prepared.manifest.files.filter(file => file.class === "excluded").every(file => !Object.hasOwn(file, "jsonSyntax")));
});
