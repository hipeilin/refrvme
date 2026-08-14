# Fonts

The watermark is set in **Bigola Display**. Drop the file here, named exactly:

```
assets/fonts/Bigola Display Regular.otf
```

The name is load-bearing — `js/lib/text.js` requests that URL (percent-encoded)
through the FontFace API. A different filename means the face will not load.

If the file is absent the app still works: the watermark falls back to whichever
composition font is selected, and the Watermark panel says so rather than
letting the substitution pass unnoticed.

The font is not in this repository because it is not ours to redistribute —
check its licence covers web embedding before deploying it.
