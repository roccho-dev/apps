import { sha256, jsonLines } from "./receipt-admissibility.mjs";
import { canonical } from "./semantic-score.mjs";
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const providers = ["jev", "typellm"], counts = { V: 6, F: 6, E: 2 };
const baseline = { jev: 689, typellm: 40 };
const max = (axis, correction) => axis === "V" ? { jev: 6, typellm: 0 }
  : axis === "F" ? { jev: 0, typellm: 6 } : { jev: correction ? 19 : 38, typellm: correction ? 1 : 2 };

export function auditRequirementsProcess({ records, journalBytes, commitmentBytes, addendumBytes, publicFiles }) {
  const issues = [], commitment = JSON.parse(commitmentBytes), addendum = JSON.parse(addendumBytes);
  if (sha256(commitmentBytes) !== "f002a267be0096beb988f5cb83e175d7724ce0213a9495755301c19fb2e3eaef"
      || sha256(addendumBytes) !== "a01560642c4fd3c3aa8a70a9389ed53bf04635a31cfa432f098c095876406ed6"
      || !same(commitment.charged_prior, baseline) || !same(commitment.cap, { jev: 300, typellm: 40 })
      || !same(commitment.allocated, { jev: 298, typellm: 40 })) issues.push("fixed preregistration");
  for (const version of ["original", "corrected"]) for (const role of ["input", "oracle"]) {
    const row = addendum[version], bytes = publicFiles[row[role]];
    if (!bytes || sha256(bytes) !== row[role + "_sha256"]) issues.push("retained pre-live oracle correction " + version + "/" + role);
  }
  if (!Array.isArray(records) || !records.length) throw Error("empty process evidence");
  const events = jsonLines(journalBytes), oldEnd = events.findIndex(e => e.kind === "phase-reconcile" && e.id === "axes-final-E-20261017");
  if (oldEnd < 0) issues.push("frozen previous-cycle cutoff");
  const tail = events.slice(oldEnd + 1), reserves = tail.filter(e => e.kind === "phase-reserve");
  const phaseIds = records.map(r => r.config.phase_id);
  if (!same(reserves.map(e => e.id), phaseIds) || new Set(phaseIds).size !== phaseIds.length
      || tail.some(e => !["phase-reserve", "phase-reconcile"].includes(e.kind))) issues.push("complete ordered cycle inventory");
  if (!same(reserves[0]?.prior_charged, baseline)) issues.push("unchanged cumulative baseline");
  const budgets = new Map(), correctionIds = new Set(), seenPublic = [], releases = [];
  for (const r of records) {
    const { index, config, input, report } = r, kind = index.phase_kind, axis = index.axis;
    if (!["public", "correction", "final"].includes(kind) || !["V", "F", "E"].includes(axis)
        || config.stage !== kind || config.axis !== axis || input.axis !== axis
        || config.case_count !== input.cases.length || config.heads.apps !== index.apps_sha) {
      issues.push("process phase shape"); continue;
    }
    if ([report.binding, report.raw, report.phase].some(x => x?.status !== "PASS")) issues.push("phase admission integrity");
    const n = input.cases.length, batch = config.correction_batch ?? null;
    if (kind === "correction") {
      if (![1, 2].includes(batch) || index.correction_batch !== batch || n !== (axis === "E" ? 1 : 6)) issues.push("bounded correction shape");
      correctionIds.add(batch);
    } else if (batch !== null || index.correction_batch !== undefined) issues.push("unexpected correction allocation");
    if (kind === "public" && n !== counts[axis] || kind === "final" && n !== ({ V: 10, F: 8, E: 10 })[axis])
      issues.push("registered phase denominator");
    const allowance = kind === "final" ? axis === "V" ? { jev: 10, typellm: 0 }
      : axis === "F" ? { jev: 0, typellm: 8 } : { jev: 190, typellm: 10 } : max(axis, kind === "correction");
    const group = kind === "correction" ? "correction-" + batch : kind + "-" + axis;
    const groupMax = kind === "correction" ? { jev: 25, typellm: 7 } : allowance;
    const used = budgets.get(group) ?? { jev: 0, typellm: 0 };
    for (const provider of providers) {
      const value = config.allowances?.[provider];
      if (!Number.isSafeInteger(value) || value < 0 || value > allowance[provider]) issues.push("phase reservation " + provider);
      used[provider] += value;
      if (used[provider] > groupMax[provider]) issues.push("stage/batch allocation " + provider);
    }
    budgets.set(group, used);
    if (kind === "final") {
      const admitted = ["F", "V", "E"].every(a => seenPublic.some(p => p.index.axis === a && p.index.apps_sha === index.apps_sha
        && p.input.cases.length === counts[a] && (a === "F" ? p.report.raw?.semantic?.requirements_criteria === "PASS"
          : a === "V" ? p.report.raw?.semantic?.verification_criteria === "PASS"
            : p.report.raw?.semantic?.enabled_criteria === "PASS" && p.report.raw?.semantic?.effect_criteria === "PASS")));
      if (!admitted) issues.push("fresh release before same-head public F/V/E admission");
      releases.push({ phase: config.phase_id, apps_sha: index.apps_sha, admitted });
    } else seenPublic.push(r);
    const expected = kind === "public" ? commitment.files.find(f => f.visibility === "public" && f.axis === axis)
      : kind === "final" ? commitment.files.find(f => f.visibility === "sealed" && f.axis === axis) : null;
    if (expected) {
      const want = kind === "public" && axis === "E" ? addendum.corrected.input_sha256 : expected.input_sha256;
      if (report.raw.inputs_sha256 !== undefined && report.raw.inputs_sha256 !== want) issues.push("fixed input seal");
      if (config.input_sha256 !== want) issues.push("registered config input");
    }
  }
  if (correctionIds.size > 2) issues.push("correction count");
  const reserved = [...budgets.values()].reduce((sum, row) => Object.fromEntries(providers.map(p => [p, sum[p] + row[p]])), { jev: 0, typellm: 0 });
  if (reserved.jev > 298 || reserved.typellm > 40) issues.push("unallocated budget used");
  return { schema: "voice-ui.requirements-cycle-process/1", status: issues.length ? "FAIL" : "PASS", issues,
    baseline, indexed_phases: records.length, correction_batches: correctionIds.size, reserved, releases,
    scope: "same-head public admission and retained exact cycle process; no CI-origin live claim" };
}
