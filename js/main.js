/**
 * main.js — application controller.
 *
 * Owns the session (image, crop rect, cached palette), schedules renders, and
 * wires the UI modules together. Everything expensive is funnelled through
 * `scheduleRender`, which collapses a burst of slider events into one frame.
 *
 * Nothing here touches the network. The image is read with FileReader, drawn
 * with the Canvas API and written back out with toBlob — it never leaves the
 * tab.
 */

import { createStore, defaultOptions, defaultSession } from './state.js';
import { renderComposition, cropToCanvas, canvasToBlob } from './render.js';
import { extractPaletteFromCanvas } from './lib/palette.js';
import { ensureFontsReady } from './lib/text.js';
import {
  largestFit,
  refitToRatio,
  clampToBounds,
  resolveRatio,
} from './lib/crop-geometry.js';
import { createCropper } from './ui/cropper.js';
import {
  bindControls,
  bindRatioChips,
  bindButtonGroup,
  renderSwatchReadout,
} from './ui/controls.js';

/* ══ Constants ═══════════════════════════════════════════════════════════ */

/** Width the preview renders at. Large enough to judge, small enough to be
 *  instant while dragging a slider. */
const PREVIEW_WIDTH = 1100;

/** Width used for palette extraction — colour averages don't need resolution. */
const PALETTE_SAMPLE_WIDTH = 360;

/* ══ Element lookup ══════════════════════════════════════════════════════ */

const el = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  replaceImage: document.getElementById('replaceImage'),

  previewView: document.getElementById('previewView'),
  previewCanvas: document.getElementById('previewCanvas'),
  previewMeta: document.getElementById('previewMeta'),

  cropView: document.getElementById('cropView'),
  cropper: document.getElementById('cropper'),
  cropImage: document.getElementById('cropImage'),
  cropRect: document.getElementById('cropRect'),
  cropMeta: document.getElementById('cropMeta'),

  stageSwitch: document.getElementById('stageSwitch'),
  warnings: document.getElementById('warnings'),

  rail: document.getElementById('rail'),
  ratioChips: document.getElementById('ratioChips'),
  orientation: document.getElementById('orientation'),
  cropGuidePick: document.getElementById('cropGuidePick'),
  wmPresetPick: document.getElementById('wmPresetPick'),
  wmPosition: document.getElementById('wmPosition'),
  wmFontPick: document.getElementById('wmFontPick'),
  hexFontPick: document.getElementById('hexFontPick'),
  fontNote: document.getElementById('fontNote'),
  recenterCrop: document.getElementById('recenterCrop'),
  edgeLink: document.getElementById('edgeLink'),

  swatchReadout: document.getElementById('swatchReadout'),
  sourceMeta: document.getElementById('sourceMeta'),
  exportMeta: document.getElementById('exportMeta'),

  download: document.getElementById('download'),
  resetAll: document.getElementById('resetAll'),
};

/* ══ State ═══════════════════════════════════════════════════════════════ */

const store = createStore(defaultOptions());
const session = defaultSession();

/**
 * Current stage view: 'preview' | 'crop'.
 *
 * Two views rather than handles drawn on the rendered output: the composition
 * changes shape as the frame and bar options change, so overlaying a crop UI
 * on it would mean re-deriving the image's position inside the canvas on every
 * setting change. Cropping against the untouched source is simpler and lets
 * the user see what they are cutting away.
 */
let stageView = 'preview';

/** Object URL for the loaded image; revoked when replaced. */
let objectUrl = null;

/**
 * Width of the crop in the last preview render. The export readout scales the
 * preview's finished dimensions by (exportWidth / this) to predict the saved
 * file size without doing a second full render on every keystroke.
 */
let lastPreviewCropW = PREVIEW_WIDTH;

/** Renders are blocked until the font faces resolve — see ensureFontsReady. */
let fontsReady = false;

/** Guards scheduleRender so a burst of slider events collapses into one frame. */
let renderQueued = false;

/**
 * The crop as it was before the current run of straighten adjustments.
 *
 * Tilting shrinks the crop to keep it inside the rotated photo. Refitting
 * from this snapshot rather than the live crop means tilting back towards
 * level grows it again, instead of every tick ratcheting it smaller. Cleared
 * whenever the crop is changed any other way.
 */
let straightenBase = null;

/* ══ Helpers ═════════════════════════════════════════════════════════════ */

/** The aspect ratio currently in force, or null when the crop is unlocked. */
function currentRatio() {
  const { ratioId, orientation } = store.get().crop;
  return resolveRatio(ratioId, orientation);
}

/** Straighten angle in degrees; 0 when level. */
function currentAngle() {
  return store.get().crop.angle || 0;
}

/**
 * The largest crop the current ratio and angle allow, centred. An unlocked
 * crop is the whole frame when level; once straightened the whole frame
 * would show empty corners, so it becomes the largest rect of the image's
 * own shape instead.
 */
function fullCrop(iw, ih) {
  const ratio = currentRatio();
  const angle = currentAngle();
  if (ratio) return largestFit(iw, ih, ratio, angle);
  return angle ? largestFit(iw, ih, iw / ih, angle) : { x: 0, y: 0, w: iw, h: ih };
}

/** Read used by the cropper to avoid stale closures mid-gesture. */
function readCropContext() {
  return {
    crop: session.crop,
    imgW: session.image?.naturalWidth || 0,
    imgH: session.image?.naturalHeight || 0,
    ratio: currentRatio(),
    angle: currentAngle(),
  };
}

function showWarnings(list) {
  if (!list.length) {
    el.warnings.hidden = true;
    el.warnings.textContent = '';
    return;
  }
  el.warnings.hidden = false;
  el.warnings.textContent = list.join(' ');
}

/**
 * Extract the palette, reusing the cached result when neither the crop nor
 * the requested count has changed.
 *
 * Extraction on every slider tick would stutter badly, and the *same* array
 * must feed the preview and the export or the two would disagree on colour.
 */
function refreshPalette() {
  if (!session.image || !session.crop) return;

  const { count } = store.get().palette;
  const angle = currentAngle();
  const c = session.crop;
  const key = [
    Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h), count, angle,
  ].join(':');

  if (key === session.paletteKey) return;

  const sample = cropToCanvas(session.image, c, Math.min(PALETTE_SAMPLE_WIDTH, c.w), angle);
  session.palette = extractPaletteFromCanvas(sample, count);
  session.paletteKey = key;

  renderSwatchReadout(el.swatchReadout, session.palette);
}

/** Collapse a burst of changes into a single render on the next frame. */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/* ══ Render ══════════════════════════════════════════════════════════════ */

function render() {
  if (!session.image || !session.crop || !fontsReady) return;

  refreshPalette();

  const opts = store.get();
  const previewWidth = Math.min(PREVIEW_WIDTH, Math.round(session.crop.w));
  lastPreviewCropW = previewWidth;

  const { canvas, warnings } = renderComposition({
    image: session.image,
    crop: session.crop,
    opts,
    outputWidth: previewWidth,
    palette: session.palette,
  });

  // Draw the freshly composed canvas into the one already in the DOM. Setting
  // width/height clears it, so no explicit clearRect is needed. Replacing the
  // element instead would drop its CSS sizing and any focus on it.
  el.previewCanvas.width = canvas.width;
  el.previewCanvas.height = canvas.height;
  el.previewCanvas.getContext('2d').drawImage(canvas, 0, 0);

  showWarnings(warnings);
  updateMeta(canvas);
  cropper?.sync();
}

/** Update the dimension readouts under the stage and in the export panel. */
function updateMeta(previewCanvas) {
  const crop = session.crop;
  const opts = store.get();

  const angle = currentAngle();
  el.cropMeta.textContent =
    `crop ${Math.round(crop.w)} × ${Math.round(crop.h)} px  ·  ` +
    `${(crop.w / crop.h).toFixed(3)}:1` +
    (angle ? `  ·  ${angle > 0 ? '+' : ''}${angle.toFixed(1)}°` : '');

  // Scale the preview's finished size up to whatever the export will use.
  const exportCropW = opts.export.maxWidth
    ? Math.min(opts.export.maxWidth, Math.round(crop.w))
    : Math.round(crop.w);
  const scale = exportCropW / lastPreviewCropW;
  const outW = Math.round(previewCanvas.width * scale);
  const outH = Math.round(previewCanvas.height * scale);

  el.previewMeta.textContent = `output ${outW} × ${outH} px`;
  el.exportMeta.textContent =
    `Saves at ${outW} × ${outH} px` +
    (opts.export.maxWidth && opts.export.maxWidth > crop.w
      ? '. The crop is smaller than the chosen width, so it will not be enlarged.'
      : '.');
}

/* ══ Image loading ═══════════════════════════════════════════════════════ */

/**
 * Load a File into the session and reset the crop to fit.
 * @param {File} file
 */
async function loadFile(file) {
  // Reached from three places: the file input, a drop, and a paste. All three
  // hand over a File, so they share this one path.
  if (!file || !file.type.startsWith('image/')) {
    showWarnings(['That file is not an image. Try a JPEG, PNG, WebP or GIF.']);
    return;
  }

  const image = new Image();
  const url = URL.createObjectURL(file);

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('decode failed'));
      image.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    showWarnings(['That image could not be opened. It may be corrupt or in an unsupported format.']);
    return;
  }

  // Release the previous image's URL now that the new one has decoded.
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = url;

  session.image = image;
  session.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
  session.paletteKey = '';

  // A straighten angle belongs to the photo it levelled, not the next one.
  store.update((draft) => { draft.crop.angle = 0; });
  straightenBase = null;
  controls.refresh();

  // Start with the largest crop the current ratio allows, centred. An unlocked
  // crop starts as the whole frame.
  session.crop = fullCrop(image.naturalWidth, image.naturalHeight);

  el.cropImage.src = url;
  el.cropImage.alt = `Source photograph: ${file.name}`;

  el.dropzone.hidden = true;
  el.stageSwitch.hidden = false;
  el.download.disabled = false;
  el.resetAll.hidden = false;
  setStageView(stageView);

  const mp = (image.naturalWidth * image.naturalHeight) / 1e6;
  el.sourceMeta.textContent =
    `${file.name} · ${image.naturalWidth} × ${image.naturalHeight} px · ${mp.toFixed(1)} MP`;

  showWarnings([]);
  scheduleRender();
}

/* ══ Stage view ══════════════════════════════════════════════════════════ */

function setStageView(view) {
  stageView = view;
  const hasImage = Boolean(session.image);

  el.previewView.hidden = !hasImage || view !== 'preview';
  el.cropView.hidden = !hasImage || view !== 'crop';

  if (view === 'crop') {
    // The image must be laid out before the overlay can be positioned, so
    // sync on the next frame rather than immediately.
    requestAnimationFrame(() => cropper?.sync());
  }
}

/* ══ Cropper ═════════════════════════════════════════════════════════════ */

const cropper = createCropper({
  root: el.cropper,
  img: el.cropImage,
  rectEl: el.cropRect,
  read: readCropContext,
  onChange(next) {
    session.crop = next;
    straightenBase = null;
    cropper.sync();
    scheduleRender();
  },
});

/* ══ Control wiring ══════════════════════════════════════════════════════ */

const controls = bindControls({
  root: el.rail,
  store,
  onChange: scheduleRender,
});

/* ── Edge: padding and radius, optionally linked ───────────────────────────
   The generic binder writes whichever slider moved; when the pair is linked
   this then copies that value to its partner. Registered after bindControls,
   so the store already holds the new value when it runs.                     */

function syncEdgeLink() {
  el.edgeLink.setAttribute('aria-pressed', String(store.get().edge.linked));
}

for (const [from, to] of [['paddingPct', 'radiusPct'], ['radiusPct', 'paddingPct']]) {
  el.rail.querySelector(`[data-bind="edge.${from}"]`).addEventListener('input', () => {
    if (!store.get().edge.linked) return;
    store.update((draft) => { draft.edge[to] = draft.edge[from]; });
    controls.refresh();
  });
}

el.edgeLink.addEventListener('click', () => {
  store.update((draft) => {
    draft.edge.linked = !draft.edge.linked;
    // Re-linking snaps the radius to the padding, so the pair is equal again.
    if (draft.edge.linked) draft.edge.radiusPct = draft.edge.paddingPct;
  });
  syncEdgeLink();
  controls.refresh();
  scheduleRender();
});

syncEdgeLink();

/* ── Straighten ────────────────────────────────────────────────────────────
   The generic binder stores the angle; this then refits the crop inside the
   rotated photo. Same ordering trick as the edge link above.                 */

const straightenInput = el.rail.querySelector('[data-bind="crop.angle"]');

function applyStraighten() {
  if (!session.image || !session.crop) return;
  const { naturalWidth: iw, naturalHeight: ih } = session.image;
  if (!straightenBase) straightenBase = { ...session.crop };
  // Size is kept where it fits and only shrinks where the tilted corners
  // would otherwise be exposed.
  session.crop = clampToBounds(straightenBase, iw, ih, currentAngle());
  cropper.sync();
}

straightenInput.addEventListener('input', applyStraighten);

// Double-click returns to level — the usual reset gesture for a slider.
straightenInput.addEventListener('dblclick', () => {
  store.update((draft) => { draft.crop.angle = 0; });
  controls.refresh();
  applyStraighten();
  scheduleRender();
});

const ratioChips = bindRatioChips({
  container: el.ratioChips,
  store,
  onPick(ratioId) {
    store.update((draft) => { draft.crop.ratioId = ratioId; });
    applyRatioToCrop();
    ratioChips.refresh();
    scheduleRender();
  },
});

const orientationGroup = bindButtonGroup({
  container: el.orientation,
  attr: 'orientation',
  read: () => store.get().crop.orientation,
  onPick(value) {
    store.update((draft) => { draft.crop.orientation = value; });
    applyRatioToCrop();
    ratioChips.refresh();
    scheduleRender();
  },
});

/** Button groups that the reset handler needs to repaint. */
const buttonGroups = [];

buttonGroups.push(bindButtonGroup({
  container: el.cropGuidePick,
  attr: 'guide',
  read: () => store.get().crop.guide,
  // Guides are a crop-view overlay only — they never touch the composed
  // image, so no scheduleRender() here (unlike every other button group).
  onPick(value) {
    store.update((draft) => { draft.crop.guide = value; });
  },
}));

buttonGroups.push(bindButtonGroup({
  container: el.wmPresetPick,
  attr: 'preset',
  read: () => store.get().watermark.preset,
  onPick(value) {
    store.update((draft) => { draft.watermark.preset = value; });
    controls.refresh(); // toggles the custom-text field's visibility
    scheduleRender();
  },
}));

buttonGroups.push(bindButtonGroup({
  container: el.wmPosition,
  attr: 'position',
  read: () => store.get().watermark.position,
  onPick(value) {
    store.update((draft) => { draft.watermark.position = value; });
    scheduleRender();
  },
}));

buttonGroups.push(bindButtonGroup({
  container: el.wmFontPick,
  attr: 'font',
  read: () => store.get().watermark.font,
  onPick(value) {
    store.update((draft) => { draft.watermark.font = value; });
    scheduleRender();
  },
}));

buttonGroups.push(bindButtonGroup({
  container: el.hexFontPick,
  attr: 'font',
  read: () => store.get().palette.font,
  onPick(value) {
    store.update((draft) => { draft.palette.font = value; });
    scheduleRender();
  },
}));

const stageTabs = bindButtonGroup({
  container: el.stageSwitch,
  attr: 'view',
  read: () => stageView,
  onPick: setStageView,
});

/** Re-fit the crop after a ratio or orientation change. */
function applyRatioToCrop() {
  if (!session.image || !session.crop) return;
  const { naturalWidth: iw, naturalHeight: ih } = session.image;
  const ratio = currentRatio();

  const angle = currentAngle();

  session.crop = ratio
    ? refitToRatio(session.crop, iw, ih, ratio, angle)
    : clampToBounds(session.crop, iw, ih, angle);

  straightenBase = null;
  session.paletteKey = ''; // crop moved, palette is stale
  cropper.sync();
}

/* ══ Actions ═════════════════════════════════════════════════════════════ */

el.recenterCrop.addEventListener('click', () => {
  if (!session.image) return;
  const { naturalWidth: iw, naturalHeight: ih } = session.image;
  session.crop = fullCrop(iw, ih);
  straightenBase = null;
  session.paletteKey = '';
  cropper.sync();
  scheduleRender();
});

el.resetAll.addEventListener('click', () => {
  store.replace(defaultOptions());
  controls.refresh();
  ratioChips.refresh();
  orientationGroup.refresh();
  buttonGroups.forEach((g) => g.refresh());
  syncEdgeLink();
  // The angle is back to level, so undo any shrinking the tilt forced.
  if (straightenBase && session.crop) session.crop = straightenBase;
  applyRatioToCrop();
  session.paletteKey = '';
  scheduleRender();
});

el.replaceImage.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
  // Clear the value so choosing the same file twice still fires.
  event.target.value = '';
});

/* ── Drag and drop ─────────────────────────────────────────────────────────
   Bound on `document` rather than the dropzone: once an image is loaded the
   dropzone is hidden, and a user dropping a second photo onto the preview
   expects it to load. preventDefault on dragover is required or the browser
   navigates away to the dropped file.                                        */

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('is-over');
  });
}

for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && event.relatedTarget) return;
    el.dropzone.classList.remove('is-over');
  });
}

document.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

/* ── Paste ─────────────────────────────────────────────────────────────────
   Screenshot straight into the tool. clipboardData.items holds one entry per
   representation, so find the image rather than assuming index 0.            */

document.addEventListener('paste', (event) => {
  const item = Array.from(event.clipboardData?.items || [])
    .find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) loadFile(file);
});

/* ── Export ────────────────────────────────────────────────────────────── */

el.download.addEventListener('click', async () => {
  if (!session.image || !session.crop) return;

  const opts = store.get();
  el.download.disabled = true;
  el.download.textContent = 'Saving…';

  try {
    // Render fresh at full resolution rather than scaling up the 1100px
    // preview, which would export a soft image. Capped at the crop's own width
    // so a small crop is never enlarged past its real detail.
    const exportWidth = opts.export.maxWidth
      ? Math.min(opts.export.maxWidth, Math.round(session.crop.w))
      : Math.round(session.crop.w);

    const { canvas, warnings } = renderComposition({
      image: session.image,
      crop: session.crop,
      opts,
      outputWidth: exportWidth,
      palette: session.palette,
    });

    // JPEG has no alpha channel, so a transparent frame would flatten to
    // black. Fall back to PNG rather than handing back a ruined file.
    const wantsAlpha = opts.frame.transparent;
    const format = wantsAlpha && opts.export.format === 'image/jpeg'
      ? 'image/png'
      : opts.export.format;

    const blob = await canvasToBlob(canvas, format, opts.export.quality);
    const ext = format.split('/')[1].replace('jpeg', 'jpg');

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${session.fileName}-passepartout.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(link.href), 30_000);

    showWarnings(warnings);
  } catch (error) {
    showWarnings([`Could not save the image: ${error.message}`]);
  } finally {
    el.download.disabled = false;
    el.download.textContent = 'Save image';
  }
});

/* ── Keep the crop overlay aligned ─────────────────────────────────────── */

// The overlay is positioned in CSS pixels, so it has to be repainted whenever
// the displayed image changes size. The ResizeObserver catches layout changes
// the window resize event misses, such as the rail's scrollbar appearing.
const resizeObserver = new ResizeObserver(() => cropper.sync());
resizeObserver.observe(el.cropImage);
window.addEventListener('resize', () => cropper.sync());

/* ══ Boot ════════════════════════════════════════════════════════════════ */

(async function init() {
  // measureText silently returns wrong widths against an unloaded face, so no
  // render may happen until the fonts are in. This matters more now that a
  // local .otf is involved: a miss is a real possibility, not a theoretical one.
  const { displayLoaded } = await ensureFontsReady();
  fontsReady = true;

  // Say so rather than quietly drawing in the fallback. A missing font file is
  // the single most likely thing to go wrong when someone forks this.
  if (!displayLoaded) {
    el.fontNote.hidden = false;
    el.fontNote.textContent =
      'Bigola Display did not load — check that assets/fonts/ contains ' +
      '"Bigola Display Regular.otf". Falling back to a serif face.';
  }

  stageTabs.refresh();
  scheduleRender();
})();
