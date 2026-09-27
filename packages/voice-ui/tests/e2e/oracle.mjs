const edgeKey = edge => `${edge.from}->${edge.to}:${edge.directed === true}`;

const worldKey = world => JSON.stringify({
  regions: [...world.regions]
    .map(region => ({
      id: region.id,
      kind: region.kind ?? null,
      parentRegionId: region.parentRegionId ?? null,
      label: region.label ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  edges: [...world.edges]
    .map(edge => ({
      from: edge.from,
      to: edge.to,
      directed: edge.directed === true,
    }))
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
});

const result = (invariant, ok, detail) => ({ invariant, ok, detail });

export const evaluateInvariant = (expectation, { initial, current }) => {
  const { invariant } = expectation;

  if (invariant === "working-changed") {
    const ok = worldKey(initial.working) !== worldKey(current.working);
    return result(invariant, ok, ok ? "working world changed" : "working world did not change");
  }

  if (invariant === "confirmed-unchanged") {
    const ok = worldKey(initial.confirmed) === worldKey(current.confirmed);
    return result(invariant, ok, ok ? "confirmed world stayed unchanged" : "confirmed world changed before Apply");
  }

  if (invariant === "cross-functional-flow") {
    const beforeRegions = new Set(initial.working.regions.map(region => region.id));
    const addedRegions = current.working.regions.filter(region => !beforeRegions.has(region.id));
    const roles = addedRegions.filter(region => region.kind === "group");
    const roleIds = new Set(roles.map(region => region.id));
    const steps = addedRegions.filter(region => roleIds.has(region.parentRegionId));

    const beforeEdges = new Set(initial.working.edges.map(edgeKey));
    const addedEdges = current.working.edges.filter(edge => !beforeEdges.has(edgeKey(edge)));

    const rolesMin = expectation.rolesMin ?? 0;
    const stepsMin = expectation.stepsMin ?? 0;
    const linksMin = expectation.linksMin ?? 0;
    const ok = roles.length >= rolesMin && steps.length >= stepsMin && addedEdges.length >= linksMin;
    return result(
      invariant,
      ok,
      `roles=${roles.length}/${rolesMin}, steps=${steps.length}/${stepsMin}, links=${addedEdges.length}/${linksMin}`,
    );
  }

  return result(invariant, false, "unsupported invariant");
};

export const checkScenario = (scenario, snapshots) => {
  const results = scenario.expect.map(expectation => evaluateInvariant(expectation, snapshots));
  return { ok: results.every(value => value.ok), results };
};
