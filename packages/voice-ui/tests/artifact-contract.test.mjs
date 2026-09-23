import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const path = new URL("../artifact.jsonl", import.meta.url);

async function loadContract() {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "artifact auth contract must contain exactly one record");
  return JSON.parse(lines[0]);
}

test("voice-ui artifact declares only its auth requirement", async () => {
  const value = await loadContract();

  assert.deepEqual(Object.keys(value).sort(), [
    "artifact",
    "kind",
    "requiredCapabilities",
  ]);
  assert.equal(value.kind, "artifact.auth.v1");
  assert.equal(value.artifact, "voice-ui");
  assert.deepEqual(value.requiredCapabilities, ["jev-api"]);
});

test("artifact auth capabilities are non-empty unique ids", async () => {
  const value = await loadContract();
  const capabilities = value.requiredCapabilities;

  assert.ok(Array.isArray(capabilities));
  assert.ok(capabilities.length > 0);
  assert.equal(new Set(capabilities).size, capabilities.length);
  for (const capability of capabilities) {
    assert.match(capability, /^[a-z0-9][a-z0-9-]*$/);
  }
});
