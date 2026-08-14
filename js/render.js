/**
 * render.js — draws the finished composition onto a canvas.
 *
 * PIPELINE ORDER (this order is load-bearing):
 *
 *   1. crop      — resample the source region to the output size
 *   2. watermark — burned into the cropped image, so it scales with it
 *   3. frame     — fill, then clip the image to rounded corners
 *   4. palette   — swatch circles + hex labels
 *   5. caption   — the three text slots
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
import { fontStr, resolveTextSize, metricOf } from './lib/text.js';
import { computeLayout, swatchMetrics, captionsCollide } from './lib/layout.js';

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
 * Watermark anchor positions, as fractions of the cropped image plus a margin.
 *
 * Seven slots: the four corners, the two edge centres, and the middle. The
 * centred slots take `align: 'center'`, so the margin only sets their distance
 * from the edge they hug — a centred string is never pushed off-axis by it.
 *
 * Exported for the unit tests: placement is pure arithmetic and worth pinning
 * down exactly rather than eyeballing in a screenshot.
 *
 * @param {string} pos
 * @param {number} w
 * @param {number} h
 * @param {number} margin
 * @returns {{x:number, y:number, align:string, anchor:string}}
 */
export function watermarkAnchor(pos, w, h, margin) {
  switch (pos) {
    case 'tl': return { x: margin, y: margin, align: 'left', anchor: 'top' };
    case 'tc': return { x: w / 2, y: margin, align: 'center', anchor: 'top' };
    case 'tr': return { x: w - margin, y: margin, align: 'right', anchor: 'top' };
    case 'bc': return { x: w / 2, y: h - margin, align: 'center', anchor: 'bottom' };
    case 'br': return { x: w - margin, y: h - margin, align: 'right', anchor: 'bottom' };
    case 'center': return { x: w / 2, y: h / 2, align: 'center', anchor: 'middle' };
    case 'bl':
    default: return { x: margin, y: h - margin, align: 'left', anchor: 'bottom' };
  }
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
 * @returns {{canvas: HTMLCanvasElement, warnings: string[], textPx: number}}
 */
export function renderComposition({ image, crop, opts, outputWidth, palette = [] }) {
  const warnings = [];

  // ---- 1. Crop ------------------------------------------------------------
  const imgCanvas = cropToCanvas(image, crop, outputWidth);
  const cropW = imgCanvas.width;
  const cropH = imgCanvas.height;
  const metric = metricOf(cropW, cropH);

  // ---- 2. Resolve the one text size used by everything ---------------------
  const captionSlots = opts.caption.on
    ? [opts.caption.left, opts.caption.center, opts.caption.right]
    : [];
  const hasCaptionText = captionSlots.some((t) => t && t.trim());

  const swatches = opts.palette.on ? palette.slice(0, opts.palette.count) : [];
  const hexStrings = opts.palette.showHex ? swatches.map(rgbToHex) : [];

  const { cell } = swatchMetrics(cropW, metric, opts.palette.count, opts.palette.swatchPct);
  const margin = metric * opts.watermark.marginPct;

  const mctx = measurer();
  const measure = (text, px, role = 'text') => {
    mctx.font = fontStr(px, opts.font, role);
    return mctx.measureText(text).width;
  };

  const sized = resolveTextSize(measure, {
    cropW,
    metric,
    strings: [
      { text: opts.watermark.on ? opts.watermark.text : '', role: 'watermark' },
      ...captionSlots,
    ],
    hexStrings,
    cell,
    marginPx: margin,
  });
  const textPx = sized.px;
  const hexPx = sized.hexPx;
  if (sized.overflow) {
    warnings.push('Text hit its minimum size and may run past the edge. Shorten it or crop wider.');
  }

  // ---- 3. Watermark, burned into the cropped image -------------------------
  if (opts.watermark.on && opts.watermark.text.trim()) {
    const ictx = imgCanvas.getContext('2d');
    ictx.font = fontStr(textPx, opts.font, 'watermark');
    ictx.fillStyle = opts.watermark.color;
    ictx.globalAlpha = opts.watermark.alpha;

    const a = watermarkAnchor(opts.watermark.position, cropW, cropH, margin);
    ictx.textAlign = a.align;
    drawText(ictx, opts.watermark.text, a.x, a.y, a.anchor);

    ictx.globalAlpha = 1;
  }

  // ---- 4. Layout ----------------------------------------------------------
  const layoutOpts = {
    frameOn: opts.frame.on,
    borderPct: opts.frame.borderPct,
    radiusPct: opts.frame.radiusPct,
    captionOn: opts.caption.on,
    hasCaptionText,
    padLeftPct: opts.caption.padLeftPct,
    padRightPct: opts.caption.padRightPct,
    paletteOn: opts.palette.on && swatches.length > 0,
    swatchCount: Math.max(1, swatches.length || opts.palette.count),
    swatchPct: opts.palette.swatchPct,
  };
  const L = computeLayout({ cropW, cropH, opts: layoutOpts, textPx, hexPx });

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
    ctx.font = fontStr(hexPx, opts.font);
    ctx.fillStyle = opts.caption.color;

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

      if (opts.palette.showHex) {
        ctx.fillStyle = opts.caption.color;
        drawText(ctx, rgbToHex(rgb), cx, L.hexCY, 'middle');
      }
    });
  }

  // ---- 7. Caption row -----------------------------------------------------
  if (L.showCaption) {
    // Same size and weight as the watermark; the family differs by design,
    // the watermark having its own display face.
    ctx.font = fontStr(textPx, opts.font);
    ctx.fillStyle = opts.caption.color;

    const slots = [
      { text: opts.caption.left, align: 'left', x: L.captionLeftX },
      { text: opts.caption.center, align: 'center', x: L.captionCenterX },
      { text: opts.caption.right, align: 'right', x: L.captionRightX },
    ];

    for (const slot of slots) {
      if (!slot.text || !slot.text.trim()) continue;
      ctx.textAlign = slot.align;
      drawText(ctx, slot.text, slot.x, L.captionCY, 'middle');
    }

    const widths = slots.map((s) => (s.text && s.text.trim() ? measure(s.text, textPx) : 0));
    if (captionsCollide(L, widths)) {
      warnings.push('Caption slots are overlapping. Shorten the text or reduce the side spacing.');
    }
  }

  if (opts.frame.transparent && opts.export.format === 'image/jpeg') {
    warnings.push('JPEG cannot store transparency — the frame will export as black. Use PNG.');
  }

  return { canvas: out, warnings, textPx };
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
