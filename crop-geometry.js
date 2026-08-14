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
