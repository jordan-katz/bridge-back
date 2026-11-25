# BridgeBack

A browser tool for the round trip with AI image generators. Paste the image the AI gave you, rough out the changes you want, and send back a packet the model can follow: your rough edit, a marked-up copy with numbered marks, and a prompt written from your sliders and notes. When the AI replies, paste its image to start the next round.

The editing is crude on purpose. The AI does the clean render. BridgeBack's job is to make the request unambiguous.

Use it at **[usebridgeback.pages.dev](https://usebridgeback.pages.dev)**. No account, nothing to install.

## What it does

**Mark what should change.** Smart select picks an object with one click. Lasso, brush, box, ellipse and a magic wand cover everything else. Hold Shift to add to the selected area, Alt to cut away. With the Move tool, Shift-click several marks to move them together or combine areas into one, with one number and one note.

**Point and write.** Drag an Arrow from a thing to where it should go. Drop a Text note straight onto the image ("too dark here"). Drop a Marker where something new should appear. Each one is numbered, drawn on the marked-up copy, and explained in the prompt.

**Rough it out.** Each area can be recolored (shading is kept), hue-shifted, brightened, scaled, rotated, mirrored, moved or removed, with soft edges. Moved or removed things leave a placeholder fill, and the prompt asks the model to fill it properly.

**The overall look.** Exposure, contrast, highlights, shadows, saturation, warmth, tint and vignette run on the GPU and show in the rough edit. Direction controls (how closely to follow the edit, realism, detail, depth of field, lighting, mood, light direction, time of day, framing, and what to keep exactly) only shape the prompt.

**Extend the canvas.** Add space on any side, or jump to 1:1, 4:5, 3:2, 16:9 or 9:16. The new area gets a blurred placeholder, the marked-up copy frames the original, and the prompt asks for the scene to continue.

**Hand it back.** `Copy for AI` (Ctrl+Shift+C) copies the next piece each time you press it. Preview shows every image and the full prompt before you copy. Options for including the original, combining everything into one labeled image, copying the prompt together with the marked-up copy, and Detailed, Short or JSON prompts. Everything can also be saved as files.

**Round by round.** Paste the AI's reply and it becomes the next round. Your marks carry over, switched off. Turn back on any the AI missed and they go out as "still needed". Earlier rounds stay viewable, and you can go back to one.

**Transparent images** are flattened onto white by default, since image models handle transparency unevenly. Pick gray, black, any color, or keep it transparent under Adjust.

**Quality of life.** A one-minute tour on first visit. Undo and redo. Hold `\` to compare with the original. Autosave in the browser, with the last eight images under Recent. Works on phones and tablets with touch and pinch zoom.

## Privacy

Your images never leave your browser. Nothing is uploaded.

Smart select runs the [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform) segmentation model on your own device with [transformers.js](https://github.com/huggingface/transformers.js). The first time you use it, the browser downloads the library from jsDelivr and the model (about 14 MB) from Hugging Face, then caches both.

## Running it

No build step and no dependencies. It is static HTML, CSS and ES modules.

```bash
cd bridge-back
python -m http.server 8080
# open http://localhost:8080
```

ES modules need a server, so opening `index.html` straight from disk will not work. A plain local server skips the headers in `_headers`, so smart select runs on one CPU thread there and is slower than on the live site.

## Deploying

Cloudflare Pages serves the repo root as-is: no build command, output directory `/`. Every push to `main` deploys. `_headers` sets the security headers, including the content security policy that allows the two hosts smart select loads from, and the cross-origin isolation that lets the model use several CPU threads.

## Layout

```
index.html            markup shell
_headers              security headers for Cloudflare Pages
css/app.css           all styles, light and dark
js/main.js            state, UI, tools, pointer and keyboard handling, rounds, handoff
js/regions.js         masks, selection tools, region edits, hole fill, compositing
js/canvasext.js       canvas extension and its placeholder fill
js/segment.js         smart select, main-thread side
js/segment-worker.js  smart select model, runs in a worker
js/gl.js              WebGL pass for the global sliders
js/prompt.js          prompt builder (Detailed, Short, JSON)
js/export.js          marked-up copy, callouts and combined image
js/tour.js            first-run tour
js/store.js           IndexedDB autosave and preferences
js/sample.js          the sample scene behind "Try the sample"
```

## Limits

- Images are worked on at up to 2048 px on the long edge, and up to 3072 px once the canvas is extended. Most image models downscale below that anyway.
- Smart select analyzes each image once. The first time it also downloads the model, so expect 10 to 30 seconds. After that each click takes well under a second.
- Copying images to the clipboard needs a browser with the async Clipboard API (current Chrome, Edge, Safari and Firefox). If it is blocked, BridgeBack offers to save the file instead.

## License

MIT. See [LICENSE](LICENSE). Free to use, change and share.
