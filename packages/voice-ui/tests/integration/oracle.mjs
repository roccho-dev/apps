const worldOf = (session, name) => {
  const graph = session?.[name];
  if (graph == null) throw new TypeError(`scenario oracle: unknown world ${name}`);
  return graph;
};

const graphKey = graph => graph.log;

const recordMatches = (record, expectation, records) => {
  if (expectation.record !== undefined && record.type !== expectation.record) return false;
  if (expectation.id !== undefined && record.id !== expectation.id) return false;
  if (expectation.kind !== undefined && record.kind !== expectation.kind) return false;
  if (expectation.label !== undefined && record.label !== expectation.label) return false;
  if (expectation.parent !== undefined && record.parent !== expectation.parent) return false;
  if (expectation.parentKind !== undefined) {
    const parent = records.find(candidate => candidate?.type === "region" && candidate.id === record.parent);
    if (parent?.kind !== expectation.parentKind) return false;
  }
  return true;
};

const result = (expectation, ok, detail) => Object.freeze({ expectation, ok, detail });

export function evaluateInvariant(expectation, { initial, current } = {}) {
  const invariant = expectation?.invariant;

  if (invariant === "status") {
    const ok = current.status === expectation.value;
    return result(expectation, ok, `status=${current.status}, expected=${expectation.value}`);
  }

  if (invariant === "changed" || invariant === "unchanged") {
    const before = worldOf(initial, expectation.world);
    const after = worldOf(current, expectation.world);
    const changed = graphKey(before) !== graphKey(after);
    const ok = invariant === "changed" ? changed : !changed;
    return result(expectation, ok, `${expectation.world} ${changed ? "changed" : "unchanged"}`);
  }

  if (invariant === "equivalent") {
    const left = worldOf(current, expectation.left);
    const right = worldOf(current, expectation.right);
    const ok = graphKey(left) === graphKey(right);
    return result(expectation, ok, `${expectation.left} ${ok ? "equals" : "differs from"} ${expectation.right}`);
  }

  if (invariant === "contains") {
    const graph = worldOf(current, expectation.world);
    const matches = graph.records.filter(record => recordMatches(record, expectation, graph.records));
    const minimum = expectation.min ?? 1;
    const maximum = expectation.max ?? Number.POSITIVE_INFINITY;
    const ok = matches.length >= minimum && matches.length <= maximum;
    return result(expectation, ok, `matches=${matches.length}, expected=${minimum}..${maximum}`);
  }

  if (invariant === "connected") {
    const graph = worldOf(current, expectation.world);
    const matches = graph.records.filter(record =>
      record?.type === "relation"
      && (expectation.from === undefined || record.from === expectation.from)
      && (expectation.to === undefined || record.to === expectation.to));
    const minimum = expectation.min ?? 1;
    const ok = matches.length >= minimum;
    return result(expectation, ok, `connections=${matches.length}, expected>=${minimum}`);
  }

  if (invariant === "preserves") {
    const before = worldOf(initial, expectation.world);
    const after = worldOf(current, expectation.world);
    const afterRecords = new Set(after.records.map(record => JSON.stringify(record)));
    const missing = before.records.filter(record => !afterRecords.has(JSON.stringify(record)));
    const ok = missing.length === 0;
    return result(expectation, ok, ok ? "all initial records preserved" : `missing=${missing.length}`);
  }

  return result(expectation, false, `unsupported invariant: ${invariant}`);
}

export function checkScenario(scenario, snapshots) {
  const results = scenario.expect.map(expectation => evaluateInvariant(expectation, snapshots));
  return Object.freeze({ ok: results.every(value => value.ok), results: Object.freeze(results) });
}
