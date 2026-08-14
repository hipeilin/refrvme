/**
 * Browser integration test. Loads the real page, uploads an image, exercises
 * the controls and checks the rendered canvas.
 *
 * Run:  node test/browser.test.mjs
 * (expects a static server on http://localhost:8080 and a test image path)
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
/** Set when the local Chromium lives somewhere Playwright does not look. */
const CHROME_PATH = process.env.CHROME_PATH || undefined;
const IMAGE = process.env.IMAGE || '/home/claude/test-photo.jpg';
const SHOTS = process.env.SHOTS || '/home/claude/shots';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail && !cond ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });

const consoleErrors = [];
// Keep the source URL: a bare "failed to load resource" is unattributable,
// and the tolerated-error filter below has to know which resource it was.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const where = m.location()?.url || '';
  consoleErrors.push(where ? `${m.text()} @ ${where}` : m.text());
});
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

// ── Fixed-frame mode: reposition & zoom ───────────────────────────────────
// The invariant under test throughout: the image must cover the frame at all
// times. Any gap here is the whitespace this mode exists to make impossible.
const boxes = () => page.evaluate(() => {
  const f = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  return {
    rect: f(document.getElementById('cropRect')),
    img: f(document.getElementById('cropImage')),
    view: f(document.getElementById('cropper')),
    meta: document.getElementById('cropMeta').textContent,
  };
});
const covers = (b) =>
  b.img.x <= b.rect.x + 0.5 &&
  b.img.y <= b.rect.y + 0.5 &&
  b.img.x + b.img.w >= b.rect.x + b.rect.w - 0.5 &&
  b.img.y + b.img.h >= b.rect.y + b.rect.h - 0.5;

check('zoom slider hidden until the box is ticked', await page.isHidden('#zoomField'));
await page.check('#resizeMode');
await page.waitForTimeout(250);
check('zoom slider appears', await page.isVisible('#zoomField'));

// Ticking the box keeps whatever crop the user already had, so recentre first
// to get a known zoom of 1.00× to assert against.
await page.click('#recenterCrop');
await page.waitForTimeout(250);

const framed = await boxes();
check('recentring lands at the zoom-out cap', /zoom 1\.00×/.test(framed.meta), framed.meta);
check('frame is centred in the viewport',
  Math.abs((framed.rect.x + framed.rect.w / 2) - (framed.view.x + framed.view.w / 2)) < 1.5 &&
  Math.abs((framed.rect.y + framed.rect.h / 2) - (framed.view.y + framed.view.h / 2)) < 1.5,
  JSON.stringify(framed));
check('frame keeps the 4:5 ratio', Math.abs(framed.rect.h / framed.rect.w - 5 / 4) < 0.02,
  (framed.rect.h / framed.rect.w).toFixed(3));
check('image covers the frame on entry', covers(framed), JSON.stringify(framed));
check('the whole image is on screen at zoom 1',
  framed.img.w <= framed.view.w + 1 || framed.img.h <= framed.view.h + 1,
  JSON.stringify(framed));
await page.screenshot({ path: `${SHOTS}/06-framed.png` });

// Drag the photograph: the frame must not budge, and the image must follow.
const vx = framed.view.x + framed.view.w / 2;
const vy = framed.view.y + framed.view.h / 2;
await page.mouse.move(vx, vy);
await page.mouse.down();
await page.mouse.move(vx + 300, vy, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const panned = await boxes();
check('the frame stays put while the image is dragged',
  Math.abs(panned.rect.x - framed.rect.x) < 0.5 && Math.abs(panned.rect.y - framed.rect.y) < 0.5,
  `${JSON.stringify(framed.rect)} -> ${JSON.stringify(panned.rect)}`);
check('the image follows the pointer', panned.img.x > framed.img.x + 5,
  `${framed.img.x} -> ${panned.img.x}`);
check('no gap after panning hard into an edge', covers(panned), JSON.stringify(panned));
await page.screenshot({ path: `${SHOTS}/07-framed-panned.png` });

// Wheel zoom, then zoom out well past the cap.
await page.mouse.move(vx, vy);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(200);
const zoomed = await boxes();
check('the wheel zooms the image in', zoomed.img.w > panned.img.w + 5,
  `${panned.img.w} -> ${zoomed.img.w}`);
check('zooming does not resize the frame', Math.abs(zoomed.rect.w - framed.rect.w) < 0.5);
check('the slider tracks a wheel zoom', Number(await page.inputValue('#zoomRange')) > 100,
  await page.inputValue('#zoomRange'));
await page.screenshot({ path: `${SHOTS}/08-framed-zoomed.png` });

await page.mouse.wheel(0, 6000);
await page.waitForTimeout(200);
const capped = await boxes();
check('zooming out stops at the covering size', /zoom 1\.00×/.test(capped.meta), capped.meta);
check('no whitespace at the zoom-out cap', covers(capped), JSON.stringify(capped));

// The slider is the pointer-free route to the same thing.
await page.evaluate(() => {
  const s = document.getElementById('zoomRange');
  s.value = '250';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
const slid = await boxes();
check('the slider zooms', /zoom 2\.50×/.test(slid.meta), slid.meta);
check('the image still covers the frame after a slider zoom', covers(slid), JSON.stringify(slid));

// Changing the ratio reshapes the frame without breaking the cover rule.
await page.click('button[data-ratio="story"]');
await page.waitForTimeout(250);
const storyFrame = await boxes();
check('the frame takes the new ratio', Math.abs(storyFrame.rect.h / storyFrame.rect.w - 16 / 9) < 0.03,
  (storyFrame.rect.h / storyFrame.rect.w).toFixed(3));
check('still covered after a ratio change', covers(storyFrame), JSON.stringify(storyFrame));

await page.click('button[data-ratio="portrait45"]');
await page.uncheck('#resizeMode');
await page.waitForTimeout(250);
check('corner marks come back when the box is unticked', await page.isVisible('.crop-mark--se'));
check('zoom slider hidden again', await page.isHidden('#zoomField'));
const restored = await boxes();
check('the crop rect sits back over the image',
  restored.rect.x >= restored.img.x - 1 &&
  restored.rect.x + restored.rect.w <= restored.img.x + restored.img.w + 1,
  JSON.stringify(restored));

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

// ── Watermark face ────────────────────────────────────────────────────────
// The display face is an asset the deployment may or may not carry, so the
// assertion is that the app tells the truth about which face it used — not
// that the file is present.
const faceState = await page.evaluate(async () => {
  const { isWatermarkFontReady, WATERMARK_FONT } = await import('/js/lib/text.js');
  return {
    ready: isWatermarkFontReady(),
    family: WATERMARK_FONT.family,
    url: WATERMARK_FONT.url,
    // document.fonts.check() answers true for a family it has never heard of
    // (nothing needs loading to render in a fallback), so it cannot answer
    // this. Measuring can: if the face is really there, a string set in it
    // comes out a different width from the same string set in a family that
    // certainly does not exist.
    canvasHas: (() => {
      const ctx = document.createElement('canvas').getContext('2d');
      const sample = 'Handgloves 123';
      ctx.font = `500 64px "${WATERMARK_FONT.family}", monospace`;
      const real = ctx.measureText(sample).width;
      ctx.font = '500 64px "NoSuchFaceAnywhere", monospace';
      const absent = ctx.measureText(sample).width;
      return Math.abs(real - absent) > 0.01;
    })(),
    note: document.getElementById('wmFontNote').textContent,
  };
});
check('the display face state matches what canvas can use',
  faceState.ready === faceState.canvasHas, JSON.stringify(faceState));
check('the watermark note reports the face actually in use',
  faceState.ready
    ? faceState.note === `Set in ${faceState.family}.`
    : faceState.note.includes('falls back'),
  faceState.note);
if (!faceState.ready) {
  console.log(`  note  ${faceState.url} is absent; watermark is using the fallback face`);
}

// Whichever face is in play, the watermark must be measured in it — a size
// clamped against the wrong metrics is how text ends up running off the edge.
const measuredInFace = await page.evaluate(async () => {
  const { fontStr } = await import('/js/lib/text.js');
  return {
    body: fontStr(40, 'sans'),
    mark: fontStr(40, 'sans', 'watermark'),
  };
});
check('watermark and caption keep the same size and weight',
  measuredInFace.body.startsWith('500 40px') && measuredInFace.mark.startsWith('500 40px'),
  JSON.stringify(measuredInFace));
check('the display face leads the watermark stack when loaded',
  faceState.ready
    ? measuredInFace.mark.startsWith(`500 40px "${faceState.family}"`)
    : measuredInFace.mark === measuredInFace.body,
  JSON.stringify(measuredInFace));

// ── Watermark position, including the two centred slots ───────────────────
// Proof by pixels: render the bare crop with and without the watermark and
// look at where the two differ. Anything else only tests that a button got a
// class, not that the ink moved.
async function inkCentroid(position) {
  return page.evaluate(async (pos) => {
    const { renderComposition } = await import('/js/render.js');
    const { createStore, defaultOptions } = await import('/js/state.js');
    void createStore;

    const image = document.getElementById('cropImage');
    const crop = { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };

    const base = defaultOptions();
    base.frame.on = false;
    base.caption.on = false;
    base.palette.on = false;
    base.watermark.text = '▮▮▮▮▮▮';
    base.watermark.color = '#FFFFFF';
    base.watermark.alpha = 1;
    base.watermark.position = pos;

    const withMark = renderComposition({ image, crop, opts: base, outputWidth: 600 }).canvas;
    const without = renderComposition({
      image, crop, opts: { ...base, watermark: { ...base.watermark, on: false } }, outputWidth: 600,
    }).canvas;

    const a = withMark.getContext('2d').getImageData(0, 0, withMark.width, withMark.height).data;
    const b = without.getContext('2d').getImageData(0, 0, without.width, without.height).data;

    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (diff < 40) continue;
      const px = (i / 4) % withMark.width;
      const py = Math.floor((i / 4) / withMark.width);
      sx += px; sy += py; n++;
    }
    return n ? { u: sx / n / withMark.width, v: sy / n / withMark.height, n } : null;
  }, position);
}

const ink = {};
for (const pos of ['tl', 'tc', 'tr', 'center', 'bl', 'bc', 'br']) {
  ink[pos] = await inkCentroid(pos);
}
check('every position draws something', Object.values(ink).every((p) => p && p.n > 50),
  JSON.stringify(ink));
check('top-centre ink sits high and centred',
  ink.tc.v < 0.25 && Math.abs(ink.tc.u - 0.5) < 0.05, JSON.stringify(ink.tc));
check('bottom-centre ink sits low and centred',
  ink.bc.v > 0.75 && Math.abs(ink.bc.u - 0.5) < 0.05, JSON.stringify(ink.bc));
check('top-centre shares the top row with the top corners',
  Math.abs(ink.tc.v - ink.tl.v) < 0.02 && Math.abs(ink.tc.v - ink.tr.v) < 0.02,
  JSON.stringify({ tl: ink.tl, tc: ink.tc, tr: ink.tr }));
check('bottom-centre shares the bottom row with the bottom corners',
  Math.abs(ink.bc.v - ink.bl.v) < 0.02 && Math.abs(ink.bc.v - ink.br.v) < 0.02,
  JSON.stringify({ bl: ink.bl, bc: ink.bc, br: ink.br }));
check('the centred slots sit between the left and right ones',
  ink.tl.u < ink.tc.u && ink.tc.u < ink.tr.u && ink.bl.u < ink.bc.u && ink.bc.u < ink.br.u,
  JSON.stringify(ink));
check('the middle slot is distinct from both centred edges',
  ink.center.v > ink.tc.v + 0.2 && ink.center.v < ink.bc.v - 0.2, JSON.stringify(ink));

// The picker must expose them too, or they are unreachable.
await page.click('#wmPosition button[data-position="tc"]');
await page.waitForTimeout(200);
check('the picker selects top centre',
  await page.evaluate(() =>
    document.querySelector('#wmPosition button[data-position="tc"]').getAttribute('aria-checked') === 'true'));
await page.click('#wmPosition button[data-position="bc"]');
await page.waitForTimeout(200);
check('the picker selects bottom centre',
  await page.evaluate(() =>
    document.querySelector('#wmPosition button[data-position="bc"]').getAttribute('aria-checked') === 'true'));
check('selecting one position clears the others',
  await page.$$eval('#wmPosition button[aria-checked="true"]', (els) => els.length) === 1);
await page.screenshot({ path: `${SHOTS}/09-watermark-bc.png` });
await page.click('#wmPosition button[data-position="br"]');
await page.waitForTimeout(200);

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
// Two 404s are expected rather than broken: the page ships no favicon, and
// the watermark's display face is an optional asset the app is built to fall
// back from. Everything else counts.
const tolerated = /favicon\.ico|Bigola%20Display/;
const realErrors = consoleErrors.filter(
  (e) => !/fonts\.(googleapis|gstatic)\.com/.test(e) && !tolerated.test(e),
);
check('no console errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (fontReport.length) console.log('\nfonts set during render:\n  ' + fontReport.join('\n  '));
process.exit(failed.length ? 1 : 0);
