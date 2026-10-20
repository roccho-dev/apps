import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Current distribution acceptance is distinct from the sealed v1 reserve pool.
// Re-read actual bodies, saved JSONL and packaged producer/protocol modules;
// do not accept a historical unit result as evidence for this consumer.
export async function auditCurrentBundleConsumer(root, output) {
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = fs.readFileSync(path.join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const relative = "site/data/bundle.v1.json";
  const bytes = fs.readFileSync(path.join(root, relative)), value = JSON.parse(bytes);
  const row = manifest.files.filter(item => item.path === relative);
  assert.equal(row.length, 1); assert.equal(row[0].sha256, hash(bytes)); assert.equal(row[0].bytes, bytes.length);
  assert.equal(value.schema, "voice-ui.bundle/2");
  const { readBundle } = await import(pathToFileURL(path.join(root, "site/app/src/bundle.mjs")));
  const protocol = await import(pathToFileURL(path.join(root, "site/ui/semantic-map/protocol/index.js")));
  const usable = readBundle(value);
  assert.equal(usable.goalSelection, "delta"); assert.deepEqual(usable.parts, value.parts); assert.deepEqual(usable.diagrams, value.diagrams);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "receipt.json")));
  assert.equal(receipt.manifest_sha256, hash(manifestBytes)); assert.deepEqual(receipt.sources, manifest.sources);
  const reads = receipt.bundleReads.filter(item => item.source === "current-distribution");
  assert.ok(reads.some(item => item.fixture === "equal-label-quantity" && item.consumerPhase === "ordinary"));
  assert.ok(reads.some(item => item.fixture === "nested-new-names" && item.consumerPhase === "ordinary"));
  for (const read of reads) {
    assert.equal(read.pathname, "/data/bundle.v1.json");
    const actual = fs.readFileSync(path.join(output, read.file));
    assert.equal(read.sha256, hash(actual)); assert.equal(read.bytes, actual.length);
    const expected = read.consumerPhase === "unknown-schema" ? Buffer.from(JSON.stringify({ ...value, schema: "voice-ui.bundle/unsupported" }))
      : read.consumerPhase === "duplicate-part-key" ? Buffer.from(JSON.stringify({ ...value, parts: [...value.parts, value.parts[0]] })) : bytes;
    assert.deepEqual(actual, expected);
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(output, "equal-label-quantity-reload-reduced.json"))).actual;
  assert.deepEqual(receipt.bundleConsumerControls.map(item => item.phase), ["unknown-schema", "duplicate-part-key", "restored-current"]);
  for (const control of receipt.bundleConsumerControls) {
    const record = JSON.parse(fs.readFileSync(path.join(output, control.file)));
    assert.equal(record.phase, control.phase);
    const read = reads.filter(item => item.fixture === "equal-label-quantity" && item.consumerPhase === control.phase);
    assert.equal(read.length, 1);
    const supplied = JSON.parse(fs.readFileSync(path.join(output, read[0].file)));
    const parsed = readBundle(supplied);
    if (control.phase === "unknown-schema") assert.deepEqual(parsed, { version: null, parts: null, diagrams: null });
    else if (control.phase === "duplicate-part-key") { assert.equal(parsed.parts, null); assert.deepEqual(parsed.diagrams, usable.diagrams); }
    else assert.deepEqual(parsed, usable);
    assert.equal(record.notice.affected, control.phase === "unknown-schema" ? "部品の追加 図の作成" : control.phase === "duplicate-part-key" ? "部品の追加" : "");
    assert.equal(record.actual.log, baseline.log); assert.equal(record.actual.stored, baseline.stored);
    assert.deepEqual(record.actual.records, baseline.records);
    const verified = await protocol.verifyDecisionLog(record.actual.log);
    assert.equal(verified.head, record.actual.head); assert.deepEqual(verified.records, record.actual.records);
    assert.equal(record.apiBefore, record.apiAfter); assert.equal(record.upstreamBefore, record.upstreamAfter);
    assert.equal(receipt.api.filter(item => item.consumerPhase === control.phase).length, 0);
    assert.equal(receipt.synthetic_upstream.filter(item => item.consumerPhase === control.phase).length, 0);
    const png = fs.readFileSync(path.join(output, control.png));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
  }
  const result = { schema: "voice-ui.current-bundle-consumer/1", status: "PASS", sources: manifest.sources,
    manifest_sha256: hash(manifestBytes), bundle_path: relative, bundle_sha256: hash(bytes),
    actual_http_reads: reads.length, negative_controls: 2, restored_current: true,
    scope: "Current completed distribution and ordinary UI boot/Goal/Apply/reload path; fixed malformed HTTP bodies, unchanged stored JSONL and packaged parser. Separate from historical v1 reserve acceptance; synthetic upstream, no live semantic claim." };
  fs.writeFileSync(path.join(output, "current-bundle-consumer-audit.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, output] = process.argv.slice(2);
  assert.ok(path.isAbsolute(root) && path.isAbsolute(output));
  console.log(JSON.stringify(await auditCurrentBundleConsumer(root, output)));
}
