import assert from 'node:assert/strict';
import { observePaintedGoal } from './painted-goal.mjs';

// Deliberately synthetic test data. This is not an AWS, Azure or SQL vendor asset.
export const symbolFixtureSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="rgb(36,80,160)"/><circle cx="32" cy="32" r="16" fill="white"/></svg>';

// Actual browser/SVG observation at the existing named-group camera. The
// external models remain synthetic; a decoded resource alone is not a pass.
export async function checkPaintedSymbols({ page, records, expected, origin, stage }) {
  const nodes = [];
  for (const item of expected) {
    const selected = records.filter(row => row.type === 'region' && row.label === item.label && row.kind === item.kind);
    assert.equal(selected.length, item.quantity, 'all expected symbol-bearing instances exist');
    for (const region of selected) {
      const description = JSON.parse(region.summary);
      assert.equal(description.schema, 'voice-ui.part-description/1');
      assert.deepEqual(description.symbol, item.symbol);
      assert.equal(typeof description.key, 'string');
      nodes.push({ id: region.id, symbol: item.symbol, key: description.key });
    }
  }
  const observe = () => page.evaluate(async ({ nodes, origin }) => {
    const doc = document.querySelector('#working-surface iframe').contentDocument;
    const all = [...doc.querySelectorAll('image')];
    const visible = element => {
      for (let at = element; at?.nodeType === 1; at = at.parentElement) {
        const style = doc.defaultView.getComputedStyle(at);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0
          || style.clipPath !== 'none' || style.maskImage !== 'none' || /opacity\(0\)/u.test(style.filter)) return false;
      }
      return true;
    };
    const observations = [];
    for (const node of nodes) {
      const matches = all.filter(image => image.closest('[data-semantic-region-id]')?.dataset.semanticRegionId === node.id);
      const image = matches[0], href = image?.getAttribute('href') ?? image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const rect = image?.getBoundingClientRect();
      const width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
      const actualUrl = href ? new URL(href, origin).href : null;
      let decoded = null;
      if (actualUrl === new URL(node.symbol.href, origin).href) {
        const decodedImage = new doc.defaultView.Image();
        decodedImage.src = actualUrl;
        try {
          await decodedImage.decode();
          const canvas = doc.createElement('canvas'); canvas.width = 16; canvas.height = 16;
          const context = canvas.getContext('2d'); context.drawImage(decodedImage, 0, 0, 16, 16);
          decoded = { width: decodedImage.naturalWidth, height: decodedImage.naturalHeight,
            corner: [...context.getImageData(0, 0, 1, 1).data], center: [...context.getImageData(8, 8, 1, 1).data] };
        } catch { decoded = null; }
      }
      observations.push({ id: node.id, count: matches.length, href: actualUrl,
        visible: !!image && visible(image), bounds: rect ? [rect.x, rect.y, rect.width, rect.height] : null,
        inside: !!rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height,
        decoded });
    }
    return { totalImages: all.length, observations };
  }, { nodes, origin });
  const verify = observed => {
    assert.equal(observed.totalImages, nodes.length, 'no missing, duplicate or leftover SVG images');
    assert.equal(observed.observations.length, nodes.length);
    for (const row of observed.observations) {
      const node = nodes.find(item => item.id === row.id);
      assert.equal(row.count, 1);
      assert.equal(row.href, new URL(node.symbol.href, origin).href);
      assert.equal(row.visible, true, 'image and every ancestor must be visible');
      assert.equal(row.inside, true, 'the actual image must fit the fixed viewport');
      assert.deepEqual(row.decoded, { width: 64, height: 64, corner: [36, 80, 160, 255], center: [255, 255, 255, 255] });
    }
  };
  const observed = await observe();
  try { verify(observed); } catch (failure) {
    // Preserve the exact failing pipeline, without repairing or replacing the UI.
    // Only this bounded synthetic fixture is observed; the original failure stays RED.
    let pipeline;
    try {
      pipeline = await page.evaluate(ids => {
        const frame = document.querySelector('#working-surface iframe');
        const runtime = frame.contentWindow.semanticMapRuntime;
        const editor = frame.contentWindow.semanticMapSite?.editor;
        const adapter = editor?.adapter, graph = adapter?.graph;
        const cells = ids.map(id => {
          const cell = adapter?.cellsByRegionId?.get(id);
          const state = cell ? graph.getView().getState(cell) : null;
          return { id, requestedShape: state?.style?.shape ?? null,
            actualShape: state?.shape?.constructor?.name ?? null,
            requestedImage: state?.style?.image ?? null, actualImageSource: state?.shape?.imageSrc ?? null };
        });
        return { head: runtime?.head ?? null,
          composition: runtime?.view?.resourceComposition ?? null,
          registeredImageShape: graph?.getCellRenderer().getShape('image')?.name ?? null,
          sceneImages: (editor?.currentScene()?.representations ?? []).filter(row => ids.includes(row.regionId))
            .map(row => ({ id: row.regionId, resource: row.resource })),
          svgImages: frame.contentDocument.querySelectorAll('image').length,
          htmlImages: frame.contentDocument.querySelectorAll('img').length, cells };
      }, nodes.map(node => node.id));
    } catch (error) { pipeline = { diagnostic_error: String(error) }; }
    console.info(JSON.stringify({ kind: 'voice-ui.symbol-pipeline-failure/1', stage,
      expected_images: nodes.length, observed, pipeline }));
    throw failure;
  }
  let hiddenImageDetected = null;
  if (stage === 'after' && nodes.length) {
    const saved = await page.evaluate(id => {
      const doc = document.querySelector('#working-surface iframe').contentDocument;
      const image = [...doc.querySelectorAll('image')].find(item => item.closest('[data-semantic-region-id]')?.dataset.semanticRegionId === id);
      const style = image.getAttribute('style'); image.style.opacity = '0'; return style;
    }, nodes[0].id);
    try {
      const negative = await observe();
      assert.throws(() => verify(negative), /visible/);
      hiddenImageDetected = true;
    } finally {
      await page.evaluate(({ id, saved }) => {
        const doc = document.querySelector('#working-surface iframe').contentDocument;
        const image = [...doc.querySelectorAll('image')].find(item => item.closest('[data-semantic-region-id]')?.dataset.semanticRegionId === id);
        if (saved === null) image.removeAttribute('style'); else image.setAttribute('style', saved);
      }, { id: nodes[0].id, saved });
    }
    verify(await observe());
  }
  const compoundFrameControls = [];
  if (stage === 'after' && nodes.length) {
    const imageRecords = records.filter(record => nodes.some(node => node.id === record.id));
    const args = { container: records.find(record => record.id === imageRecords[0].parent), records: imageRecords, identity: true };
    assert.equal((await page.evaluate(observePaintedGoal, args)).complete, true, 'decoded image frames retain unique painted geometry');
    for (const mutation of ['duplicate-frame', 'displaced-border']) {
      const saved = await page.evaluate(({ id, mutation }) => {
        const doc = document.querySelector('#working-surface iframe').contentDocument;
        const group = [...doc.querySelectorAll('[data-semantic-region-id][data-semantic-role="shape"]')]
          .find(node => node.dataset.semanticRegionId === id);
        const rects = [...group.children].filter(node => node.localName === 'rect');
        if (rects.length !== 2) throw Error('expected exact image compound frame');
        if (mutation === 'duplicate-frame') {
          const clone = rects[0].cloneNode(true); clone.dataset.testCompoundFrame = 'duplicate'; group.appendChild(clone); return null;
        }
        const x = rects[1].getAttribute('x'); rects[1].setAttribute('x', String(Number(x) + 2)); return x;
      }, { id: nodes[0].id, mutation });
      try {
        const rejected = await page.evaluate(observePaintedGoal, args);
        assert.equal(rejected.shapes.find(shape => shape.id === nodes[0].id).bounds, null, mutation + ' cannot establish a unique physical frame');
        compoundFrameControls.push({ mutation, detected: true });
      } finally {
        await page.evaluate(({ id, mutation, saved }) => {
          const doc = document.querySelector('#working-surface iframe').contentDocument;
          const group = [...doc.querySelectorAll('[data-semantic-region-id][data-semantic-role="shape"]')]
            .find(node => node.dataset.semanticRegionId === id);
          if (mutation === 'duplicate-frame') group.querySelector('[data-test-compound-frame="duplicate"]').remove();
          else {
            const rect = [...group.children].filter(node => node.localName === 'rect')[1];
            if (saved === null) rect.removeAttribute('x'); else rect.setAttribute('x', saved);
          }
        }, { id: nodes[0].id, mutation, saved });
      }
    }
    assert.equal((await page.evaluate(observePaintedGoal, args)).complete, true, 'restoring the same nodes restores the positive geometry');
    verify(await observe());
  }
  return { status: 'PASS', stage, scope: 'SYNTHETIC_ASSET_ACTUAL_SVG_AND_DECODE', nodes, observed, hiddenImageDetected, compoundFrameControls };
}
