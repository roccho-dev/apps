import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readConfig } from "../src/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = JSON.parse(fs.readFileSync(path.join(here, "../web/data/config.v1.json"), "utf8"));
const VALID = Object.freeze({
  schema: "voice-ui.config/1",
  persistence: { mechanism: "localStorage", key: "some key" },
  data: { bundle: "/data/some.json" },
});
const withPersistence = persistence => ({ ...VALID, persistence: { ...VALID.persistence, ...persistence } });
const withBundle = bundle => ({ ...VALID, data: { bundle } });

test("the shipped config declares localStorage, the existing key and the packaged bundle", () => {
  assert.deepEqual(readConfig(SHIPPED), {
    persistence: { mechanism: "localStorage", key: "voice-ui.decision-log.v1" },
    data: { bundle: "/data/bundle.v1.json" },
  });
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
  assert.match(readConfig({ ...VALID, schema: "voice-ui.config/2" }).error, /schema/u);
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
