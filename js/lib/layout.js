/**
 * layout.js — computes every coordinate in the finished composition.
 *
 * Pure arithmetic, no canvas. Keeping it separate means the geometry can be
 * verified in isolation, and the renderer stays a thin "draw what layout said"
 * routine.
 *
 * THE STACK, top to bottom:
 *
 *   ┌──────────────────────────────┐  ← frame
 *   │  ┌────────────────────────┐  │
 *   │  │                        │  │
 *   │  │      cropped image     │  │  (watermark already burned in)
 *   │  │                        │  │
 *   │  └────────────────────────┘  │
 *   │   ●     ●     ●     ●     ●  │  ← palette swatches
 *   │ #1A1C1F #3D4147 ...          │  ← hex labels
 *   └──────────────────────────────┘
 *
 * Note that `metric` derives from the CROPPED IMAGE only, never the finished
 * canvas. Adding a frame or a palette bar must not change the size of the
 * watermark — that is the whole point of the shared text spec.
 */

import { metricOf } from './text.js';

/**
 * @typedef {object} LayoutOptions
 * @property {boolean} frameOn
 * @property {number} borderPct     frame width, as a fraction of metric
 * @property {number} radiusPct     image corner radius, as a fraction of metric
 * @property {boolean} paletteOn
 * @property {number} swatchCount
 * @property {number} swatchPct     swatch diameter, as a fraction of metric
 */

/** Vertical breathing room under the bar content, as a fraction of metric. */
const BAR_PAD_PCT = 0.05;

/**
 * Compute the swatch column width and diameter.
 *
 * Needed *before* text sizing (the hex-label clamp depends on column width),
 * so it lives in its own function that both phases can call.
 *
 * @param {number} cropW
 * @param {number} metric
 * @param {number} count
 * @param {number} swatchPct
 * @returns {{cell: number, dia: number}}
 */
export function swatchMetrics(cropW, metric, count, swatchPct) {
  const cell = cropW / Math.max(1, count);
  // Past roughly six swatches the column width, not the image size, becomes
  // the binding constraint — without this clamp ten circles collide.
  const dia = Math.min(metric * swatchPct, cell * 0.62);
  return { cell, dia };
}

/**
 * Build the full geometry of the composition.
 *
 * @param {object} args
 * @param {number} args.cropW
 * @param {number} args.cropH
 * @param {LayoutOptions} args.opts
 * @param {number} args.textPx  resolved shared text size
 * @param {number} args.hexPx   resolved hex label size
 * @returns {object} geometry
 */
export function computeLayout({ cropW, cropH, opts, textPx, hexPx }) {
  const metric = metricOf(cropW, cropH);

  const border = opts.frameOn ? metric * opts.borderPct : 0;
  // Past half the shorter side, roundRect starts producing shapes nobody
  // asked for, so cap it there.
  const radius = opts.frameOn
    ? Math.min(metric * opts.radiusPct, Math.min(cropW, cropH) / 2)
    : 0;

  const { cell, dia } = swatchMetrics(cropW, metric, opts.swatchCount, opts.swatchPct);

  // --- Bar contents --------------------------------------------------------
  // The palette strip can sit under a borderless image just as well as under
  // a mounted one.
  const showPalette = opts.paletteOn;

  const labelGap = textPx * 0.45;
  const paletteH = showPalette ? dia + labelGap + hexPx : 0;
  const contentH = paletteH;
  const barExtra = contentH > 0 ? contentH + metric * BAR_PAD_PCT : 0;

  // --- Canvas size ---------------------------------------------------------
  const width = cropW + border * 2;
  const height = cropH + border * 2 + barExtra;

  // The bar region is everything below the image: the frame's bottom edge
  // plus whatever extra height the content needed. Centring the content
  // inside that whole region — rather than inside `barExtra` alone — is what
  // makes it read as one deliberate bottom margin instead of two stacked
  // strips.
  const barTop = border + cropH;
  const barH = height - barTop;
  const topPad = contentH > 0 ? (barH - contentH) / 2 : 0;

  const paletteTop = barTop + topPad;

  return {
    metric,
    border,
    radius,
    /** Concentric rounded rects need the outer radius to exceed the inner one
     *  by exactly the gap between them, or the corners look pinched. */
    outerRadius: radius > 0 ? radius + border : 0,

    width,
    height,

    imgX: border,
    imgY: border,
    imgW: cropW,
    imgH: cropH,

    showPalette,
    /** Whether anything needs a background fill behind it. */
    hasBackground: opts.frameOn || contentH > 0,
    cell,
    swatchDia: dia,
    /** Vertical centre of the swatch circles. */
    swatchCY: paletteTop + dia / 2,
    /** Vertical centre of the hex label row. */
    hexCY: paletteTop + dia + labelGap + hexPx / 2,
  };
}
