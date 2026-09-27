import assert from "node:assert/strict";
import test from "node:test";

import { checkScenario } from "./e2e/oracle.mjs";

const initial = {
  confirmed: {
    regions: [
      { id: "node-a", kind: "step", parentRegionId: "root", label: "A" },
      { id: "node-b", kind: "step", parentRegionId: "root", label: "B" },
    ],
    edges: [],
  },
  working: {
    regions: [
      { id: "node-a", kind: "step", parentRegionId: "root", label: "A" },
      { id: "node-b", kind: "step", parentRegionId: "root", label: "B" },
    ],
    edges: [],
  },
};

const composed = {
  confirmed: initial.confirmed,
  working: {
    regions: [
      ...initial.working.regions,
      { id: "role-a", kind: "group", parentRegionId: "root", label: "申請者" },
      { id: "role-b", kind: "group", parentRegionId: "root", label: "承認者" },
      { id: "step-a", kind: "step", parentRegionId: "role-a", label: "申請" },
      { id: "step-b", kind: "decision", parentRegionId: "role-b", label: "承認" },
      { id: "step-c", kind: "step", parentRegionId: "role-a", label: "結果" },
    ],
    edges: [
      { from: "step-a", to: "step-b", directed: true },
      { from: "step-b", to: "step-c", directed: true },
    ],
  },
};

test("the oracle checks product meaning, not DOM or exact coordinates", () => {
  const scenario = {
    expect: [
      { invariant: "working-changed" },
      { invariant: "confirmed-unchanged" },
      { invariant: "cross-functional-flow", rolesMin: 2, stepsMin: 3, linksMin: 2 },
    ],
  };
  const result = checkScenario(scenario, { initial, current: composed });
  assert.equal(result.ok, true);
  assert.equal(result.results.every(value => value.ok), true);
});

test("an unknown future invariant stays Red until the oracle/product contract exists", () => {
  const scenario = { expect: [{ invariant: "future-capability" }] };
  const result = checkScenario(scenario, { initial, current: composed });
  assert.equal(result.ok, false);
  assert.match(result.results[0].detail, /unsupported/u);
});
