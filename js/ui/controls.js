/**
 * ui/controls.js — binds the control rail to the options object.
 *
 * Every input in index.html carries `data-bind="section.key"`. Rather than
 * writing a listener per control (three dozen near-identical blocks that drift
 * out of sync), one generic binder walks those attributes. Adding a new slider
 * becomes a markup change with no JavaScript at all.
 *
 * Value formatting for the little readouts is driven by `data-format`.
 */

import { RATIO_PRESETS, ratioLabel } from '../lib/crop-geometry.js';
import { rgbToHex } from '../lib/color.js';
import { splitLines, composeWatermarkText } from '../lib/text.js';

/** Read `obj.a.b` from a dotted path. */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Write `obj.a.b = value` from a dotted path. */
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

/**
 * Show or hide controls that only apply in certain configurations.
 *
 * Quality does nothing for PNG; the custom text field is meaningless unless
 * the "Custom" preset is picked; line spacing does nothing until the
 * watermark has a second line. Leaving them visible invites the user to drag
 * a slider and see no change.
 *
 * @param {HTMLElement} root
 * @param {object} state
 */
function syncConditionalFields(root, state) {
  const quality = root.querySelector('#qualityField');
  if (quality) quality.hidden = state.export.format === 'image/png';

  const customText = root.querySelector('#wmCustomTextField');
  if (customText) customText.hidden = state.watermark.preset !== 'custom';

  const lineHeight = root.querySelector('#lineHeightField');
  if (lineHeight) lineHeight.hidden = splitLines(composeWatermarkText(state.watermark)).length < 2;

  const glow = root.querySelector('#edgeGlowFields');
  if (glow) glow.hidden = !state.edge.glowOn;
}

/** Format a value for its readout. */
function formatValue(value, format) {
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (format === 'degrees') return `${value > 0 ? '+' : ''}${value.toFixed(1)}°`;
  return String(value);
}

/**
 * Wire up every declarative control.
 *
 * @param {object} config
 * @param {HTMLElement} config.root element containing the controls
 * @param {object} config.store the options store
 * @param {() => void} config.onChange called after any change
 * @returns {{refresh: () => void}}
 */
export function bindControls({ root, store, onChange }) {
  const bound = Array.from(root.querySelectorAll('[data-bind]'));

  /** Push the current state into the DOM (initial paint and after a reset). */
  function refresh() {
    const state = store.get();

    for (const el of bound) {
      const path = el.dataset.bind;
      const value = getPath(state, path);

      if (el.type === 'checkbox') {
        el.checked = Boolean(value);
      } else if (el.type === 'range' || el.dataset.type === 'number') {
        el.value = String(value);
      } else {
        el.value = value ?? '';
      }

      const out = root.querySelector(`output[data-for="${path}"]`);
      if (out) out.textContent = formatValue(value, el.dataset.format);
    }

    // Panels whose master switch is off get dimmed, so the rail communicates
    // what is actually affecting the image.
    for (const el of bound) {
      if (el.type !== 'checkbox' || !el.dataset.bind.endsWith('.on')) continue;
      el.closest('.panel')?.classList.toggle('is-muted', !el.checked);
    }

    // Hide controls that cannot affect anything in the current configuration,
    // rather than leaving dead sliders in the rail.
    syncConditionalFields(root, state);
  }

  // ── Generic input listener ───────────────────────────────────────────────
  for (const el of bound) {
    const path = el.dataset.bind;

    const handler = () => {
      let value;
      if (el.type === 'checkbox') {
        value = el.checked;
      } else if (el.type === 'range' || el.dataset.type === 'number') {
        value = Number(el.value);
      } else {
        value = el.value;
      }

      store.update((draft) => setPath(draft, path, value));

      const out = root.querySelector(`output[data-for="${path}"]`);
      if (out) out.textContent = formatValue(value, el.dataset.format);

      if (el.type === 'checkbox' && path.endsWith('.on')) {
        el.closest('.panel')?.classList.toggle('is-muted', !el.checked);
      }
      if (path === 'export.format' || path.startsWith('watermark.') || path === 'edge.glowOn') {
        syncConditionalFields(root, store.get());
      }

      onChange();
    };

    // `input` for live feedback while dragging; `change` covers colour pickers
    // in browsers that only fire input on commit.
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  refresh();
  return { refresh };
}

/**
 * Build the aspect-ratio chips and keep them in sync.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {object} config.store
 * @param {(ratioId: string) => void} config.onPick
 * @returns {{refresh: () => void}}
 */
export function bindRatioChips({ container, store, onPick }) {
  container.innerHTML = '';

  for (const preset of RATIO_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.ratio = preset.id;
    chip.title = preset.note;
    chip.setAttribute('aria-pressed', 'false');
    chip.textContent = preset.label;
    chip.addEventListener('click', () => onPick(preset.id));
    container.appendChild(chip);
  }

  function refresh() {
    const { ratioId, orientation } = store.get().crop;
    for (const chip of container.children) {
      const active = chip.dataset.ratio === ratioId;
      chip.setAttribute('aria-pressed', String(active));
      // Show the ratio the way it will actually be applied, so "4:5" reads
      // "5:4" once the user switches to landscape.
      const preset = RATIO_PRESETS.find((p) => p.id === chip.dataset.ratio);
      chip.textContent = preset.value === null
        ? preset.label
        : ratioLabel(chip.dataset.ratio, orientation);
    }
  }

  refresh();
  return { refresh };
}

/**
 * Bind a group of buttons that behave as one radio group.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {string} config.attr dataset key holding each button's value
 * @param {() => string} config.read current value
 * @param {(value: string) => void} config.onPick
 * @returns {{refresh: () => void}}
 */
export function bindButtonGroup({ container, attr, read, onPick }) {
  const buttons = Array.from(container.querySelectorAll('button'));

  function refresh() {
    const current = read();
    for (const btn of buttons) {
      const active = btn.dataset[attr] === current;
      // Tabs use aria-selected; radios use aria-checked. Set whichever the
      // markup declared so the semantics stay correct.
      const key = btn.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-checked';
      btn.setAttribute(key, String(active));
    }
  }

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      onPick(btn.dataset[attr]);
      refresh();
    });
  }

  refresh();
  return { refresh };
}

/**
 * Render the extracted palette as copyable chips in the rail.
 *
 * @param {HTMLElement} container
 * @param {number[][]} palette
 */
export function renderSwatchReadout(container, palette) {
  container.innerHTML = '';
  if (!palette.length) return;

  for (const rgb of palette) {
    const hex = rgbToHex(rgb);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.title = `Copy ${hex}`;

    const dot = document.createElement('i');
    dot.style.background = hex;

    const label = document.createElement('span');
    label.textContent = hex;

    chip.append(dot, label);
    chip.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(hex);
        label.textContent = 'Copied';
        setTimeout(() => { label.textContent = hex; }, 1000);
      } catch {
        // Clipboard access can be blocked; leave the value on screen to copy
        // by hand rather than failing loudly.
        label.textContent = hex;
      }
    });

    container.appendChild(chip);
  }
}
