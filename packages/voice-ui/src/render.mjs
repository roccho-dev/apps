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

  if (ir.capability === "render.semantic-map" && ir.payloadKind === "semantic-map-envelope/3") {
    await renderSemanticMap({
      document,
      input: { envelope: ir.payload },
      surfaceMount: mount,
    });
    return ir;
  }

  throw new Error("unsupported UI capability");
}
