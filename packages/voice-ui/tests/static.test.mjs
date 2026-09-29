import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Source evidence, and only source evidence: a precise pattern gate over every
// repo-authored executable file in this package, found by walking it. It
// proves the patterns below are absent - not runtime reachability, not
// concurrency, not REAL provider evidence - and it stands beside independent
// review, not in place of it. Its own patterns are the one readable table
// below; every other byte of this file is scanned like any other file.

// class-free-patterns: begin
// JavaScript authored-OOP mechanisms.
const CLASS_SYNTAX = /\bclass(\s+[A-Za-z_$][\w$]*)?(\s+extends\b[^{\n]*)?\s*\{/u;
const EXTENDS = /\bextends\b/u;
const SUPER = /\bsuper\s*[.(]/u;
const NEW_TARGET = /\bnew\.target\b/u;
const THIS_IN_CODE = /\bthis(\.|\[|\s*[,);])/u;
const INSTANCEOF = /\binstanceof\b/u;
const PROTOTYPE = /\.prototype\b/u;
const PROTO = /__proto__/u;
const OBJECT_PROTOTYPES = /\bObject\.(create|setPrototypeOf)\b/u;
const REFLECT_PROTOTYPES = /\bReflect\.(construct|setPrototypeOf)\b/u;
const EVAL = /\beval\s*\(/u;
const NEW_FUNCTION = /\bnew\s+Function\b/u;
const NEW_CALL = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/gu;
// Python authored-OOP mechanisms.
const PY_CLASS = /^\s*class\s+\w+\s*[(:]/mu;
const PY_TYPE = /\btype\s*\([^()\n]*,[^()\n]*,/u;
// Skip-as-pass forms.
const SKIP_BANS = [
  "test.skip",
  "describe.skip",
  "t.skip(",
  "skip:",
  "todo:",
  "process.exit(0)",
];
// The one test-instrumentation exception and what may match inside it.
const EXCEPTION_MARKER = /^\s*\/\/ class-free-exception: (begin|end) AudioWorklet\.prototype\.addModule\s*$/u;
const EXCEPTION_TARGET = /AudioWorklet\.prototype\.addModule/gu;
const EXCEPTION_FORWARDED_THIS = /\.apply\(this, /gu;
// This table's own delimiters.
const PATTERN_MARKER = /^\s*\/\/ class-free-patterns: (begin|end)\s*$/u;
// Standard platform constructors this package actually calls with new.
const PLATFORM_CONSTRUCTORS = [
  "AbortController",
  "DOMException",
  "Date",
  "Error",
  "Map",
  "MutationObserver",
  "Promise",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "TypeError",
  "URL",
];
// class-free-patterns: end

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SELF = "tests/static.test.mjs";
const E2E = "tests/local-voice-graph-e2e.mjs";

const walk = directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(relative) : [relative];
});
const files = walk("").sort();
const javascript = files.filter(file => /\.(m?js)$/u.test(file));
const python = files.filter(file => file.endsWith(".py"));
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const lines = file => read(file).split("\n");

const PRODUCTION = /^(src\/.+\.mjs|web\/[^/]+\.mjs|functions\/.+\.mjs|dev\/.+\.mjs)$/u;
const production = javascript.filter(file => PRODUCTION.test(file));
const ENTRYPOINTS = Object.freeze({
  "web/app.mjs": [],
  "functions/pages-worker.mjs": ["default"],
  "dev/serve.mjs": [],
});

// The lines of a file between one delimiter pair, delimiters included, as
// [first, last] indexes - asserting there is exactly one ordered pair.
const range = (file, marker) => {
  const hits = lines(file).map((line, index) => [line.match(marker)?.[1], index]).filter(([kind]) => kind !== undefined);
  assert.deepEqual(hits.map(([kind]) => kind), ["begin", "end"], `${file}: exactly one ordered, nonnested marker pair`);
  return [hits[0][1], hits[1][1]];
};

// Each line of a file as the class-free gate sees it: the table in this file
// and the one exception's own target and forwarded receiver are taken out, and
// nothing else is.
const scanned = file => {
  const all = lines(file);
  const table = file === SELF ? range(SELF, PATTERN_MARKER) : null;
  const exception = file === E2E ? range(E2E, EXCEPTION_MARKER) : null;
  return all.map((line, index) => {
    if (table !== null && index >= table[0] && index <= table[1]) return "";
    if (exception !== null && index >= exception[0] && index <= exception[1]) {
      return line.replace(EXCEPTION_TARGET, "").replace(EXCEPTION_FORWARDED_THIS, "(");
    }
    return line;
  });
};

const FORBIDDEN = [CLASS_SYNTAX, EXTENDS, SUPER, NEW_TARGET, THIS_IN_CODE, INSTANCEOF, PROTOTYPE, PROTO,
  OBJECT_PROTOTYPES, REFLECT_PROTOTYPES, EVAL, NEW_FUNCTION];

test("the walk finds this package's executables, this gate among them", () => {
  assert.ok(javascript.includes(SELF) && javascript.includes(E2E) && production.includes("web/app.mjs"));
  assert.ok(python.includes("dist.py"));
  for (const entry of Object.keys(ENTRYPOINTS)) assert.ok(production.includes(entry), entry);
});

test("no authored class, prototype chain, receiver-based object, constructor type test, eval or function constructor", () => {
  const found = javascript.flatMap(file => scanned(file).flatMap((line, index) =>
    FORBIDDEN.filter(pattern => pattern.test(line)).map(pattern => `${file}:${index + 1} ${pattern} ${line.trim()}`)));
  assert.deepEqual(found, []);
  const inPython = python.flatMap(file => [PY_CLASS, PY_TYPE].filter(pattern => pattern.test(read(file))).map(pattern => `${file} ${pattern}`));
  assert.deepEqual(inPython, []);
});

test("new calls only the reviewed platform constructors, and every one of them is used", () => {
  const used = new Set();
  const unknown = [];
  for (const file of javascript) {
    scanned(file).forEach((line, index) => {
      for (const [, name] of line.matchAll(NEW_CALL)) {
        used.add(name);
        if (!PLATFORM_CONSTRUCTORS.includes(name)) unknown.push(`${file}:${index + 1} ${name}`);
      }
    });
  }
  assert.deepEqual(unknown, [], "a constructor outside the reviewed platform list");
  assert.deepEqual(PLATFORM_CONSTRUCTORS.filter(name => !used.has(name)), [], "an allowlist entry nothing uses");
  assert.deepEqual(PLATFORM_CONSTRUCTORS, [...PLATFORM_CONSTRUCTORS].sort());
});

test("the one exception is a single marked pair in the browser E2E, and holds only its own target", () => {
  const markers = javascript.flatMap(file => lines(file).map((line, index) => [file, index, line.match(EXCEPTION_MARKER)?.[1]]))
    .filter(([, , kind]) => kind !== undefined);
  assert.deepEqual(markers.map(([file, , kind]) => [file, kind]), [[E2E, "begin"], [E2E, "end"]]);
  const [first, last] = range(E2E, EXCEPTION_MARKER);
  const inside = lines(E2E).slice(first, last + 1).join("\n");
  assert.equal([...inside.matchAll(EXCEPTION_TARGET)].length >= 1, true, "the exception names its target");
});

test("the gate's own table has exactly one range, honoured only here, of plain literal definitions", () => {
  const holders = javascript.filter(file => lines(file).some(line => PATTERN_MARKER.test(line)));
  assert.deepEqual(holders, [SELF]);
  const [first, last] = range(SELF, PATTERN_MARKER);
  const body = lines(SELF).slice(first + 1, last);
  const literal = String.raw`(\/(?:\\.|[^/\\\n])+\/[a-z]*|"(?:\\.|[^"\\])*")`;
  const single = new RegExp(String.raw`^const [A-Z][A-Z0-9_]* = ${literal};$`, "u");
  const opening = /^const [A-Z][A-Z0-9_]* = \[$/u;
  const item = new RegExp(String.raw`^  ${literal},?$`, "u");
  let inArray = false;
  const odd = body.filter(line => {
    if (inArray) {
      if (line === "];") {
        inArray = false;
        return false;
      }
      return !item.test(line);
    }
    if (line.trim() === "" || /^\/\/ /u.test(line)) return false;
    if (opening.test(line)) {
      inArray = true;
      return false;
    }
    return !single.test(line);
  });
  assert.deepEqual(odd, [], "a line in the table that is not a plain literal definition");
  assert.equal(inArray, false, "every array in the table is closed");
});

test("no skip-as-pass form anywhere, and no browser E2E runs as a node test", () => {
  const found = javascript.flatMap(file => scanned(file).flatMap((line, index) =>
    SKIP_BANS.filter(form => line.includes(form)).map(form => `${file}:${index + 1} ${form}`)));
  assert.deepEqual(found, []);
  const browsers = javascript.filter(file => /["']playwright(-core)?["']/u.test(read(file)));
  assert.ok(browsers.length >= 2, "precondition: the browser E2Es are found");
  assert.deepEqual(browsers.filter(file => file.endsWith(".test.mjs")), []);
});

test("the page has no inline script", () => {
  for (const file of files.filter(name => name.endsWith(".html"))) {
    for (const [tag, body] of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu).map(match => [match[1], match[2]])) {
      assert.match(tag, /\bsrc=/u, `${file}: a script without src`);
      assert.equal(body.trim(), "", `${file}: an inline script body`);
    }
  }
});

// Production executables hold no protocol but the current one, no starter,
// default or fallback content, no test success, no product words and no test
// hook.
const LEGACY = [
  /voice-ui\.jev\.request\.v[1-9]\b/u,
  /voice-ui\.jev\.decision\.v[1-4]\b/u,
  /ui\.ir\.v1/u,
  /a2ui/u,
  /ui-ir/u,
  /voiceUiReady/u,
  /createVoiceUiApp/u,
];
const STARTER = [/node-[abc]\b/u, /voice graph/u, /initialGraph/u, /genesis/iu];
const TEST_SUCCESS = [/jev-test/u, /\bmock/iu];
const GLOBAL_WRITE = /\b(window|globalThis|self)(\.[\w$]+|\[[^\]]+\])\s*=(?!=)/u;

test("production executables carry only the current protocol, and no starter or test content", () => {
  const found = production.flatMap(file => read(file).split("\n").flatMap((line, index) =>
    [...LEGACY, ...STARTER, ...TEST_SUCCESS, GLOBAL_WRITE].filter(pattern => pattern.test(line))
      .map(pattern => `${file}:${index + 1} ${pattern} ${line.trim()}`)));
  assert.deepEqual(found, []);
});

test("no product word from the DataBundle is written into executable code", () => {
  const bundle = JSON.parse(read("web/data/bundle.v1.json"));
  const words = [
    ...bundle.parts.flatMap(part => [part.label, part.purpose]),
    ...bundle.diagrams.flatMap(diagram => [
      diagram.key, diagram.label, diagram.purpose,
      ...diagram.lanes.flatMap(lane => [lane.ref, lane.label]),
      ...diagram.steps.flatMap(step => [step.ref, step.label]),
    ]),
  ];
  const found = production.flatMap(file => words.filter(word => read(file).includes(word)).map(word => `${file}: ${word}`));
  assert.deepEqual(found, []);
});

// Imports as the browser and node resolve them. `/app/src/` is the one
// browser mapping into this package; everything else absolute is a provider.
const IMPORT = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))?\s*from\s*["']([^"']+)["']/gu;
const EXPORT = /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z_$][\w$]*)/gmu;
const resolve = (file, spec) => {
  if (spec.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  if (spec.startsWith("/app/src/")) return `src/${spec.slice("/app/src/".length)}`;
  assert.equal(spec.startsWith("/app/"), false, `${file}: ${spec} is not under the one /app/src/ mapping`);
  return null;
};

test("every production export has a production importer or is a named entrypoint; nothing is re-exported", () => {
  const used = new Map(production.map(file => [file, new Set()]));
  for (const file of production) {
    const source = read(file);
    assert.doesNotMatch(source, /^export\s*(\{|\*)/mu, `${file}: re-exports and export lists are forbidden`);
    for (const [, defaultName, named, namespace, spec] of source.matchAll(IMPORT)) {
      const target = resolve(file, spec);
      if (target === null) continue;
      assert.ok(production.includes(target), `${file} imports ${spec}, which is not a production module`);
      assert.equal(namespace, undefined, `${file}: a namespace import of ${spec} hides which exports are live`);
      if (defaultName !== undefined) used.get(target).add("default");
      for (const name of (named ?? "").split(",").map(entry => entry.trim().split(/\s+as\s+/u)[0]).filter(Boolean)) {
        used.get(target).add(name);
      }
    }
  }
  const exportsOf = file => {
    const names = [...read(file).matchAll(EXPORT)].map(match => match[1]);
    return /^export\s+default\b/mu.test(read(file)) ? [...names, "default"] : names;
  };
  const missing = [...used].flatMap(([file, names]) => [...names].filter(name => !exportsOf(file).includes(name))
    .map(name => `${file}#${name}`));
  assert.deepEqual(missing, [], "an import of a name its module does not export");
  const dead = [];
  for (const file of production) {
    const exported = exportsOf(file);
    if (Object.hasOwn(ENTRYPOINTS, file)) {
      assert.deepEqual(exported, ENTRYPOINTS[file], `${file} is an entrypoint with exactly its declared exports`);
      continue;
    }
    for (const name of exported) if (!used.get(file).has(name)) dead.push(`${file}#${name}`);
  }
  assert.deepEqual(dead, []);
});
