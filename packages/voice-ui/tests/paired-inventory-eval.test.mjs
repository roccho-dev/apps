import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("comparison runner rejects unknown schemas before reading runtime modules, creating outputs or HTTP", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-schema-"));
  try {
    for (const schema of [undefined, null, "voice-ui.poc.input-projecton/2", "voice-ui.poc.input-projection/3"]) {
      const input = path.join(directory, "input.json"), output = path.join(directory, "out");
      fs.writeFileSync(input, JSON.stringify({ schema }));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./paired-inventory-eval.mjs", import.meta.url)),
        "--inputs", input, "--origin", "http://127.0.0.1:18845", "--semantic-map", path.join(directory, "absent-modules"),
        "--identities", path.join(directory, "absent-identity.json"), "--out", output], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.match(result.stderr, /evaluation_input_schema/u);
      assert.equal(fs.existsSync(output), false);
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + "candidate-schema-"));
    fs.rmSync(directory, { recursive: true });
  }
});

