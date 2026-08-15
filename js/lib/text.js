/**
 * text.js — the single source of truth for canvas text.
 *
 * There are two independent pieces of text in the composition: the watermark,
 * and the hex labels under the palette swatches. They are sized separately.
 *
 * (An earlier version tied the labels to the watermark at a fixed ratio,
 * because a caption row shared the watermark's size and the labels hung off
 * that. With the caption gone the two have nothing to do with each other, and
 * keeping them coupled would mean nudging the watermark's size silently
 * resized the swatch labels.)
 *
 * Sizes are fractions of `metric` (the geometric mean of the cropped image's
 * dimensions) rather than raw pixels, so a phone snapshot and a 60-megapixel
 * scan produce visually identical output.
 */

/**
 * Font stacks offered to the user. Keys are stored in app state.
 *
 * `display` is the custom face declared with @font-face in styles.css. The
 * fallbacks behind it are not decoration: if the .otf is missing the browser
 * substitutes silently, and a serif fallback keeps the composition looking
 * deliberate rather than dropping to whatever the default sans happens to be.
 */
export const FONT_STACKS = {
  display: '"Bigola Display", "Iowan Old Style", Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
};

/** Family name declared by @font-face, used to detect a failed font load. */
export const DISPLAY_FAMILY = 'Bigola Display';

/** Base text specification. */
export const TEXT = {
  weight: 500,
  /** Watermark height, as a fraction of `metric`. */
  sizePct: 0.032,
  /**
   * Hex label height, as a fraction of `metric`. Smaller than the watermark
   * because the labels are metadata, not a signature.
   */
  hexSizePct: 0.024,
  /** Never render text smaller than this, however extreme the clamp. */
  minPx: 9,
};

/**
 * Fraction of its column a hex label may fill before it is shrunk. At 0.9 the
 * labels technically fit but read as one continuous string; the extra gap is
 * what separates them visually at ten swatches.
 */
export const HEX_COLUMN_FILL = 0.82;

/**
 * Default line spacing, as a multiple of the text size.
 *
 * 1.25 is tighter than body copy wants, because a watermark is two or three
 * short lines rather than a paragraph, and generous leading makes it read as a
 * block of text instead of a mark.
 */
export const DEFAULT_LINE_HEIGHT = 1.25;

/**
 * Build a canvas font string.
 * @param {number} px
 * @param {string} stackKey key of FONT_STACKS
 * @returns {string}
 */
export function fontStr(px, stackKey = 'sans') {
  const family = FONT_STACKS[stackKey] || FONT_STACKS.sans;
  return `${TEXT.weight} ${px}px ${family}`;
}

/**
 * Geometric mean of the crop's dimensions.
 *
 * Width alone is a poor scale reference: a 2000x1000 landscape and a
 * 1000x2000 portrait would get watermarks differing by 2x even though they
 * are the same "size" of image. The geometric mean gives both ~1414.
 *
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function metricOf(w, h) {
  return Math.sqrt(w * h);
}

/**
 * Split a string into drawable lines.
 *
 * `fillText` renders `\n` as nothing at all — it does not wrap, and it does
 * not error. Any multi-line text has to be split and positioned by hand.
 *
 * Blank lines at the start and end are dropped (usually stray keystrokes),
 * but interior blanks are kept, because those are deliberate spacing.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());

  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;

  return lines.slice(start, end);
}

/**
 * Width of the widest line in a block.
 *
 * The size clamp cares about the widest line, not the total character count —
 * a four-line watermark is narrow even when it is long.
 *
 * @param {(text: string, px: number, fontKey: string) => number} measure
 * @param {string} text may contain newlines
 * @param {number} px
 * @param {string} fontKey
 * @returns {number}
 */
export function measureBlock(measure, text, px, fontKey) {
  const lines = splitLines(text);
  if (!lines.length) return 0;
  return Math.max(...lines.map((line) => (line ? measure(line, px, fontKey) : 0)));
}

/**
 * Resolve the watermark's drawn size.
 *
 * Starts from a fraction of `metric`, applies the user's optical `scale`, and
 * shrinks if the widest line would run past the image's width budget.
 *
 * `scale` is folded into the measurement rather than applied afterwards: text
 * width is linear in size, so measuring at `base * scale` gives the true drawn
 * width, and a scaled-up watermark still cannot overflow.
 *
 * @param {(text: string, px: number, fontKey: string) => number} measure
 *        width of `text` set at `px` in `fontKey`. Backed by ctx.measureText
 *        in the browser; injectable so this function stays testable.
 * @param {object} opts
 * @param {number} opts.cropW cropped image width in px
 * @param {number} opts.metric geometric mean of the crop
 * @param {string} opts.text watermark text, may contain newlines
 * @param {string} opts.font font stack key
 * @param {number} opts.scale optical size multiplier, 1 = no adjustment
 * @param {number} opts.marginPx horizontal inset the text must respect
 * @returns {{px: number, overflow: boolean}}
 */
export function resolveWatermarkSize(measure, opts) {
  const { cropW, metric, text = '', font = 'sans', scale = 1, marginPx = 0 } = opts;

  const base = metric * TEXT.sizePct;
  const widest = measureBlock(measure, text, base * scale, font);
  const budget = Math.max(1, cropW - 2 * marginPx);

  const ideal = widest > budget ? base * (budget / widest) : base;
  const px = Math.max(TEXT.minPx, ideal);

  return {
    px,
    /**
     * True when the legibility floor stopped us shrinking far enough to fit —
     * the text will run past its budget. The floor wins (unreadable text helps
     * nobody) but the UI should say so rather than render off-canvas text with
     * no explanation.
     */
    overflow: ideal < TEXT.minPx,
  };
}

/**
 * Resolve the hex labels' drawn size.
 *
 * Independent of the watermark. Clamped against the width of a single palette
 * column, since a wide palette makes each column narrow long before the image
 * width becomes a constraint.
 *
 * @param {(text: string, px: number, fontKey: string) => number} measure
 * @param {object} opts
 * @param {number} opts.metric
 * @param {string[]} opts.labels
 * @param {string} opts.font
 * @param {number} opts.cell width of one palette column
 * @returns {{px: number}}
 */
export function resolveHexSize(measure, opts) {
  const { metric, labels = [], font = 'mono', cell = Infinity } = opts;

  let px = metric * TEXT.hexSizePct;

  const live = labels.filter(Boolean);
  if (live.length && Number.isFinite(cell)) {
    const widest = Math.max(...live.map((t) => measure(t, px, font)));
    const budget = Math.max(1, cell * HEX_COLUMN_FILL);
    if (widest > budget) px *= budget / widest;
  }

  return { px: Math.max(TEXT.minPx * 0.8, px) };
}

/**
 * Ask the browser to load every face we might draw with, then wait.
 *
 * `measureText` fails *silently* against an unloaded face — it falls back to a
 * system face and returns widths for the wrong glyphs, so the clamps above get
 * tuned to metrics that never appear on screen. Always await this before the
 * first render.
 *
 * @returns {Promise<{displayLoaded: boolean}>} whether the custom face loaded
 */
export async function ensureFontsReady() {
  if (typeof document === 'undefined' || !document.fonts) {
    return { displayLoaded: false };
  }

  const probes = Object.keys(FONT_STACKS).map((key) =>
    document.fonts.load(fontStr(100, key)).catch(() => {}),
  );
  await Promise.all(probes);
  await document.fonts.ready;

  // Whether the custom .otf actually arrived. `document.fonts.check` returns
  // true for any family it does not know (it reports "a font will be used"),
  // so ask it specifically about the declared family with no fallbacks — that
  // form answers "is THIS face available".
  let displayLoaded = false;
  try {
    displayLoaded = document.fonts.check(`${TEXT.weight} 100px "${DISPLAY_FAMILY}"`);
  } catch {
    displayLoaded = false;
  }

  return { displayLoaded };
}
