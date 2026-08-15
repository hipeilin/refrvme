/**
 * Visual matrix — renders a spread of configurations and writes each export to
 * disk, plus a contact sheet. Not an assertion suite; this is for looking at.
 *
 * Run: node test/visual.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
const IMAGE = process.env.IMAGE || '/home/claude/test-photo.jpg';
const OUT = process.env.OUT || '/home/claude/shots';

const CASES = [
  {
    name: 'a-classic-mat', watermark: 'Passepartout',
    ratio: 'portrait45', orientation: 'portrait',
    set: { 'frame.borderPct': 0.045, 'frame.radiusPct': 0, 'palette.count': 5 },
  
  },
  {
    name: 'b-rounded-thick', watermark: 'Costa da Caparica',
    ratio: 'square', orientation: 'portrait',
    set: { 'frame.borderPct': 0.07, 'frame.radiusPct': 0.05, 'palette.count': 6 },
  
  },
  {
    name: 'c-ten-swatches', watermark: 'No. 12\n2026',
    ratio: 'rednote', orientation: 'portrait',
    set: { 'frame.borderPct': 0.035, 'frame.radiusPct': 0.02, 'palette.count': 10 },
  
  },
  {
    name: 'd-landscape-wide', watermark: 'Atlantic\nf/8 · 1/500',
    ratio: 'landscape', orientation: 'landscape',
    set: { 'frame.borderPct': 0.03, 'frame.radiusPct': 0.01, 'palette.count': 4 },
  
  },
  {
    name: 'e-story-no-palette', watermark: 'Lisbon\n2026',
    ratio: 'story', orientation: 'portrait',
    set: { 'frame.borderPct': 0.05, 'frame.radiusPct': 0.03 },
    off: ['palette.on'],
  
  },
  {
    name: 'f-dark-frame', watermark: 'PLATE IV',
    ratio: 'classic', orientation: 'landscape',
    set: { 'frame.borderPct': 0.05, 'frame.radiusPct': 0, 'palette.count': 5 },
    colors: { 'frame.color': '#151515', 'palette.hexColor': '#E8E6E1' },
  
  },
  {
    name: 'g-no-frame', watermark: '© your name',
    ratio: 'square', orientation: 'portrait',
    off: ['frame.on'],
  
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.setInputFiles('#fileInput', IMAGE);
await page.waitForFunction(() => document.getElementById('previewCanvas').width > 1);

/** Set a bound control by dispatching, which works for hidden inputs too. */
async function setBound(bind, value) {
  await page.evaluate(([b, v]) => {
    const input = document.querySelector(`[data-bind="${b}"]`);
    if (!input) throw new Error('no control for ' + b);
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [bind, value]);
}

const report = [];

for (const c of CASES) {
  // Reset to defaults between cases so settings don't leak across the matrix.
  await page.click('#resetAll');
  await page.waitForTimeout(120);

  await page.click(`button[data-ratio="${c.ratio}"]`);
  await page.click(`button[data-orientation="${c.orientation}"]`);
  await page.click('#recenterCrop');

  for (const [k, v] of Object.entries(c.set || {})) await setBound(k, v);
  for (const [k, v] of Object.entries(c.colors || {})) await setBound(k, v);
  for (const k of c.off || []) await setBound(k, false);
  if (c.watermark) await page.fill('#wmText', c.watermark);

  await page.waitForTimeout(350);

  // Pull the finished canvas straight out as a PNG.
  const dataUrl = await page.evaluate(() =>
    document.getElementById('previewCanvas').toDataURL('image/png'));
  writeFileSync(`${OUT}/case-${c.name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

  const info = await page.evaluate(() => {
    const c2 = document.getElementById('previewCanvas');
    return {
      w: c2.width, h: c2.height,
      warning: document.getElementById('warnings').hidden
        ? null : document.getElementById('warnings').textContent,
    };
  });
  report.push({ name: c.name, ...info });
  console.log(`${c.name.padEnd(22)} ${info.w}x${info.h}${info.warning ? '  ⚠ ' + info.warning : ''}`);
}

await browser.close();
console.log('\nwrote ' + report.length + ' cases to ' + OUT);
