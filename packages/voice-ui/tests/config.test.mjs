import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readConfig } from "../src/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = JSON.parse(fs.readFileSync(path.join(here, "../web/data/config.v1.json"), "utf8"));
const ARCHITECTURE = JSON.parse(fs.readFileSync(path.join(here, "../dev/architecture-config.v1.json"), "utf8"));
const VALID = Object.freeze({
  schema: "voice-ui.config/2",
  persistence: { format: "decision-log/1", mechanism: "localStorage", key: "some key" },
  data: { bundle: "/data/some.json" },
});
const withPersistence = persistence => ({ ...VALID, persistence: { ...VALID.persistence, ...persistence } });
const withBundle = bundle => ({ ...VALID, data: { bundle } });

test("the shipped config declares the plain format, localStorage, the existing key and the packaged bundle", () => {
  assert.deepEqual(readConfig(SHIPPED), {
    persistence: { format: "decision-log/1", mechanism: "localStorage", key: "voice-ui.decision-log.v1" },
    data: { bundle: "/data/bundle.v1.json" },
  });
});

test("the architecture page's config declares its own format and key, and the prepared source beside it", () => {
  assert.deepEqual(readConfig(ARCHITECTURE), {
    persistence: { format: "architecture-document/1", mechanism: "localStorage", key: "voice-ui.architecture-document.v1" },
    data: { bundle: "/data/bundle.v1.json", source: "/architecture/data/source.v1.json" },
  });
  assert.notEqual(ARCHITECTURE.persistence.key, SHIPPED.persistence.key, "the two pages never share a stored value");
});

test("each format has exactly its own data, and no other format exists", () => {
  assert.match(readConfig(withPersistence({ format: "architecture-document/2" })).error, /format/u);
  assert.match(readConfig(withPersistence({ format: undefined })).error, /format/u);
  assert.match(readConfig({ ...VALID, data: { bundle: "/b.json", source: "/s.json" } }).error, /exactly bundle$/u,
    "the plain format takes no source");
  const architecture = withPersistence({ format: "architecture-document/1" });
  assert.match(readConfig(architecture).error, /exactly bundle, source/u, "the architecture format needs its source");
  assert.match(readConfig({ ...architecture, data: { bundle: "/b.json", source: "s.json" } }).error, /data source/u);
});

test("a valid config is returned as declared, frozen, with the key exactly as written", () => {
  const config = readConfig(withPersistence({ key: "  spaced key  " }));
  assert.equal(config.error, undefined);
  assert.equal(config.persistence.key, "  spaced key  ", "the key is never rewritten");
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.persistence) && Object.isFrozen(config.data));
});

test("there are no defaults: nothing, or any missing or extra field, is refused", () => {
  for (const value of [null, undefined, "config", [], {}]) assert.ok(readConfig(value).error, JSON.stringify(value));
  const { schema, persistence, data } = VALID;
  for (const value of [{ persistence, data }, { schema, data }, { schema, persistence }, { ...VALID, extra: 1 },
    { ...VALID, persistence: { mechanism: "localStorage" } }, { ...VALID, persistence: { key: "k" } },
    { ...VALID, persistence: { ...persistence, extra: 1 } }, { ...VALID, data: {} }, { ...VALID, data: { ...data, extra: 1 } }]) {
    assert.ok(readConfig(value).error, JSON.stringify(value));
  }
});

test("the schema, the one mechanism and a non-empty key are required", () => {
  assert.match(readConfig({ ...VALID, schema: "voice-ui.config/1" }).error, /schema/u, "the earlier schema is not read");
  for (const mechanism of ["indexedDB", "sessionStorage", "", null]) {
    assert.match(readConfig(withPersistence({ mechanism })).error, /mechanism/u, String(mechanism));
  }
  for (const key of ["", "   ", "\t\n", null, 1]) {
    assert.match(readConfig(withPersistence({ key })).error, /key/u, JSON.stringify(key));
  }
});

test("the bundle is a clean root-relative path of this origin, never rewritten", () => {
  for (const bundle of ["/data/bundle.v1.json", "/b.json", "/a/b/c.json"]) {
    assert.equal(readConfig(withBundle(bundle)).data.bundle, bundle);
  }
  for (const bundle of [
    "data/bundle.v1.json", "./bundle.json", "//evil.invalid/b.json", "https://evil.invalid/b.json",
    "/data/b.json?x=1", "/data/b.json#x", "/data\\b.json", "/data/../b.json", "/data/./b.json",
    "/data/a b.json", "", null,
  ]) {
    assert.match(readConfig(withBundle(bundle)).error, /bundle/u, JSON.stringify(bundle));
  }
});
