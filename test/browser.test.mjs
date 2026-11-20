// Render the examples in headless Chromium and compare every mark with the Python renderer of the book.
// The golden positions were produced by scripts/render_landscape.py of Geonitab/Landscape (inches, y up).
// Needs Chrome or Chromium: set PUPPETEER_EXECUTABLE_PATH, or let Puppeteer download one. Run `npm run test:browser`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const golden = JSON.parse(fs.readFileSync(path.join(root, 'test/golden-positions.json'), 'utf8'));
const { default: puppeteer } = await import('puppeteer');

let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
} catch (error) {
  test('browser tests', { skip: `no Chrome or Chromium: ${String(error.message).split('\n')[0]}` }, () => {});
}

if (browser) {
  test.after(() => browser.close());
  for (const [name, marks] of Object.entries(golden)) {
    test(`${name}: ${Object.keys(marks).length} marks sit where the Python renderer puts them`, async () => {
      const page = await browser.newPage();
      await page.setContent('<div id="out"></div>');
      await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
      await page.addScriptTag({ path: path.join(root, 'src/mermaid-contour.mjs'), type: 'module' });
      await page.waitForFunction(() => globalThis.mermaid && globalThis.mermaidContour);
      const found = await page.evaluate(async (text) => {
        await globalThis.mermaidContour.registerContour(globalThis.mermaid);
        globalThis.mermaid.initialize({ startOnLoad: false });
        const { svg } = await globalThis.mermaid.render('t', text);
        document.getElementById('out').innerHTML = svg;
        return Object.fromEntries([...document.querySelectorAll('desc[data-unit]')].map((d) => [d.dataset.unit, [+d.dataset.x, +d.dataset.y]]));
      }, fs.readFileSync(path.join(root, 'examples', `${name}.mmd`), 'utf8'));
      assert.deepEqual(Object.keys(found).sort(), Object.keys(marks).sort());
      const worst = Math.max(...Object.entries(marks).map(([id, [x, y]]) => Math.max(Math.abs(found[id][0] - x), Math.abs(found[id][1] - y))));
      assert.ok(worst < 0.001, `largest difference ${worst} in`);
      await page.close();
    });
  }
}
