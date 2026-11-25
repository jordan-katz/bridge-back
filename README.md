# BridgeBack

A browser tool for the round trip with AI image generators. Paste the image the AI gave you, rough out the changes you want, and send back a packet the model can follow: your rough edit, a marked-up copy with numbered outlines, and a prompt written from your sliders and notes.

The editing is crude on purpose. The AI does the clean render. BridgeBack's job is to make the request unambiguous.

Use it at **[usebridgeback.netlify.app](https://usebridgeback.netlify.app)**. No account, nothing to install.

## What it does

**Global sliders (rendered).** Exposure, contrast, highlights, shadows, saturation, warmth, tint and vignette run on the GPU and show up in the rough edit. The prompt describes them too, so the model keeps the look.

**Direction sliders (prompt only).** How closely to follow the edit, realism, detail, depth of field, lighting drama, mood, light direction, time of day and framing. Plus "keep exactly" checkboxes for faces, text, composition and art style, and a free-text note.

**Regions.** Select with lasso, ellipse, rectangle or a magic wand (hold Shift to add another piece to the selected area, Alt to cut one away). With the Move tool, Shift-click several areas to move them together or combine them into one area with one number and one note. Each region gets a number, a note and its own edits: recolor (keeps shading), hue, saturation, brightness, scale, rotate, mirror, move, remove, and soft edges. When you move or remove something, the hole is filled from its surroundings as a placeholder and the prompt tells the model to fill it properly. Markers (P) mark a spot where something new should go.

**Handoff.** `Copy for AI` (Ctrl+Shift+C) copies the next piece each time you press it: rough edit, marked-up copy, prompt. Paste each into the chat. Options for including the original, combining everything into one labeled image, copying the prompt together with the marked-up copy in a single paste, and Detailed, Short or JSON prompts. Everything can also be saved as files.

**Transparent images.** Images with a transparent background are flattened onto white by default, since image models handle transparency unevenly. Pick gray, black, any color, or keep it transparent under Adjust. The prompt says which.

**Quality of life.** Opens blank, with a Resume button for your last image. Paste or drop to open. Undo and redo. Hold `\` to compare with the original. Sessions autosave in the browser (IndexedDB), with the last eight images under Recent. Works on phones and tablets with touch and pinch zoom.

## Running it

No build step and no dependencies. It is static HTML, CSS and ES modules.

```bash
cd bridge-back
python -m http.server 8080
# open http://localhost:8080
```

ES modules need a server, so opening `index.html` straight from disk will not work.

## Deploying

Netlify serves the repo root as-is (`netlify.toml` sets the publish directory and security headers). Connect the repo in Netlify, or run `netlify deploy --prod` from this folder.

## Layout

```
index.html        markup shell
css/app.css       all styles, light and dark
js/main.js        state, UI, pointer and keyboard handling, handoff
js/regions.js     masks, selection tools, region edits, hole fill, compositing
js/gl.js          WebGL pass for the global sliders
js/prompt.js      prompt builder (Detailed, Short, JSON)
js/export.js      marked-up copy and combined image
js/store.js       IndexedDB autosave and preferences
js/sample.js      the sample scene behind "Try the sample"
```

## Limits

- Images are worked on at up to 2048 px on the long edge. Most image models downscale below that anyway.
- Copying images to the clipboard needs a browser with the async Clipboard API (current Chrome, Edge, Safari and Firefox). If it is blocked, BridgeBack offers to save the file instead.
- Everything stays in your browser. Nothing is uploaded.

## License

MIT. See [LICENSE](LICENSE). Free to use, change and share.
