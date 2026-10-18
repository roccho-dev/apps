// One public, run-specific diagnostic. No secret access, retries or production changes.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
export function classify(response, event, readSlots, readRows) {
  if (event.status === null || event.status === undefined)
    return { status: "TRANSPORT_UNKNOWN", required: null };
  if (event.status !== 200) return { status: response?.error === "parts_contract"
    ? "HTTP_CONTRACT_REJECTED" : "HTTP_ERROR", required: null };
  const keys = ["schema", "request_id", "slots", "required"];
  const closed = response !== null && typeof response === "object" && !Array.isArray(response)
    && Object.keys(response).length === keys.length && keys.every(k => Object.hasOwn(response, k));
  const required = closed && response.schema === "voice-ui.parts.requirements/2"
    && typeof response.request_id === "string"
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(response.request_id)
    ? readSlots(response.slots) : null;
  return required !== null && isDeepStrictEqual(required, readRows(response.required))
    ? { status: "VALID_CONTRACT", required } : { status: "CONTRACT_INVALID", required: null };
}
export function jobs(plan) {
  assert.equal(plan.schema, "voice-ui.extraction-diagnostic/1");
  assert.deepEqual(plan.authority.phase_cap, { jev: 0, typellm: 16 });
  assert.equal(plan.cases.length, 2); assert.equal(plan.conditions.length, 4);
  assert.equal(plan.schedule.length, 16);
  assert.equal(new Set(plan.schedule.map(c => c.id)).size, 16);
  const rows = plan.schedule.map(slot => {
    const item = plan.cases.find(c => c.id === slot.case);
    const condition = plan.conditions.find(c => c.id === slot.condition);
    assert.ok(item && condition && [1, 2].includes(slot.rep));
    assert.ok(["dependent", "independent"].includes(condition.generation));
    assert.ok(["full", "empty"].includes(condition.definitions));
    const request = structuredClone(item.request);
    if (condition.definitions === "empty") request.state.parts = [];
    return { ...slot, key: slot.case + "-" + slot.condition, request,
      route: plan.measurement.endpoint + "?generation=" + condition.generation };
  });
  assert.equal(new Set(rows.map(r => r.key)).size, 8);
  for (const row of rows) assert.equal(rows.filter(r => r.key === row.key).length, 2);
  return rows;
}
async function wire(planFile, runtimeFile, out) {
  const plan = json(planFile), rt = json(runtimeFile), rows = jobs(plan);
  assert.equal(rt.apps_sha, plan.measurement.apps);
  const workerBytes = fs.readFileSync(rt.worker.path);
  assert.equal(hash(workerBytes), rt.worker.sha256);
  const worker = (await import(pathToFileURL(rt.worker.path))).default;
  const captures = {};
  for (const row of rows) {
    if (captures[row.key]) continue;
    const sent = [], original = globalThis.fetch;
    let response;
    try {
      globalThis.fetch = async (input, init) => {
        assert.equal(input, "https://api.typellm.ai/v1/generate");
        assert.equal(init.method, "POST"); assert.equal(sent.length, 0);
        sent.push(init.body);
        return Response.json({ status: "completed", result: Object.fromEntries([1, 2, 3].map(n =>
          ["required" + n, { label: "", kind: "none", quantity: "0" }])) });
      };
      response = await worker.fetch(new Request("http://127.0.0.1:18845" + row.route, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row.request),
      }), { TYPELLM_API_KEY: "synthetic-diagnostic-only" });
    } finally { globalThis.fetch = original; }
    assert.equal(response.status, 200); assert.equal(sent.length, 1);
    captures[row.key] = { route: row.route, request_body_utf8: JSON.stringify(row.request),
      type_body_utf8: sent[0] };
  }
  const removeDependencies = x => {
    if (!x || typeof x !== "object") return;
    delete x.depends_on;
    for (const value of Object.values(x)) removeDependencies(value);
  };
  for (const row of rows) {
    const expected = JSON.parse(captures[row.case + "-DF"].type_body_utf8);
    const c = plan.conditions.find(c => c.id === row.condition);
    if (c.definitions === "empty") {
      const context = JSON.parse(expected.context); context.part_definitions = [];
      expected.context = JSON.stringify(context);
    }
    if (c.generation === "independent") removeDependencies(expected.questions);
    assert.deepEqual(JSON.parse(captures[row.key].type_body_utf8), expected);
    assert.equal(JSON.stringify(row.request), captures[row.key].request_body_utf8);
  }
  const result = { status: "PASS", scope: "KEYLESS_TYPE_BODY_BOUND_TO_LIVE_HTTP_INPUT_AND_FIXED_RUNTIME_NOT_LIVE_UPSTREAM_CAPTURE",
    measurement_apps: rt.apps_sha, plan_sha256: hash(fs.readFileSync(planFile)),
    worker_sha256: hash(workerBytes), provider_sha256: rt.provider.sha256,
    configured_model: "typellm-latest", configured_temperature: 0,
    captures, slots: rows.map(({ id, key, rep }) => ({ id, key, rep })),
    external_provider_sends: 0 };
  write(out, result); console.log(JSON.stringify({ status: result.status, captures: 8, slots: 16, external_provider_sends: 0 }));
}
async function run(planFile, runtimeFile, origin, out, wireFile) {
  assert.match(origin, /^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{3,4}$/u);
  const plan = json(planFile), rt = json(runtimeFile), witness = json(wireFile), rows = jobs(plan);
  assert.equal(rt.apps_sha, plan.measurement.apps);
  assert.equal(witness.plan_sha256, hash(fs.readFileSync(planFile)));
  assert.equal(witness.measurement_apps, rt.apps_sha); assert.equal(witness.status, "PASS");
  assert.equal(hash(fs.readFileSync(rt.worker.path)), witness.worker_sha256);
  const { readRequiredSlots, readRequired } = await import(pathToFileURL(rt.source_path + "/packages/voice-ui/src/completion.mjs"));
  const helper = rt.source_path + "/packages/voice-ui/tests/requirements-cycle-http.mjs";
  const { evaluationPost } = await import(pathToFileURL(helper));
  fs.mkdirSync(out, { mode: 0o700 });
  write(path.join(out, "identity.json"), { scope: plan.scope, measurement: rt,
    plan_sha256: witness.plan_sha256, wire_sha256: hash(fs.readFileSync(wireFile)),
    driver_sha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    http_helper_sha256: hash(fs.readFileSync(helper)), ordered_ids: rows.map(r => r.id),
    oracle_policy: "caller does not read or forward the public oracle" });
  const journal = fs.openSync(path.join(out, "events.jsonl"), "wx", 0o600), summary = [];
  const record = event => { fs.writeSync(journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); fs.fsyncSync(journal); };
  try {
    for (const [index, row] of rows.entries()) {
      const capture = witness.captures[row.key], body = JSON.stringify(row.request);
      assert.equal(row.route, capture.route); assert.equal(body, capture.request_body_utf8);
      const event = { id: row.id, arm: row.condition, n: index + 1, route: row.route, request: row.request };
      record({ kind: "http-start", ...event });
      let response = null;
      try { response = await evaluationPost({ url: origin + row.route, event, record }); }
      catch { /* Retain this failed slot. Never retry or substitute a later answer. */ }
      response ??= event.response ?? null;
      const { status, required } = classify(response, event, readRequiredSlots, readRequired);
      const cell = { ...row, request_body_utf8: body, response, event, status, required };
      write(path.join(out, row.id + ".json"), cell);
      summary.push({ id: row.id, case: row.case, condition: row.condition, rep: row.rep, status });
    }
  } finally {
    fs.fsyncSync(journal); fs.closeSync(journal);
    write(path.join(out, "execution.json"), { planned: 16, recorded: summary.length, summary,
      scope: plan.scope, retries: 0, additional_setup_provider_sends: 0 });
  }
  console.log(JSON.stringify({ planned: 16, recorded: summary.length,
    valid_contract: summary.filter(r => r.status === "VALID_CONTRACT").length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === "wire" && args.length === 3) await wire(...args);
  else if (action === "run" && args.length === 5) await run(...args);
  else throw Error("expected wire PLAN RUNTIME OUT or run PLAN RUNTIME ORIGIN OUT WIRE");
}
