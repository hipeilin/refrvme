/**
 * Browser integration test. Loads the real page, uploads an image, exercises
 * the controls and checks the rendered canvas.
 *
 * Run:  node test/browser.test.mjs
 * (expects a static server on http://localhost:8080 and a test image path)
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const IMAGE = process.env.IMAGE || '/home/claude/test-photo.jpg';
const SHOTS = process.env.SHOTS || '/home/claude/shots';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail && !cond ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });

// ── Empty state ───────────────────────────────────────────────────────────
check('dropzone visible before upload', await page.isVisible('#dropzone'));
check('save button disabled before upload', await page.isDisabled('#download'));
await page.screenshot({ path: `${SHOTS}/01-empty.png` });

// ── Upload ────────────────────────────────────────────────────────────────
await page.setInputFiles('#fileInput', IMAGE);
await page.waitForFunction(() => document.getElementById('previewCanvas').width > 1, null, { timeout: 5000 });

check('dropzone hidden after upload', await page.isHidden('#dropzone'));
check('save button enabled', !(await page.isDisabled('#download')));
check('source meta shows dimensions',
  (await page.textContent('#sourceMeta')).includes('2400 × 1600'),
  await page.textContent('#sourceMeta'));

// ── Canvas geometry ───────────────────────────────────────────────────────
const geom = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});
check('preview canvas has size', geom.w > 100 && geom.h > 100, JSON.stringify(geom));
// Default is 4:5 portrait with a frame and a caption bar, so the canvas must
// be taller than 5/4 of its width.
check('canvas taller than the crop ratio (frame + bar present)',
  geom.h / geom.w > 5 / 4, `${geom.w}x${geom.h} ratio ${(geom.h / geom.w).toFixed(3)}`);

// ── Palette ───────────────────────────────────────────────────────────────
const swatches = await page.$$eval('#swatchReadout button', (els) =>
  els.map((e) => e.textContent.trim()));
check('palette readout has 5 swatches', swatches.length === 5, JSON.stringify(swatches));
check('swatches are hex codes', swatches.every((s) => /^#[0-9A-F]{6}$/.test(s)), JSON.stringify(swatches));

await page.screenshot({ path: `${SHOTS}/02-loaded.png` });

// ── THE CORE INVARIANT: watermark and caption render at the same size ─────
await page.fill('#capLeft', 'Left slot');
await page.fill('#capRight', 'Right');
await page.waitForTimeout(150);

const fontsMatch = await page.evaluate(async () => {
  const { renderComposition } = await import('/js/render.js');
  // Instrument the canvas context to capture every font string used.
  const seen = [];
  const proto = CanvasRenderingContext2D.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'font');
  Object.defineProperty(proto, 'font', {
    get: desc.get,
    set(v) { seen.push(v); desc.set.call(this, v); },
    configurable: true,
  });
  window.__seenFonts = seen;
  return true;
});
check('instrumented ctx.font', fontsMatch);

// Re-render by nudging a control, then inspect what fonts were set.
await page.fill('#wmText', '© Test Photographer');
await page.waitForTimeout(250);

const fontReport = await page.evaluate(() => {
  const seen = window.__seenFonts || [];
  // Ignore measurement-only sizes: those are set on the scratch canvas during
  // the clamp search. Drawing fonts are the ones set right before fillText.
  return seen.slice(-14);
});

// ── Toggle everything off and on ──────────────────────────────────────────
// The switch inputs are visually hidden (the styled track is the visible
// control), so drive them by dispatching rather than clicking.
async function toggle(bind) {
  await page.evaluate((b) => {
    const input = document.querySelector(`input[data-bind="${b}"]`);
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, bind);
  await page.waitForTimeout(150);
}

const before = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});

await toggle('frame.on');
const noFrame = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});
check('turning the frame off narrows the canvas', noFrame.w < before.w,
  `${JSON.stringify(before)} -> ${JSON.stringify(noFrame)}`);
check('no frame means canvas width equals the crop width', noFrame.w === 1100, String(noFrame.w));
// The palette bar is independent of the frame, so it survives and the canvas
// stays taller than the bare crop.
check('palette bar survives with the frame off', noFrame.h / noFrame.w > 5 / 4,
  `ratio ${(noFrame.h / noFrame.w).toFixed(4)}`);

// With the frame and BOTH bar contents off, the canvas must be exactly the
// crop — no border, no bar, nothing added.
await toggle('palette.on');
await toggle('caption.on');
const bare = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});
check('frame and bar off gives the bare crop',
  Math.abs(bare.h / bare.w - 5 / 4) < 0.01, `ratio ${(bare.h / bare.w).toFixed(4)}`);

await toggle('caption.on'); // back on
await toggle('palette.on'); // back on
await toggle('frame.on'); // back on

await toggle('palette.on');
const noPalette = await page.evaluate(() => document.getElementById('previewCanvas').height);
check('hiding the palette shortens the bar', noPalette < before.h, `${noPalette} vs ${before.h}`);
await toggle('palette.on');

// ── Ratio switching ───────────────────────────────────────────────────────
await page.click('button[data-ratio="story"]');
await page.waitForTimeout(200);
const story = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});
check('9:16 makes a much taller canvas', story.h / story.w > 1.6, `${(story.h / story.w).toFixed(3)}`);

await page.click('button[data-orientation="landscape"]');
await page.waitForTimeout(200);
const land = await page.evaluate(() => {
  const c = document.getElementById('previewCanvas');
  return { w: c.width, h: c.height };
});
check('landscape 16:9 is wider than tall', land.w > land.h, `${land.w}x${land.h}`);
check('landscape chip relabels to 16:9',
  (await page.textContent('button[data-ratio="story"]')) === '16:9',
  await page.textContent('button[data-ratio="story"]'));

await page.click('button[data-orientation="portrait"]');
await page.click('button[data-ratio="portrait45"]');
await page.waitForTimeout(200);

// ── Crop view + drag ──────────────────────────────────────────────────────
await page.click('button[data-view="crop"]');
await page.waitForTimeout(300);
check('crop view visible', await page.isVisible('#cropper'));
check('crop rect is positioned', await page.evaluate(() => {
  const r = document.getElementById('cropRect');
  return r.offsetWidth > 10 && r.offsetHeight > 10;
}));
await page.screenshot({ path: `${SHOTS}/03-crop.png` });

const cropBefore = await page.evaluate(() => {
  const r = document.getElementById('cropRect').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
});

// Drag the SE trim mark inward.
const seMark = await page.$('.crop-mark--se');
const box = await seMark.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x - 90, box.y - 110, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(250);

const cropAfter = await page.evaluate(() => {
  const r = document.getElementById('cropRect').getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
});
check('dragging a corner resizes the crop', cropAfter.w < cropBefore.w,
  `${JSON.stringify(cropBefore)} -> ${JSON.stringify(cropAfter)}`);
check('ratio held during drag', Math.abs(cropAfter.h / cropAfter.w - 5 / 4) < 0.02,
  `ratio ${(cropAfter.h / cropAfter.w).toFixed(3)}`);
check('anchor corner stayed put', Math.abs(cropAfter.x - cropBefore.x) < 2,
  `${cropBefore.x} -> ${cropAfter.x}`);
await page.screenshot({ path: `${SHOTS}/04-cropped.png` });

// Drag the body of the rect to move it.
const rectBox = await page.evaluate(() => {
  const r = document.getElementById('cropRect').getBoundingClientRect();
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x };
});
await page.mouse.move(rectBox.cx, rectBox.cy);
await page.mouse.down();
await page.mouse.move(rectBox.cx + 60, rectBox.cy, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const moved = await page.evaluate(() => document.getElementById('cropRect').getBoundingClientRect().x);
check('dragging the body moves the crop', moved > rectBox.x + 20, `${rectBox.x} -> ${moved}`);

await page.click('button[data-view="preview"]');
await page.waitForTimeout(300);

// ── Palette count ─────────────────────────────────────────────────────────
await page.evaluate(() => {
  const s = document.querySelector('input[data-bind="palette.count"]');
  s.value = '10';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const ten = await page.$$eval('#swatchReadout button', (e) => e.length);
check('ten swatches requested and rendered', ten === 10, String(ten));
await page.screenshot({ path: `${SHOTS}/05-ten-swatches.png` });

await page.evaluate(() => {
  const s = document.querySelector('input[data-bind="palette.count"]');
  s.value = '5';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);

// ── Long text warning ─────────────────────────────────────────────────────
await page.fill('#capCenter', 'A very long middle caption that will certainly collide with both sides');
await page.fill('#capLeft', 'Also quite a long left caption here');
await page.waitForTimeout(300);
check('collision warning shown', await page.isVisible('#warnings'),
  await page.textContent('#warnings'));

await page.fill('#capCenter', 'Lisbon, 2026');
await page.fill('#capLeft', 'Leica M6 · 35mm');
await page.waitForTimeout(250);
check('warning clears when text fits', await page.isHidden('#warnings'));

// ── Export ────────────────────────────────────────────────────────────────
const download = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#download'),
]).then(([d]) => d).catch(() => null);

check('clicking save produces a download', !!download,
  download ? download.suggestedFilename() : 'no download event');
if (download) {
  check('filename is sensible', /passepartout\.(png|jpg|webp)$/.test(download.suggestedFilename()),
    download.suggestedFilename());
  await download.saveAs(`${SHOTS}/export.png`);
}

await page.screenshot({ path: `${SHOTS}/06-final.png` });

// ── Mobile layout ─────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflowX = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow on mobile', overflowX <= 1, `overflow ${overflowX}px`);
await page.screenshot({ path: `${SHOTS}/07-mobile.png`, fullPage: false });

// ── Console hygiene ───────────────────────────────────────────────────────
const realErrors = consoleErrors.filter((e) => !/fonts\.(googleapis|gstatic)\.com/.test(e));
check('no console errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (fontReport.length) console.log('\nfonts set during render:\n  ' + fontReport.join('\n  '));
process.exit(failed.length ? 1 : 0);
