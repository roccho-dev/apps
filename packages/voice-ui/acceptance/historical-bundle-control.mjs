import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// The original comparisons require one identical inventory on both versions.
// An explicit historical mode preserves that input; it cannot admit the
// current default bundle or replace the independent current-consumer gate.
export function historicalBundleControl(artifact, baselineArtifact, extra) {
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const relative = "site/data/bundle.v1.json";
  const current = fs.readFileSync(path.join(artifact, relative));
  const baseline = fs.readFileSync(path.join(baselineArtifact, relative));
  assert.ok(extra.length === 0 || extra.length === 2 && extra[0] === "--historical-bundle");
  let bytes = current;
  if (extra.length) {
    assert.ok(path.isAbsolute(extra[1])); bytes = fs.readFileSync(extra[1]);
    assert.equal(hash(bytes), "8fd1b4f37f6a113653dbaeda5e040ba5bed6d7b007ab9269d307f8642d339189");
    assert.deepEqual(bytes, baseline, "exact original historical inventory");
    const original = JSON.parse(bytes);
    assert.equal(original.schema, "voice-ui.bundle/1"); assert.equal(original.parts.length, 8);
    assert.deepEqual(JSON.parse(current), { ...original, schema: "voice-ui.bundle/2" }, "current complete catalogue retained apart from declared schema migration");
  }
  assert.equal(hash(bytes), hash(baseline), "original paired inventory equality");
  return { bytes, proof: { mode: extra.length ? "EXPLICIT_FIXED_HISTORICAL_V1" : "CURRENT_DEFAULT_IDENTICAL_TO_BASELINE",
    distribution_bundle_path: relative, distribution_bundle_sha256: hash(current),
    served_comparison_bundle_sha256: hash(bytes), baseline_bundle_sha256: hash(baseline),
    current_consumer_acceptance: "SEPARATE_REQUIRED_GATE; historical PASS is insufficient" } };
}
