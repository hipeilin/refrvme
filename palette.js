/**
 * palette.js — dominant colour extraction via median cut.
 *
 * Median cut is used rather than naive frequency counting because photographs
 * are full of near-identical neighbouring shades; counting most-common pixels
 * on a landscape returns eight variations of the same sky. Median cut splits
 * the colour *volume* instead, so distinct regions each get representation.
 *
 * `extractPalette` is pure: it takes a plain {data, width, height} object
 * (the same shape as ImageData) so it can be exercised in Node without a
 * canvas.
 */

import { luminance } from './color.js';

/** Pixels sampled before quantising. More than this buys accuracy we can't see. */
const SAMPLE_BUDGET = 100_000;

/**
 * Find the widest channel of a bucket and the size of that spread.
 * @param {number[][]} bucket array of [r,g,b]
 * @returns {{channel: number, spread: number}}
 */
function widestChannel(bucket) {
  let channel = 0;
  let spread = -1;
  for (let c = 0; c < 3; c++) {
    let lo = 255;
    let hi = 0;
    for (const px of bucket) {
      if (px[c] < lo) lo = px[c];
      if (px[c] > hi) hi = px[c];
    }
    if (hi - lo > spread) {
      spread = hi - lo;
      channel = c;
    }
  }
  return { channel, spread };
}

/** Mean colour of a bucket, rounded to integers. */
function averageColor(bucket) {
  const total = bucket.reduce(
    (acc, px) => [acc[0] + px[0], acc[1] + px[1], acc[2] + px[2]],
    [0, 0, 0],
  );
  return total.map((v) => Math.round(v / bucket.length));
}

/**
 * Reduce an image to its `count` most representative colours.
 *
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} imageData
 * @param {number} count how many colours to return (1–16 is sensible)
 * @returns {number[][]} array of [r,g,b], sorted dark → light
 */
export function extractPalette(imageData, count) {
  const n = Math.max(1, Math.floor(count));
  const { data, width, height } = imageData;

  // Stride the pixel array so we look at roughly SAMPLE_BUDGET pixels
  // regardless of how large the source is. Keeps a 50MP file as fast as a
  // thumbnail.
  const totalPixels = width * height;
  const stride = Math.max(1, Math.floor(totalPixels / SAMPLE_BUDGET));

  const pixels = [];
  for (let i = 0; i < totalPixels; i += stride) {
    const o = i * 4;
    if (data[o + 3] < 128) continue; // skip transparent pixels
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }
  if (pixels.length === 0) return [];

  // Repeatedly split the bucket with the largest colour spread, halving it at
  // the median of its widest channel.
  let buckets = [pixels];
  while (buckets.length < n) {
    let targetIndex = -1;
    let targetSpread = -1;

    buckets.forEach((bucket, i) => {
      if (bucket.length < 2) return;
      const { spread } = widestChannel(bucket);
      if (spread > targetSpread) {
        targetSpread = spread;
        targetIndex = i;
      }
    });

    // Every remaining bucket is a single pixel (or uniform) — nothing left to
    // split, so the image genuinely has fewer distinct colours than requested.
    if (targetIndex < 0 || targetSpread <= 0) break;

    const bucket = buckets[targetIndex];
    const { channel } = widestChannel(bucket);
    bucket.sort((a, b) => a[channel] - b[channel]);
    const mid = bucket.length >> 1;
    buckets.splice(targetIndex, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  return buckets
    .filter((b) => b.length > 0)
    .map(averageColor)
    .sort((a, b) => luminance(a) - luminance(b));
}

/**
 * Read pixels off a canvas and extract its palette.
 * Downsamples first — reading 50 megapixels through getImageData is slow and
 * the extra precision is invisible at swatch size.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} count
 * @returns {number[][]}
 */
export function extractPaletteFromCanvas(canvas, count) {
  const area = canvas.width * canvas.height;
  const ratio = Math.min(1, Math.sqrt(SAMPLE_BUDGET / Math.max(1, area)));

  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * ratio));
  small.height = Math.max(1, Math.round(canvas.height * ratio));

  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, small.width, small.height);

  return extractPalette(ctx.getImageData(0, 0, small.width, small.height), count);
}
