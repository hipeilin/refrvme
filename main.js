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
  wmPosition: document.getElementById('wmPosition'),
  fontPick: document.getElementById('fontPick'),
  recenterCrop: document.getElementById('recenterCrop'),

  swatchReadout: document.getElementById('swatchReadout'),
  sourceMeta: document.getElementById('sourceMeta'),
  exportMeta: document.getElementById('exportMeta'),

  download: document.getElementById('download'),
  resetAll: document.getElementById('resetAll'),
};

/* ══ State ═══════════════════════════════════════════════════════════════ */

const store = createStore(defaultOptions());
const session = defaultSession();

/** Current stage view: 'preview' | 'crop'. */
let stageView = 'preview';

/** Object URL for the loaded image; revoked when replaced. */
let objectUrl = null;

/** Width of the crop used by the last preview render, for export maths. */
let lastPreviewCropW = PREVIEW_WIDTH;

let fontsReady = false;
let renderQueued = false;

/* ══ Helpers ═════════════════════════════════════════════════════════════ */

/** The aspect ratio currently in force, or null when the crop is unlocked. */
function currentRatio() {
  const { ratioId, orientation } = store.get().crop;
  return resolveRatio(ratioId, orientation);
}

/** Read used by the cropper to avoid stale closures mid-gesture. */
function readCropContext() {
  return {
    crop: session.crop,
    imgW: session.image?.naturalWidth || 0,
    imgH: session.image?.naturalHeight || 0,
    ratio: currentRatio(),
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
  const c = session.crop;
  const key = [
    Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h), count,
  ].join(':');

  if (key === session.paletteKey) return;

  const sample = cropToCanvas(session.image, c, Math.min(PALETTE_SAMPLE_WIDTH, c.w));
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

  // Swap the rendered canvas into the visible one. Resizing then drawing is
  // cheaper than replacing the element and avoids losing CSS state.
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

  el.cropMeta.textContent =
    `crop ${Math.round(crop.w)} × ${Math.round(crop.h)} px  ·  ` +
    `${(crop.w / crop.h).toFixed(3)}:1`;

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

  const ratio = currentRatio();
  session.crop = ratio
    ? largestFit(image.naturalWidth, image.naturalHeight, ratio)
    : { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };

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

bindButtonGroup({
  container: el.wmPosition,
  attr: 'position',
  read: () => store.get().watermark.position,
  onPick(value) {
    store.update((draft) => { draft.watermark.position = value; });
    scheduleRender();
  },
});

bindButtonGroup({
  container: el.fontPick,
  attr: 'font',
  read: () => store.get().font,
  onPick(value) {
    store.update((draft) => { draft.font = value; });
    scheduleRender();
  },
});

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

  session.crop = ratio
    ? refitToRatio(session.crop, iw, ih, ratio)
    : clampToBounds(session.crop, iw, ih);

  session.paletteKey = ''; // crop moved, palette is stale
  cropper.sync();
}

/* ══ Actions ═════════════════════════════════════════════════════════════ */

el.recenterCrop.addEventListener('click', () => {
  if (!session.image) return;
  const { naturalWidth: iw, naturalHeight: ih } = session.image;
  const ratio = currentRatio();
  session.crop = ratio ? largestFit(iw, ih, ratio) : { x: 0, y: 0, w: iw, h: ih };
  session.paletteKey = '';
  cropper.sync();
  scheduleRender();
});

el.resetAll.addEventListener('click', () => {
  store.replace(defaultOptions());
  controls.refresh();
  ratioChips.refresh();
  orientationGroup.refresh();
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

/* ── Drag and drop ─────────────────────────────────────────────────────── */

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

/* ── Paste ─────────────────────────────────────────────────────────────── */

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
    // Render fresh at full resolution rather than upscaling the preview.
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

const resizeObserver = new ResizeObserver(() => cropper.sync());
resizeObserver.observe(el.cropImage);
window.addEventListener('resize', () => cropper.sync());

/* ══ Boot ════════════════════════════════════════════════════════════════ */

(async function init() {
  // measureText silently returns wrong widths against an unloaded webfont, so
  // no render may happen until the faces are in.
  await ensureFontsReady();
  fontsReady = true;
  stageTabs.refresh();
  scheduleRender();
})();
