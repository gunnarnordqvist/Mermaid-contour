#!/usr/bin/env node
/**
 * Render Mermaid text, including the `contour` diagram type, to SVG or PNG.
 *
 *   contour-render input.mmd output.svg|output.png [--theme default|dark|forest|neutral]
 *
 * Opens a blank page in headless Chromium through Puppeteer, loads the Mermaid of your project
 * (node_modules/mermaid/dist/mermaid.min.js) and the contour module, and renders. Mermaid's own `mmdc`
 * cannot load external diagram types, hence this script. Set PUPPETEER_EXECUTABLE_PATH to a Chrome or
 * Chromium when Puppeteer has none. The views use the Inter typeface; install it for a faithful rendering.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const themeAt = args.indexOf('--theme');
const theme = themeAt >= 0 ? args.splice(themeAt, 2)[1] : 'default';
const [input, output] = args;
if (!theme || !input || !output) {
  console.error('usage: contour-render input.mmd output.svg|png [--theme default|dark|forest|neutral]');
  process.exit(2);
}

const { default: puppeteer } = await import('puppeteer');
const mermaidJs = require.resolve('mermaid/dist/mermaid.min.js');

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
});
let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1700, height: 900, deviceScaleFactor: 2 });
  await page.setContent('<body style="margin:0;background:#F8FAFF"><div id="out"></div></body>');
  await page.addScriptTag({ path: mermaidJs });
  await page.addScriptTag({ path: path.join(here, '../src/mermaid-contour.mjs'), type: 'module' });
  await page.waitForFunction(() => globalThis.mermaid && globalThis.mermaidContour);
  const svg = await page.evaluate(async (text, theme) => {
    await globalThis.mermaidContour.registerContour(globalThis.mermaid);
    globalThis.mermaid.initialize({ startOnLoad: false, theme });
    const { svg } = await globalThis.mermaid.render('contour-figure', text);
    document.getElementById('out').innerHTML = svg;
    return svg;
  }, fs.readFileSync(input, 'utf8'), theme);
  if (output.endsWith('.svg')) fs.writeFileSync(output, svg);
  else await (await page.$('#out svg')).screenshot({ path: output });
} catch (error) {
  console.error(String(error.message).split('\n')[0]);
  code = 1;
} finally {
  await browser.close();
}
process.exit(code);
