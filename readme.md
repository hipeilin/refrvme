# Passepartout

Crop a photograph to a platform aspect ratio, watermark it, mount it in a
frame, caption it, and print its colour palette underneath. Everything runs in
your browser with the Canvas API. No upload, no server, no analytics.

![A photograph mounted in a white frame, with a row of colour swatches and hex
codes below it and a three-part caption along the bottom](docs/example.png)

## Run it locally

The site is static. Any file server will do:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Opening `index.html` directly with `file://` will not work. The code uses ES
modules, which browsers refuse to load over that scheme.

## Deploy to GitHub Pages

1. Push the repository to GitHub with `index.html` at the root.
2. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder
   `/ (root)`.
3. Wait a minute. The site appears at
   `https://<username>.github.io/<repo>/`.

Nothing needs building. There is no bundler, no dependency install, no
`dist` folder. Every path in the HTML is relative, so the site works from a
repository subdirectory as well as from a custom domain.

`.nojekyll` is included so GitHub serves the directories as-is rather than
running the files through Jekyll first.

## What it does

**Crop.** Seven ratio presets (free, 1:1, 4:5, 3:4, 9:16, 1.91:1, 3:2) with a
portrait/landscape switch. Drag the rectangle to move it, drag a trim mark to
resize. Arrow keys nudge; `+` and `-` zoom.

**Resize (reposition & zoom).** Tick it and the interaction turns round: the
frame is pinned to the middle of the stage and the photograph is dragged and
zoomed behind it, the way a profile-picture cropper works. Scroll, use the
slider, or press `+` and `-` to zoom; drag or use the arrow keys to reposition.
The whole photograph stays on screen while you aim, with everything outside the
frame dimmed. Zooming out stops at the point where the image still covers the
frame — its shorter side — so no edge is ever exposed and the export can never
contain whitespace.

**Watermark.** Text, colour, opacity, inset, and one of five anchor positions.

**Frame.** Border width, background colour, and a corner radius applied to the
image. The outer corner radius follows the inner one plus the border width, so
the border stays a constant width around the curve.

**Caption.** Three slots along the bottom, left/middle/right, with independent
left and right spacing controls.

**Palette.** Two to ten dominant colours pulled from the cropped area, drawn
as evenly spaced circles with their hex codes beneath. Click a swatch in the
sidebar to copy its hex.

**Export.** PNG, JPEG or WebP, at original resolution or capped to 2048, 1440
or 1080 pixels wide.

## How it fits together

```
index.html
css/styles.css
js/
  main.js              controller: file loading, render scheduling, export
  state.js             options store and session data
  render.js            the canvas pipeline
  lib/
    color.js           hex/rgb conversion, luminance
    palette.js         median-cut colour extraction
    crop-geometry.js   crop rectangle maths, ratio presets, pan & zoom limits
    text.js            the shared font specification
    layout.js          composition geometry
  ui/
    cropper.js         pointer-driven crop overlay, both gesture modes
    controls.js        generic control binding
test/
  logic.test.mjs       97 assertions, runs in Node
  browser.test.mjs     53 assertions, runs in Playwright
  visual.mjs           renders a matrix of configurations to PNG
```

### The pipeline

```
crop → watermark → frame → palette → caption
```

The order matters. Burning the watermark into the cropped image before the
frame goes on means switching the frame on cannot change the watermark's size.

### Two gestures, one rectangle

The crop rect is the only state either gesture mode writes, and it always
lives in source-image pixels. Dragging a trim mark and dragging the photograph
are the same edit expressed two ways — panning the image right subtracts from
`crop.x`, zooming in shrinks `crop.w` about the anchor point — so nothing
downstream needs to know which mode produced the rect.

Zoom is not stored. It is read back out of the rect as `maxW / crop.w`, where
`maxW` is the widest rect of the frame's shape that fits inside the image.
Defining zoom 1 that way rather than as the image's natural size is what makes
whitespace unreachable: the rect is clamped to the image, so the frame is
always fully covered and zooming out simply runs out of room at the shorter
side.

### Everything scales from one number

No dimension in the output is a fixed pixel value. They all derive from
`metric`, the geometric mean of the cropped image:

```js
const metric = Math.sqrt(cropW * cropH);
```

Width alone would be a poor reference. A 2000×1000 landscape and a 1000×2000
portrait would get watermarks differing by a factor of two even though the
images are the same size. The geometric mean gives both 1414, so a phone
snapshot and a 60-megapixel scan produce visually identical output.

This is also why the preview is honest. It renders at 1100 pixels wide and the
export renders at full resolution, from the same settings object. Because
every measurement is a fraction of `metric`, the preview is an exact
proportional twin of the file you save.

### One font specification

`js/lib/text.js` owns the font. The watermark and the caption always render at
the same family, weight and pixel size, because one function decides that size
and nothing else in the codebase sets `ctx.font` with a size it computed
itself.

`resolveTextSize` runs a single clamp across the watermark and all three
caption slots. If one string is too long, they all shrink by the same factor
and stay measurably equal.

Hex labels are deliberate metadata, so they sit at a fixed 0.8 of the matched
size and clamp *separately* against their own column width. Folding them into
the main clamp would mean adding a tenth swatch silently shrank your caption.

### Adding a control

Controls bind declaratively. Add an input to `index.html` with a `data-bind`
path and the generic binder in `js/ui/controls.js` picks it up:

```html
<label class="range-field">
  <span class="field__label">Border width <output data-for="frame.borderPct"></output></span>
  <input type="range" data-bind="frame.borderPct" min="0" max="0.15" step="0.0025" data-format="percent">
</label>
```

Add the matching key to `defaultOptions()` in `js/state.js`. No JavaScript
changes.

## Tests

```bash
node test/logic.test.mjs      # pure logic, no browser needed
```

The browser suites need Playwright and a running server:

```bash
npm install
npx playwright install chromium
python3 -m http.server 8080 &
node test/browser.test.mjs    # drives the real UI
node test/visual.mjs          # writes a matrix of renders to inspect
```

`browser.test.mjs` instruments `CanvasRenderingContext2D.prototype.font` and
asserts on what the renderer actually set, which is how the watermark/caption
match is verified rather than assumed.

## Things worth knowing

**No webfonts.** System stacks only. A font CDN would mean a third-party
request on every page load, which would make the privacy claim in the header
untrue, and it would block the first render. If you add one, await
`document.fonts.ready` before rendering: `measureText` fails silently against
an unloaded face and returns widths for the wrong glyphs.

**Very large images.** A 50-megapixel file decodes fine on desktop but can hit
memory limits on mobile Safari. If you need to handle those, decode with
`createImageBitmap()` and do the work in a Web Worker.

**Transparent backgrounds.** Turning on "Transparent" and exporting as JPEG
would flatten the frame to black, so the export falls back to PNG and says so.

**Platform ratios change.** The presets in `crop-geometry.js` reflect what the
major platforms accepted at the time of writing. Check the current guidelines
before relying on them for a posting workflow.

## Browser support

Chrome, Edge, Firefox and Safari, current versions. `roundRect` has a manual
`arcTo` fallback for older Safari.

## Licence

MIT. See [LICENSE](LICENSE).
