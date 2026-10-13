/**
 * Unit tests for the pure logic modules.
 * Run with: node test/logic.test.mjs
 *
 * These cover the geometry and sizing rules that are easy to break and hard
 * to eyeball — aspect-ratio locking at image edges, the shared text clamp,
 * and the bar layout arithmetic.
 */

import { extractPalette } from '../js/lib/palette.js';
import { rgbToHex, hexToRgb, luminance } from '../js/lib/color.js';
import {
  largestFit,
  refitToRatio,
  clampToBounds,
  moveRect,
  resizeFromHandle,
  resolveRatio,
  fitsRotated,
} from '../js/lib/crop-geometry.js';
import {
  resolveWatermarkSize, resolveHexSize, metricOf, splitLines, measureBlock,
  HEX_COLUMN_FILL, TEXT,
} from '../js/lib/text.js';
import { computeLayout, swatchMetrics, borderPx, innerRatio } from '../js/lib/layout.js';

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function close(name, a, b, tol = 1e-6) {
  ok(name, Math.abs(a - b) <= tol, `got ${a}, expected ~${b}`);
}

function group(title) {
  console.log(`\n${title}`);
}

/**
 * A crude measurer. Per-font width factors let the tests verify that each
 * string is measured with its OWN face — a display face is wider per glyph,
 * which is exactly the case that would break a single-font clamp.
 */
const WIDTH_FACTOR = { sans: 0.55, serif: 0.52, mono: 0.60, display: 0.78 };
const fakeMeasure = (text, px, font = 'sans') =>
  text.length * px * (WIDTH_FACTOR[font] ?? 0.55);

/** Shorthand for the common resolveWatermarkSize call shape. */
const wmSize = (o) => resolveWatermarkSize(fakeMeasure, {
  cropW: 1000, metric: metricOf(1000, 1000), font: 'sans', scale: 1, marginPx: 0, ...o,
});

// ---------------------------------------------------------------- colour ---
group('color');
ok('rgbToHex pads', rgbToHex([0, 8, 255]) === '#0008FF', rgbToHex([0, 8, 255]));
ok('hexToRgb shorthand', JSON.stringify(hexToRgb('#f0a')) === '[255,0,170]');
ok('hexToRgb rejects junk', hexToRgb('nope') === null);
ok('luminance: white > black', luminance([255, 255, 255]) > luminance([0, 0, 0]));
ok('green weighs most', luminance([0, 255, 0]) > luminance([255, 0, 0]));

// --------------------------------------------------------------- palette ---
group('palette');
{
  // Synthetic 4x1 image: two pure reds, two pure blues.
  const data = new Uint8ClampedArray([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]);
  const pal = extractPalette({ data, width: 4, height: 1 }, 2);
  ok('splits two distinct colours', pal.length === 2, JSON.stringify(pal));
  const hexes = pal.map(rgbToHex);
  ok('finds red and blue', hexes.includes('#FF0000') && hexes.includes('#0000FF'), hexes.join(','));
  ok('sorted dark to light', luminance(pal[0]) <= luminance(pal[1]));
}
{
  // A uniform image cannot yield more than one colour, however many we ask for.
  const data = new Uint8ClampedArray(16 * 4).fill(120);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const pal = extractPalette({ data, width: 4, height: 4 }, 8);
  ok('uniform image degrades gracefully', pal.length === 1, `len ${pal.length}`);
}
{
  // Fully transparent input should produce nothing rather than throwing.
  const data = new Uint8ClampedArray(16 * 4); // alpha all zero
  ok('all-transparent returns empty', extractPalette({ data, width: 4, height: 4 }, 5).length === 0);
}

// --------------------------------------------------------------- cropping ---
group('crop geometry');
{
  const r = largestFit(2000, 1000, 4 / 5);
  close('largestFit height maxes out', r.h, 1000);
  close('largestFit keeps ratio', r.w / r.h, 4 / 5, 1e-9);
  ok('largestFit is centred', Math.abs(r.x + r.w / 2 - 1000) < 1e-9);
  ok('largestFit stays inside', r.x >= 0 && r.y >= 0 && r.x + r.w <= 2000);
}
{
  const r = clampToBounds({ x: -50, y: -50, w: 100, h: 100 }, 500, 500);
  ok('clamp pushes back inside', r.x === 0 && r.y === 0);
  const big = clampToBounds({ x: 0, y: 0, w: 900, h: 300 }, 400, 400);
  ok('clamp scales oversize rects', big.w <= 400 && big.h <= 400, JSON.stringify(big));
  close('clamp preserves ratio when scaling', big.w / big.h, 3, 1e-9);
}
{
  // The critical case: drag a corner past the image edge with a locked ratio.
  const start = { x: 100, y: 100, w: 200, h: 250 }; // 4:5
  const out = resizeFromHandle(start, 'se', 9999, 9999, 4 / 5, 1000, 600);
  close('ratio survives edge clamp', out.w / out.h, 4 / 5, 1e-9);
  ok('stays inside image', out.x + out.w <= 1000.001 && out.y + out.h <= 600.001, JSON.stringify(out));
  ok('anchor corner held', out.x === 100 && out.y === 100);
}
{
  // Dragging north-west should hold the south-east corner fixed.
  const start = { x: 200, y: 200, w: 300, h: 300 };
  const out = resizeFromHandle(start, 'nw', 0, 0, 1, 1000, 1000);
  close('nw drag holds SE corner x', out.x + out.w, 500);
  close('nw drag holds SE corner y', out.y + out.h, 500);
  close('square stays square', out.w, out.h, 1e-9);
}
{
  // Free mode should not enforce any ratio.
  const out = resizeFromHandle({ x: 0, y: 0, w: 100, h: 100 }, 'se', 400, 120, null, 1000, 1000);
  close('free mode width follows pointer', out.w, 400);
  close('free mode height follows pointer', out.h, 120);
}
{
  const out = resizeFromHandle({ x: 0, y: 0, w: 100, h: 100 }, 'se', -500, -500, null, 1000, 1000);
  ok('never inverts through anchor', out.w > 0 && out.h > 0, JSON.stringify(out));
}
{
  const refit = refitToRatio({ x: 100, y: 100, w: 400, h: 400 }, 1000, 1000, 9 / 16);
  close('refit adopts new ratio', refit.w / refit.h, 9 / 16, 1e-9);
  ok('refit stays in bounds', refit.x >= 0 && refit.y + refit.h <= 1000.001);
}

// ----------------------------------------------------------- straighten ---
group('straighten');
{
  const W = 3000, H = 2000;
  for (const angle of [-30, -4.5, 2, 12, 45]) {
    const r = largestFit(W, H, 4 / 5, angle);
    close(`largestFit keeps ratio at ${angle}°`, r.w / r.h, 4 / 5, 1e-9);
    ok(`largestFit fits at ${angle}°`, fitsRotated(r, W, H, angle), JSON.stringify(r));
    // Maximal: 1% bigger must poke a corner out.
    const grown = { x: r.x - r.w * 0.005, y: r.y - r.h * 0.005, w: r.w * 1.01, h: r.h * 1.01 };
    ok(`largestFit is maximal at ${angle}°`, !fitsRotated(grown, W, H, angle));
  }
}
{
  // Known case: a square rotated 45° holds an upright square of side W/√2.
  const r = largestFit(1000, 1000, 1, 45);
  close('45° square inscribes at side/√2', r.w, (1000 - 2) / Math.SQRT2, 1e-6);
}
{
  const W = 3000, H = 2000, angle = 8;
  const start = largestFit(W, H, 1, angle);
  const small = { x: start.x + 100, y: start.y + 100, w: 400, h: 400 };

  const moved = moveRect(small, 5000, 3000, W, H, angle);
  ok('move clamps inside rotated image', fitsRotated(moved, W, H, angle), JSON.stringify(moved));
  close('move keeps size', moved.w, 400);

  const pushed = clampToBounds({ x: -900, y: -900, w: 2900, h: 1900 }, W, H, angle);
  ok('clamp shrinks oversize rect to fit', fitsRotated(pushed, W, H, angle), JSON.stringify(pushed));
  close('clamp keeps ratio', pushed.w / pushed.h, 2900 / 1900, 1e-9);

  const locked = resizeFromHandle(small, 'se', 99999, 99999, 4 / 5, W, H, angle);
  close('rotated resize keeps ratio', locked.w / locked.h, 4 / 5, 1e-9);
  ok('rotated resize fits', fitsRotated(locked, W, H, angle), JSON.stringify(locked));
  ok('rotated resize holds anchor', locked.x === small.x && locked.y === small.y);
  ok('rotated resize reaches the edge', !fitsRotated(
    { ...locked, w: locked.w * 1.01, h: locked.h * 1.01 }, W, H, angle));

  const free = resizeFromHandle(small, 'nw', -99999, small.y - 50, null, W, H, angle);
  ok('rotated free resize fits', fitsRotated(free, W, H, angle), JSON.stringify(free));
  close('rotated free resize holds SE corner', free.x + free.w, small.x + small.w, 1e-6);
}
{
  // Angle 0 must be the exact unrotated behaviour, not a near-miss of it.
  const r = { x: -50, y: 20, w: 100, h: 100 };
  const a = clampToBounds(r, 500, 500);
  const b = clampToBounds(r, 500, 500, 0);
  ok('angle 0 is the level path', a.x === b.x && a.y === b.y && a.w === b.w);
}
{
  // Orientation is absolute, not an inversion: "portrait" always yields the
  // taller shape regardless of how the preset happens to be written.
  ok('portrait takes the tall form', Math.abs(resolveRatio('landscape', 'portrait') - 1 / 1.91) < 1e-9);
  ok('landscape takes the wide form', Math.abs(resolveRatio('landscape', 'landscape') - 1.91) < 1e-9);
  ok('portrait 4:5 stays 4:5', Math.abs(resolveRatio('portrait45', 'portrait') - 4 / 5) < 1e-9);
  ok('landscape 4:5 becomes 5:4', Math.abs(resolveRatio('portrait45', 'landscape') - 5 / 4) < 1e-9);
  ok('square is orientation-proof', resolveRatio('square', 'portrait') === resolveRatio('square', 'landscape'));
  ok('free stays null', resolveRatio('free', 'portrait') === null);
}

// ------------------------------------------------------------------- text ---
group('watermark sizing');
{
  const cropW = 2000;
  const cropH = 1600;
  const metric = metricOf(cropW, cropH);
  close('metric is the geometric mean', metric, Math.sqrt(2000 * 1600));
  // Orientation independence: the whole reason we use a geometric mean.
  close('metric is orientation-agnostic', metricOf(2000, 1000), metricOf(1000, 2000));

  const r = wmSize({ cropW, metric, text: '© Jane', marginPx: metric * 0.03 });
  close('unconstrained size is the base fraction', r.px, metric * TEXT.sizePct, 1e-9);
  ok('no false overflow when there is room', r.overflow === false);
}
{
  // A string too wide for the image must shrink to fit.
  const cropW = 800;
  const metric = metricOf(800, 800);
  const margin = metric * 0.03;
  const long = 'x'.repeat(60);

  const clamped = wmSize({ cropW, metric, text: long, marginPx: margin });
  const short = wmSize({ cropW, metric, text: 'short', marginPx: margin });
  ok('long text forces a shrink', clamped.px < short.px);
  ok('clamped text fits its budget',
    fakeMeasure(long, clamped.px, 'sans') <= cropW - 2 * margin + 0.001 || clamped.overflow);
}
{
  const tiny = wmSize({ cropW: 10, metric: 10, text: 'y'.repeat(500), marginPx: 4 });
  ok('never goes below the floor', tiny.px >= TEXT.minPx);
  ok('overflow flagged at the floor', tiny.overflow === true);
}
{
  // Different faces have different widths, so a wider face clamps harder.
  const text = 'Wide watermark string that will not fit';
  const display = wmSize({ cropW: 600, metric: metricOf(600, 600), text, font: 'display' });
  const sans = wmSize({ cropW: 600, metric: metricOf(600, 600), text, font: 'sans' });
  ok('a wider face clamps harder', display.px <= sans.px,
    `display ${display.px.toFixed(2)} vs sans ${sans.px.toFixed(2)}`);
}
{
  // Optical scale must be folded into the clamp, or a scaled-up watermark
  // would silently run off the edge instead of shrinking to fit.
  const cropW = 800;
  const metric = metricOf(800, 800);
  const text = 'W'.repeat(40);

  const plain = wmSize({ cropW, metric, text, scale: 1 });
  const doubled = wmSize({ cropW, metric, text, scale: 2 });
  ok('scaling up clamps the size down', doubled.px < plain.px,
    `${doubled.px.toFixed(2)} vs ${plain.px.toFixed(2)}`);
  ok('scaled watermark still fits the budget',
    fakeMeasure(text, doubled.px * 2, 'sans') <= cropW + 0.001 || doubled.overflow);

  const omitted = resolveWatermarkSize(fakeMeasure, {
    cropW, metric, text: 'short', font: 'sans', marginPx: 0,
  });
  close('omitting scale equals scale 1', omitted.px, plain.px > 0 ? wmSize({
    cropW, metric, text: 'short', scale: 1,
  }).px : 0, 1e-9);
}

group('hex label sizing');
{
  const metric = metricOf(1000, 1000);
  const labels = Array.from({ length: 10 }, () => '#AABBCC');

  const roomy = resolveHexSize(fakeMeasure, {
    metric, labels: ['#AABBCC'], font: 'mono', cell: 500,
  });
  close('unconstrained hex size is its own fraction', roomy.px, metric * TEXT.hexSizePct, 1e-9);

  const tight = resolveHexSize(fakeMeasure, {
    metric, labels, font: 'mono', cell: 100,
  });
  ok('narrow columns shrink the labels', tight.px < roomy.px,
    `${tight.px.toFixed(2)} vs ${roomy.px.toFixed(2)}`);
  ok('label fits its column',
    fakeMeasure('#AABBCC', tight.px, 'mono') <= 100 * HEX_COLUMN_FILL + 0.001);
}
{
  // THE POINT OF THE SPLIT: hex labels and the watermark are independent, so
  // changing one must not move the other.
  const metric = metricOf(1000, 1000);
  const hexA = resolveHexSize(fakeMeasure, { metric, labels: ['#ABCDEF'], font: 'mono', cell: 400 });
  const hexB = resolveHexSize(fakeMeasure, { metric, labels: ['#ABCDEF'], font: 'mono', cell: 400 });
  close('hex size is stable', hexA.px, hexB.px, 1e-9);

  // Hex sizing takes no watermark input at all, so no watermark setting can
  // reach it. Assert the resolver's independence directly: a short mark fits
  // at any scale, so its resolved size is the base fraction either way, and
  // the label size is identical across both.
  const wmSmall = wmSize({ metric, text: 'mark', scale: 0.6 });
  const wmLarge = wmSize({ metric, text: 'mark', scale: 1.8 });
  close('a fitting mark resolves to the base size at any scale',
    wmSmall.px, wmLarge.px, 1e-9);
  const hexAfter = resolveHexSize(fakeMeasure, {
    metric, labels: ['#ABCDEF'], font: 'mono', cell: 400,
  });
  close('hex size unmoved by watermark settings', hexAfter.px, hexA.px, 1e-9);
}

group('multi-line text');
{
  ok('single line stays one', splitLines('© Jane').length === 1);
  ok('newline splits', splitLines('line one\nline two').length === 2);
  ok('CRLF splits too', splitLines('a\r\nb').length === 2);
  ok('empty string yields nothing', splitLines('').length === 0);
  ok('null-ish yields nothing', splitLines(undefined).length === 0);

  // Leading and trailing blanks are stray keystrokes; interior blanks are
  // deliberate spacing and must survive.
  const trimmed = splitLines('\n\nfirst\nsecond\n\n');
  ok('outer blank lines dropped', trimmed.length === 2, JSON.stringify(trimmed));
  const interior = splitLines('first\n\nthird');
  ok('interior blank kept', interior.length === 3, JSON.stringify(interior));
  ok('interior blank is empty', interior[1] === '');

  ok('lines are trimmed', splitLines('  padded  ')[0] === 'padded');
}
{
  // The clamp cares about the WIDEST LINE, not the total string length. A
  // four-line watermark is narrow even when it is long, and measuring the raw
  // string would shrink the whole composition for no reason.
  // Sized so the one-line form overflows the budget below and the stacked
  // form does not — otherwise neither clamps and the comparison proves nothing.
  const wide = 'X'.repeat(80);
  const stacked = Array.from({ length: 4 }, () => 'X'.repeat(20)).join('\n');

  ok('block width is the widest line',
    measureBlock(fakeMeasure, stacked, 20, 'sans') === fakeMeasure('X'.repeat(20), 20, 'sans'));
  ok('stacked text measures narrower than the same characters in one line',
    measureBlock(fakeMeasure, stacked, 20, 'sans') < measureBlock(fakeMeasure, wide, 20, 'sans'));

  const cropW = 600;
  const metric = metricOf(600, 600);
  const oneLine = wmSize({ cropW, metric, text: wide });
  const fourLines = wmSize({ cropW, metric, text: stacked });
  ok('breaking a long watermark into lines relieves the clamp',
    fourLines.px > oneLine.px, `${fourLines.px.toFixed(2)} vs ${oneLine.px.toFixed(2)}`);
}

// ----------------------------------------------------------------- layout ---
group('layout');
{
  const opts = {
    frameOn: true, borderPct: 0.035, radiusPct: 0.02,
    paletteOn: true, showHex: true, swatchCount: 5, swatchPct: 0.085,
  };
  const cropW = 1600, cropH = 1200;
  const metric = metricOf(cropW, cropH);
  const hexPx = metric * TEXT.hexSizePct;
  const L = computeLayout({ cropW, cropH, opts, hexPx });

  close('canvas width = crop + two borders', L.width, cropW + 2 * L.border, 1e-9);
  ok('canvas is taller than crop + borders', L.height > cropH + 2 * L.border);
  close('outer radius = inner + border', L.outerRadius, L.radius + L.border, 1e-9);
  ok('image sits at the border inset', L.imgX === L.border && L.imgY === L.border);

  ok('palette sits below the image', L.swatchCY - L.swatchDia / 2 >= L.imgY + L.imgH - 0.001);
  ok('hex labels below the swatches', L.hexCY > L.swatchCY);
  ok('hex labels inside the canvas', L.hexCY + hexPx / 2 <= L.height + 0.001);
}
{
  // metric must come from the CROP, so toggling the frame cannot resize text.
  const base = { cropW: 1600, cropH: 1200, hexPx: 40 };
  const bare = {
    borderPct: 0.05, radiusPct: 0.02,
    paletteOn: false, showHex: false, swatchCount: 5, swatchPct: 0.085,
  };
  const on = computeLayout({ ...base, opts: { ...bare, frameOn: true } });
  const off = computeLayout({ ...base, opts: { ...bare, frameOn: false } });

  close('metric unaffected by frame', on.metric, off.metric, 1e-9);
  ok('no frame means no border', off.border === 0 && off.outerRadius === 0);
  close('no frame and no palette means canvas equals crop', off.height, 1200, 1e-9);
  ok('no frame and no palette needs no background', off.hasBackground === false);
}
{
  // Radius must never exceed half the shorter side.
  const L = computeLayout({
    cropW: 400, cropH: 200,
    opts: { frameOn: true, borderPct: 0.02, radiusPct: 10,
            paletteOn: false, showHex: false, swatchCount: 3, swatchPct: 0.085 },
    hexPx: 16,
  });
  ok('radius capped at half the short side', L.radius <= 100.001, String(L.radius));
}
{
  // Swatch diameter must collapse as the count rises, or circles collide.
  const metric = metricOf(1000, 1000);
  const five = swatchMetrics(1000, metric, 5, 0.085);
  const twelve = swatchMetrics(1000, metric, 12, 0.085);
  ok('more swatches, smaller circles', twelve.dia < five.dia);
  ok('circles never exceed their column', twelve.dia <= twelve.cell);
}
{
  // A palette strip under a borderless image: the two options are independent.
  const L = computeLayout({
    cropW: 1000, cropH: 1000,
    opts: { frameOn: false, borderPct: 0.05, radiusPct: 0,
            paletteOn: true, showHex: true, swatchCount: 4, swatchPct: 0.085 },
    hexPx: 26,
  });
  ok('strip renders without a frame', L.showPalette && L.showHex);
  ok('canvas grows for the strip', L.height > 1000);
  ok('no border added', L.border === 0);
  close('width still equals the crop', L.width, 1000, 1e-9);
  ok('background needed for the strip', L.hasBackground === true);
}
{
  // Hiding hex codes must reclaim their row, not leave a gap.
  const common = {
    cropW: 1000, cropH: 1000, hexPx: 30,
  };
  const withHex = computeLayout({ ...common, opts: {
    frameOn: true, borderPct: 0.03, radiusPct: 0,
    paletteOn: true, showHex: true, swatchCount: 5, swatchPct: 0.085 } });
  const noHex = computeLayout({ ...common, opts: {
    frameOn: true, borderPct: 0.03, radiusPct: 0,
    paletteOn: true, showHex: false, swatchCount: 5, swatchPct: 0.085 } });
  ok('hiding hex codes shortens the strip', noHex.height < withHex.height,
    `${noHex.height.toFixed(1)} vs ${withHex.height.toFixed(1)}`);
  ok('showHex reflected in layout', withHex.showHex === true && noHex.showHex === false);
}

// ---------------------------------------------------------------- border ---
group('Border');
{
  // 60px on a 4:5 1080 export: photo 960 × 1230, finished 1080 × 1350.
  const b = borderPx(1080, 60);
  ok('px are exact at 1080', b === 60);
  const inner = innerRatio(4 / 5, 60);
  close('inner ratio is 960:1230', inner, 960 / 1230, 1e-12);
  const innerW = 1080 - 2 * b;
  const innerH = Math.round(innerW / inner);
  ok('finished image is 1080 × 1350', innerW + 2 * b === 1080 && innerH + 2 * b === 1350,
    `${innerW + 2 * b} × ${innerH + 2 * b}`);
  ok('border scales with output width', borderPx(2160, 60) === 120);
  close('zero border leaves the ratio alone', innerRatio(4 / 5, 0), 0.8, 1e-12);
  close('impossible border falls back to the ratio', innerRatio(1, 600), 1, 1e-12);
}

// ------------------------------------------------------------------ done ---
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
