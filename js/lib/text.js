/**
 * text.js — the single source of truth for canvas text.
 *
 * THE RULE: the watermark and the caption must render at exactly the same
 * weight and pixel size. That only holds if there is one place that decides
 * those values. Nothing else in the codebase may call `ctx.font =` with a size
 * it computed itself — it asks for `fontStr(px)` instead.
 *
 * The *family* is the one thing that may differ: the watermark is set in its
 * own display face (see WATERMARK_FONT). Because two families of the same
 * pixel size measure differently, the shared size clamp measures each string
 * in the face it will actually be drawn in — see `resolveTextSize`.
 *
 * Sizes are expressed as fractions of `metric` (the geometric mean of the
 * cropped image's dimensions) rather than raw pixels, so a phone snapshot and
 * a 60-megapixel raw file produce visually identical output.
 */

/** Font stacks offered to the user. Keys are stored in app state. */
export const FONT_STACKS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
};

/**
 * The watermark's own face, shipped with the site rather than picked from the
 * system.
 *
 * The URL is pre-encoded: the filename has spaces in it, and an unencoded
 * space in a `url()` inside a font-face source is a parse error rather than a
 * 404 — it fails in a way that looks like the font simply not existing.
 */
export const WATERMARK_FONT = {
  family: 'Bigola Display',
  url: 'assets/fonts/Bigola%20Display%20Regular.otf',
};

/**
 * Whether the display face actually loaded.
 *
 * The file is an asset the repository may not carry, so every path that needs
 * the family asks this rather than assuming. When it is false the watermark
 * quietly uses the composition font instead of rendering in a browser default
 * nobody chose.
 */
let watermarkFontReady = false;

/** @returns {boolean} true once the display face is available to canvas. */
export function isWatermarkFontReady() {
  return watermarkFontReady;
}

/**
 * The font stack the watermark draws with: the display face first, with the
 * composition font behind it as the fallback.
 *
 * @param {string} stackKey key of FONT_STACKS
 * @returns {string}
 */
export function watermarkStack(stackKey = 'sans') {
  const fallback = FONT_STACKS[stackKey] || FONT_STACKS.sans;
  return watermarkFontReady ? `"${WATERMARK_FONT.family}", ${fallback}` : fallback;
}

/** Base text specification. */
export const TEXT = {
  weight: 500,
  /**
   * Text height as a fraction of `metric`.
   * Tuned so that three populated caption slots clear each other on a square
   * crop — the tightest realistic case. Larger values look fine with one slot
   * and collide with three.
   */
  sizePct: 0.032,
  /** Never render text smaller than this, however extreme the clamp. */
  minPx: 9,
};

/**
 * Hex labels are deliberately subordinate to the caption — they are metadata,
 * not content. Expressed as an explicit ratio so the relationship survives
 * future edits rather than drifting into an ad-hoc magic number.
 */
export const HEX_SCALE = 0.8;

/**
 * Fraction of its column a hex label may fill before it is shrunk. At 0.9 the
 * labels technically fit but read as one continuous string; the extra gap is
 * what separates them visually at ten swatches.
 */
export const HEX_COLUMN_FILL = 0.82;

/**
 * Build a canvas font string.
 *
 * @param {number} px
 * @param {string} stackKey key of FONT_STACKS
 * @param {'text'|'watermark'} role which face this string is drawn in
 * @returns {string}
 */
export function fontStr(px, stackKey = 'sans', role = 'text') {
  const family = role === 'watermark'
    ? watermarkStack(stackKey)
    : FONT_STACKS[stackKey] || FONT_STACKS.sans;
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
 * Decide the one text size used by every string in the composition.
 *
 * Runs a single clamp pass across the watermark, all three caption slots and
 * the hex labels. If any one string would overflow, *everything* shrinks by
 * the same factor — which is what keeps them measurably equal instead of
 * merely similar.
 *
 * @param {(text: string, px: number, role?: string) => number} measure
 *        width of `text` when set at `px` in `role`'s face. Backed by
 *        ctx.measureText in the browser; injectable so this function stays
 *        testable.
 * @param {object} opts
 * @param {number} opts.cropW cropped image width in px
 * @param {number} opts.metric geometric mean of the crop
 * @param {(string|{text: string, role: string})[]} opts.strings
 *        watermark + caption strings (falsy entries ignored). An entry may
 *        name the face it is drawn in; a bare string means the body face.
 * @param {string[]} opts.hexStrings hex labels, measured at HEX_SCALE
 * @param {number} opts.cell width of one palette column, for hex label budget
 * @param {number} opts.marginPx horizontal inset the wide strings must respect
 * @returns {{px: number, hexPx: number}}
 */
export function resolveTextSize(measure, opts) {
  const { cropW, metric, strings = [], hexStrings = [], cell = Infinity, marginPx = 0 } = opts;

  const base = metric * TEXT.sizePct;

  // --- The matched size: watermark + all three caption slots ---------------
  // One clamp across all of them, so if any single string is too long they
  // all shrink together and stay measurably equal.
  //
  // Each is measured in its OWN face. The watermark's display face is wider
  // per character than the body stack, so measuring it as body text would
  // under-report its width and let it run off the edge at the size the clamp
  // picked.
  const live = strings
    .map((entry) => (typeof entry === 'string' ? { text: entry, role: 'text' } : entry))
    .filter((entry) => entry && entry.text);
  const widest = live.length
    ? Math.max(...live.map((entry) => measure(entry.text, base, entry.role)))
    : 0;
  const budget = Math.max(1, cropW - 2 * marginPx);
  const ideal = widest > budget ? base * (budget / widest) : base;
  const px = Math.max(TEXT.minPx, ideal);

  // --- Hex labels: subordinate, and clamped SEPARATELY ---------------------
  // They start at a fixed ratio of the matched size, but a wide palette makes
  // each column narrow, and folding that into the clamp above would mean
  // adding a tenth swatch silently shrank the caption. Hex labels are
  // metadata; they give way on their own.
  const liveHex = hexStrings.filter(Boolean);
  let hexPx = px * HEX_SCALE;
  if (liveHex.length) {
    const widestHex = Math.max(...liveHex.map((t) => measure(t, hexPx)));
    const hexBudget = Math.max(1, cell * HEX_COLUMN_FILL);
    if (widestHex > hexBudget) hexPx *= hexBudget / widestHex;
  }

  return {
    px,
    hexPx: Math.max(TEXT.minPx * HEX_SCALE, hexPx),
    /**
     * True when the legibility floor stopped us shrinking far enough to fit —
     * i.e. the text will run past its budget. The floor wins (unreadable text
     * helps nobody) but the UI should say so rather than render off-canvas
     * text with no explanation.
     */
    overflow: ideal < TEXT.minPx,
  };
}

/**
 * Ask the browser to load every weight/family we might draw with, then wait.
 *
 * `measureText` fails *silently* against an unloaded webfont — it falls back
 * to a system face and returns widths for the wrong glyphs, so the clamp above
 * gets tuned to metrics that never appear on screen. Always await this before
 * the first render.
 *
 * @returns {Promise<void>}
 */
export async function ensureFontsReady() {
  if (typeof document === 'undefined' || !document.fonts) return;
  await loadWatermarkFont();
  const probes = Object.keys(FONT_STACKS).map((key) =>
    document.fonts.load(fontStr(100, key)).catch(() => {}),
  );
  await Promise.all(probes);
  await document.fonts.ready;
}

/**
 * Fetch the watermark's display face and register it for canvas use.
 *
 * Loaded through the FontFace API rather than a CSS `@font-face` rule for one
 * reason: a missing or corrupt file rejects here, so the app can *know* the
 * face is absent and say so. A CSS rule fails silently, and the watermark
 * would quietly render in a fallback face with no explanation.
 *
 * The weight is declared as a range so the single Regular face answers for
 * whatever weight TEXT asks for. Declaring it as 400 alone would leave the
 * browser free to synthesise a fake 500 — a smeared, uneven version of a face
 * chosen precisely for its shapes.
 *
 * @returns {Promise<boolean>} whether the face is available
 */
export async function loadWatermarkFont() {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') {
    return false;
  }
  if (watermarkFontReady) return true;

  try {
    const face = new FontFace(
      WATERMARK_FONT.family,
      `url("${WATERMARK_FONT.url}")`,
      { weight: '100 900', style: 'normal', display: 'block' },
    );
    await face.load();
    document.fonts.add(face);
    watermarkFontReady = true;
  } catch {
    // The asset is not in the build. Not an error the user can act on mid-
    // session, and the fallback is legible, so the app carries on and the
    // watermark panel is left to explain the substitution.
    watermarkFontReady = false;
  }
  return watermarkFontReady;
}
