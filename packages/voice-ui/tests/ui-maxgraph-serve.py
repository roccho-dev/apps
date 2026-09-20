from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else ""
if not url:
    raise SystemExit("ui-maxgraph-serve: URL is required")

page_errors: list[str] = []
console_errors: list[str] = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )

    response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    assert response and response.status == 200
    page.wait_for_function(
        "globalThis.semanticMapSite?.ready === true",
        timeout=60_000,
    )

    proof = page.evaluate(
        """() => {
          const adapter = globalThis.semanticMapApp.adapter;
          const svg = document.querySelector('#graph-container svg');
          const box = svg?.getBoundingClientRect();
          const importMap = JSON.parse(document.querySelector('script[type="importmap"]').textContent);
          const moduleIds = Object.keys(importMap.imports || {});
          return {
            pattern: globalThis.semanticMapRuntime.view.pattern,
            cells: adapter.cellsByRegionId.size,
            edges: adapter.edgesByProjectionKey.size,
            svg: Boolean(box && box.width > 0 && box.height > 0),
            rendererModule: moduleIds.includes('ui:packages/semantic-map/renderer-maxgraph/adapter.js'),
            maxGraphModule: moduleIds.some(value => value.startsWith('ui:packages/semantic-map/vendor/maxgraph/')),
          };
        }"""
    )

    assert proof["pattern"] == "graph/1"
    assert proof["cells"] > 0
    assert proof["edges"] > 0
    assert proof["svg"] is True
    assert proof["rendererModule"] is True
    assert proof["maxGraphModule"] is True
    assert page_errors == [], page_errors
    assert console_errors == [], console_errors

    browser.close()

print(
    "ui-maxgraph-serve: PASS "
    f"cells={proof['cells']} edges={proof['edges']} "
    "renderer=maxGraph"
)
