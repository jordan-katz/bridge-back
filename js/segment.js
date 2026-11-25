// Main-thread side of smart select. Talks to segment-worker.js and keeps one image analyzed at a time.

import { makeCanvas } from './util.js';

const EMBED_MAX = 1024; // the model works at 1024 px; larger inputs only cost time

let worker = null;
let seq = 0;
const pending = new Map();
let progressCb = null;
let ready = false;
let embeddedKey = null;
let embedding = null;
let scale = 1;

function start() {
  if (worker) return worker;
  worker = new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      progressCb?.(m.loaded, m.total);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'failed'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'));
    pending.clear();
    worker = null;
    ready = false;
    embeddedKey = null;
  };
  return worker;
}

function call(type, payload = {}, transfer = []) {
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...payload }, transfer);
  });
}

export const isReady = () => ready;
export const isAnalyzed = (key) => embeddedKey === key;

/** Load the model (first use downloads about 14 MB). `onProgress(loaded, total)` reports bytes. */
export async function ensureModel(onProgress) {
  progressCb = onProgress || null;
  if (ready) return;
  await call('load');
  ready = true;
}

/** Analyze `canvas` once per `key`. Later clicks on the same key are fast. */
export function analyze(key, canvas) {
  if (embeddedKey === key && !embedding) return Promise.resolve();
  if (embedding && embedding.key === key) return embedding.p;
  scale = Math.min(1, EMBED_MAX / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
  const c = makeCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, w, h);
  const rgba = x.getImageData(0, 0, w, h).data;
  const p = call('embed', { key, rgba, w, h }, [rgba.buffer]).then(() => {
    embeddedKey = key;
    embedding = null;
  }, (err) => {
    embedding = null;
    throw err;
  });
  embedding = { key, p };
  return p;
}

/**
 * Get the mask for clicked points (image coords of the full-size image).
 * Returns { canvas, w, h } where canvas is a white-on-transparent mask at analysis size, and the scale used.
 */
export async function pick(key, points) {
  const r = await call('decode', { key, points: points.map((p) => ({ x: p.x * scale, y: p.y * scale, label: p.label })) });
  const { bits, w, h } = r;
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  const img = x.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      const k = i * 4;
      d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return { canvas: c, scale, score: r.score };
}
