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
 * @param {number} [angle] straighten angle in degrees — see "Straighten" below
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function largestFit(imgW, imgH, ratio, angle = 0) {
  if (angle) {
    const { L1, L2 } = limits(imgW, imgH);
    const { m1, m2 } = reach(ratio, 1, trig(angle));
    const h = Math.min(L1 / m1, L2 / m2);
    const w = h * ratio;
    return { x: (imgW - w) / 2, y: (imgH - h) / 2, w, h };
  }
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
 * @param {number} [angle] straighten angle in degrees
 * @returns {object} new rect
 */
export function refitToRatio(rect, imgW, imgH, ratio, angle = 0) {
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

  return clampToBounds({ x: cx - w / 2, y: cy - h / 2, w, h }, imgW, imgH, angle);
}

/**
 * Push a rect back inside the image without changing its size (unless it is
 * larger than the image, in which case it is scaled down proportionally).
 *
 * @param {object} rect
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} [angle] straighten angle in degrees
 * @returns {object}
 */
export function clampToBounds(rect, imgW, imgH, angle = 0) {
  if (angle) return clampRotated(rect, imgW, imgH, angle);
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
 * @param {number} [angle] straighten angle in degrees
 * @returns {object}
 */
export function moveRect(rect, dx, dy, imgW, imgH, angle = 0) {
  if (angle) return clampRotated({ ...rect, x: rect.x + dx, y: rect.y + dy }, imgW, imgH, angle);
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
 * @param {number} [angle] straighten angle in degrees
 * @returns {object} new rect
 */
export function resizeFromHandle(rect, handle, px, py, ratio, imgW, imgH, angle = 0) {
  if (angle) return resizeRotated(rect, handle, px, py, ratio, imgW, imgH, angle);
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

/* ══ Straighten ════════════════════════════════════════════════════════════
 *
 * Straightening rotates the SOURCE by `angle` degrees (clockwise, about its
 * centre) behind a crop rect that stays axis-aligned. The crop still lives in
 * source-sized pixel space with the same centre — only now it must keep all
 * four corners inside the rotated image, or the export shows empty corners.
 *
 * Let u be the crop centre's offset from the image centre, and (c, s) the
 * angle's cosine and sine. Rotating u back into the image's own axes gives
 *
 *   q1 =  c·ux + s·uy        q2 = -s·ux + c·uy
 *
 * and the crop's farthest corner reaches m1 = (|c|w + |s|h)/2 along the first
 * axis and m2 = (|s|w + |c|h)/2 along the second. The crop fits exactly when
 *
 *   |q1| + m1 ≤ imgW/2   and   |q2| + m2 ≤ imgH/2
 *
 * Every constraint is linear in position and size, so each operation below
 * has a closed form — no iterating towards the edge.
 */

/**
 * Inset from the rotated edge, in source px. Resampling a corner that sits
 * exactly on the edge blends in a sliver of transparency.
 */
const EDGE_EPS = 1;

function trig(angle) {
  const t = (angle * Math.PI) / 180;
  return { c: Math.cos(t), s: Math.sin(t) };
}

function limits(imgW, imgH) {
  return { L1: imgW / 2 - EDGE_EPS, L2: imgH / 2 - EDGE_EPS };
}

/** How far a w×h rect's corners reach along each of the image's axes. */
function reach(w, h, { c, s }) {
  const ac = Math.abs(c);
  const as = Math.abs(s);
  return { m1: (ac * w + as * h) / 2, m2: (as * w + ac * h) / 2 };
}

/** Rotated counterpart of clampToBounds: shrink only if the size cannot fit
 *  anywhere, then slide the centre to the nearest place it does. */
function clampRotated(rect, imgW, imgH, angle) {
  const t = trig(angle);
  const { L1, L2 } = limits(imgW, imgH);

  let { w, h } = rect;
  let { m1, m2 } = reach(w, h, t);
  const k = Math.min(1, L1 / m1, L2 / m2);
  w *= k; h *= k; m1 *= k; m2 *= k;

  const ux = rect.x + rect.w / 2 - imgW / 2;
  const uy = rect.y + rect.h / 2 - imgH / 2;
  const r1 = Math.max(0, L1 - m1);
  const r2 = Math.max(0, L2 - m2);
  // Clamping each coordinate in the image's own (orthonormal) axes is the
  // nearest valid centre, so a drag into an edge slides along it.
  const q1 = Math.max(-r1, Math.min(r1, t.c * ux + t.s * uy));
  const q2 = Math.max(-r2, Math.min(r2, -t.s * ux + t.c * uy));

  const cx = imgW / 2 + t.c * q1 - t.s * q2;
  const cy = imgH / 2 + t.s * q1 + t.c * q2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * The fit test for a rect grown from a fixed corner, as linear constraints
 * `cw·w + ch·h ≤ rhs`. All coefficients are non-negative, so growing either
 * side can only ever use up room.
 */
function anchoredConstraints(anchorX, anchorY, dirX, dirY, imgW, imgH, angle) {
  const { c, s } = trig(angle);
  const { L1, L2 } = limits(imgW, imgH);
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const ax = anchorX - imgW / 2;
  const ay = anchorY - imgH / 2;
  const q1 = c * ax + s * ay;
  const q2 = -s * ax + c * ay;

  const out = [];
  for (const sign of [1, -1]) {
    out.push({
      cw: (sign * c * dirX + ac) / 2,
      ch: (sign * s * dirY + as) / 2,
      rhs: L1 - sign * q1,
    });
    out.push({
      cw: (-sign * s * dirX + as) / 2,
      ch: (sign * c * dirY + ac) / 2,
      rhs: L2 - sign * q2,
    });
  }
  return out;
}

function resizeRotated(rect, handle, px, py, ratio, imgW, imgH, angle) {
  const dirX = handle.includes('e') ? 1 : -1;
  const dirY = handle.includes('s') ? 1 : -1;
  const anchorX = dirX > 0 ? rect.x : rect.x + rect.w;
  const anchorY = dirY > 0 ? rect.y : rect.y + rect.h;
  const cons = anchoredConstraints(anchorX, anchorY, dirX, dirY, imgW, imgH, angle);

  let w = Math.max(MIN_CROP, (px - anchorX) * dirX);
  let h = Math.max(MIN_CROP, (py - anchorY) * dirY);

  if (ratio) {
    const fromW = { w, h: w / ratio };
    const fromH = { w: h * ratio, h };
    const pick = fromW.w * fromW.h >= fromH.w * fromH.h ? fromW : fromH;
    w = pick.w;
    h = pick.h;

    // Largest scale of this shape that still fits — the locked-ratio clamp
    // re-derives both sides together, never one alone.
    let k = 1;
    for (const { cw, ch, rhs } of cons) {
      const need = cw * w + ch * h;
      if (need > 0) k = Math.min(k, rhs / need);
    }
    w *= k;
    h *= k;
  } else {
    // Width first, then height, so dragging into one edge still lets the
    // other axis follow the pointer — the same feel as the unrotated clamp.
    const maxW = (hh) => Math.min(...cons.filter((k) => k.cw > 0).map((k) => (k.rhs - k.ch * hh) / k.cw));
    const maxH = (ww) => Math.min(...cons.filter((k) => k.ch > 0).map((k) => (k.rhs - k.cw * ww) / k.ch));
    w = Math.min(w, maxW(h));
    if (w < MIN_CROP) w = MIN_CROP;
    h = Math.min(h, maxH(w));
  }

  // Only reachable when the anchor itself sits on the edge; holding still
  // beats returning a rect that pokes outside the image.
  if (w < MIN_CROP - 1e-6 || h < MIN_CROP - 1e-6) return { ...rect };

  return {
    x: dirX > 0 ? anchorX : anchorX - w,
    y: dirY > 0 ? anchorY : anchorY - h,
    w,
    h,
  };
}

/**
 * Whether every corner of `rect` lies inside the image rotated by `angle`.
 * Exposed for tests.
 */
export function fitsRotated(rect, imgW, imgH, angle, tol = 1e-6) {
  const t = trig(angle);
  const { m1, m2 } = reach(rect.w, rect.h, t);
  const ux = rect.x + rect.w / 2 - imgW / 2;
  const uy = rect.y + rect.h / 2 - imgH / 2;
  return Math.abs(t.c * ux + t.s * uy) + m1 <= imgW / 2 + tol
    && Math.abs(-t.s * ux + t.c * uy) + m2 <= imgH / 2 + tol;
}
