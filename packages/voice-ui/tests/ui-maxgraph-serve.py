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
        "globalThis.appsSemanticMapProof?.ready === true",
        timeout=60_000,
    )
    page.wait_for_function(
        """() => {
          const frame = document.querySelector('iframe[data-package="semantic-map"]');
          return frame?.contentWindow?.semanticMapSite?.ready === true;
        }""",
        timeout=60_000,
    )

    proof = page.evaluate(
        """() => {
          const frame = document.querySelector('iframe[data-package="semantic-map"]');
          const win = frame.contentWindow;
          const adapter = win.semanticMapApp.adapter;
          const svg = frame.contentDocument.querySelector('#graph-container svg');
          const box = svg?.getBoundingClientRect();
          const resources = win.performance.getEntriesByType('resource').map(entry => entry.name);
          return {
            receipt: globalThis.appsSemanticMapProof.receipt,
            cells: adapter.cellsByRegionId.size,
            edges: adapter.edgesByProjectionKey.size,
            svg: Boolean(box && box.width > 0 && box.height > 0),
            rendererLoaded: resources.some(value => value.includes('/renderer-maxgraph/adapter.js')),
            maxGraphLoaded: resources.some(value => value.includes('/vendor/maxgraph/')),
          };
        }"""
    )

    assert proof["receipt"]["schema"] == "semantic-map-render-receipt/1"
    assert proof["receipt"]["source"]["contract"] == "semantic-map-envelope/3"
    assert proof["cells"] > 0
    assert proof["edges"] > 0
    assert proof["svg"] is True
    assert proof["rendererLoaded"] is True
    assert proof["maxGraphLoaded"] is True
    assert page_errors == [], page_errors
    assert console_errors == [], console_errors

    browser.close()

print(
    "ui-maxgraph-serve: PASS "
    f"cells={proof['cells']} edges={proof['edges']} "
    "renderer=maxGraph"
)
