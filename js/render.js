/**
 * render.js — draws the finished composition onto a canvas.
 *
 * PIPELINE ORDER (this order is load-bearing):
 *
 *   1. crop      — resample the source region to the output size
 *   2. watermark — burned into the cropped image, so it scales with it
 *   3. frame     — fill, then clip the image to rounded corners
 *   4. palette   — swatch circles + hex labels
 *
 * The watermark goes on before the frame so that turning the frame on cannot
 * change the watermark's size. Every measurement derives from `metric`, the
 * geometric mean of the *cropped image*, never of the finished canvas.
 *
 * The same function renders the on-screen preview and the exported file — the
 * only difference is `outputWidth`. Because every dimension is a fraction of
 * metric, a 900px preview is an exact proportional twin of a 4000px export.
 */

import { rgbToHex, hexToRgb, luminance } from './lib/color.js';
import {
  fontStr, resolveWatermarkSize, resolveHexSize, metricOf, splitLines,
  composeWatermarkText, DEFAULT_LINE_HEIGHT,
} from './lib/text.js';
import { computeLayout, swatchMetrics } from './lib/layout.js';

/** Scratch context used only for text measurement during layout. */
let scratchCtx = null;
function measurer() {
  if (!scratchCtx) {
    scratchCtx = document.createElement('canvas').getContext('2d');
  }
  return scratchCtx;
}

/**
 * Draw text positioned by its *visible* glyph bounds rather than the font's
 * em box.
 *
 * `textBaseline = 'middle'` centres the em box, which includes space reserved
 * for descenders whether or not the string has any — so "HEX" floats visibly
 * high and "gjpq" sits low. Measuring the actual bounding box and offsetting
 * the alphabetic baseline puts the ink where the eye expects it.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {'top'|'middle'|'bottom'} anchor which edge of the glyphs sits at y
 */
function drawText(ctx, text, x, y, anchor) {
  const m = ctx.measureText(text);
  const ascent = m.actualBoundingBoxAscent || 0;
  const descent = m.actualBoundingBoxDescent || 0;

  let baseline = y;
  if (anchor === 'middle') baseline = y + (ascent - descent) / 2;
  else if (anchor === 'bottom') baseline = y - descent;
  else if (anchor === 'top') baseline = y + ascent;

  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, baseline);
}

/**
 * Draw a block of one or more lines, anchored as a whole.
 *
 * `fillText` has no concept of a newline, so each line is positioned by hand.
 * The block is anchored by its outer ink edges — the top of the first line's
 * glyphs, or the bottom of the last line's — rather than by baselines, so a
 * two-line watermark sits exactly where a one-line one did instead of
 * creeping toward the edge as lines are added.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string[]} lines
 * @param {number} x
 * @param {number} y
 * @param {'top'|'middle'|'bottom'} anchor
 * @param {number} lineStep vertical distance between baselines, in px
 * @param {number} [firstLineLetterSpacingPx] tracking applied to line 0 only —
 *        the preset/custom caption line, not the tag or year lines under it
 */
function drawTextBlock(ctx, lines, x, y, anchor, lineStep, firstLineLetterSpacingPx = 0) {
  if (!lines.length) return;

  // `letterSpacing` is a context property, not a fillText argument, so it has
  // to be re-armed before every measurement or draw that should use it.
  const armSpacing = (i) => { ctx.letterSpacing = `${i === 0 ? firstLineLetterSpacingPx : 0}px`; };

  if (lines.length === 1) {
    armSpacing(0);
    drawText(ctx, lines[0], x, y, anchor);
    return;
  }

  ctx.textBaseline = 'alphabetic';

  // Ink extents of the outer lines. Interior lines are spaced by lineStep and
  // never affect where the block as a whole sits.
  armSpacing(0);
  const firstAscent = ctx.measureText(lines[0] || 'X').actualBoundingBoxAscent || 0;
  armSpacing(lines.length - 1);
  const lastMetrics = ctx.measureText(lines[lines.length - 1] || 'X');
  const lastDescent = lastMetrics.actualBoundingBoxDescent || 0;

  const span = (lines.length - 1) * lineStep;
  const blockHeight = firstAscent + span + lastDescent;

  let firstBaseline;
  if (anchor === 'top') firstBaseline = y + firstAscent;
  else if (anchor === 'bottom') firstBaseline = y - lastDescent - span;
  else firstBaseline = y - blockHeight / 2 + firstAscent;

  lines.forEach((line, i) => {
    if (!line) return; // interior blank line: consumes space, draws nothing
    armSpacing(i);
    ctx.fillText(line, x, firstBaseline + i * lineStep);
  });
}

/**
 * Rounded rectangle path, with a fallback for browsers without roundRect.
 * @param {CanvasRenderingContext2D} ctx
 */
function roundedPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Cut the cropped region out of the source image at the requested size.
 *
 * The nine-argument drawImage does the crop and the resample in one step, so
 * there is never an intermediate full-size copy in memory.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} image
 * @param {{x:number,y:number,w:number,h:number}} crop in source pixels
 * @param {number} outputWidth
 * @returns {HTMLCanvasElement}
 */
export function cropToCanvas(image, crop, outputWidth) {
  const cropW = Math.max(1, Math.round(outputWidth));
  const cropH = Math.max(1, Math.round((outputWidth * crop.h) / crop.w));

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, cropW, cropH);

  return canvas;
}

/**
 * Resolve a watermark position id into a draw anchor.
 *
 * Positions are a 3x3 grid encoded as `<row><col>`, rows `t|m|b` and columns
 * `l|c|r` — so `tc` is top-centre, `br` bottom-right, `mc` dead centre.
 * Deriving x/y/alignment from the two characters means all nine cases share
 * one code path instead of a nine-arm switch.
 *
 * @param {string} pos
 * @param {number} w cropped image width
 * @param {number} h cropped image height
 * @param {number} margin inset from the edge
 * @returns {{x: number, y: number, align: string, anchor: string}}
 */
function watermarkAnchor(pos, w, h, margin) {
  // 'center' was the id used before the grid grew to nine cells; map it so
  // settings saved by an older build still resolve.
  const id = pos === 'center' ? 'mc' : (pos || 'br');
  const row = id[0];
  const col = id[1];

  const x = col === 'l' ? margin : col === 'r' ? w - margin : w / 2;
  const y = row === 't' ? margin : row === 'b' ? h - margin : h / 2;
  const align = col === 'l' ? 'left' : col === 'r' ? 'right' : 'center';
  const anchor = row === 't' ? 'top' : row === 'b' ? 'bottom' : 'middle';

  return { x, y, align, anchor };
}

/**
 * Render the whole composition.
 *
 * @param {object} args
 * @param {HTMLImageElement} args.image source image
 * @param {object} args.crop crop rect in source pixels
 * @param {object} args.opts full options object (see state.js)
 * @param {number} args.outputWidth width of the cropped image in the output
 * @param {number[][]} args.palette pre-extracted colours; pass the same array
 *        to preview and export so the two never disagree
 * @returns {{canvas: HTMLCanvasElement, warnings: string[], watermarkPx: number}}
 */
export function renderComposition({ image, crop, opts, outputWidth, palette = [] }) {
  const warnings = [];

  // ---- 1. Crop ------------------------------------------------------------
  const imgCanvas = cropToCanvas(image, crop, outputWidth);
  const cropW = imgCanvas.width;
  const cropH = imgCanvas.height;
  const metric = metricOf(cropW, cropH);

  // ---- 2. Resolve text sizes ----------------------------------------------
  const swatches = opts.palette.on ? palette.slice(0, opts.palette.count) : [];
  const hexStrings = opts.palette.showHex ? swatches.map(rgbToHex) : [];

  const { cell } = swatchMetrics(cropW, metric, opts.palette.count, opts.palette.swatchPct);
  const margin = metric * opts.watermark.marginPct;

  const mctx = measurer();
  const measure = (text, px, fontKey) => {
    mctx.font = fontStr(px, fontKey);
    return mctx.measureText(text).width;
  };

  // Preset + custom text + tag + year, each their own line — see lib/text.js.
  const watermarkText = opts.watermark.on ? composeWatermarkText(opts.watermark) : '';

  // Letter spacing applies to the caption line only (not the tag/year lines
  // under it), and widens it by (chars - 1) gaps — the size clamp needs to
  // measure that too, or a widely tracked watermark could overflow. Kept as a
  // separate wrapper rather than baked into `measure` because the hex labels
  // below share `measure` and must NOT be tracked the same way.
  const firstLine = splitLines(watermarkText)[0] || '';
  const letterSpacingEm = opts.watermark.letterSpacing || 0;
  const measureWatermark = (text, px, fontKey) => {
    const width = measure(text, px, fontKey);
    if (text !== firstLine || text.length <= 1) return width;
    return width + letterSpacingEm * px * (text.length - 1);
  };

  // The watermark and the hex labels are sized independently — see text.js.
  const wm = resolveWatermarkSize(measureWatermark, {
    cropW,
    metric,
    text: watermarkText,
    font: opts.watermark.font,
    scale: opts.watermark.scale,
    marginPx: margin,
  });
  const hex = resolveHexSize(measure, {
    metric,
    labels: hexStrings,
    font: opts.palette.font,
    cell,
  });

  const watermarkPx = wm.px;
  const hexPx = hex.px;
  if (wm.overflow) {
    warnings.push('The watermark hit its minimum size and may run past the edge. Shorten it or crop wider.');
  }

  // ---- 3. Watermark, burned into the cropped image -------------------------
  if (opts.watermark.on && splitLines(watermarkText).length) {
    const ictx = imgCanvas.getContext('2d');
    // `scale` is 1 by default: the watermark is drawn at its base fraction of
    // metric with no adjustment. It exists because two faces at the same pixel
    // size do not LOOK the same size — cap-heights differ — so swapping to a
    // display face usually needs a nudge to sit right against the image.
    const wmPx = watermarkPx * (opts.watermark.scale ?? 1);
    ictx.font = fontStr(wmPx, opts.watermark.font);
    ictx.fillStyle = opts.watermark.color;
    ictx.globalAlpha = opts.watermark.alpha;

    const a = watermarkAnchor(opts.watermark.position, cropW, cropH, margin);
    ictx.textAlign = a.align;

    const lines = splitLines(watermarkText);
    const lineStep = wmPx * (opts.watermark.lineHeight ?? DEFAULT_LINE_HEIGHT);
    // A native context property (Chrome/Firefox 2023+, Safari 17.4+) rather
    // than hand-spacing each glyph: it also feeds ctx.measureText, so the
    // block's ink-bounds anchoring stays accurate with tracking applied.
    // drawTextBlock arms it for line 0 only — the caption, not tag/year.
    drawTextBlock(ictx, lines, a.x, a.y, a.anchor, lineStep, letterSpacingEm * wmPx);

    ictx.globalAlpha = 1;
  }

  // ---- 4. Layout ----------------------------------------------------------
  const layoutOpts = {
    frameOn: opts.frame.on,
    borderPct: opts.frame.borderPct,
    radiusPct: opts.frame.radiusPct,
    paletteOn: opts.palette.on && swatches.length > 0,
    showHex: opts.palette.showHex,
    swatchCount: Math.max(1, swatches.length || opts.palette.count),
    swatchPct: opts.palette.swatchPct,
  };
  const L = computeLayout({ cropW, cropH, opts: layoutOpts, hexPx });

  // ---- 5. Compose ---------------------------------------------------------
  const out = document.createElement('canvas');
  out.width = Math.round(L.width);
  out.height = Math.round(L.height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // The background fills the frame AND the bar below, so it is drawn whenever
  // either exists — not only when the frame is switched on.
  if (L.hasBackground && !opts.frame.transparent) {
    ctx.fillStyle = opts.frame.color;
    roundedPath(ctx, 0, 0, L.width, L.height, L.outerRadius);
    ctx.fill();
  }

  // Clip to the inner rounded rect and drop the image in.
  ctx.save();
  roundedPath(ctx, L.imgX, L.imgY, L.imgW, L.imgH, L.radius);
  ctx.clip();
  ctx.drawImage(imgCanvas, L.imgX, L.imgY);
  ctx.restore();

  // ---- 6. Palette row -----------------------------------------------------
  if (L.showPalette) {
    // Pick a ring that contrasts with whatever sits behind the swatches.
    const bgRgb = opts.frame.transparent ? null : hexToRgb(opts.frame.color);
    const ringColor = bgRgb && luminance(bgRgb) < 128
      ? 'rgba(255,255,255,0.28)'
      : 'rgba(0,0,0,0.18)';

    ctx.textAlign = 'center';
    ctx.font = fontStr(hexPx, opts.palette.font);

    swatches.forEach((rgb, i) => {
      const cx = L.border + L.cell * (i + 0.5);

      ctx.beginPath();
      ctx.arc(cx, L.swatchCY, L.swatchDia / 2, 0, Math.PI * 2);
      ctx.fillStyle = rgbToHex(rgb);
      ctx.fill();

      // Hairline ring. Without it a near-white swatch on a white background is
      // an invisible circle with a hex code floating underneath. The ring has
      // to invert on a dark background or it has the same problem there.
      ctx.lineWidth = Math.max(1, L.swatchDia * 0.012);
      ctx.strokeStyle = ringColor;
      ctx.stroke();

      if (L.showHex) {
        ctx.fillStyle = opts.palette.hexColor;
        drawText(ctx, rgbToHex(rgb), cx, L.hexCY, 'middle');
      }
    });
  }

  if (opts.frame.transparent && opts.export.format === 'image/jpeg') {
    warnings.push('JPEG cannot store transparency — the frame will export as black. Use PNG.');
  }

  return { canvas: out, warnings, watermarkPx };
}

/**
 * Turn a canvas into a Blob.
 * @param {HTMLCanvasElement} canvas
 * @param {string} type mime type
 * @param {number} quality 0–1, ignored for PNG
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      type,
      quality,
    );
  });
}
