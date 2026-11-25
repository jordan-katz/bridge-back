// Smart select worker: runs SlimSAM (Segment Anything, distilled) with transformers.js.
// The library loads from jsDelivr and the model from Hugging Face the first time it is used.
// The browser caches both, so later visits start instantly and nothing counts against this site.

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';
const MODEL = 'Xenova/slimsam-77-uniform';

let lib = null;
let model = null;
let processor = null;
let loading = null;
let current = null; // { key, inputs, embeddings, w, h }

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function load() {
  if (loading) return loading;
  loading = (async () => {
    lib = await import(LIB);
    lib.env.allowLocalModels = false;
    const files = new Map();
    const progress = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: 'progress', loaded, total });
    };
    [model, processor] = await Promise.all([
      lib.SamModel.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress }),
      lib.AutoProcessor.from_pretrained(MODEL, { progress_callback: progress }),
    ]);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

async function embed(key, rgba, w, h) {
  if (current && current.key === key) return;
  await load();
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  const image = new lib.RawImage(rgb, w, h, 3);
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);
  current = { key, inputs, embeddings, w, h };
}

async function decode(key, points) {
  if (!current || current.key !== key) throw new Error('not-embedded');
  const { inputs, embeddings, w, h } = current;
  const [rh, rw] = inputs.reshaped_input_sizes[0];
  const coords = points.flatMap((p) => [(p.x / w) * rw, (p.y / h) * rh]);
  const input_points = new lib.Tensor('float32', coords, [1, 1, points.length, 2]);
  const input_labels = new lib.Tensor('int64', points.map((p) => BigInt(p.label ? 1 : 0)), [1, 1, points.length]);
  const out = await model({ ...embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
  const scores = out.iou_scores.data;
  let best = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k] > scores[best]) best = k;
  const n = w * h;
  const bits = new Uint8Array(n);
  const data = masks[0].data;
  const off = best * n;
  for (let i = 0; i < n; i++) bits[i] = data[off + i] ? 1 : 0;
  return { bits, w, h, score: scores[best] };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'load') {
      await load();
      post({ id, ok: true });
    } else if (type === 'embed') {
      await embed(e.data.key, e.data.rgba, e.data.w, e.data.h);
      post({ id, ok: true });
    } else if (type === 'decode') {
      const r = await decode(e.data.key, e.data.points);
      post({ id, ok: true, ...r }, [r.bits.buffer]);
    }
  } catch (err) {
    post({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
