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
      /** Ruler overlay in the crop view. 'off' | 'thirds' | 'golden' | 'center'. */
      guide: 'thirds',
    },

    watermark: {
      on: true,
      /**
       * Which line the watermark's first line comes from. 'day' | 'set' |
       * 'night' select a fixed preset caption; 'custom' uses `customText`
       * instead. See WATERMARK_PRESETS in lib/text.js for the preset copy.
       */
      preset: 'day',
      /** Free text used only when `preset` is 'custom'. May contain newlines. */
      customText: '© your name',
      /** Instagram handle, without the leading '@'. Adds its own line when set. */
      tag: '@yung.pei.frames',
      /** Adds its own line when set. */
      year: '2026',
      color: '#FFFFFF',
      alpha: 1,
      /** Typeface for the watermark. Independent of the hex labels'. */
      font: 'display',
      /**
       * Optical size multiplier. 1 draws the watermark at its base fraction of
       * metric with no adjustment; anything else is a deliberate nudge, which
       * a display face usually needs to sit right against the image.
       */
      scale: 0.6,
      /** Line spacing for multi-line watermarks, as a multiple of text size. */
      lineHeight: 1.25,
      /** Extra gap between letters, as a multiple of text size. 0 is normal tracking. */
      letterSpacing: 0.5,
      /** 3x3 grid: <row><col>, rows t|m|b, columns l|c|r. */
      position: 'bc',
      /** Inset from the image edge, as a fraction of metric. */
      marginPct: 0.05,
    },

    frame: {
      on: false,
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
      on: false,
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
      /** Width of the exported crop in px; height follows its aspect ratio. 0 means "use the original size". */
      maxWidth: 1080,
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
