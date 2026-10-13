/**
 * render.js — draws the finished composition onto a canvas.
 *
 * PIPELINE ORDER (this order is load-bearing):
 *
 *   1. crop      — resample the source region to the output size
 *   2. watermark — burned into the cropped image, so it scales with it
 *   2b. edge     — pad, round and feather the image, add a halation glow
 *   3. frame     — fill, then clip the image to rounded corners
 *   4. palette   — swatch circles + hex labels
 *   5. border    — plain outer border, carved out of the output width
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
import { computeLayout, swatchMetrics, borderPx } from './lib/layout.js';

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

  // The canvas adds the spacing after EVERY glyph, the last one included, so
  // a tracked line carries an invisible trailing gap that textAlign counts as
  // width. Right-aligned, that pulls the visible ink short of the edge the
  // other lines end on; centred, it shifts the line off-centre by half a gap.
  // Push the tracked line back by the gap so its ink lines up.
  const trailing = ctx.textAlign === 'right' || ctx.textAlign === 'end' ? 1
    : ctx.textAlign === 'center' ? 0.5 : 0;
  const xFor = (i) => x + (i === 0 ? firstLineLetterSpacingPx * trailing : 0);

  if (lines.length === 1) {
    armSpacing(0);
    drawText(ctx, lines[0], xFor(0), y, anchor);
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
    ctx.fillText(line, xFor(i), firstBaseline + i * lineStep);
  });
}

/**
 * Rounded rectangle path, with a fallback for browsers without roundRect.
 * @param {CanvasRenderingContext2D} ctx
 */
function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  traceRounded(ctx, x, y, w, h, r);
}

/** Add a rounded rect as a subpath of the current path, without resetting it. */
function traceRounded(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
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
 * Run `draw` with a Gaussian blur of `px` applied to whatever it paints.
 *
 * `ctx.filter` is the direct route but older Safari lacks it. The fallback
 * paints the shape far off-canvas and lets its shadow — which every browser
 * blurs — land back in place. `draw` receives the x offset to trace at.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} px blur radius (standard deviation), in px
 * @param {string} color the colour `draw` paints with; the shadow needs it too
 * @param {(dx: number) => void} draw
 */
function drawBlurred(ctx, px, color, draw) {
  if (px <= 0) {
    draw(0);
    return;
  }
  ctx.save();
  if ('filter' in ctx) {
    ctx.filter = `blur(${px}px)`;
    draw(0);
  } else {
    const off = ctx.canvas.width + ctx.canvas.height + px * 8;
    ctx.shadowColor = color;
    // shadowBlur is twice the standard deviation, unlike filter's blur().
    ctx.shadowBlur = px * 2;
    ctx.shadowOffsetX = off;
    draw(-off);
  }
  ctx.restore();
}

/**
 * Pad the image, round its corners and feather the boundary, then lay a
 * halation glow along that boundary.
 *
 * Runs on the watermarked crop, before layout, so to everything downstream
 * the padded result simply *is* the image: the frame mounts it, the palette
 * strip spans it.
 *
 * @param {HTMLCanvasElement} src watermarked crop
 * @param {number} metric of the bare crop
 * @param {object} edge `opts.edge` (see state.js)
 * @returns {HTMLCanvasElement}
 */
function applyEdge(src, metric, edge) {
  const w = src.width;
  const h = src.height;
  const pad = Math.round(metric * edge.paddingPct);
  const radius = Math.min(metric * edge.radiusPct, Math.min(w, h) / 2);

  const out = document.createElement('canvas');
  out.width = w + pad * 2;
  out.height = h + pad * 2;
  const ctx = out.getContext('2d');

  // Solid fill first, so the feathered fill drawn over the image below has
  // opaque colour behind it rather than a translucent ring outside the image.
  ctx.fillStyle = edge.color;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, pad, pad);

  // Everything outside the rounded image, blurred so it bleeds softly over
  // the image edge. The outer rect overshoots the canvas so the blur never
  // fades the fill at the canvas's own border.
  const blur = metric * edge.blurPct;
  const bleed = Math.ceil(blur * 4) + 2;
  ctx.fillStyle = edge.color;
  drawBlurred(ctx, blur, edge.color, (dx) => {
    ctx.beginPath();
    ctx.rect(-bleed + dx, -bleed, out.width + bleed * 2, out.height + bleed * 2);
    traceRounded(ctx, pad + dx, pad, w, h, radius);
    ctx.fill('evenodd');
  });

  // Halation: a blurred stroke along the edge, screened on so it can only
  // lighten — it glows into the image and out across the fill.
  if (edge.glowOn && edge.glowStrength > 0) {
    const glow = metric * edge.glowBlurPct;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = edge.glowStrength;
    ctx.strokeStyle = edge.glowColor;
    ctx.lineWidth = Math.max(1, glow * 0.6, metric * 0.002);
    drawBlurred(ctx, glow, edge.glowColor, (dx) => {
      roundedPath(ctx, pad + dx, pad, w, h, radius);
      ctx.stroke();
    });
    ctx.restore();
  }

  return out;
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
 * @param {number} [angle] straighten angle in degrees, clockwise. The crop
 *        rect is in the straightened space described in crop-geometry.js.
 * @returns {HTMLCanvasElement}
 */
export function cropToCanvas(image, crop, outputWidth, angle = 0) {
  const cropW = Math.max(1, Math.round(outputWidth));
  const cropH = Math.max(1, Math.round((outputWidth * crop.h) / crop.w));

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (!angle) {
    ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, cropW, cropH);
    return canvas;
  }

  // Map crop space onto the output, then rotate the whole source about its
  // centre. Everything outside the canvas is discarded by the draw, so this
  // costs about the same as the nine-argument form.
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  ctx.scale(cropW / crop.w, cropH / crop.h);
  ctx.translate(-crop.x + iw / 2, -crop.y + ih / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(image, -iw / 2, -ih / 2);
  // The caller draws the watermark on this same context. Left armed, the
  // transform would tilt it and fling it toward the middle of the image.
  ctx.setTransform(1, 0, 0, 1, 0, 0);

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
 * @param {number} args.outputWidth width of the cropped image in the output,
 *        or of the bordered image when the border is on — the border is
 *        carved out of this width, not added to it
 * @param {number[][]} args.palette pre-extracted colours; pass the same array
 *        to preview and export so the two never disagree
 * @returns {{canvas: HTMLCanvasElement, warnings: string[], watermarkPx: number}}
 */
export function renderComposition({ image, crop, opts, outputWidth, palette = [] }) {
  const warnings = [];

  // The border is inset: the crop renders narrower so that crop + border
  // lands on outputWidth exactly (1080 stays 1080 for Instagram).
  const outerPad = opts.border?.on ? borderPx(outputWidth, opts.border.widthPx) : 0;

  // ---- 1. Crop ------------------------------------------------------------
  const imgCanvas = cropToCanvas(image, crop, outputWidth - outerPad * 2, opts.crop.angle);
  const cropW = imgCanvas.width;
  const cropH = imgCanvas.height;
  const metric = metricOf(cropW, cropH);

  // ---- 2. Resolve text sizes ----------------------------------------------
  const swatches = opts.palette.on ? palette.slice(0, opts.palette.count) : [];
  const hexStrings = opts.palette.showHex ? swatches.map(rgbToHex) : [];

  // The edge pads the image, and the palette strip spans the padded width, so
  // the swatch columns have to be sized from that width, not the bare crop's.
  // Same rounding as applyEdge so the two cannot drift by a pixel.
  const edgePad = opts.edge?.on ? Math.round(metric * opts.edge.paddingPct) : 0;
  const imgW = cropW + edgePad * 2;

  const { cell } = swatchMetrics(imgW, metric, opts.palette.count, opts.palette.swatchPct);
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

  // ---- 3b. Edge: padding, rounded corners, feather, halation ---------------
  const imgOut = opts.edge?.on ? applyEdge(imgCanvas, metric, opts.edge) : imgCanvas;

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
  const L = computeLayout({
    cropW: imgOut.width, cropH: imgOut.height, opts: layoutOpts, hexPx, metric,
  });

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
  ctx.drawImage(imgOut, L.imgX, L.imgY);
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

  // ---- 7. Border ----------------------------------------------------------
  if (outerPad > 0) {
    const bordered = document.createElement('canvas');
    bordered.width = out.width + outerPad * 2;
    bordered.height = out.height + outerPad * 2;
    const bctx = bordered.getContext('2d');
    bctx.fillStyle = opts.border.color;
    bctx.fillRect(0, 0, bordered.width, bordered.height);
    bctx.drawImage(out, outerPad, outerPad);
    return { canvas: bordered, warnings, watermarkPx };
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
