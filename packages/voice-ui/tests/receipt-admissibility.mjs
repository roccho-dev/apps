// Independent deterministic receipt joins. A PASS here means recorded evidence
// agrees; it does not establish CI-origin live execution or re-observe a past PID.
import { createHash } from "node:crypto";
import { canonical } from "./semantic-score.mjs";
import { gradeArm, summarizePanel } from "./panel-semantic-score.mjs";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
const stringify = value => JSON.stringify(canonical(value));
const same = (a, b) => stringify(a) === stringify(b);
const decode = bytes => JSON.parse(Buffer.from(bytes).toString("utf8"));
const exact = (x, keys) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const pair = row => row.id + "/" + row.arm;
const providers = ["jev", "typellm"];
const counts = () => ({ jev: 0, typellm: 0 });
const countShape = value => exact(value, providers) && providers.every(p => Number.isInteger(value[p]) && value[p] >= 0);

export function jsonLines(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.slice(0, -1).split("\n").some(line => !line))
    throw Error("noncanonical_jsonl_framing");
  return text.slice(0, -1).split("\n").map(line => JSON.parse(line));
}

export function combineFactors(row) {
  if (!exact(row, ["kind", "head", "factors"]) || row.kind !== "voice-ui.parts.factors.v1"
      || !/^sha256:[a-f0-9]{64}$/.test(row.head ?? "") || !exact(row.factors, ["intent", "labels", "capacity"]))
    throw Error("factor_contract");
  const choices = { intent: ["change", "ambiguous", "no-change", "unsupported"], labels: ["available", "missing"], capacity: ["within", "exceeded"] };
  for (const [key, allowed] of Object.entries(choices)) {
    const answer = row.factors[key];
    if (!exact(answer, ["choice", "confidence"]) || !allowed.includes(answer.choice)
        || typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
      throw Error("factor_answer");
  }
  const { intent, labels, capacity } = row.factors;
  if (intent.choice !== "change") return { choice: intent.choice, confidence: intent.confidence };
  const witnesses = [labels.choice === "missing" ? labels.confidence : null,
    capacity.choice === "exceeded" ? capacity.confidence : null].filter(x => x !== null);
  return { choice: witnesses.length ? "missing" : "sufficient", confidence: Math.min(intent.confidence,
    witnesses.length ? Math.max(...witnesses) : Math.min(labels.confidence, capacity.confidence)) };
}

// The caller supplies exact bytes from a stopped phase, including the journal
// prefix frozen at that stop. No environment, identity file or provider is read.
export function auditProviderPhase({ configBytes, processBytes, stderrBytes, stdoutBytes, journalBytes }, expectedSends) {
  const issues = [], config = decode(configBytes), process = decode(processBytes), events = jsonLines(journalBytes);
  const charged = counts(), pending = new Map(), reservedIds = new Set();
  let ownReserve, ownReconcile, before;
  for (const event of events) {
    if (event.kind === "reserve") {
      if (!providers.includes(event.provider) || event.charge !== 1) throw Error("one_off_charge");
      charged[event.provider]++;
    } else if (event.kind === "phase-reserve") {
      if (!countShape(event.allowances) || providers.some(p => event.allowances[p] > 300)
          || reservedIds.has(event.id) || pending.size || !same(event.prior_charged, charged)
          || providers.some(p => charged[p] + event.allowances[p] > 1000)) throw Error("phase_reservation");
      reservedIds.add(event.id); pending.set(event.id, event.allowances);
      if (event.id === config.phase_id) { ownReserve = event; before = { ...charged }; }
    } else if (event.kind === "phase-reconcile") {
      const limit = pending.get(event.id);
      if (!limit || !countShape(event.sent) || providers.some(p => event.sent[p] > limit[p])) throw Error("phase_reconciliation");
      for (const p of providers) charged[p] += event.sent[p];
      pending.delete(event.id);
      if (event.id === config.phase_id) { if (ownReconcile) throw Error("duplicate_reconciliation"); ownReconcile = event; }
    } else if (event.kind !== "outcome") throw Error("journal_event");
    if (providers.some(p => charged[p] > 1000)) throw Error("whole_run_limit");
  }
  const sent = counts();
  for (const line of Buffer.from(stderrBytes).toString("utf8").split("\n")) {
    const match = /^provider-send:(jev|typellm):([1-9][0-9]*)$/.exec(line);
    if (match) { if (+match[2] !== ++sent[match[1]]) throw Error("provider_send_sequence"); }
    else if (line.startsWith("provider-send:")) throw Error("provider_send_format");
  }
  if (!ownReserve || !ownReconcile || pending.size) issues.push("phase not finally reconciled");
  if (!same(config.allowances, process.allowances) || !same(config.heads, process.heads)
      || config.program !== process.program || config.phase_id !== process.phase_id || process.pgid !== process.pid
      || ownReserve?.config_sha256 !== sha256(configBytes) || process.config_sha256 !== sha256(configBytes)
      || !same(ownReserve?.heads, config.heads) || !same(ownReserve?.allowances, config.allowances)
      || ownReserve?.program !== config.program) issues.push("reservation/config/process binding");
  if (!same(ownReconcile?.sent, sent) || !same(sent, expectedSends) || ownReconcile?.pid !== process.pid
      || ownReconcile?.start_ticks !== process.start_ticks || ownReconcile?.stopped_group_empty !== true
      || ownReconcile?.stderr_sha256 !== sha256(stderrBytes) || ownReconcile?.stdout_sha256 !== sha256(stdoutBytes)
      || providers.some(p => sent[p] > config.allowances[p])) issues.push("send/stop/log binding");
  return { status: issues.length ? "FAIL" : "PASS", issues, phase: config.phase_id, sent, prior_charged: before,
    charged_at_cutoff: charged, journal_sha256: sha256(journalBytes), config_sha256: sha256(configBytes),
    stop_scope: "recorded reconciliation only; independent live PID observation remains an explicit audit reference" };
}

function endFields(call) {
  return { status: call.status ?? null, ...(Object.hasOwn(call, "response") ? { response: call.response } : {}),
    ...(Object.hasOwn(call, "error") ? { error: call.error } : {}), elapsedMs: call.elapsedMs };
}

function auditEvents(events, rows, initials) {
  const issues = []; let at = 0, lastTime = -Infinity;
  for (const event of events) {
    const time = Date.parse(event.at);
    if (!Number.isFinite(time) || time < lastTime) issues.push("event time order");
    lastTime = time;
  }
  const take = (kind, row) => {
    const event = events[at++];
    if (!event || event.kind !== kind || event.id !== row.id || event.arm !== row.arm) { issues.push("event structure " + pair(row)); return null; }
    return event;
  };
  for (const row of rows) {
    const start = take("arm-start", row), initial = initials.get(row.id);
    if (start?.head !== initial?.head || start?.initial_log_sha256 !== sha256(initial?.log ?? "")) issues.push("arm-start initial binding");
    let preparations = 0;
    for (const call of row.calls) {
      if (events[at]?.kind === "literal-preparation") {
        const event = take("literal-preparation", row);
        if (!same(event?.value, row.preparation?.[preparations++]) || row.arm !== "B" || call.n < 2) issues.push("literal preparation join");
      }
      const begin = take("http-start", row), end = take("http-end", row);
      if (begin?.n !== call.n || begin?.route !== call.route || !same(begin?.request, call.request)
          || end?.n !== call.n || !same(endFields(end ?? {}), endFields(call))) issues.push("HTTP event/call join " + pair(row));
    }
    if (events[at]?.kind === "literal-preparation") {
      const event = take("literal-preparation", row);
      if (!same(event?.value, row.preparation?.[preparations++]) || row.arm !== "B") issues.push("literal preparation join");
    }
    if (preparations !== (row.preparation?.length ?? 0)) issues.push("literal preparation count");
    const end = take("arm-end", row);
    if (end?.valid_execution !== row.valid_execution || end?.reason !== row.result?.reason
        || end?.httpCalls !== row.calls.length || end?.elapsedMs !== row.elapsedMs) issues.push("arm-end join");
  }
  if (events[at]?.kind === "runner-failed") at++;
  if (at !== events.length) issues.push("unjoined events");
  return issues;
}

function fullPlan(projection, subset = false) {
  const order = projection.comparison?.case_order;
  if (!Array.isArray(order) || new Set(order).size !== projection.cases?.length || order.length !== projection.cases.length)
    throw Error("case_order");
  const raw = projection.comparison.arm_order;
  const flat = Array.isArray(raw) && raw.every(x => typeof x === "string" && ["A", "B", "C"].includes(x));
  if (!flat && (Array.isArray(raw) ? raw.length !== order.length
    : raw === null || typeof raw !== "object" || !same(Object.keys(raw).sort(), [...order].sort()))) throw Error("arm_order_shape");
  return order.flatMap((id, i) => {
    if (projection.cases.filter(c => c.id === id).length !== 1) throw Error("case_order");
    const selected = flat ? raw
      : Array.isArray(raw) ? raw[i] : raw?.[id];
    const arms = typeof selected === "string" ? [...selected] : selected;
    if (!Array.isArray(arms) || !(subset ? arms.length >= 1 && arms.length <= 3 : arms.length === 3)
        || new Set(arms).size !== arms.length || !arms.every(x => ["A", "B", "C"].includes(x)))
      throw Error("arm_order");
    return arms.map(arm => ({ id, arm }));
  });
}

// Optional selectedProjectionBytes is an explicitly bound correction plan over
// the parent public projection. It cannot make an incomplete panel complete.
export async function auditRawPanel({ projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes,
  selectedProjectionBytes = null, phaseKind = "public" }) {
  const issues = [], projection = decode(projectionBytes), oracle = decode(oracleBytes), bundle = decode(bundleBytes);
  if (projection.schema !== "voice-ui.poc.input-projection/2" || projection.oracle_sha256 !== sha256(oracleBytes)
      || !same(projection.fixture_contract, oracle.fixture_contract) || !same(projection.comparison, oracle.comparison)) throw Error("projection_oracle_binding");
  let selected = null;
  if (selectedProjectionBytes) {
    selected = decode(selectedProjectionBytes);
    if (selected.schema !== "voice-ui.poc.selected-cells/1" || !["correction", "public-remainder"].includes(selected.phase_kind)
        || selected.phase_kind !== phaseKind || selected.parent_inputs_sha256 !== sha256(projectionBytes)
        || JSON.stringify(selected.fixture_contract) !== JSON.stringify(projection.fixture_contract)
        || !Array.isArray(selected.cases) || selected.cases.length < 1 || selected.cases.length > 10
        || selected.cases.some(item => JSON.stringify(item) !== JSON.stringify(projection.cases.find(c => c.id === item.id))))
      throw Error("selected_parent_projection");
  }
  const planned = fullPlan(selected ?? projection, selected !== null), identity = decode(rawFiles["identity.json"]), execution = decode(rawFiles["execution.json"]);
  if (!["public", "correction", "public-remainder", "fresh"].includes(phaseKind) || !Array.isArray(planned) || !planned.length
      || new Set(planned.map(pair)).size !== planned.length
      || planned.some(row => !projection.cases.some(c => c.id === row.id) || !["A", "B", "C"].includes(row.arm))) throw Error("selected_plan");
  if (identity.inputs_sha256 !== sha256(selectedProjectionBytes ?? projectionBytes) || identity.bundle_sha256 !== sha256(bundleBytes)) issues.push("input/library digest binding");
  if (selected ? identity.schema !== "voice-ui.poc.selected-cell-execution/1" || identity.phase_kind !== phaseKind
      || identity.parent_inputs_sha256 !== sha256(projectionBytes) || !same(identity.selected_cells, planned) || identity.planned_arms !== planned.length
    : identity.schema !== "voice-ui.poc.candidate-panel/1") issues.push("receipt kind/plan binding");
  const summary = execution.summary;
  if (!Array.isArray(summary) || summary.length > planned.length || summary.some((row, i) => pair(row) !== pair(planned[i]))) throw Error("consumed_arm_order");
  const names = ["identity.json", "execution.json", "events.jsonl", ...summary.map(row => row.id + "-" + row.arm + ".json")].sort();
  if (!same(Object.keys(rawFiles).sort(), names)) issues.push("raw file inventory");
  const rows = summary.map(row => decode(rawFiles[row.id + "-" + row.arm + ".json"]));
  const initials = new Map(), proofs = [], graded = [], http = counts(), checkCalls = [];
  for (const row of rows) {
    const item = projection.cases.find(c => c.id === row.id), expected = oracle.cases.find(c => c.id === row.id);
    if (!item || !expected || !same({ id: row.id, fixture: row.fixture, utterance: row.utterance }, item)
        || !same(summary[proofs.length], { id: row.id, arm: row.arm, valid_execution: row.valid_execution,
          reason: row.result?.reason, httpCalls: row.calls.length, elapsedMs: row.elapsedMs })) issues.push("raw input/summary binding");
    if (!initials.has(row.id)) {
      const f = projection.fixture_contract, fixture = f.fixtures[item.fixture];
      const created = await protocol.createDecisionLog([...f.base_records, ...fixture.extra_records], f.map_id);
      const pin = await protocol.createDecision(created.head, [{ type: "PinRegions", items: [...f.base_pins, ...fixture.extra_pins] }], created.records);
      initials.set(row.id, (await protocol.appendDecision(created.log, pin.decision)).verified);
    }
    const initial = initials.get(row.id);
    let proof, proofIssue = null;
    try {
      proof = await protocol.verifyDecisionLog(row.final_log);
      if (!row.final_log.startsWith(initial.log) || row.initial_head !== initial.head || row.initial_log_sha256 !== sha256(initial.log)
          || !same(row.initial_records, initial.records) || proof.head !== row.final_head || !same(proof.records, row.final_records))
        throw Error("initial/final proof binding");
      const prefixes = new Map(); const lines = row.final_log.trimEnd().split("\n");
      for (let n = initial.decisions.length; n <= lines.length; n++) {
        const verified = await protocol.verifyDecisionLog(lines.slice(0, n).join("\n") + "\n");
        prefixes.set(verified.head, { verified, n });
      }
      const judges = row.calls.filter(c => c.route === "/api/judge");
      if (judges.length !== (row.result.trace?.length ?? 0)) throw Error("trace count");
      let previous = initial.decisions.length;
      for (const [n, call] of judges.entries()) {
        const trace = row.result.trace[n], prefix = prefixes.get(trace.head), state = call.request?.state;
        if (!prefix || prefix.n < previous || !same(trace.answers, call.response?.answers)
            || state?.utterance !== item.utterance || !same(state.graph, prefix.verified.records.filter(r => r.type === "region").map(({id,label,parent}) => ({id,label,parent})))
            || !same(state.edges, prefix.verified.records.filter(r => r.type === "relation").map(({id,from,to}) => ({id,from,to})))) throw Error("trace/request proof join");
        previous = prefix.n;
      }
    } catch { proofIssue = "protocol/log/trace binding " + pair(row); issues.push(proofIssue); }
    proofs.push({ id: row.id, arm: row.arm, status: proofIssue ? "FAIL" : "PASS", final_head: row.final_head,
      initial_log_sha256: sha256(initial.log), final_log_sha256: sha256(row.final_log) });
    for (const [n, call] of row.calls.entries()) {
      if (call.id !== row.id || call.arm !== row.arm || call.n !== n + 1) issues.push("HTTP call identity/order");
      if (call.route === "/api/parts/check") {
        http.jev++; checkCalls.push(call);
        const expectedRequest = { kind: "voice-ui.goal.inventory.v1", state: { utterance: item.utterance, head: initial.head,
          regions: initial.records.filter(r => r.type === "region").map(({id,label,kind,parent}) => ({id,label,kind,parent})),
          edges: initial.records.filter(r => r.type === "relation").map(({id,from,to}) => ({id,from,to})), parts: bundle.parts } };
        if (n !== 0 || !same(call.request, expectedRequest)) issues.push("inventory input binding");
      } else if (call.route === "/api/judge") http.jev++;
      else if (call.route === "/api/parts/complete") {
        http.typellm++;
        if (row.arm !== "C" || !same(call.request, row.calls[0]?.request)) issues.push("typed request binding");
      } else issues.push("unknown HTTP route");
    }
    graded.push(gradeArm(row, expected));
  }
  issues.push(...auditEvents(jsonLines(rawFiles["events.jsonl"]), rows, initials));
  const factors = Buffer.from(stdoutBytes).toString("utf8").split("\n").filter(line => line.startsWith("{"))
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(row => row?.kind === "voice-ui.parts.factors.v1");
  if (factors.length !== checkCalls.length) issues.push("factor count");
  factors.forEach((factor, n) => {
    try { if (factor.head !== checkCalls[n]?.request?.state?.head || !same(combineFactors(factor), checkCalls[n]?.response)) issues.push("factor/check recomputation"); }
    catch { issues.push("factor contract"); }
  });
  const full = !selected && rows.length === planned.length;
  const allValid = rows.every(r => r.valid_execution === true);
  if (!["RECORDED", "INVALID"].includes(execution.status) || (execution.status === "RECORDED") !== (rows.length === planned.length && allValid))
    issues.push("terminal execution status");
  const missingResponses = rows.flatMap(r => r.calls.filter(c => !Object.hasOwn(c, "response")).map(c => ({ id:r.id, arm:r.arm, n:c.n, status:c.status ?? null })));
  return { schema: "voice-ui.poc.raw-receipt-audit/1", status: issues.length ? "FAIL" : "PASS", issues,
    phase_kind: phaseKind, consumed: rows.length, planned: planned.length, complete_same_source_panel: full,
    model_comparison_admissible: issues.length === 0 && full && allValid && graded.every(r => r.score_input_valid),
    recorded_execution_status: execution.status, missing_responses: missingResponses, http_attempts: http, factor_count: factors.length,
    proofs, rows: graded, panels: Object.fromEntries(["A", "B", "C"].map(selected => [selected, summarizePanel(graded, oracle.cases, selected)])),
    raw_sha256: Object.fromEntries(Object.entries(rawFiles).map(([name, bytes]) => [name, sha256(bytes)])),
    CI_LIVE_EXECUTION: "UNPROVEN", four_way_comparison: "INCOMPLETE_D_BLOCKED_COST", currency: "COST_NOT_MEASURED" };
}

// producer is a separately committed, independently reviewed expectation. It
// must not be regenerated from the receipt at verification time. Audit-reference
// hashes bind testimony; CI cannot turn those into CI-origin live observations.
export function auditProducerBinding({ identityBytes, runtimeAuditBytes, configBytes, processBytes,
  artifactManifestBytes, workerBytes, providerBytes, protocolEntryBytes, bundleBytes, sourceFiles, auditReferences,
  rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes }, producer) {
  if (producer.schema !== "voice-ui.poc.producer-expectation/1") throw Error("producer_schema");
  const identity = decode(identityBytes), runtime = decode(runtimeAuditBytes), config = decode(configBytes), process = decode(processBytes);
  const manifest = decode(artifactManifestBytes), issues = [], source = identity.source;
  for (const [key, bytes] of Object.entries({ raw_identity_sha256: identityBytes, runtime_audit_sha256: runtimeAuditBytes,
    config_sha256: configBytes, process_sha256: processBytes, artifact_manifest_sha256: artifactManifestBytes,
    worker_sha256: workerBytes, provider_sha256: providerBytes, protocol_sha256: protocolEntryBytes,
    stdout_sha256: stdoutBytes, stderr_sha256: stderrBytes, journal_sha256: journalBytes, replay_sha256: replayBytes }))
    if (producer[key] !== sha256(bytes)) issues.push("producer digest " + key);
  if (!same(Object.keys(producer.raw_sha256 ?? {}).sort(), Object.keys(rawFiles ?? {}).sort())) issues.push("fixed raw snapshot inventory");
  else for (const [name, digest] of Object.entries(producer.raw_sha256 ?? {})) if (sha256(rawFiles[name]) !== digest) issues.push("fixed raw snapshot digest " + name);
  if (!rawFiles || !Object.hasOwn(rawFiles, "identity.json") || !Buffer.from(rawFiles["identity.json"]).equals(Buffer.from(identityBytes))) issues.push("raw identity byte binding");
  if (!same(producer.heads, source.heads) || !same(producer.source_sha256, identity.source_sha256)
      || producer.inputs_sha256 !== identity.inputs_sha256 || producer.bundle_sha256 !== identity.bundle_sha256
      || producer.phase_id !== source.launcher.phase_id || config.phase_id !== source.launcher.phase_id
      || config.heads.apps !== runtime.apps_sha || runtime.apps_sha !== source.heads.apps
      || manifest.sources.apps !== runtime.apps_sha || manifest.sources.ui !== source.heads.ui
      || source.audit_sha256 !== sha256(runtimeAuditBytes)
      || runtime.worker.sha256 !== sha256(workerBytes) || source.worker_entry.sha256 !== sha256(workerBytes)
      || runtime.worker.path !== source.worker_entry.path || runtime.manifest.sha256 !== sha256(artifactManifestBytes)
      || runtime.manifest.sha256 !== source.artifact.manifest_sha256 || runtime.artifact_root !== source.artifact.root
      || runtime.provider.sha256 !== sha256(providerBytes) || source.provider_entry.sha256 !== sha256(providerBytes)
      || runtime.provider.path !== source.provider_entry.path || manifest.sources["jev-provider"].entry_sha256 !== sha256(providerBytes)
      || runtime.semantic_map.protocol.sha256 !== sha256(protocolEntryBytes) || source.semantic_map.protocol_sha256 !== sha256(protocolEntryBytes)
      || runtime.semantic_map.root !== source.semantic_map.root || runtime.dev_program.path !== source.launcher.dev_program
      || process.pid !== source.launcher.pid || process.start_ticks !== source.launcher.start_ticks
      || !same(process.allowances, source.launcher.allowances) || !same(process.heads, config.heads)
      || process.program !== source.launcher.program || identity.origin !== source.origin) issues.push("runtime/artifact/source joins");
  if (sha256(bundleBytes) !== producer.bundle_sha256 || !same(Object.keys(sourceFiles ?? {}).sort(), Object.keys(producer.source_sha256).sort()))
    issues.push("built library/source file inventory");
  else for (const [name, digest] of Object.entries(producer.source_sha256)) if (sha256(sourceFiles[name]) !== digest) issues.push("built source digest " + name);
  const refs = producer.independent_audit_sha256;
  if (!refs || !Object.keys(refs).length || !same(Object.keys(refs).sort(), Object.keys(auditReferences ?? {}).sort())) issues.push("independent audit references");
  else for (const [name, digest] of Object.entries(refs)) if (sha256(auditReferences[name]) !== digest) issues.push("independent audit digest " + name);
  return { status: issues.length ? "FAIL" : "PASS", issues, producer_schema: producer.schema,
    provenance_scope: "exact byte/metadata joins to separately reviewed expectations and audit references",
    CI_LIVE_EXECUTION: "UNPROVEN" };
}

// The actual replay process must consume all recorded arm files, including
// wrong or INVALID outputs. Repainting them cannot promote model quality.
export function auditReplayJoin({ replayBytes, rawFiles, artifactManifestBytes, assessGoal, assessEdge }) {
  const receipt = decode(replayBytes), manifest = decode(artifactManifestBytes), issues = [], failures = [];
  const rawNames = Object.keys(rawFiles).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]*-[ABC][.]json$/.test(name)).sort();
  const expectedPairs = rawNames.map(name => pair(decode(rawFiles[name]))).sort();
  if (receipt.schema !== "voice-ui.closed-live-log-browser/1" || receipt.scope !== "KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY"
      || receipt.ci_live_execution !== "UNPROVEN" || !same(receipt.viewport, [1280, 720]) || receipt.deviceScaleFactor !== 1
      || receipt.artifact_manifest_sha256 !== sha256(artifactManifestBytes) || !same(receipt.artifact_sources, manifest.sources)
      || !Array.isArray(receipt.rows) || !same(receipt.rows.map(pair).sort(), expectedPairs)
      || new Set(receipt.rows.map(pair)).size !== expectedPairs.length || !rawNames.length) throw Error("replay_identity_coverage");
  let frames = 0, assessed = 0;
  for (const row of receipt.rows) {
    const name = row.id + "-" + row.arm + ".json", raw = decode(rawFiles[name]);
    if (row.raw_sha256 !== sha256(rawFiles[name]) || row.log_sha256 !== sha256(raw.final_log)) issues.push("replay/raw byte join");
    const regions = raw.final_records.filter(r => r.type === "region"), edges = raw.final_records.filter(r => r.type === "relation");
    const groups = regions.filter(r => r.kind === "group" && r.parent !== null);
    const cameras = ["overview", ...groups.map(r => r.id), ...edges.map(r => r.id)];
    if (!Array.isArray(row.frames) || !same(row.frames.map(f => f.camera), cameras)) { issues.push("replay required cameras"); continue; }
    frames += row.frames.length;
    for (const frame of row.frames.slice(1)) {
      const group = groups.find(r => r.id === frame.camera), edge = edges.find(r => r.id === frame.camera), observation = frame.observation;
      const expectedShapes = group ? regions.filter(r => r.parent === group.id)
        : [edge?.from, edge?.to].map(id => regions.find(r => r.id === id));
      if (observation?.identity !== true || observation?.association !== "render-owned-semantic-id"
          || group && observation.container?.id !== group.id
          || edge && (observation.edge?.from !== edge.from || observation.edge?.to !== edge.to)
          || !same(observation?.shapes?.map(s => ({ id: s.id, label: s.rawLabel })), expectedShapes.map(s => ({ id:s?.id, label:s?.label }))))
        issues.push("replay semantic ID/label join");
      const result = group ? assessGoal(observation) : assessEdge(observation); assessed++;
      if (!same(result, frame.assessment)) issues.push("replay assessment recomputation");
      if (result.status !== "PASS") failures.push({ id: row.id, arm: row.arm, camera: frame.camera, assessment: result });
    }
  }
  const product = failures.some(row => row.assessment.status === "UNPROVEN") ? "UNPROVEN" : failures.length ? "UNMET" : "PASS";
  if (!same(receipt.failures, failures) || receipt.status !== product) issues.push("replay product status join");
  return { status: issues.length ? "FAIL" : "PASS", issues, consumed: receipt.rows.length, frames, assessed_frames: assessed,
    recorded_paint_status: product, replay_sha256: sha256(replayBytes), model_quality_scope: "NONE", CI_LIVE_EXECUTION: "UNPROVEN" };
}
