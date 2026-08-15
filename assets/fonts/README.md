# Fonts

Drop **`Bigola Display Regular.otf`** in this folder.

The filename must match exactly, spaces included. It is referenced from
`css/styles.css`:

```css
@font-face {
  font-family: "Bigola Display";
  src: url("../assets/fonts/Bigola%20Display%20Regular.otf") format("opentype");
}
```

The `%20` is the URL encoding for the spaces. If you rename the file, update
that line to match.

## If the font is missing

The app still works. It falls back to a serif stack, and a note appears under
the watermark typeface control saying the face did not load. Nothing throws.

## Using a different font

1. Put the file here.
2. Point the `src` in `css/styles.css` at it, and set `format()` to match:
   `opentype` for `.otf`, `truetype` for `.ttf`, `woff2` for `.woff2`.
3. Change `font-family` in that same rule to whatever you want to call it.
4. Update `DISPLAY_FAMILY` and the `display` entry in `FONT_STACKS`, both in
   `js/lib/text.js`, to the same name.

Prefer `.woff2` if you have it — typically 40% smaller than `.otf` for the
same face, which matters because the file is fetched before the first render.

## Licensing

Check that your licence permits web embedding before publishing. Many retail
and free-for-personal-use fonts allow desktop installation but not webfont
serving, and a public GitHub Pages site is unambiguously the latter. This
repository ships no font files.
