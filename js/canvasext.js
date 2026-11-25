// Extend canvas: pad the image on any side and fill the new space with a soft placeholder
// made from the image's own edges, so the AI sees what to continue.

import { makeCanvas } from './util.js';

export const MAX_EXTENDED = 3072;
export const noExt = () => ({ t: 0, r: 0, b: 0, l: 0 });
export const hasExt = (e) => !!(e && (e.t || e.r || e.b || e.l));
export const sameExt = (a, b) => (a?.t || 0) === (b?.t || 0) && (a?.r || 0) === (b?.r || 0) && (a?.b || 0) === (b?.b || 0) && (a?.l || 0) === (b?.l || 0);

/** Aspect presets offered in the panel. 0 means "back to the original frame". */
export const ASPECTS = [
  ['orig', 'Original', 0],
  ['1:1', '1:1', 1],
  ['4:5', '4:5', 4 / 5],
  ['3:2', '3:2', 3 / 2],
  ['16:9', '16:9', 16 / 9],
  ['9:16', '9:16', 9 / 16],
];

/** Padding that brings a w×h image to `ratio`, split evenly, only ever adding space. */
export function extForAspect(w, h, ratio) {
  if (!ratio) return noExt();
  if (w / h < ratio) {
    const add = Math.round(h * ratio - w);
    return { t: 0, b: 0, l: Math.floor(add / 2), r: Math.ceil(add / 2) };
  }
  const add = Math.round(w / ratio - h);
  return { l: 0, r: 0, t: Math.floor(add / 2), b: Math.ceil(add / 2) };
}

/** Keep the padded size under MAX_EXTENDED by trimming each side proportionally. */
export function clampExt(e, w, h) {
  const out = { t: Math.max(0, Math.round(e.t || 0)), r: Math.max(0, Math.round(e.r || 0)), b: Math.max(0, Math.round(e.b || 0)), l: Math.max(0, Math.round(e.l || 0)) };
  const fit = (a, b, size) => {
    const room = Math.max(0, MAX_EXTENDED - size);
    if (a + b <= room) return [a, b];
    const k = room / (a + b);
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  [out.l, out.r] = fit(out.l, out.r, w);
  [out.t, out.b] = fit(out.t, out.b, h);
  return out;
}

/** Downscale then upscale: a cheap, strong blur that works everywhere. */
function softened(src, w, h, k) {
  const small = makeCanvas(Math.max(2, Math.round(src.width / k)), Math.max(2, Math.round(src.height / k)));
  const sx = small.getContext('2d');
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(src, 0, 0, small.width, small.height);
  const out = makeCanvas(w, h);
  const ox = out.getContext('2d');
  ox.imageSmoothingEnabled = true;
  ox.imageSmoothingQuality = 'high';
  ox.drawImage(small, 0, 0, w, h);
  return out;
}

/** The padded working image: the original in the middle, a smeared continuation around it. */
export function buildExtended(base0, e) {
  if (!hasExt(e)) return base0;
  const w = base0.width, h = base0.height;
  const W = w + e.l + e.r, H = h + e.t + e.b;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  // 1. A heavily blurred version of the whole image stretched over the full canvas.
  x.drawImage(softened(base0, W, H, Math.max(16, Math.round(Math.max(w, h) / 24))), 0, 0);
  // 2. Edge strips stretched outward, then blurred, for color continuity at the seams.
  const strip = makeCanvas(W, H);
  const s = strip.getContext('2d');
  const d = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  if (e.l) s.drawImage(base0, 0, 0, d, h, 0, e.t, e.l, h);
  if (e.r) s.drawImage(base0, w - d, 0, d, h, e.l + w, e.t, e.r, h);
  if (e.t) s.drawImage(base0, 0, 0, w, d, e.l, 0, w, e.t);
  if (e.b) s.drawImage(base0, 0, h - d, w, d, e.l, e.t + h, w, e.b);
  if (e.l && e.t) s.drawImage(base0, 0, 0, d, d, 0, 0, e.l, e.t);
  if (e.r && e.t) s.drawImage(base0, w - d, 0, d, d, e.l + w, 0, e.r, e.t);
  if (e.l && e.b) s.drawImage(base0, 0, h - d, d, d, 0, e.t + h, e.l, e.b);
  if (e.r && e.b) s.drawImage(base0, w - d, h - d, d, d, e.l + w, e.t + h, e.r, e.b);
  x.globalAlpha = 0.85;
  x.drawImage(softened(strip, W, H, 10), 0, 0);
  x.globalAlpha = 1;
  // 3. The original, untouched.
  x.drawImage(base0, e.l, e.t);
  return c;
}
