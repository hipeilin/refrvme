/**
 * crop-geometry.js — pure geometry for the crop rectangle.
 *
 * COORDINATE SPACE: every rectangle here is in *source image pixels*
 * (i.e. relative to img.naturalWidth / naturalHeight). Display coordinates
 * are converted at the edges of the UI layer only. Mixing the two is the
 * classic way these editors break on window resize, so it is worth being
 * strict about it.
 *
 * A rect is `{ x, y, w, h }` with the origin at the image's top-left.
 */

/** Smallest crop we allow, in source pixels. */
export const MIN_CROP = 24;

/** The four corner handles, each paired with the corner it pivots around. */
export const HANDLES = ['nw', 'ne', 'sw', 'se'];

/**
 * Largest rectangle of a given aspect ratio that fits inside the image,
 * centred. Used when the user picks a new ratio preset from scratch.
 *
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio width / height
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function largestFit(imgW, imgH, ratio) {
  let w = imgW;
  let h = w / ratio;
  if (h > imgH) {
    h = imgH;
    w = h * ratio;
  }
  return { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h };
}

/**
 * Re-fit an existing rect to a new aspect ratio, preserving its centre and
 * staying inside the image. Keeps the crop roughly where the user put it
 * when they flip between, say, 4:5 and 9:16.
 *
 * @param {object} rect
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio
 * @returns {object} new rect
 */
export function refitToRatio(rect, imgW, imgH, ratio) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  // Start from the current area so the crop doesn't jump in size.
  const area = rect.w * rect.h;
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;

  // Shrink to fit the image if the new shape doesn't have room.
  const scale = Math.min(1, imgW / w, imgH / h);
  w *= scale;
  h *= scale;

  return clampToBounds({ x: cx - w / 2, y: cy - h / 2, w, h }, imgW, imgH);
}

/**
 * Push a rect back inside the image without changing its size (unless it is
 * larger than the image, in which case it is scaled down proportionally).
 *
 * @param {object} rect
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object}
 */
export function clampToBounds(rect, imgW, imgH) {
  let { x, y, w, h } = rect;

  if (w > imgW || h > imgH) {
    const scale = Math.min(imgW / w, imgH / h);
    w *= scale;
    h *= scale;
  }

  x = Math.max(0, Math.min(x, imgW - w));
  y = Math.max(0, Math.min(y, imgH - h));

  return { x, y, w, h };
}

/**
 * Translate a rect, keeping it inside the image.
 *
 * @param {object} rect
 * @param {number} dx
 * @param {number} dy
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object}
 */
export function moveRect(rect, dx, dy, imgW, imgH) {
  return {
    ...rect,
    x: Math.max(0, Math.min(rect.x + dx, imgW - rect.w)),
    y: Math.max(0, Math.min(rect.y + dy, imgH - rect.h)),
  };
}

/**
 * Resize a rect by dragging one of its corners.
 *
 * The opposite corner acts as a fixed anchor, so the rect can never flip
 * through itself. When `ratio` is non-null the shape is locked: whichever
 * axis the pointer pushed further wins, and the other is derived from it.
 *
 * The bounds clamp has to *re-derive* the partner dimension, otherwise
 * dragging into an image edge silently breaks the aspect ratio — the single
 * most common bug in hand-rolled croppers.
 *
 * @param {object} rect current rect
 * @param {string} handle one of HANDLES
 * @param {number} px pointer x, in source pixels
 * @param {number} py pointer y, in source pixels
 * @param {number|null} ratio locked aspect ratio, or null for free
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object} new rect
 */
export function resizeFromHandle(rect, handle, px, py, ratio, imgW, imgH) {
  // Direction each axis grows in, and the anchored corner it grows away from.
  const dirX = handle.includes('e') ? 1 : -1;
  const dirY = handle.includes('s') ? 1 : -1;
  const anchorX = dirX > 0 ? rect.x : rect.x + rect.w;
  const anchorY = dirY > 0 ? rect.y : rect.y + rect.h;

  // How much room exists between the anchor and the image edge.
  const roomW = dirX > 0 ? imgW - anchorX : anchorX;
  const roomH = dirY > 0 ? imgH - anchorY : anchorY;

  let w = Math.max(MIN_CROP, (px - anchorX) * dirX);
  let h = Math.max(MIN_CROP, (py - anchorY) * dirY);

  if (ratio) {
    // Two candidate shapes — one driven by the horizontal drag, one by the
    // vertical. Take the larger; it tracks the pointer more naturally than
    // always letting width win.
    const fromW = { w, h: w / ratio };
    const fromH = { w: h * ratio, h };
    const pick = fromW.w * fromW.h >= fromH.w * fromH.h ? fromW : fromH;
    w = pick.w;
    h = pick.h;

    // Clamp to the image, re-deriving the partner axis each time.
    if (w > roomW) {
      w = roomW;
      h = w / ratio;
    }
    if (h > roomH) {
      h = roomH;
      w = h * ratio;
    }
  } else {
    w = Math.min(w, roomW);
    h = Math.min(h, roomH);
  }

  return {
    x: dirX > 0 ? anchorX : anchorX - w,
    y: dirY > 0 ? anchorY : anchorY - h,
    w,
    h,
  };
}

/* ── Fixed-frame mode (pan & zoom) ─────────────────────────────────────────

   The "Reposition & zoom" tick-box inverts the interaction: the frame stays
   put and the image travels underneath it. The stored state does not change —
   the crop rect is still the only source of truth — so a rect produced by a
   pan is indistinguishable from one produced by a corner drag. Only the
   gesture differs: dragging the image right subtracts from crop.x, and zooming
   in shrinks the rect about the anchor point.

   Zoom 1 is defined as *the largest rect of the frame's shape that fits inside
   the image*, not as the image at its natural size. That definition is what
   makes whitespace impossible: the rect can never grow past the image, so the
   frame is always fully covered, and zooming out simply stops when the shorter
   side of the image runs out.                                                */

/** How far past the zoom-out cap the user may zoom in. */
export const MAX_ZOOM = 8;

/**
 * The frame's aspect ratio: the locked ratio when there is one, otherwise the
 * crop's own shape frozen as it stands.
 *
 * A free crop still needs a fixed frame to pan against — without this, "free"
 * would leave the frame shapeless and there would be nothing to pan relative
 * to.
 *
 * @param {object|null} crop
 * @param {number|null} ratio
 * @returns {number} width / height
 */
export function frameRatioOf(crop, ratio) {
  if (ratio) return ratio;
  if (crop && crop.w > 0 && crop.h > 0) return crop.w / crop.h;
  return 1;
}

/**
 * Smallest and largest crop widths allowed in fixed-frame mode.
 *
 * `maxW` is the zoom-out cap — the point where the image exactly covers the
 * frame on its shorter side. `minW` is the zoom-in limit.
 *
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio frame ratio (never null)
 * @returns {{minW: number, maxW: number}}
 */
export function zoomBounds(imgW, imgH, ratio) {
  const maxW = largestFit(imgW, imgH, ratio).w;
  return { maxW, minW: Math.min(maxW, Math.max(MIN_CROP, maxW / MAX_ZOOM)) };
}

/**
 * How far the image is currently zoomed in, where 1 means "zoomed out as far
 * as the image allows".
 *
 * @param {object} crop
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio frame ratio
 * @returns {number}
 */
export function zoomFactorOf(crop, imgW, imgH, ratio) {
  const { maxW } = zoomBounds(imgW, imgH, ratio);
  return crop.w > 0 ? maxW / crop.w : 1;
}

/**
 * Set an absolute zoom level, holding one point of the frame still.
 *
 * `anchor` is expressed in frame-relative units — {x: 0.5, y: 0.5} is the
 * centre, {x: 0, y: 0} the top-left corner. Passing the pointer's position is
 * what makes wheel zoom feel like it is pulling the image toward the cursor
 * rather than toward the middle.
 *
 * The result is clamped back inside the image, so no amount of zooming or
 * anchoring can expose an edge.
 *
 * @param {object} crop
 * @param {number} zoom target factor; clamped to [1, MAX_ZOOM]
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio frame ratio
 * @param {{x: number, y: number}} [anchor]
 * @returns {object} new rect
 */
export function zoomTo(crop, zoom, imgW, imgH, ratio, anchor = { x: 0.5, y: 0.5 }) {
  const { minW, maxW } = zoomBounds(imgW, imgH, ratio);

  // Clamping the *width* rather than the factor keeps the two limits in one
  // place; a factor below 1 would otherwise quietly produce a rect larger than
  // the image and reintroduce the whitespace this mode exists to prevent.
  const w = Math.min(maxW, Math.max(minW, maxW / Math.max(zoom, 1e-6)));
  const h = w / ratio;

  // The source pixel currently under the anchor, held fixed across the change.
  const px = crop.x + anchor.x * crop.w;
  const py = crop.y + anchor.y * crop.h;

  return clampToBounds({ x: px - anchor.x * w, y: py - anchor.y * h, w, h }, imgW, imgH);
}

/**
 * Multiply the current zoom, holding an anchor point still.
 *
 * @param {object} crop
 * @param {number} factor >1 zooms in, <1 zooms out
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} ratio frame ratio
 * @param {{x: number, y: number}} [anchor]
 * @returns {object} new rect
 */
export function zoomBy(crop, factor, imgW, imgH, ratio, anchor) {
  return zoomTo(crop, zoomFactorOf(crop, imgW, imgH, ratio) * factor, imgW, imgH, ratio, anchor);
}

/**
 * Where the fixed frame sits inside the crop viewport, in CSS pixels relative
 * to the viewport's top-left.
 *
 * The padding is what leaves room for the dimmed overflow: without it the
 * frame would fill the stage and the parts of the image being cropped away
 * would have nowhere to show.
 *
 * @param {number} viewW
 * @param {number} viewH
 * @param {number} ratio frame ratio
 * @param {number} pad breathing room on each side
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function frameBox(viewW, viewH, ratio, pad = 0) {
  const availW = Math.max(1, viewW - pad * 2);
  const availH = Math.max(1, viewH - pad * 2);
  const fit = largestFit(availW, availH, ratio);
  return { x: (viewW - fit.w) / 2, y: (viewH - fit.h) / 2, w: fit.w, h: fit.h };
}

/**
 * Aspect ratio presets. Stored as a single width/height number; vertical
 * orientation is just the reciprocal, so each preset covers both modes.
 *
 * Platform specs change — check the current guidelines before relying on
 * these for a real posting workflow.
 */
export const RATIO_PRESETS = [
  { id: 'free', label: 'Free', note: 'Unlocked', value: null },
  { id: 'square', label: '1:1', note: 'Square post', value: 1 },
  { id: 'portrait45', label: '4:5', note: 'Instagram portrait', value: 4 / 5 },
  { id: 'rednote', label: '3:4', note: 'RedNote / Xiaohongshu', value: 3 / 4 },
  { id: 'story', label: '9:16', note: 'Stories & Reels', value: 9 / 16 },
  { id: 'landscape', label: '1.91:1', note: 'Link preview', value: 1.91 },
  { id: 'classic', label: '3:2', note: 'Classic 35mm', value: 3 / 2 },
];

/**
 * Resolve a preset id plus orientation into a usable ratio number.
 *
 * Orientation is applied absolutely rather than as an inversion: "portrait"
 * always means the taller of the two shapes, whichever way round the preset
 * happens to be written. Blindly inverting would turn portrait 4:5 into
 * landscape when the user asked for portrait.
 *
 * @param {string} id
 * @param {'portrait'|'landscape'} orientation
 * @returns {number|null} width/height, or null for free crop
 */
export function resolveRatio(id, orientation) {
  const preset = RATIO_PRESETS.find((p) => p.id === id);
  if (!preset || preset.value === null) return null;
  const v = preset.value;
  const tall = Math.min(v, 1 / v);
  const wide = Math.max(v, 1 / v);
  return orientation === 'portrait' ? tall : wide;
}

/**
 * Human-readable form of a resolved ratio, e.g. "4:5".
 * @param {string} id
 * @param {'portrait'|'landscape'} orientation
 * @returns {string}
 */
export function ratioLabel(id, orientation) {
  const preset = RATIO_PRESETS.find((p) => p.id === id);
  if (!preset || preset.value === null) return 'Free';
  const [a, b] = preset.label.split(':');
  const tall = Number(a) < Number(b);
  const wantTall = orientation === 'portrait';
  return tall === wantTall ? preset.label : `${b}:${a}`;
}
