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
} from '../lib/crop-geometry.js';

/**
 * @param {object} config
 * @param {HTMLElement} config.root the positioned wrapper around the image
 * @param {HTMLImageElement} config.img the displayed source image
 * @param {HTMLElement} config.rectEl the crop rectangle element
 * @param {() => {crop: object, imgW: number, imgH: number, ratio: number|null, angle: number}} config.read
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
   * @type {{mode: 'move'|'resize', handle: string, startX: number, startY: number, startRect: object}|null}
   */
  let drag = null;

  /**
   * The image's UNROTATED box in client pixels.
   *
   * When straightened, the image is turned with a CSS transform, and
   * getBoundingClientRect then returns the box around the rotated shape. The
   * crop space is the unrotated box with the same centre, so recover it: a
   * w×h box turned by θ has a bounding width of w·|cos θ| + h·|sin θ|. The
   * integer offsetWidth would also do, but drifts by up to a pixel.
   */
  function imageBox() {
    const b = img.getBoundingClientRect();
    const { imgW, imgH, angle } = read();
    if (!angle || !imgW) return b;
    const t = (angle * Math.PI) / 180;
    const aspect = imgH / imgW;
    const width = b.width / (Math.abs(Math.cos(t)) + aspect * Math.abs(Math.sin(t)));
    const height = width * aspect;
    return {
      left: b.left + (b.width - width) / 2,
      top: b.top + (b.height - height) / 2,
      width,
      height,
    };
  }

  /**
   * Convert a client point into source-image pixels.
   *
   * The image is displayed at whatever size the layout gives it, so the scale
   * factor changes on every window resize. Recomputing it per event rather
   * than caching it is what keeps the crop accurate when the user resizes the
   * window mid-session.
   */
  function toSource(clientX, clientY) {
    const box = imageBox();
    const { imgW, imgH } = read();
    // Guard against a zero-width box during layout thrash.
    const scaleX = box.width > 0 ? imgW / box.width : 1;
    const scaleY = box.height > 0 ? imgH / box.height : 1;
    return {
      x: (clientX - box.left) * scaleX,
      y: (clientY - box.top) * scaleY,
    };
  }

  function onPointerDown(event) {
    const { crop } = read();
    if (!crop) return;

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

    const { imgW, imgH, ratio, angle } = read();
    const point = toSource(event.clientX, event.clientY);

    const next =
      drag.mode === 'move'
        ? moveRect(drag.startRect, point.x - drag.startX, point.y - drag.startY, imgW, imgH, angle)
        : resizeFromHandle(drag.startRect, drag.handle, point.x, point.y, ratio, imgW, imgH, angle);

    onChange(next);
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
   */
  function onKeyDown(event) {
    const { crop, imgW, imgH, ratio, angle } = read();
    if (!crop) return;

    // Step as a fraction of the image, so a nudge feels the same on a small
    // JPEG and a huge scan.
    const delta = Math.max(1, Math.round(Math.min(imgW, imgH) * 0.01));
    let next = null;

    switch (event.key) {
      case 'ArrowLeft': next = moveRect(crop, -delta, 0, imgW, imgH, angle); break;
      case 'ArrowRight': next = moveRect(crop, delta, 0, imgW, imgH, angle); break;
      case 'ArrowUp': next = moveRect(crop, 0, -delta, imgW, imgH, angle); break;
      case 'ArrowDown': next = moveRect(crop, 0, delta, imgW, imgH, angle); break;
      case '+': case '=': {
        const w = crop.w * 1.05;
        const h = ratio ? w / ratio : crop.h * 1.05;
        next = clampToBounds({ x: crop.x - (w - crop.w) / 2, y: crop.y - (h - crop.h) / 2, w, h }, imgW, imgH, angle);
        break;
      }
      case '-': case '_': {
        const w = crop.w * 0.95;
        const h = ratio ? w / ratio : crop.h * 0.95;
        next = clampToBounds({ x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h }, imgW, imgH, angle);
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

  return {
    /**
     * Paint the rect element at the position implied by the current crop.
     *
     * This is the only place source pixels turn back into CSS pixels. Call it
     * after any state change and on resize; a ResizeObserver in main.js wires
     * up the latter.
     */
    sync() {
      const { crop, imgW, imgH, angle } = read();
      // The photo turns behind a crop rect that stays upright.
      img.style.transform = angle ? `rotate(${angle}deg)` : '';
      if (!crop || !imgW) {
        rectEl.hidden = true;
        return;
      }
      rectEl.hidden = false;

      const box = imageBox();
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
    },
  };
}
