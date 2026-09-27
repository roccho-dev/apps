import assert from "node:assert/strict";
import { chromium } from "playwright";

const STORAGE_KEY = "voice-ui.decision-log.v1";

const choice = value => ({ type: "choice", choice: value, confidence: 0.99 });

const craftDecision = (request, typed) => {
  const answers = {
    action: choice("none"),
    source: choice("none"),
    target: choice("none"),
    part: choice("none"),
  };

  if ((request.state.working.placeable?.length ?? 0) >= 2) {
    answers.move = choice("none");
    answers.anchor = choice("none");
    answers.direction = choice("none");
  }
  if ((request.state.working.edges?.length ?? 0) > 0) answers.edge = choice("none");
  if ((request.state.candidates?.length ?? 0) > 0) answers.diagram = choice("none");

  for (const [slot, value] of Object.entries(typed)) answers[slot] = choice(value);

  return {
    kind: "voice-ui.jev.decision.v4",
    model: "scenario-fixture",
    answers,
  };
};

const assertTyped = (decision, expected) => {
  for (const [slot, value] of Object.entries(expected)) {
    assert.equal(
      decision?.answers?.[slot]?.choice,
      value,
      `typed result mismatch for ${slot}: ${JSON.stringify(decision?.answers)}`,
    );
  }
};

const waitReady = page =>
  page.waitForFunction(() => window.voiceUiReady === true, null, { timeout: 120000 });

const settle = page =>
  page.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 120000 });

const world = (page, pane) => page.evaluate(async pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  if (!frame) throw new Error(`${pane} semantic-map iframe missing`);

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error(`${pane} semantic-map ready timeout`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const adapter = frame.contentWindow.semanticMapApp.adapter;
  return {
    regions: [...adapter.cellsByRegionId.entries()]
      .map(([id, cell]) => ({
        id,
        kind: cell.semantic?.kind ?? null,
        parentRegionId: cell.semantic?.parentRegionId ?? null,
        label: cell.semantic?.label ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...adapter.edgesByProjectionKey.values()]
      .map(edge => ({
        from: edge.semantic.from,
        to: edge.semantic.to,
        directed: edge.semantic.directed === true,
      }))
      .sort((left, right) =>
        `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`)),
  };
}, pane);

const screen = async page => ({
  state: await page.evaluate(() => document.body.dataset.state),
  status: await page.locator("#status").textContent(),
  stored: await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY),
  draftCount: await page.locator("#draft li").count(),
  confirmed: await world(page, "confirmed"),
  working: await world(page, "working"),
});

export const openScenarioBrowser = async ({ url, live }) => {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext();
  const page = await context.newPage();
  const jevUrl = new URL("/api/jev", url).href;

  const navigation = await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  assert.equal(navigation?.status(), 200);
  await waitReady(page);

  const say = async say => {
    const spec = typeof say === "string" ? { text: say } : say;
    if (!live && !spec.as) {
      throw new Error(`deterministic mode needs typed intent for: ${spec.text}`);
    }

    if (!live) {
      await page.route(jevUrl, route => {
        const request = JSON.parse(route.request().postData());
        return route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify(craftDecision(request, spec.as)),
        });
      }, { times: 1 });
    }

    const answer = page.waitForResponse(
      response => response.url() === jevUrl && response.status() === 200,
      { timeout: 120000 },
    );

    await page.locator("#text").fill(spec.text);
    await page.locator("#send").click();
    await settle(page);

    const response = await answer;
    const decision = await response.json();
    if (spec.as) assertTyped(decision, spec.as);
    return decision;
  };

  const control = async name => {
    if (name === "reload") {
      await page.reload({ waitUntil: "commit", timeout: 120000 });
      await waitReady(page);
      return;
    }

    const selector = {
      apply: "#apply",
      undo: "#undo",
      discard: "#discard",
    }[name];
    if (!selector) throw new Error(`unknown control: ${name}`);
    await page.locator(selector).click();
    await settle(page);
  };

  return {
    snapshot: () => screen(page),
    say,
    control,
    close: () => browser.close(),
  };
};
