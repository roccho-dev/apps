// Offline byte verification only. Semantic scores are the independent R reports.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sums = JSON.parse(fs.readFileSync(path.join(root, "evidence-index.json")));
assert.equal(sums.schema, "voice-ui.poc.evidence-index/1");
assert.ok(Array.isArray(sums.files) && sums.files.length > 0);
const names = new Set();
let archives = 0, rawFiles = 0, rawBytes = 0;
for (const file of sums.files) {
  assert.match(file.name, /^(?:evidence\/)?[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  assert.ok(!names.has(file.name)); names.add(file.name);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const bytes = fs.readFileSync(path.join(root, file.name));
  assert.equal(bytes.length, file.bytes, file.name + ":bytes");
  assert.equal(hash(bytes), file.sha256, file.name + ":sha256");
  if (!file.name.endsWith(".evidence.json.gz")) continue;
  const archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
  assert.equal(archive.schema, "voice-ui.poc.evidence-archive/1");
  assert.ok(Array.isArray(archive.files) && archive.files.length > 0);
  const members = new Set();
  for (const member of archive.files) {
    assert.match(member.name, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    assert.ok(!members.has(member.name)); members.add(member.name);
    assert.match(member.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof member.bytes_base64, "string");
    const raw = Buffer.from(member.bytes_base64, "base64");
    assert.equal(raw.toString("base64"), member.bytes_base64);
    assert.equal(hash(raw), member.sha256, file.name + ":" + member.name);
    rawFiles++; rawBytes += raw.length;
  }
  archives++;
}
const actual = fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? fs.readdirSync(path.join(root, entry.name)).map(name => entry.name + "/" + name)
  : entry.name).filter(name => name !== "evidence-index.json").sort();
assert.deepEqual([...names].sort(), actual, "unindexed or absent evidence");
console.log(JSON.stringify({ status: "VERIFIED_BYTES_ONLY", indexedFiles: names.size, archives, rawFiles, rawBytes }));
