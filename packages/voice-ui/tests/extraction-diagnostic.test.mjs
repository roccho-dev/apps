// Recompute one finite stopped extraction diagnostic. No provider or product imports.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { jobs } from "../../../docs/voice-ui/extraction-cycle-20261018/diagnostic.mjs";
import { gradeFullRequired, sameValue } from "./requirements-cycle-score.mjs";
const root = fileURLToPath(new URL("../../../docs/voice-ui/extraction-cycle-20261018/", import.meta.url));
const read = p => fs.readFileSync(root + p), json = p => JSON.parse(read(p));
const hash = x => createHash("sha256").update(x).digest("hex");
const lines = p => read(p).toString().trim().split("\n").map(JSON.parse);
test("saved extraction diagnostic retains all 16 outcomes and recomputes finite comparisons", () => {
  const plan = json("diagnostic.json"), oracle = json("diagnostic.oracle.json"), result = json("result.json");
  const expected = jobs(plan), base = "evidence/public-A/", execution = json(base + "raw/execution.json");
  assert.equal(result.registration, "a8848187af718c52acfac9e8518522191af75b55");
  assert.equal(result.measurement_apps, plan.measurement.apps);
  assert.equal(result.scope, plan.scope);
  assert.deepEqual(fs.readdirSync(root + base + "raw").sort(),
    [...expected.map(r => r.id + ".json"), "identity.json", "events.jsonl", "execution.json"].sort());
  const identity = json(base + "raw/identity.json"), wire = json("diagnostic.wire.json");
  assert.equal(identity.plan_sha256, hash(read("diagnostic.json")));
  assert.equal(identity.wire_sha256, hash(read("diagnostic.wire.json")));
  assert.equal(identity.driver_sha256, hash(read("diagnostic.mjs")));
  assert.equal(identity.http_helper_sha256, hash(fs.readFileSync(fileURLToPath(new URL("./requirements-cycle-http.mjs", import.meta.url)))));
  assert.equal(identity.measurement.apps_sha, plan.measurement.apps);
  assert.equal(wire.worker_sha256, identity.measurement.worker.sha256);
  assert.equal(wire.provider_sha256, identity.measurement.provider.sha256);
  assert.deepEqual(identity.ordered_ids, expected.map(r => r.id));
  const events = lines(base + "raw/events.jsonl");
  assert.equal(events.length, 32);
  const stages = read(base + "stdout.log").toString().split("\n").filter(l => l.startsWith("{")).map(JSON.parse);
  assert.equal(stages.length, 16);
  assert.equal(new Set(stages.map(s => s.request_id)).size, 16);
  const rows = expected.map((r, index) => {
    const cell = json(base + "raw/" + r.id + ".json");
    for (const k of ["id", "case", "condition", "rep", "key", "route", "request"]) assert.deepEqual(cell[k], r[k]);
    assert.equal(cell.request_body_utf8, JSON.stringify(r.request));
    assert.equal(cell.request_body_utf8, wire.captures[r.key].request_body_utf8);
    assert.equal(cell.route, wire.captures[r.key].route);
    assert.equal(cell.event.n, index + 1);
    assert.deepEqual(cell.event.request, r.request);
    const [start, end] = events.slice(index * 2, index * 2 + 2);
    assert.equal(start.kind, "http-start"); assert.equal(end.kind, "http-end");
    for (const ev of [start, end]) { assert.equal(ev.id, r.id); assert.equal(ev.arm, r.condition); assert.equal(ev.n, index + 1); }
    assert.equal(end.status, cell.event.status); assert.deepEqual(end.response ?? null, cell.response);
    // This helper requires the original stock8 solely for its unused stock projection.
    // Empty-definition requests are still graded by their original full NEW oracle.
    const stock = plan.cases.find(c => c.id === r.case).request.state.parts;
    const grade = gradeFullRequired(cell.response, { required: oracle.required[r.case] }, stock);
    const valid = cell.event.status === 200 && grade.contract_valid;
    const stage = stages[index];
    assert.equal(stage.kind, "voice-ui.parts.stage.v2"); assert.equal(stage.stage, "TYPE_REQUIRED");
    assert.equal(stage.generation, plan.conditions.find(c => c.id === r.condition).generation);
    assert.equal(stage.valid, valid);
    if (valid) { assert.equal(stage.request_id, cell.response.request_id); assert.deepEqual(stage.proposal, { slots:cell.response.slots, required:cell.response.required }); }
    const status = cell.event.status == null ? "TRANSPORT_UNKNOWN" : cell.event.status !== 200
      ? cell.response?.error === "parts_contract" ? "HTTP_CONTRACT_REJECTED" : "HTTP_ERROR"
      : valid ? "VALID_CONTRACT" : "CONTRACT_INVALID";
    assert.equal(cell.status, status);
    assert.deepEqual(cell.required, valid ? cell.response.required : null);
    return { id: r.id, case: r.case, condition: r.condition, rep: r.rep, status,
      contract_valid: valid, exact: cell.event.status === 200 && grade.exact, required: cell.response?.required ?? null };
  });
  assert.deepEqual(result.rows, rows);
  assert.equal(execution.planned, 16); assert.equal(execution.recorded, 16); assert.equal(execution.retries, 0);
  assert.deepEqual(execution.summary, rows.map(({id, case: c, condition, rep, status}) => ({id, case:c, condition, rep, status})));
  const counts = {};
  for (const c of plan.conditions) {
    const cells = rows.filter(r => r.condition === c.id);
    counts[c.id] = { planned: cells.length, valid: cells.filter(r => r.contract_valid).length,
      exact: cells.filter(r => r.exact).length, semantic_wrong: cells.filter(r => r.contract_valid && !r.exact).length,
      http_contract_rejected: cells.filter(r => r.status === "HTTP_CONTRACT_REJECTED").length,
      other_invalid_or_unknown: cells.filter(r => !r.contract_valid && r.status !== "HTTP_CONTRACT_REJECTED").length };
  }
  assert.deepEqual(result.counts, counts);
  assert.deepEqual(result.pairs.map(p => [p.baseline, p.candidate]), [["DF","IF"],["DF","DE"],["DE","IE"],["IF","IE"]]);
  for (const p of result.pairs) {
    const q = { baseline:p.baseline, candidate:p.candidate, planned:4, valid_both:0, gains:0, regressions:0, ties:0, excluded_contract_or_transport:0 };
    for (const a of rows.filter(r => r.condition === p.baseline)) {
      const z = rows.find(r => r.case === a.case && r.rep === a.rep && r.condition === p.candidate);
      if (a.contract_valid && z.contract_valid) { q.valid_both++; if (!a.exact && z.exact) q.gains++; else if (a.exact && !z.exact) q.regressions++; else q.ties++; }
      else q.excluded_contract_or_transport++;
    }
    assert.deepEqual(p, q);
  }
  for (const k of ["product_effect", "fresh_quality", "model_mechanism"]) assert.equal(result[k], "UNPROVEN");
});
test("saved send ledger and stop receipt keep the whole cap and bootstrap failures", () => {
  const b = "evidence/public-A/", plan = json("diagnostic.json"), terminal = json(b + "root-terminal.json");
  const config = json(b + "config.json"), process = json(b + "process.json"), stop = json(b + "orchestration.json");
  assert.deepEqual(config.allowances, plan.authority.phase_cap);
  assert.equal(process.config_sha256, hash(read(b + "config.json")));
  assert.equal(stop.execution.exit, 0); assert.equal(stop.stop.status, "STOPPED_RECONCILED");
  const sends = read(b + "stderr.log").toString().split("\n").filter(l => l.startsWith("provider-send:"));
  assert.deepEqual(sends, Array.from({length:16}, (_,i) => "provider-send:typellm:" + (i+1)));
  const ledger = lines(b + "journal.jsonl"), charged = {jev:0,typellm:0}, pending = new Map();
  for (const e of ledger) {
    if (e.kind === "reserve") charged[e.provider] += e.charge;
    else if (e.kind === "phase-reserve") { assert.equal(pending.has(e.id),false); pending.set(e.id,e.allowances); }
    else if (e.kind === "phase-reconcile") { const a = pending.get(e.id); assert.ok(a); for (const p of ["jev","typellm"]) { assert.ok(Number.isInteger(e.sent[p]) && e.sent[p]>=0 && e.sent[p]<=a[p]); charged[p]+=e.sent[p]; } assert.equal(e.stopped_group_empty,true); pending.delete(e.id); }
    else assert.equal(e.kind,"outcome");
  }
  assert.equal(pending.size,0); assert.deepEqual(charged,{jev:847,typellm:104});
  assert.equal(terminal.journal_sha256,hash(read(b + "journal.jsonl")));
  assert.deepEqual(terminal.charged,charged); assert.equal(terminal.outstanding,0); assert.deepEqual(terminal.remaining_members,[]);
  assert.equal(terminal.owned_pgids,45); assert.deepEqual(stop.stop.result.whole_run_sent,charged);
  const last = ledger.at(-1); assert.equal(last.id,config.phase_id); assert.deepEqual(last.sent,{jev:0,typellm:16});
  assert.equal(last.stdout_sha256,hash(read(b + "stdout.log"))); assert.equal(last.stderr_sha256,hash(read(b + "stderr.log")));
  for (const phase of ["extraction-public-A-20261018","extraction-public-A2-20261018"]) {
    const receipt = json(b + "bootstrap/" + phase + ".process.json");
    assert.ok(ledger.some(e => e.kind==="phase-reconcile" && e.id===phase && sameValue(e.sent,{jev:0,typellm:0}) && e.pid===receipt.pid));
    assert.equal(read(b + "bootstrap/" + phase + ".stderr.log").toString().includes("provider-send:"),false);
  }
});
