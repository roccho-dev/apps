// Build-time preparation of one exact source snapshot for the architecture
// view. It reads files and nothing else: every file under the scope root must
// be admitted or excluded by the scope data, admitted ES modules are parsed by
// the platform's own module parser (constructed only, never linked or
// evaluated), and declared JSON facts are read at exact pointers. It writes a
// public manifest (identities, entities, imports, candidates, facts, coverage;
// never file contents) and a private evidence file (the admitted files' text),
// which only the server binds. Without an exact commit there is no snapshot, so
// both files say "unavailable" and why.
//
// node --experimental-vm-modules prepare.mjs --scope <file> --root <dir> --commit <sha or ""> --out <dir>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Only present when this process runs with --experimental-vm-modules; its
// absence is reported as unavailable, never replaced by another parser.
const { SourceTextModule } = vm;

const MANIFEST_SCHEMA = "voice-ui.architecture-source/1";
const EVIDENCE_SCHEMA = "voice-ui.architecture-evidence/1";
const SCOPE_SCHEMA = "voice-ui.architecture-scope/1";
const COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;

const fail = message => {
  process.stderr.write(`architecture prepare: ${message}\n`);
  process.exit(1);
};

const parseArgs = argv => {
  const names = ["scope", "root", "commit", "out"];
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!names.includes(name) || Object.hasOwn(values, name) || argv[index + 1] === undefined) {
      fail(`usage: --scope <file> --root <dir> --commit <sha or ""> --out <dir>`);
    }
    values[name] = argv[index + 1];
  }
  if (!names.every(name => Object.hasOwn(values, name))) fail("--scope, --root, --commit and --out are all required");
  return values;
};

const exactKeys = (value, keys, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail(`${label} must have exactly ${keys.join(", ")}`);
  }
  return value;
};
const text = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must match ${ID}`);
  return value;
};
const list = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
};

// The scope data, checked strictly. It is the one authority for what is
// admitted, excluded or external, and for the vocabulary Jev is offered.
function readScope(file) {
  const scope = exactKeys(JSON.parse(fs.readFileSync(file, "utf8")),
    ["schema", "handle", "root", "urls", "admitted", "excluded", "external", "facts", "roles", "relations", "notAnalyzed"], "scope");
  if (scope.schema !== SCOPE_SCHEMA) fail(`scope schema must be ${SCOPE_SCHEMA}`);
  id(scope.handle, "scope.handle");
  text(scope.root, "scope.root");
  for (const entry of list(scope.urls, "scope.urls")) {
    exactKeys(entry, ["prefix", "path"], "scope.urls[]");
    text(entry.prefix, "url prefix");
    text(entry.path, "url path");
  }
  for (const entry of list(scope.admitted, "scope.admitted")) {
    exactKeys(entry, ["path", "entity", "label"], "scope.admitted[]");
    text(entry.path, "admitted path");
    id(entry.entity, "admitted entity");
    text(entry.label, "admitted label");
  }
  for (const entry of list(scope.excluded, "scope.excluded")) {
    exactKeys(entry, ["path", "reason"], "scope.excluded[]");
    text(entry.path, "excluded path");
    text(entry.reason, "excluded reason");
  }
  for (const entry of list(scope.external, "scope.external")) {
    exactKeys(entry, ["entity", "label", "urls", "identifiers"], "scope.external[]");
    id(entry.entity, "external entity");
    text(entry.label, "external label");
    list(entry.urls, "external urls").forEach(url => text(url, "external url"));
    list(entry.identifiers, "external identifiers").forEach(value => text(value, "external identifier"));
  }
  for (const entry of list(scope.facts, "scope.facts")) {
    exactKeys(entry, ["id", "path", "pointer"], "scope.facts[]");
    id(entry.id, "fact id");
    text(entry.path, "fact path");
    if (typeof entry.pointer !== "string" || !entry.pointer.startsWith("/")) fail("fact pointer must be a JSON pointer");
  }
  for (const name of ["roles", "relations"]) {
    for (const entry of list(scope[name], `scope.${name}`)) {
      exactKeys(entry, ["key", "purpose"], `scope.${name}[]`);
      id(entry.key, `${name} key`);
      text(entry.purpose, `${name} purpose`);
    }
  }
  list(scope.notAnalyzed, "scope.notAnalyzed").forEach(value => text(value, "notAnalyzed"));
  const entities = [...scope.admitted.map(entry => entry.entity), ...scope.external.map(entry => entry.entity)];
  if (new Set(entities).size !== entities.length) fail("entity ids must be unique");
  const paths = [...scope.admitted, ...scope.excluded].map(entry => entry.path);
  if (new Set(paths).size !== paths.length) fail("a path may be admitted or excluded only once");
  return scope;
}

// Every file under the root, as posix paths relative to it, sorted.
const walk = (root, directory = "") => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(root, relative) : [relative];
  })
  .sort();

// Git's own identity for file content.
const blobOf = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// RFC 6901: the value at an exact pointer, or undefined.
const atPointer = (value, pointer) => pointer.slice(1).split("/")
  .map(token => token.replace(/~1/gu, "/").replace(/~0/gu, "~"))
  .reduce((current, token) => (current !== null && typeof current === "object" && Object.hasOwn(current, token) ? current[token] : undefined), value);

const unavailable = (out, reason) => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify({ schema: MANIFEST_SCHEMA, status: "unavailable", reason })}\n`);
  fs.writeFileSync(path.join(out, "evidence.json"), `${JSON.stringify({ schema: EVIDENCE_SCHEMA, status: "unavailable", reason })}\n`);
};

function prepare({ scope: scopeFile, root, commit, out }) {
  const scope = readScope(scopeFile);
  if (commit === "") {
    unavailable(out, "no exact commit: the source tree has uncommitted changes");
    return;
  }
  if (!COMMIT.test(commit)) fail("--commit must be a 40-character lowercase commit id or empty");
  if (typeof SourceTextModule !== "function") fail("unavailable: node:vm SourceTextModule is missing");

  const files = walk(root);
  const admitted = new Map(scope.admitted.map(entry => [entry.path, entry]));
  const excluded = new Map(scope.excluded.map(entry => [entry.path, entry]));
  const unclassified = files.filter(file => !admitted.has(file) && !excluded.has(file));
  if (unclassified.length > 0) fail(`files neither admitted nor excluded: ${unclassified.join(", ")}`);
  const missing = [...admitted.keys(), ...excluded.keys()].filter(file => !files.includes(file));
  if (missing.length > 0) fail(`scope names files that are not in the source: ${missing.join(", ")}`);

  const bytesOf = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file))]));
  const entityOfPath = new Map(scope.admitted.map(entry => [entry.path, entry.entity]));

  // Where a specifier leads: an admitted file's entity, an external entity, or
  // a reason it is not drawn.
  const target = (file, specifier) => {
    let resolved = null;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    } else if (specifier.startsWith("/")) {
      const mapped = scope.urls.find(entry => specifier.startsWith(entry.prefix));
      if (mapped !== undefined) resolved = `${mapped.path}${specifier.slice(mapped.prefix.length)}`;
      else {
        const external = scope.external.find(entry => entry.urls.some(url => specifier.startsWith(url)));
        return external === undefined ? { omitted: "unresolved absolute import" } : { entity: external.entity };
      }
    } else if (specifier.startsWith("node:")) {
      return { omitted: "platform import" };
    } else {
      return { omitted: "unresolved bare import" };
    }
    if (entityOfPath.has(resolved)) return { entity: entityOfPath.get(resolved) };
    if (excluded.has(resolved)) return { omitted: `import into a file not admitted (${resolved})` };
    return { omitted: `unresolved import (${resolved})` };
  };

  const imports = [];
  const unsupported = [];
  const skipped = [];
  for (const entry of scope.admitted) {
    if (!/\.m?js$/u.test(entry.path)) {
      unsupported.push({ path: entry.path, reason: "not an ES module: imports are not analyzed" });
      continue;
    }
    let requests;
    try {
      requests = new SourceTextModule(bytesOf.get(entry.path).toString("utf8"), { identifier: entry.path }).moduleRequests;
    } catch (error) {
      unsupported.push({ path: entry.path, reason: `not parsed: ${String(error?.message ?? error)}` });
      continue;
    }
    if (!Array.isArray(requests)) fail("unavailable: node:vm SourceTextModule has no moduleRequests");
    for (const { specifier } of requests) {
      const reached = target(entry.path, specifier);
      if (reached.omitted !== undefined) skipped.push({ path: entry.path, specifier, reason: reached.omitted });
      else if (reached.entity !== entry.entity) imports.push({ from: entry.entity, to: reached.entity, path: entry.path, specifier });
    }
  }

  // Candidate pairs Jev may judge: every import, and every admitted file whose
  // text contains an external entity's declared identifier. The second is a
  // string co-occurrence and nothing more.
  const reasons = new Map();
  const note = (from, to, reason) => {
    const key = `${from} ${to}`;
    reasons.set(key, [...new Set([...(reasons.get(key) ?? []), reason])].sort());
  };
  for (const edge of imports) note(edge.from, edge.to, "import");
  for (const entry of scope.admitted) {
    const content = bytesOf.get(entry.path).toString("utf8");
    for (const external of scope.external) {
      for (const identifier of external.identifiers) {
        if (content.includes(identifier)) note(entry.entity, external.entity, `cooccurrence:${identifier}`);
      }
    }
  }
  const candidates = [...reasons].map(([key, why]) => {
    const [from, to] = key.split(" ");
    return { id: `c-${from}--${to}`, from, to, reasons: why };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const facts = scope.facts.map(fact => {
    if (!admitted.has(fact.path) || !fact.path.endsWith(".json")) fail(`fact ${fact.id} must read an admitted JSON file`);
    const value = atPointer(JSON.parse(bytesOf.get(fact.path).toString("utf8")), fact.pointer);
    if (!["string", "number", "boolean"].includes(typeof value)) fail(`fact ${fact.id}: ${fact.pointer} is not a string, number or boolean`);
    return { id: fact.id, entity: entityOfPath.get(fact.path), path: fact.path, pointer: fact.pointer, value };
  });

  const source = { handle: scope.handle, commit };
  const manifest = {
    schema: MANIFEST_SCHEMA,
    status: "available",
    source,
    files: files.map(file => admitted.has(file)
      ? { path: file, blob: blobOf(bytesOf.get(file)), class: "admitted", entity: admitted.get(file).entity }
      : { path: file, blob: blobOf(bytesOf.get(file)), class: "excluded", reason: excluded.get(file).reason }),
    entities: [
      ...scope.admitted.map(entry => ({ id: entry.entity, label: entry.label, kind: "file", path: entry.path })),
      ...scope.external.map(entry => ({ id: entry.entity, label: entry.label, kind: "external" })),
    ],
    imports: imports.sort((left, right) => `${left.from} ${left.to} ${left.specifier}`.localeCompare(`${right.from} ${right.to} ${right.specifier}`)),
    candidates,
    facts,
    roles: scope.roles,
    relations: scope.relations,
    coverage: { unsupported, skipped, notAnalyzed: scope.notAnalyzed },
  };
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    status: "available",
    source,
    files: Object.fromEntries(scope.admitted.map(entry => [entry.entity, bytesOf.get(entry.path).toString("utf8")])),
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(path.join(out, "evidence.json"), `${JSON.stringify(evidence)}\n`);
}

prepare(parseArgs(process.argv.slice(2)));
