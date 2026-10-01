// Build-time preparation of one exact source snapshot for the architecture
// view. It reads regular files under the scope root and nothing else: a
// symbolic link or special file is never followed or read, only reported.
// Every file falls in exactly one class of the scope data - admitted or
// excluded, the reason with it - and each admitted file is one entity, named
// by its own path. Admitted ES modules are parsed by the platform's own module
// parser (constructed only, never linked or evaluated), and declared facts are
// read at exact pointers of a JSON file or of one row of a JSONL file. It
// writes a public manifest (identities, entities, imports, candidates, facts,
// coverage; never file contents) and a private evidence file (the admitted
// files' text), which only the server binds. Without an exact commit there is
// no snapshot, so both files say "unavailable" and why.
//
// node --experimental-vm-modules prepare.mjs --scope <file> --root <dir> --commit <sha or ""> --out <dir>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Only present when this process runs with --experimental-vm-modules; its
// absence is reported as unavailable, never replaced by another parser.
const { SourceTextModule } = vm;

const MANIFEST_SCHEMA = "voice-ui.architecture-source/2";
const EVIDENCE_SCHEMA = "voice-ui.architecture-evidence/1";
const SCOPE_SCHEMA = "voice-ui.architecture-scope/2";
const COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ADMITTED = "admitted";
const EXCLUDED = "excluded";
const EXTERNAL_PREFIX = "ext-";

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

// The scope data, checked strictly. It is the one authority for which class
// each file falls in, what is external and how absolute imports resolve, and
// for the vocabulary Jev is offered. It names no entity and no label: those
// are the files' own paths and the external identifiers as written.
function readScope(file) {
  const scope = exactKeys(JSON.parse(fs.readFileSync(file, "utf8")),
    ["schema", "handle", "root", "urls", "classes", "external", "shared", "facts", "roles", "relations", "notAnalyzed"], "scope");
  if (scope.schema !== SCOPE_SCHEMA) fail(`scope schema must be ${SCOPE_SCHEMA}`);
  id(scope.handle, "scope.handle");
  text(scope.root, "scope.root");
  for (const entry of list(scope.urls, "scope.urls")) {
    exactKeys(entry, ["prefix", "path"], "scope.urls[]");
    text(entry.prefix, "url prefix");
    text(entry.path, "url path");
  }
  for (const entry of list(scope.classes, "scope.classes")) {
    exactKeys(entry, entry?.class === ADMITTED ? ["match", "class"] : ["match", "class", "reason"], "scope.classes[]");
    text(entry.match, "class match");
    if (entry.class !== ADMITTED && entry.class !== EXCLUDED) fail(`a class is ${ADMITTED} or ${EXCLUDED}`);
    if (entry.class === EXCLUDED) text(entry.reason, "excluded reason");
  }
  const matches = scope.classes.map(entry => entry.match);
  if (new Set(matches).size !== matches.length) fail("a class match may appear only once");
  for (const entry of list(scope.external, "scope.external")) {
    exactKeys(entry, Object.hasOwn(entry ?? {}, "url") ? ["url"] : ["identifier"], "scope.external[]");
    text(entry.url ?? entry.identifier, "external identifier or url");
  }
  for (const entry of list(scope.shared, "scope.shared")) {
    exactKeys(entry, ["identifier", "declaredBy"], "scope.shared[]");
    text(entry.identifier, "shared identifier");
    text(entry.declaredBy, "shared declaredBy");
  }
  for (const entry of list(scope.facts, "scope.facts")) {
    exactKeys(entry, Object.hasOwn(entry ?? {}, "row") ? ["id", "path", "row", "pointer"] : ["id", "path", "pointer"], "scope.facts[]");
    id(entry.id, "fact id");
    text(entry.path, "fact path");
    if (entry.row !== undefined && !(Number.isSafeInteger(entry.row) && entry.row >= 1)) fail("a fact row is a line number from 1");
    if (typeof entry.pointer !== "string" || !entry.pointer.startsWith("/")) fail("fact pointer must be a JSON pointer");
  }
  const factIds = scope.facts.map(entry => entry.id);
  if (new Set(factIds).size !== factIds.length) fail("fact ids must be unique");
  for (const name of ["roles", "relations"]) {
    for (const entry of list(scope[name], `scope.${name}`)) {
      exactKeys(entry, ["key", "purpose"], `scope.${name}[]`);
      id(entry.key, `${name} key`);
      text(entry.purpose, `${name} purpose`);
    }
  }
  list(scope.notAnalyzed, "scope.notAnalyzed").forEach(value => text(value, "notAnalyzed"));
  return scope;
}

// An entity id from a path or an identifier as written: lower case, every run
// of other characters one dash.
const idFrom = value => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

// Every entry under the root, as posix paths relative to it, in sorted order,
// each marked whether it is a regular file. Only a real directory is entered
// and only a regular file is ever read; a symbolic link or a special file is
// neither followed nor read, whatever it points at.
const walk = (root, directory = "") => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(root, relative) : [{ path: relative, regular: entry.isFile() }];
  })
  .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

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

  const entries = walk(root);
  // Never followed, never read: listed as what it is.
  const unsupported = entries.filter(entry => !entry.regular)
    .map(entry => ({ path: entry.path, reason: "not a regular file (a symbolic link or special file): not followed, not read" }));
  const files = entries.filter(entry => entry.regular).map(entry => entry.path);

  // Each file's one class, or the preparation stops.
  const classOf = new Map(files.map(file => {
    const matching = scope.classes.filter(entry => (entry.match.endsWith("/") ? file.startsWith(entry.match) : file === entry.match));
    if (matching.length !== 1) fail(`${file} falls in ${matching.length === 0 ? "no class" : "more than one class"}`);
    return [file, matching[0]];
  }));
  const unused = scope.classes.filter(entry => ![...classOf.values()].includes(entry));
  if (unused.length > 0) fail(`classes that match no file: ${unused.map(entry => entry.match).join(", ")}`);
  const admitted = files.filter(file => classOf.get(file).class === ADMITTED);

  const bytesOf = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file))]));
  const textOf = file => bytesOf.get(file).toString("utf8");
  // Syntax only, over the identical whole original text. No extension gate,
  // cleaning or reserialization; every JSON value, including null, counts.
  const jsonSyntaxOf = new Map(admitted.map(file => {
    try { JSON.parse(textOf(file)); return [file, true]; }
    catch { return [file, false]; }
  }));
  const entityOfPath = new Map(admitted.map(file => [file, idFrom(file)]));
  const externals = scope.external.map(entry => ({ ...entry, entity: `${EXTERNAL_PREFIX}${idFrom(entry.url ?? entry.identifier)}` }));
  const entities = [
    ...admitted.map(file => ({ id: entityOfPath.get(file), label: file, kind: "file", path: file })),
    ...externals.map(entry => ({ id: entry.entity, label: entry.url ?? entry.identifier, kind: "external" })),
  ];
  for (const entity of entities) id(entity.id, `the entity id of ${entity.label}`);
  if (new Set(entities.map(entity => entity.id)).size !== entities.length) fail("two paths or identifiers make the same entity id");

  // Where a specifier leads: an admitted file's entity, an external entity, or
  // a reason it is not drawn; and what the resolution rests on.
  const target = (file, specifier) => {
    let resolved = null;
    let resolution;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      resolution = "relative";
    } else if (specifier.startsWith("/")) {
      const mapped = scope.urls.find(entry => specifier.startsWith(entry.prefix));
      if (mapped !== undefined) {
        resolved = `${mapped.path}${specifier.slice(mapped.prefix.length)}`;
        resolution = "scope-url-map";
      } else {
        const external = externals.find(entry => entry.url !== undefined && specifier.startsWith(entry.url));
        return external === undefined ? { omitted: "unresolved absolute import" } : { entity: external.entity, resolution: "scope-external-url" };
      }
    } else if (specifier.startsWith("node:")) {
      return { omitted: "platform import" };
    } else {
      return { omitted: "unresolved bare import" };
    }
    if (entityOfPath.has(resolved)) return { entity: entityOfPath.get(resolved), resolution };
    if (classOf.has(resolved)) return { omitted: `import into a file not admitted (${resolved})` };
    return { omitted: `unresolved import (${resolved})` };
  };

  const imports = [];
  const skipped = [];
  for (const file of admitted) {
    if (!/\.m?js$/u.test(file)) {
      unsupported.push({ path: file, reason: "not an ES module: imports are not analyzed" });
      continue;
    }
    let requests;
    try {
      requests = new SourceTextModule(textOf(file), { identifier: file }).moduleRequests;
    } catch (error) {
      unsupported.push({ path: file, reason: `not parsed: ${String(error?.message ?? error)}` });
      continue;
    }
    if (!Array.isArray(requests)) fail("unavailable: node:vm SourceTextModule has no moduleRequests");
    for (const { specifier } of requests) {
      const reached = target(file, specifier);
      if (reached.omitted !== undefined) skipped.push({ path: file, specifier, reason: reached.omitted });
      else if (reached.entity !== entityOfPath.get(file)) {
        imports.push({ from: entityOfPath.get(file), to: reached.entity, path: file, specifier, resolution: reached.resolution });
      }
    }
  }

  // Candidate pairs Jev may judge, each reason naming the exact text it rests
  // on: an import by its specifier; an admitted file whose text contains an
  // external identifier; and an admitted file whose text contains an
  // identifier the scope says another admitted file declares, towards that
  // file. The last two are string matches and nothing more.
  const reasons = new Map();
  const note = (from, to, reason) => {
    const key = `${from} ${to}`;
    reasons.set(key, [...new Set([...(reasons.get(key) ?? []), reason])].sort());
  };
  for (const edge of imports) note(edge.from, edge.to, `import:${edge.specifier}`);
  for (const file of admitted) {
    for (const external of externals.filter(entry => entry.identifier !== undefined)) {
      if (textOf(file).includes(external.identifier)) note(entityOfPath.get(file), external.entity, `identifier:${external.identifier}`);
    }
  }
  for (const shared of scope.shared) {
    if (!entityOfPath.has(shared.declaredBy) || !textOf(shared.declaredBy).includes(shared.identifier)) {
      fail(`${shared.declaredBy} must be admitted and contain ${shared.identifier}`);
    }
    for (const file of admitted.filter(other => other !== shared.declaredBy && textOf(other).includes(shared.identifier))) {
      note(entityOfPath.get(file), entityOfPath.get(shared.declaredBy), `identifier:${shared.identifier}`);
    }
  }
  const candidates = [...reasons].map(([key, why]) => {
    const [from, to] = key.split(" ");
    return { id: `c-${from}--${to}`, from, to, reasons: why };
  }).sort((left, right) => left.id.localeCompare(right.id));

  // A fact is the value at a pointer of an admitted JSON file, or of one row
  // of an admitted JSONL file: a string, number or boolean, or a list of them.
  const scalar = value => ["string", "number", "boolean"].includes(typeof value);
  const facts = scope.facts.map(fact => {
    const jsonl = fact.row !== undefined;
    if (!entityOfPath.has(fact.path) || !fact.path.endsWith(jsonl ? ".jsonl" : ".json")) {
      fail(`fact ${fact.id} must read an admitted ${jsonl ? "JSONL file at a row" : "JSON file"}`);
    }
    const line = jsonl ? textOf(fact.path).split("\n")[fact.row - 1] : textOf(fact.path);
    if (typeof line !== "string" || line.trim() === "") fail(`fact ${fact.id}: ${fact.path} has no row ${fact.row}`);
    const value = atPointer(JSON.parse(line), fact.pointer);
    if (!(scalar(value) || (Array.isArray(value) && value.every(scalar)))) {
      fail(`fact ${fact.id}: ${fact.pointer} is not a string, number or boolean, or a list of them`);
    }
    return { id: fact.id, entity: entityOfPath.get(fact.path), path: fact.path, ...(jsonl ? { row: fact.row } : {}), pointer: fact.pointer, value };
  });

  const source = { handle: scope.handle, commit };
  const manifest = {
    schema: MANIFEST_SCHEMA,
    status: "available",
    source,
    files: files.map(file => classOf.get(file).class === ADMITTED
      ? { path: file, blob: blobOf(bytesOf.get(file)), class: ADMITTED, entity: entityOfPath.get(file), jsonSyntax: jsonSyntaxOf.get(file) }
      : { path: file, blob: blobOf(bytesOf.get(file)), class: EXCLUDED, reason: classOf.get(file).reason }),
    entities,
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
    files: Object.fromEntries(admitted.map(file => [entityOfPath.get(file), textOf(file)])),
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(path.join(out, "evidence.json"), `${JSON.stringify(evidence)}\n`);
}

prepare(parseArgs(process.argv.slice(2)));
