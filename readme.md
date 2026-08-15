# Passepartout

Crop a photograph to a platform aspect ratio, watermark it, mount it in a
frame, and print its colour palette underneath. Everything runs in your browser
with the Canvas API. No upload, no server, no analytics.

![A photograph mounted in a white frame, with a row of colour swatches and
their hex codes printed below it](assets/example.png)

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

**Watermark.** Text, colour, opacity, inset, and a 3x3 grid of nine anchor
positions, with its own typeface and relative size. Press Enter in the text box
for multiple lines; a line-spacing control appears once there is more than one.

**Frame.** Border width, background colour, and a corner radius applied to the
image. The outer corner radius follows the inner one plus the border width, so
the border stays a constant width around the curve.

**Palette.** Two to ten dominant colours pulled from the cropped area, drawn
as evenly spaced circles with their hex codes beneath, in a typeface and colour
of your choosing. Click a swatch in the sidebar to copy its hex.

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
    crop-geometry.js   crop rectangle maths, ratio presets
    text.js            the shared font specification
    layout.js          composition geometry
  ui/
    cropper.js         pointer-driven crop overlay
    controls.js        generic control binding
test/
  logic.test.mjs       85 assertions, runs in Node
  browser.test.mjs     30 assertions, runs in Playwright
  visual.mjs           renders a matrix of configurations to PNG
assets/
  example.png          the screenshot at the top of this file
  fonts/               drop Bigola Display Regular.otf here (see its README)
```

There is no separate documentation site. This README covers setup and the
design decisions; the reasoning behind individual choices lives in comments
next to the code it explains. `js/lib/text.js` and `js/lib/layout.js` are the
two worth reading first if you plan to change how anything is positioned.

### The pipeline

```
crop → watermark → frame → palette
```

The order matters. Burning the watermark into the cropped image before the
frame goes on means switching the frame on cannot change the watermark's size.

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

### Two independent text sizes

`js/lib/text.js` owns everything about canvas text. There are two pieces of it
and they are sized separately:

- `resolveWatermarkSize` — a fraction of `metric`, times the user's optical
  `scale`, shrunk if the widest line would overrun the image width.
- `resolveHexSize` — its own fraction of `metric`, shrunk if a label would
  overrun its palette column.

They do not consult each other. An earlier version tied the labels to the
watermark at a fixed ratio, because a caption row shared the watermark's size
and the labels hung off that. Once the caption went, keeping them coupled would
have meant nudging the watermark's size silently resized the swatch labels.

`scale` is folded into the measurement rather than applied after it. Text width
is linear in size, so measuring at `base * scale` gives the true drawn width and
a scaled-up watermark still cannot overflow.

### Multi-line watermarks

`fillText` has no concept of a newline. It does not wrap, and it does not
error — it simply draws nothing for the `\n`. So lines are split and
positioned by hand in `drawTextBlock`.

The block is anchored by its outer ink edges rather than by baselines: with a
bottom anchor, the *last* line's descender sits on the margin. A two-line
watermark therefore occupies the same bottom edge a one-line one did, growing
upward instead of creeping off the canvas.

The size clamp measures the widest *line*, not the whole string, so breaking a
long watermark across lines relieves the clamp instead of shrinking it.

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
asserts on what the renderer actually set, so typeface and size claims are
verified against the real draw calls rather than assumed.

## Things worth knowing

**Fonts are served from this repository, never a CDN.** A font CDN would mean
a third-party request on every page load, which would make the privacy claim
in the header untrue. `assets/fonts/` holds the custom display face; see the
README in that folder for how to swap it.

The app awaits `document.fonts.ready` before the first render, and it must:
`measureText` fails *silently* against an unloaded face, returning widths for
the wrong glyphs, so the size clamp gets tuned to metrics that never appear on
screen. If the font file is missing the app renders in a serif fallback and
says so under the watermark controls.

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
