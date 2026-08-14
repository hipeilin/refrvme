/**
 * ui/cropper.js — the draggable crop overlay.
 *
 * COORDINATE DISCIPLINE: the crop rect always lives in source-image pixels.
 * This module converts pointer positions into that space on the way in, and
 * back into CSS pixels on the way out. Nothing else in the app ever sees
 * display coordinates.
 *
 * Pointer Events are used rather than mouse events: touch and stylus come for
 * free, and `setPointerCapture` keeps the drag alive when the cursor leaves
 * the element — otherwise dragging a corner off the edge of the window
 * silently abandons the gesture.
 */

import {
  HANDLES,
  moveRect,
  resizeFromHandle,
  clampToBounds,
  frameRatioOf,
  frameBox,
  zoomBy,
} from '../lib/crop-geometry.js';

/**
 * Breathing room around the fixed frame, as a fraction of the viewport's
 * shorter side, so the dimmed overflow has somewhere to show.
 */
const FRAME_PAD_PCT = 0.09;
const FRAME_PAD_MIN = 16;
const FRAME_PAD_MAX = 72;

/** Wheel sensitivity. Chosen so one detent is a comfortable ~10% step. */
const WHEEL_ZOOM = 0.0015;

/**
 * @param {object} config
 * @param {HTMLElement} config.root the positioned wrapper around the image
 * @param {HTMLImageElement} config.img the displayed source image
 * @param {HTMLElement} config.rectEl the crop rectangle element
 * @param {() => {crop: object, imgW: number, imgH: number, ratio: number|null,
 *                resizeMode: boolean}} config.read
 *        supplies current state at gesture time (avoids stale closures)
 * @param {(crop: object) => void} config.onChange
 */
export function createCropper({ root, img, rectEl, read, onChange }) {
  // Build the four corner marks once.
  rectEl.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'crop-rect__grid';
  rectEl.appendChild(grid);

  for (const handle of HANDLES) {
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = `crop-mark crop-mark--${handle}`;
    mark.dataset.handle = handle;
    mark.setAttribute('aria-label', `Resize crop from ${handle.toUpperCase()} corner`);
    rectEl.appendChild(mark);
  }

  /**
   * The in-flight gesture, or null when idle.
   *
   * The rect at gesture START is captured here rather than read live on each
   * move. Deriving from the live rect would compound rounding on every
   * pointermove and let the crop drift away from the cursor over a long drag.
   *
   * `pan` is the fixed-frame counterpart of `move`. It tracks the pointer in
   * CLIENT pixels rather than source pixels, because the image itself travels
   * under the cursor in that mode: re-reading the source position each move
   * would measure against an image that has already shifted, and the drag
   * would run away from the pointer.
   *
   * @type {{mode: 'move'|'resize'|'pan', handle: string, startX: number, startY: number,
   *         startRect: object, scale: number}|null}
   */
  let drag = null;

  /**
   * Convert a client point into source-image pixels.
   *
   * The image is displayed at whatever size the layout gives it, so the scale
   * factor changes on every window resize. Recomputing it per event rather
   * than caching it is what keeps the crop accurate when the user resizes the
   * window mid-session.
   */
  function toSource(clientX, clientY) {
    const box = img.getBoundingClientRect();
    const { imgW, imgH } = read();
    // Guard against a zero-width box during layout thrash.
    const scaleX = box.width > 0 ? imgW / box.width : 1;
    const scaleY = box.height > 0 ? imgH / box.height : 1;
    return {
      x: (clientX - box.left) * scaleX,
      y: (clientY - box.top) * scaleY,
    };
  }

  /**
   * Display pixels per source pixel, measured live.
   *
   * Constant for the duration of a pan (only zooming changes it), which is why
   * a pan can safely capture it once at gesture start.
   */
  function displayScale() {
    const box = img.getBoundingClientRect();
    const { imgW } = read();
    return box.width > 0 && imgW > 0 ? box.width / imgW : 1;
  }

  /**
   * A client point expressed in frame-relative units, where (0,0) is the
   * frame's top-left and (1,1) its bottom-right. Values outside that range are
   * fine — zooming with the pointer out in the dimmed margin still works.
   */
  function toFrame(clientX, clientY) {
    const box = rectEl.getBoundingClientRect();
    return {
      x: box.width > 0 ? (clientX - box.left) / box.width : 0.5,
      y: box.height > 0 ? (clientY - box.top) / box.height : 0.5,
    };
  }

  function onPointerDown(event) {
    const { crop, resizeMode } = read();
    if (!crop) return;

    // In fixed-frame mode the frame does not move, so every press anywhere on
    // the stage grabs the image. The corner marks are hidden in this mode, so
    // there is nothing else a press could mean.
    if (resizeMode) {
      event.preventDefault();
      drag = {
        mode: 'pan',
        handle: '',
        startX: event.clientX,
        startY: event.clientY,
        startRect: { ...crop },
        scale: displayScale(),
      };
      root.setPointerCapture(event.pointerId);
      root.classList.add('is-dragging');
      return;
    }

    // A corner mark starts a resize; the rect body (or its thirds grid) starts
    // a move. A press anywhere else on the stage is ignored, so clicking the
    // dimmed area outside the crop does nothing rather than jumping the rect.
    const handle = event.target instanceof HTMLElement ? event.target.dataset.handle : null;
    const isRect = event.target === rectEl || event.target === grid;
    if (!handle && !isRect) return;

    event.preventDefault();
    const point = toSource(event.clientX, event.clientY);

    drag = {
      mode: handle ? 'resize' : 'move',
      handle: handle || '',
      startX: point.x,
      startY: point.y,
      startRect: { ...crop },
      scale: 1,
    };

    // Capture keeps the gesture alive once the cursor leaves the element.
    // Without it, dragging a corner past the window edge silently abandons the
    // drag and the rect freezes mid-move.
    root.setPointerCapture(event.pointerId);
    root.classList.add('is-dragging');
  }

  function onPointerMove(event) {
    if (!drag) return;
    event.preventDefault();

    const { imgW, imgH, ratio } = read();

    if (drag.mode === 'pan') {
      // Dragging the image right shows what lies to its LEFT, so the window
      // travels the opposite way to the pointer. moveRect's clamp is what
      // stops the image being pulled off the frame and leaving a gap.
      const dx = (event.clientX - drag.startX) / drag.scale;
      const dy = (event.clientY - drag.startY) / drag.scale;
      onChange(moveRect(drag.startRect, -dx, -dy, imgW, imgH));
      return;
    }

    const point = toSource(event.clientX, event.clientY);

    const next =
      drag.mode === 'move'
        ? moveRect(drag.startRect, point.x - drag.startX, point.y - drag.startY, imgW, imgH)
        : resizeFromHandle(drag.startRect, drag.handle, point.x, point.y, ratio, imgW, imgH);

    onChange(next);
  }

  /**
   * Wheel and trackpad-pinch zoom, live only in fixed-frame mode.
   *
   * Left alone outside that mode so the page scrolls normally; inside it the
   * gesture is claimed with preventDefault, which requires a non-passive
   * listener.
   */
  function onWheel(event) {
    const { crop, imgW, imgH, ratio, resizeMode } = read();
    if (!resizeMode || !crop) return;

    event.preventDefault();
    const anchor = toFrame(event.clientX, event.clientY);

    // Firefox reports lines (deltaMode 1) rather than pixels; without this a
    // notch there would be a 3-unit no-op instead of a step.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1;
    const factor = Math.exp(-event.deltaY * unit * WHEEL_ZOOM);
    onChange(zoomBy(crop, factor, imgW, imgH, frameRatioOf(crop, ratio), anchor));
  }

  function endDrag(event) {
    if (!drag) return;
    drag = null;
    root.classList.remove('is-dragging');
    if (event && root.hasPointerCapture?.(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
  }

  /**
   * Keyboard control, so the crop is usable without a pointer.
   *
   * Arrow keys move the rect by 1% of the image's shorter side; `+` and `-`
   * scale it about its own centre. Zooming preserves the locked ratio by
   * deriving height from width, the same rule the corner drag uses.
   *
   * In fixed-frame mode the arrows nudge the IMAGE instead, matching what the
   * eye sees: the frame is nailed down, so pressing right has to push the
   * photograph right, which is the crop window moving left.
   */
  function onKeyDown(event) {
    const { crop, imgW, imgH, ratio, resizeMode } = read();
    if (!crop) return;

    // Step as a fraction of the image, so a nudge feels the same on a small
    // JPEG and a huge scan.
    const delta = Math.max(1, Math.round(Math.min(imgW, imgH) * 0.01));
    let next = null;

    if (resizeMode) {
      const frameRatio = frameRatioOf(crop, ratio);
      switch (event.key) {
        case 'ArrowLeft': next = moveRect(crop, delta, 0, imgW, imgH); break;
        case 'ArrowRight': next = moveRect(crop, -delta, 0, imgW, imgH); break;
        case 'ArrowUp': next = moveRect(crop, 0, delta, imgW, imgH); break;
        case 'ArrowDown': next = moveRect(crop, 0, -delta, imgW, imgH); break;
        case '+': case '=': next = zoomBy(crop, 1.08, imgW, imgH, frameRatio); break;
        case '-': case '_': next = zoomBy(crop, 1 / 1.08, imgW, imgH, frameRatio); break;
        default: return;
      }
      event.preventDefault();
      onChange(next);
      return;
    }

    switch (event.key) {
      case 'ArrowLeft': next = moveRect(crop, -delta, 0, imgW, imgH); break;
      case 'ArrowRight': next = moveRect(crop, delta, 0, imgW, imgH); break;
      case 'ArrowUp': next = moveRect(crop, 0, -delta, imgW, imgH); break;
      case 'ArrowDown': next = moveRect(crop, 0, delta, imgW, imgH); break;
      case '+': case '=': {
        const w = crop.w * 1.05;
        const h = ratio ? w / ratio : crop.h * 1.05;
        next = clampToBounds({ x: crop.x - (w - crop.w) / 2, y: crop.y - (h - crop.h) / 2, w, h }, imgW, imgH);
        break;
      }
      case '-': case '_': {
        const w = crop.w * 0.95;
        const h = ratio ? w / ratio : crop.h * 0.95;
        next = clampToBounds({ x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h }, imgW, imgH);
        break;
      }
      default: return;
    }

    event.preventDefault();
    onChange(next);
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('keydown', onKeyDown);
  // Non-passive: the handler claims the gesture with preventDefault, which a
  // passive listener is not allowed to do.
  root.addEventListener('wheel', onWheel, { passive: false });

  /**
   * Fixed-frame layout: the frame is pinned to the middle of the viewport and
   * the image is transformed to put the cropped region behind it.
   *
   * Everything the frame does not cover stays on screen rather than being
   * clipped away, so the user can see what they are steering — the crop-rect's
   * shade is what dims it.
   */
  function syncFramed(crop, imgW, imgH, ratio) {
    const rootBox = root.getBoundingClientRect();
    const pad = Math.min(
      FRAME_PAD_MAX,
      Math.max(FRAME_PAD_MIN, Math.min(rootBox.width, rootBox.height) * FRAME_PAD_PCT),
    );
    const frame = frameBox(rootBox.width, rootBox.height, frameRatioOf(crop, ratio), pad);

    // One scale for both axes: the crop and the frame share an aspect ratio by
    // construction, so frame.w / crop.w already describes the vertical fit.
    const scale = crop.w > 0 ? frame.w / crop.w : 1;

    // The image is laid out at its natural size and scaled by transform rather
    // than by width/height, so a pan is a composited move instead of a full
    // resample of a multi-megapixel bitmap on every pointer event.
    img.style.width = `${imgW}px`;
    img.style.height = `${imgH}px`;
    img.style.transform =
      `translate(${frame.x - crop.x * scale}px, ${frame.y - crop.y * scale}px) scale(${scale})`;

    rectEl.style.left = `${frame.x}px`;
    rectEl.style.top = `${frame.y}px`;
    rectEl.style.width = `${frame.w}px`;
    rectEl.style.height = `${frame.h}px`;
  }

  return {
    /**
     * Paint the rect element at the position implied by the current crop.
     *
     * This is the only place source pixels turn back into CSS pixels. Call it
     * after any state change and on resize; a ResizeObserver in main.js wires
     * up the latter.
     */
    sync() {
      const { crop, imgW, imgH, ratio, resizeMode } = read();
      if (!crop || !imgW) {
        rectEl.hidden = true;
        return;
      }
      rectEl.hidden = false;

      root.classList.toggle('cropper--resize', Boolean(resizeMode));

      if (resizeMode) {
        syncFramed(crop, imgW, imgH, ratio);
        return;
      }

      // Back to the flowed layout: the inline transform and natural size only
      // apply to the framed mode, and leaving them behind would hold the image
      // at full resolution the moment the tick-box came off.
      img.style.width = '';
      img.style.height = '';
      img.style.transform = '';

      const box = img.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      const scale = box.width / imgW;
      void imgH;

      // The image is centred inside the stage and letterboxed, so its box does
      // not start at the root's origin. Overlaying the rect on the root without
      // this offset is the bug that makes a crop overlay look correct on one
      // aspect ratio and drift on every other.
      const offsetX = box.left - rootBox.left;
      const offsetY = box.top - rootBox.top;

      rectEl.style.left = `${offsetX + crop.x * scale}px`;
      rectEl.style.top = `${offsetY + crop.y * scale}px`;
      rectEl.style.width = `${crop.w * scale}px`;
      rectEl.style.height = `${crop.h * scale}px`;
    },

    destroy() {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', endDrag);
      root.removeEventListener('pointercancel', endDrag);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('wheel', onWheel);
    },
  };
}
