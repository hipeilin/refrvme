/**
 * state.js — one plain object holding every user-adjustable value, plus a
 * minimal subscribe/notify store.
 *
 * All sizing values are stored as *fractions of metric*, never pixels. That is
 * what lets a single settings object produce identical-looking results from a
 * 900px phone photo and a 8000px scan. The UI sliders convert to and from
 * percentages for display only.
 */

/** Default settings. Also the shape used by the reset button. */
export function defaultOptions() {
  return {
    crop: {
      ratioId: 'portrait45',
      orientation: 'portrait', // 'portrait' | 'landscape'
    },

    watermark: {
      on: true,
      /** May contain newlines; each line is drawn separately. */
      text: '© your name',
      color: '#FFFFFF',
      alpha: 0.55,
      /** Typeface for the watermark. Independent of the hex labels'. */
      font: 'display',
      /**
       * Optical size multiplier. 1 draws the watermark at its base fraction of
       * metric with no adjustment; anything else is a deliberate nudge, which
       * a display face usually needs to sit right against the image.
       */
      scale: 1,
      /** Line spacing for multi-line watermarks, as a multiple of text size. */
      lineHeight: 1.25,
      /** 3x3 grid: <row><col>, rows t|m|b, columns l|c|r. */
      position: 'br',
      /** Inset from the image edge, as a fraction of metric. */
      marginPct: 0.03,
    },

    frame: {
      on: true,
      /** Frame width, as a fraction of metric. */
      borderPct: 0.035,
      /**
       * Image corner radius, as a fraction of metric. Square by default: a
       * mounted print has sharp corners, and rounding is a deliberate choice
       * rather than a house style.
       */
      radiusPct: 0,
      color: '#FFFFFF',
      transparent: false,
    },

    palette: {
      on: true,
      count: 5,
      showHex: true,
      /**
       * Typeface and colour for the hex labels. Mono by default — they are
       * codes, and a monospace face keeps the columns visually even.
       */
      font: 'mono',
      hexColor: '#111111',
      /** Swatch diameter, as a fraction of metric. */
      swatchPct: 0.075,
    },

    export: {
      format: 'image/png',
      quality: 0.92,
      /** Longest edge of the exported crop; 0 means "use the original size". */
      maxWidth: 0,
    },
  };
}

/**
 * Create a tiny observable store.
 *
 * Deliberately not reactive-per-key: every change triggers one render, which
 * is debounced to an animation frame by the caller. Simpler to reason about
 * than fine-grained invalidation, and a full render is a few milliseconds.
 *
 * @param {object} initial
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    /**
     * Apply a mutation and notify subscribers.
     * @param {(draft: object) => void} mutator
     */
    update(mutator) {
      mutator(state);
      listeners.forEach((fn) => fn(state));
    },

    /** Replace the whole state (used by "Reset all"). */
    replace(next) {
      state = next;
      listeners.forEach((fn) => fn(state));
    },

    /**
     * @param {(state: object) => void} fn
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Session-level data that isn't a user setting (image, crop rect, palette). */
export function defaultSession() {
  return {
    /** @type {HTMLImageElement|null} */
    image: null,
    fileName: '',
    /** Crop rect in SOURCE IMAGE PIXELS. See crop-geometry.js. */
    crop: null,
    /** Extracted colours, cached until the crop or count changes. */
    palette: [],
    /** Cache key for the above. */
    paletteKey: '',
  };
}
