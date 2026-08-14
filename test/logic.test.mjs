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
  resizeFromHandle,
  resolveRatio,
  frameRatioOf,
  frameBox,
  zoomBounds,
  zoomTo,
  zoomBy,
  zoomFactorOf,
  MAX_ZOOM,
} from '../js/lib/crop-geometry.js';
import {
  resolveTextSize,
  metricOf,
  fontStr,
  watermarkStack,
  isWatermarkFontReady,
  FONT_STACKS,
  WATERMARK_FONT,
  HEX_SCALE,
  HEX_COLUMN_FILL,
  TEXT,
} from '../js/lib/text.js';
import { computeLayout, swatchMetrics, captionsCollide } from '../js/lib/layout.js';
import { watermarkAnchor } from '../js/render.js';

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

/** A crude monospace-ish measurer: every glyph is 0.55em wide. */
const fakeMeasure = (text, px) => text.length * px * 0.55;

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

// ------------------------------------------------- fixed-frame pan & zoom ---
group('crop geometry — pan & zoom');
{
  // The whole point of the mode: zooming out can never expose an edge.
  const iw = 2000, ih = 1000, ratio = 4 / 5;
  const start = largestFit(iw, ih, ratio);
  const out = zoomTo(start, 0.2, iw, ih, ratio); // asked for far past the cap
  close('zoom-out caps at the covering size', out.w, start.w, 1e-9);
  ok('capped rect stays inside the image',
    out.x >= -1e-9 && out.y >= -1e-9 && out.x + out.w <= iw + 1e-9 && out.y + out.h <= ih + 1e-9,
    JSON.stringify(out));
  close('cap is set by the shorter side', out.h, ih, 1e-9);
}
{
  const iw = 1200, ih = 1600, ratio = 1;
  const { minW, maxW } = zoomBounds(iw, ih, ratio);
  close('cap is the largest fitting square', maxW, 1200, 1e-9);
  close('zoom-in limit is MAX_ZOOM deep', minW, 1200 / MAX_ZOOM, 1e-9);

  const deep = zoomTo(largestFit(iw, ih, ratio), 99, iw, ih, ratio);
  close('zoom-in is clamped too', deep.w, minW, 1e-9);
  close('zoom factor reads back', zoomFactorOf(deep, iw, ih, ratio), MAX_ZOOM, 1e-9);
}
{
  // Zooming holds the anchor point still: the source pixel under the top-left
  // corner of the frame must not move when the frame is anchored there.
  const iw = 2000, ih = 2000, ratio = 1;
  const start = { x: 400, y: 400, w: 800, h: 800 };
  const anchor = { x: 0, y: 0 };
  const out = zoomBy(start, 2, iw, ih, ratio, anchor);
  close('anchored corner holds x', out.x, 400, 1e-9);
  close('anchored corner holds y', out.y, 400, 1e-9);
  close('zooming in halves the window', out.w, 400, 1e-9);
}
{
  // Centre anchoring is the slider's behaviour.
  const iw = 2000, ih = 2000, ratio = 1;
  const start = { x: 500, y: 500, w: 1000, h: 1000 };
  const out = zoomBy(start, 2, iw, ih, ratio);
  close('centre held on x', out.x + out.w / 2, 1000, 1e-9);
  close('centre held on y', out.y + out.h / 2, 1000, 1e-9);
}
{
  // Anchoring near an edge would push the rect out; the clamp has to win, and
  // it must not distort the shape while doing so.
  const iw = 1000, ih = 1000, ratio = 1;
  const out = zoomTo({ x: 0, y: 0, w: 200, h: 200 }, 1, iw, ih, ratio, { x: 0, y: 0 });
  ok('clamped back inside after anchoring at the edge',
    out.x >= -1e-9 && out.x + out.w <= iw + 1e-9, JSON.stringify(out));
  close('shape survives the clamp', out.w / out.h, 1, 1e-9);
}
{
  ok('locked ratio wins', frameRatioOf({ x: 0, y: 0, w: 300, h: 100 }, 4 / 5) === 4 / 5);
  close('free frame freezes the crop shape', frameRatioOf({ x: 0, y: 0, w: 300, h: 100 }, null), 3, 1e-9);
  ok('free frame with no crop is square', frameRatioOf(null, null) === 1);
}
{
  const f = frameBox(1000, 600, 4 / 5, 40);
  close('frame fits the padded height', f.h, 520, 1e-9);
  close('frame keeps its ratio', f.w / f.h, 4 / 5, 1e-9);
  close('frame is centred horizontally', f.x + f.w / 2, 500, 1e-9);
  close('frame is centred vertically', f.y + f.h / 2, 300, 1e-9);

  const wide = frameBox(400, 1000, 2, 0);
  close('width-bound frame uses the full width', wide.w, 400, 1e-9);
  close('and its ratio holds', wide.h, 200, 1e-9);
}

// ------------------------------------------------------------------- text ---
group('text sizing');
{
  const cropW = 2000;
  const cropH = 1600;
  const metric = metricOf(cropW, cropH);
  close('metric is the geometric mean', metric, Math.sqrt(2000 * 1600));
  // Orientation independence: the whole reason we use a geometric mean.
  close('metric is orientation-agnostic', metricOf(2000, 1000), metricOf(1000, 2000));

  const { px, hexPx } = resolveTextSize(fakeMeasure, {
    cropW,
    metric,
    strings: ['© Jane', 'Left', 'Middle', 'Right'],
    hexStrings: ['#FFFFFF'],
    cell: cropW / 5,
    marginPx: metric * 0.03,
  });
  close('unconstrained size is the base fraction', px, metric * TEXT.sizePct, 1e-9);
  close('hex label tracks the ratio', hexPx, px * HEX_SCALE, 1e-9);
}
{
  // One very long string must shrink *everything*, not just itself.
  const cropW = 800;
  const metric = metricOf(800, 800);
  const margin = metric * 0.03;
  const long = 'x'.repeat(200);

  const withLong = resolveTextSize(fakeMeasure, {
    cropW, metric, strings: ['short', long], hexStrings: [], cell: 800, marginPx: margin,
  });
  const withoutLong = resolveTextSize(fakeMeasure, {
    cropW, metric, strings: ['short'], hexStrings: [], cell: 800, marginPx: margin,
  });
  ok('long string forces a shrink', withLong.px < withoutLong.px);
  close('hex ratio holds after shrink', withLong.hexPx / withLong.px, HEX_SCALE, 1e-9);

  // Contract: either the text fits its budget, or it hit the legibility floor
  // and said so. Silently overflowing is the one outcome we forbid.
  const fits = fakeMeasure(long, withLong.px) <= cropW - 2 * margin + 0.001;
  ok('fits budget or reports overflow', fits || withLong.overflow === true);
  ok('overflow flagged at the floor', withLong.px === TEXT.minPx && withLong.overflow);

  const roomy = resolveTextSize(fakeMeasure, {
    cropW: 4000, metric: metricOf(4000, 4000), strings: ['© Jane Doe'],
    hexStrings: [], cell: 4000, marginPx: 100,
  });
  ok('no false overflow when there is room', roomy.overflow === false);
}
{
  // The watermark is drawn in its own display face, which is wider per
  // character than the body stack. The clamp has to measure it in that face or
  // it will pick a size the watermark cannot fit into.
  const cropW = 900;
  const metric = metricOf(900, 900);
  // A measurer where the watermark face is twice as wide as the body face.
  const byRole = (text, px, role) => text.length * px * (role === 'watermark' ? 1.1 : 0.55);

  const seen = [];
  const spy = (text, px, role) => { seen.push(role); return byRole(text, px, role); };
  resolveTextSize(spy, {
    cropW, metric, strings: [{ text: '© Jane', role: 'watermark' }, 'Left'],
    hexStrings: [], cell: cropW, marginPx: 0,
  });
  ok('the watermark is measured as a watermark', seen.includes('watermark'), seen.join(','));
  ok('caption slots are measured as body text', seen.includes('text'), seen.join(','));

  // Same string, same length: the wider face must be the one that forces the
  // shrink, so tagging it changes the result.
  const long = 'x'.repeat(60);
  const asWatermark = resolveTextSize(byRole, {
    cropW, metric, strings: [{ text: long, role: 'watermark' }], hexStrings: [], cell: cropW, marginPx: 0,
  });
  const asBody = resolveTextSize(byRole, {
    cropW, metric, strings: [long], hexStrings: [], cell: cropW, marginPx: 0,
  });
  ok('the wider face shrinks further', asWatermark.px < asBody.px,
    `${asWatermark.px} vs ${asBody.px}`);
  ok('the watermark still fits its budget',
    byRole(long, asWatermark.px, 'watermark') <= cropW + 0.001,
    String(byRole(long, asWatermark.px, 'watermark')));

  // Bare strings must keep working — most callers never name a face.
  const plain = resolveTextSize(fakeMeasure, {
    cropW, metric, strings: ['© Jane', 'Left'], hexStrings: [], cell: cropW, marginPx: 0,
  });
  close('bare strings still resolve', plain.px, metric * TEXT.sizePct, 1e-9);
}
{
  // fontStr is the only place a font string is built, and the watermark's is
  // the only one that may name a different family.
  const body = fontStr(40, 'serif');
  const mark = fontStr(40, 'serif', 'watermark');
  ok('body text uses the picked stack', body.includes('Georgia'), body);
  ok('the two share weight and size',
    body.startsWith(`${TEXT.weight} 40px`) && mark.startsWith(`${TEXT.weight} 40px`),
    `${body} / ${mark}`);
  // Outside a browser the face can never have loaded, so the stack must be the
  // fallback — proving the watermark degrades to the picked font rather than
  // naming a family that is not there.
  ok('missing face falls back to the picked stack', mark === body, mark);
  ok('the face is reported as unloaded', isWatermarkFontReady() === false);
  ok('the watermark stack is the fallback', watermarkStack('mono') === FONT_STACKS.mono);
  ok('the font file path is declared', /Bigola/.test(WATERMARK_FONT.url), WATERMARK_FONT.url);
  ok('the font url is percent-encoded', !/ /.test(WATERMARK_FONT.url), WATERMARK_FONT.url);
}
{
  // Ten swatches make each column narrow. The hex labels must give way — but
  // the caption/watermark size must NOT, or adding a swatch would silently
  // resize the user's caption.
  const cropW = 900;
  const metric = metricOf(900, 900);
  const hexes = Array.from({ length: 10 }, () => '#AABBCC');
  const many = resolveTextSize(fakeMeasure, {
    cropW, metric, strings: ['hi'], hexStrings: hexes, cell: cropW / 10, marginPx: 0,
  });
  const few = resolveTextSize(fakeMeasure, {
    cropW, metric, strings: ['hi'], hexStrings: ['#AABBCC'], cell: cropW / 2, marginPx: 0,
  });
  close('palette count cannot resize the caption', many.px, few.px, 1e-9);
  ok('narrow columns shrink only the hex labels', many.hexPx < few.hexPx,
    `${many.hexPx} vs ${few.hexPx}`);
  ok('hex label fits its column',
    fakeMeasure('#AABBCC', many.hexPx) <= (cropW / 10) * HEX_COLUMN_FILL + 0.001);
  ok('hex never exceeds its ratio of the matched size', many.hexPx <= many.px * HEX_SCALE + 1e-9);
}
{
  const tiny = resolveTextSize(fakeMeasure, {
    cropW: 10, metric: 10, strings: ['y'.repeat(500)], hexStrings: [], cell: 10, marginPx: 4,
  });
  ok('never goes below the floor', tiny.px >= TEXT.minPx);
}

// ------------------------------------------------------ watermark placing ---
group('watermark placement');
{
  const w = 1000, h = 800, margin = 40;
  const at = (pos) => watermarkAnchor(pos, w, h, margin);

  // The four corners: inset from both edges, and anchored so the text grows
  // inward rather than off the picture.
  ok('tl hugs the top left',
    at('tl').x === 40 && at('tl').y === 40 && at('tl').align === 'left' && at('tl').anchor === 'top');
  ok('tr hugs the top right',
    at('tr').x === 960 && at('tr').y === 40 && at('tr').align === 'right' && at('tr').anchor === 'top');
  ok('bl hugs the bottom left',
    at('bl').x === 40 && at('bl').y === 760 && at('bl').align === 'left' && at('bl').anchor === 'bottom');
  ok('br hugs the bottom right',
    at('br').x === 960 && at('br').y === 760 && at('br').align === 'right' && at('br').anchor === 'bottom');

  // The two edge centres: horizontally centred, vertically inset by the margin.
  const tc = at('tc');
  ok('tc sits on the horizontal centre line', tc.x === 500 && tc.align === 'center', JSON.stringify(tc));
  ok('tc is inset from the top by the margin', tc.y === 40 && tc.anchor === 'top', JSON.stringify(tc));
  const bc = at('bc');
  ok('bc sits on the horizontal centre line', bc.x === 500 && bc.align === 'center', JSON.stringify(bc));
  ok('bc is inset from the bottom by the margin', bc.y === 760 && bc.anchor === 'bottom', JSON.stringify(bc));

  // The centred slots share the corners' vertical inset, so switching between
  // "bottom left" and "bottom centre" slides the text sideways only.
  ok('tc shares the top row with the top corners', tc.y === at('tl').y && tc.y === at('tr').y);
  ok('bc shares the bottom row with the bottom corners', bc.y === at('bl').y && bc.y === at('br').y);

  // The middle ignores the margin entirely — it is centred on both axes.
  const mid = at('center');
  ok('centre is centred on both axes',
    mid.x === 500 && mid.y === 400 && mid.anchor === 'middle', JSON.stringify(mid));

  // An unknown key must land somewhere sensible rather than at NaN.
  const fallback = at('nonsense');
  ok('an unknown position falls back to bottom left',
    fallback.x === 40 && fallback.y === 760, JSON.stringify(fallback));
}

// ----------------------------------------------------------------- layout ---
group('layout');
{
  const opts = {
    frameOn: true, borderPct: 0.035, radiusPct: 0.02,
    captionOn: true, hasCaptionText: true, padLeftPct: 0.02, padRightPct: 0.02,
    paletteOn: true, swatchCount: 5, swatchPct: 0.085,
  };
  const cropW = 1600, cropH = 1200;
  const metric = metricOf(cropW, cropH);
  const textPx = metric * 0.042;
  const L = computeLayout({ cropW, cropH, opts, textPx, hexPx: textPx * HEX_SCALE });

  close('canvas width = crop + two borders', L.width, cropW + 2 * L.border, 1e-9);
  ok('canvas is taller than crop + borders', L.height > cropH + 2 * L.border);
  close('outer radius = inner + border', L.outerRadius, L.radius + L.border, 1e-9);
  ok('image sits at the border inset', L.imgX === L.border && L.imgY === L.border);

  // Palette row must sit below the image and above the caption.
  ok('palette below image', L.swatchCY - L.swatchDia / 2 >= L.imgY + L.imgH - 0.001);
  ok('hex labels below swatches', L.hexCY > L.swatchCY);
  ok('caption below hex labels', L.captionCY > L.hexCY);
  ok('caption inside canvas', L.captionCY + textPx / 2 <= L.height + 0.001);

  // Caption anchors.
  close('left anchor respects padding', L.captionLeftX, L.border + metric * 0.02, 1e-9);
  close('centre anchor is the midline', L.captionCenterX, L.width / 2, 1e-9);
  close('right anchor mirrors left', L.width - L.captionRightX, L.border + metric * 0.02, 1e-9);
}
{
  // metric must come from the CROP, so toggling the frame cannot resize text.
  const base = { cropW: 1600, cropH: 1200, textPx: 50, hexPx: 40 };
  const on = computeLayout({ ...base, opts: {
    frameOn: true, borderPct: 0.05, radiusPct: 0.02, captionOn: false, hasCaptionText: false,
    padLeftPct: 0, padRightPct: 0, paletteOn: false, swatchCount: 5, swatchPct: 0.085 } });
  const off = computeLayout({ ...base, opts: {
    frameOn: false, borderPct: 0.05, radiusPct: 0.02, captionOn: false, hasCaptionText: false,
    padLeftPct: 0, padRightPct: 0, paletteOn: false, swatchCount: 5, swatchPct: 0.085 } });
  close('metric unaffected by frame', on.metric, off.metric, 1e-9);
  ok('no frame means no border', off.border === 0 && off.outerRadius === 0);
  close('no frame and no bar means canvas equals crop', off.height, 1200, 1e-9);
  ok('no frame and no bar needs no background', off.hasBackground === false);
}
{
  // Radius must never exceed half the shorter side.
  const L = computeLayout({
    cropW: 400, cropH: 200,
    opts: { frameOn: true, borderPct: 0.02, radiusPct: 10, captionOn: false, hasCaptionText: false,
            padLeftPct: 0, padRightPct: 0, paletteOn: false, swatchCount: 3, swatchPct: 0.085 },
    textPx: 20, hexPx: 16,
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
  const opts = {
    frameOn: true, borderPct: 0.03, radiusPct: 0.02,
    captionOn: true, hasCaptionText: true, padLeftPct: 0.02, padRightPct: 0.02,
    paletteOn: false, swatchCount: 5, swatchPct: 0.085,
  };
  const L = computeLayout({ cropW: 1000, cropH: 1000, opts, textPx: 40, hexPx: 32 });
  ok('overlong slots collide', captionsCollide(L, [600, 300, 600]));
  ok('short slots do not', !captionsCollide(L, [80, 60, 80]));
}
{
  // A caption bar under a borderless image: the two options are independent.
  const L = computeLayout({
    cropW: 1000, cropH: 1000,
    opts: { frameOn: false, borderPct: 0.05, radiusPct: 0,
            captionOn: true, hasCaptionText: true, padLeftPct: 0.02, padRightPct: 0.02,
            paletteOn: true, swatchCount: 4, swatchPct: 0.085 },
    textPx: 32, hexPx: 26,
  });
  ok('bar renders without a frame', L.showCaption && L.showPalette);
  ok('canvas grows for the bar', L.height > 1000);
  ok('no border added', L.border === 0);
  close('width still equals the crop', L.width, 1000, 1e-9);
  ok('background needed for the bar', L.hasBackground === true);
  ok('caption anchored to the canvas edge', Math.abs(L.captionLeftX - 1000 * 0.02) < 1e-9);
}

// ------------------------------------------------------------------ done ---
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
