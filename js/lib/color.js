/**
 * color.js — small colour helpers.
 *
 * Everything here is pure (no DOM), so it is unit-testable in Node.
 * Colours are passed around as `[r, g, b]` arrays of 0–255 integers.
 */

/** Clamp a number into the 0–255 integer range. */
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Convert an [r,g,b] triplet to an uppercase `#RRGGBB` string.
 * @param {number[]} rgb
 * @returns {string}
 */
export function rgbToHex([r, g, b]) {
  return (
    '#' +
    [r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  );
}

/**
 * Parse `#RGB` or `#RRGGBB` into an [r,g,b] triplet.
 * Returns null for anything unparseable, so callers can fall back safely.
 * @param {string} hex
 * @returns {number[]|null}
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Perceptual luminance (ITU-R BT.709 coefficients), 0–255.
 * Used to sort the extracted palette so it reads as a gradient rather than
 * an arbitrary bucket order.
 * @param {number[]} rgb
 * @returns {number}
 */
export function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick whichever of two colours is more readable on the given background.
 * Simple luminance split — enough for choosing label colours.
 * @param {number[]} bg
 * @param {string} darkHex
 * @param {string} lightHex
 * @returns {string}
 */
export function readableOn(bg, darkHex = '#111111', lightHex = '#FFFFFF') {
  return luminance(bg) > 140 ? darkHex : lightHex;
}

/**
 * Build an `rgba()` string from a hex colour plus an alpha value.
 * Falls back to the raw input if the hex cannot be parsed.
 * @param {string} hex
 * @param {number} alpha 0–1
 * @returns {string}
 */
export function withAlpha(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
