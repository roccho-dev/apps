import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

test("selected cells reject changed parent inputs and duplicate/unknown arms before runtime or HTTP", () => {
  const parentBytes = fs.readFileSync(new URL("../../../docs/voice-ui/candidate-ci-20261017/preregistered/public-eight.inputs.json", import.meta.url));
  const parent = JSON.parse(parentBytes), directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-selected-"));
  try {
    for (const [mutate, expected] of [
      [x => { x.parent_inputs_sha256 = "0".repeat(64); }, "evaluation_selected_parent_binding"],
      [x => { x.cases[0].utterance += " changed"; }, "evaluation_selected_parent_binding"],
      [x => { x.comparison.arm_order = ["C", "C"]; }, "evaluation_arm_order"],
      [x => { x.comparison.arm_order = ["D"]; }, "evaluation_arm_order"],
    ]) {
      const value = { schema: "voice-ui.poc.selected-cells/1", phase_kind: "correction",
        parent_inputs_sha256: createHash("sha256").update(parentBytes).digest("hex"),
        fixture_contract: structuredClone(parent.fixture_contract), cases: [structuredClone(parent.cases[0])],
        comparison: { case_order: [parent.cases[0].id], arm_order: ["C"] } };
      mutate(value);
      const input = path.join(directory, "input.json"), output = path.join(directory, "out");
      fs.writeFileSync(input, JSON.stringify(value));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./paired-inventory-eval.mjs", import.meta.url)),
        "--inputs", input, "--origin", "http://127.0.0.1:18845", "--semantic-map", path.join(directory, "absent-modules"),
        "--identities", path.join(directory, "absent-identity.json"), "--out", output], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(expected), result.stderr);
      assert.equal(fs.existsSync(output), false);
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + "candidate-selected-"));
    fs.rmSync(directory, { recursive: true });
  }
});

