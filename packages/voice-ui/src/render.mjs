export async function renderUiIr({
  ir,
  validateUiIr,
  renderTrustedSurface,
  renderSemanticMap,
  document,
  mount,
} = {}) {
  validateUiIr(ir);

  if (ir.capability === "a2ui-browser" && ir.payloadKind === "a2ui.surface.v1") {
    renderTrustedSurface({
      components: ir.payload.components,
      dataModel: ir.payload.dataModel,
      document,
      mount,
    });
    return ir;
  }

  // This app never lets the embed edit its input, and it owns every control
  // around the graph itself, so the embed is asked for the diagram alone: the
  // provider's opt-in 'chrome-free' presentation, which draws none of its own
  // topbar, dock, status, toast, Active list or ID chip over the cells.
  if (ir.capability === "render.semantic-map" && ir.payloadKind === "semantic-map-envelope/3") {
    await renderSemanticMap({
      document,
      input: { envelope: ir.payload },
      surfaceMount: mount,
      presentation: "chrome-free",
    });
    return ir;
  }

  throw new Error("unsupported UI capability");
}
