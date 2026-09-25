// Region masks, per-region edits, and the composite pass.
// A mask is immutable: {id, x, y, w, h, canvas}. The canvas alpha channel is the selection.

import { makeCanvas, ctx2d, uid, clamp, hexToRgb, rgbToHsl, hslToRgb } from './util.js';

export const defaultOps = () => ({
  recolor: null, // '#rrggbb' or null
  recolorAmt: 100,
  hue: 0, // -180..180
  sat: 0, // -100..100
  bright: 0, // -100..100
  scale: 100, // percent
  rotate: 0, // degrees, clockwise
  flipX: false,
  dx: 0,
  dy: 0,
  remove: false,
  fill: 'smudge', // 'smudge' | 'flat' | 'keep'
  feather: 0, // px
});

export const isMoved = (o) => !!(o.dx || o.dy || o.scale !== 100 || o.rotate || o.flipX);
export const hasColorOps = (o) => !!((o.recolor && o.recolorAmt > 0) || o.hue || o.sat || o.bright);
export const isActive = (r) =>
  r.kind === 'area' && r.enabled && (hasColorOps(r.ops) || isMoved(r.ops) || r.ops.remove);

// ---------- mask construction ----------

/** Trim a canvas to its non-transparent pixels and wrap it as a mask. Returns null if empty. */
export function makeMask(canvas, x, y) {
  const w = canvas.width, h = canvas.height;
  const d = ctx2d(canvas, true).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let yy = 0; yy < h; yy++) {
    const row = yy * w;
    for (let xx = 0; xx < w; xx++) {
      if (d[(row + xx) * 4 + 3] > 8) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  if (maxX < 0) return null;
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const c = makeCanvas(tw, th);
  c.getContext('2d').drawImage(canvas, -minX, -minY);
  return { id: uid(), x: x + minX, y: y + minY, w: tw, h: th, canvas: c };
}

function clipBox(x0, y0, x1, y1, W, H) {
  const x = clamp(Math.floor(Math.min(x0, x1)) - 1, 0, W);
  const y = clamp(Math.floor(Math.min(y0, y1)) - 1, 0, H);
  const xe = clamp(Math.ceil(Math.max(x0, x1)) + 1, 0, W);
  const ye = clamp(Math.ceil(Math.max(y0, y1)) + 1, 0, H);
  if (xe - x < 1 || ye - y < 1) return null;
  return { x, y, w: xe - x, h: ye - y };
}

export function rasterPolygon(pts, W, H) {
  if (pts.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const b = clipBox(x0, y0, x1, y1, W, H);
  if (!b) return null;
  const c = makeCanvas(b.w, b.h);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.beginPath();
  pts.forEach((p, i) => (i ? x.lineTo(p.x - b.x, p.y - b.y) : x.moveTo(p.x - b.x, p.y - b.y)));
  x.closePath();
  x.fill();
  return makeMask(c, b.x, b.y);
}

export function rasterEllipse(a, bpt, W, H) {
  const b = clipBox(a.x, a.y, bpt.x, bpt.y, W, H);
  if (!b) return null;
  const rx = Math.abs(bpt.x - a.x) / 2, ry = Math.abs(bpt.y - a.y) / 2;
  if (rx < 1 || ry < 1) return null;
  const cx = (a.x + bpt.x) / 2 - b.x, cy = (a.y + bpt.y) / 2 - b.y;
  const c = makeCanvas(b.w, b.h);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.beginPath();
  x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  x.fill();
  return makeMask(c, b.x, b.y);
}

export function rasterRect(a, bpt, W, H) {
  const x0 = clamp(Math.min(a.x, bpt.x), 0, W), x1 = clamp(Math.max(a.x, bpt.x), 0, W);
  const y0 = clamp(Math.min(a.y, bpt.y), 0, H), y1 = clamp(Math.max(a.y, bpt.y), 0, H);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const bx = Math.floor(x0), by = Math.floor(y0);
  const c = makeCanvas(Math.ceil(x1) - bx, Math.ceil(y1) - by);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(x0 - bx, y0 - by, x1 - x0, y1 - y0);
  return makeMask(c, bx, by);
}

/** Combine two masks. mode 'add' unions, 'sub' removes b from a. */
export function combineMasks(a, b, mode) {
  let x, y, w, h;
  if (mode === 'add') {
    x = Math.min(a.x, b.x); y = Math.min(a.y, b.y);
    w = Math.max(a.x + a.w, b.x + b.w) - x;
    h = Math.max(a.y + a.h, b.y + b.h) - y;
  } else {
    ({ x, y, w, h } = a);
  }
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(a.canvas, a.x - x, a.y - y);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : 'destination-out';
  ctx.drawImage(b.canvas, b.x - x, b.y - y);
  return makeMask(c, x, y);
}

/** Magic wand: select pixels whose color is within `tol` (0..100) of the clicked pixel. */
export function wandMask(img, sx, sy, tol, contiguous) {
  const { width: W, height: H, data: d } = img;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const i0 = (sy * W + sx) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const t = (tol / 100) * 441.7;
  const t2 = t * t;
  const sel = new Uint8Array(W * H);
  const match = (p) => {
    const j = p * 4;
    const dr = d[j] - r0, dg = d[j + 1] - g0, db = d[j + 2] - b0, da = d[j + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da * 2 <= t2;
  };
  if (contiguous) {
    const stack = new Int32Array(W * H);
    let sp = 0;
    const start = sy * W + sx;
    stack[sp++] = start;
    sel[start] = 1;
    while (sp) {
      const p = stack[--sp];
      const px = p % W, py = (p - px) / W;
      if (px > 0 && !sel[p - 1] && match(p - 1)) { sel[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < W - 1 && !sel[p + 1] && match(p + 1)) { sel[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0 && !sel[p - W] && match(p - W)) { sel[p - W] = 1; stack[sp++] = p - W; }
      if (py < H - 1 && !sel[p + W] && match(p + W)) { sel[p + W] = 1; stack[sp++] = p + W; }
    }
  } else {
    for (let p = 0; p < W * H; p++) if (match(p)) sel[p] = 1;
  }
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (sel[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (sel[(y + minY) * W + x + minX]) {
        const k = (y * w + x) * 4;
        od[k] = od[k + 1] = od[k + 2] = 255;
        od[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return { id: uid(), x: minX, y: minY, w, h, canvas: c };
}

/** The region's mask as it sits now (moved, scaled, rotated), in image coords. */
export function placedMask(r) {
  if (!isMoved(r.ops)) return r.mask;
  const c4 = corners(r);
  const bx = Math.floor(Math.min(...c4.map((p) => p.x))) - 1, by = Math.floor(Math.min(...c4.map((p) => p.y))) - 1;
  const bw = Math.ceil(Math.max(...c4.map((p) => p.x))) + 1 - bx, bh = Math.ceil(Math.max(...c4.map((p) => p.y))) + 1 - by;
  const c = makeCanvas(bw, bh);
  const x = c.getContext('2d');
  x.translate(-bx, -by);
  applyTransform(x, r);
  x.drawImage(r.mask.canvas, r.mask.x, r.mask.y);
  return makeMask(c, bx, by);
}

/** Map a mask drawn at a region's current (moved) position back into its original space. */
export function toRegionSpace(r, mask) {
  if (!isMoved(r.ops)) return mask;
  const pts = [
    inv(r, mask.x, mask.y), inv(r, mask.x + mask.w, mask.y),
    inv(r, mask.x + mask.w, mask.y + mask.h), inv(r, mask.x, mask.y + mask.h),
  ];
  const bx = Math.floor(Math.min(...pts.map((p) => p.x))) - 1, by = Math.floor(Math.min(...pts.map((p) => p.y))) - 1;
  const bw = Math.ceil(Math.max(...pts.map((p) => p.x))) + 1 - bx, bh = Math.ceil(Math.max(...pts.map((p) => p.y))) + 1 - by;
  const c = makeCanvas(bw, bh);
  const x = c.getContext('2d');
  const t = tf(r);
  x.translate(-bx, -by);
  x.translate(t.cx, t.cy);
  x.scale(1 / (t.s * t.fx), 1 / t.s);
  x.rotate(-t.rot);
  x.translate(-t.tx, -t.ty);
  x.drawImage(mask.canvas, mask.x, mask.y);
  return makeMask(c, bx, by);
}

// ---------- mask derivatives (cached; masks are immutable) ----------

const alphaCache = new WeakMap();
export function maskAlpha(m) {
  let a = alphaCache.get(m.canvas);
  if (!a) {
    const d = ctx2d(m.canvas, true).getImageData(0, 0, m.w, m.h).data;
    a = new Uint8ClampedArray(m.w * m.h);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    alphaCache.set(m.canvas, a);
  }
  return a;
}

const pathCache = new WeakMap();
/** Outline of the mask as a Path2D in image coordinates (pixel-edge runs). */
export function maskPath(m) {
  let p = pathCache.get(m.canvas);
  if (p) return p;
  const a = maskAlpha(m);
  const { w, h, x: ox, y: oy } = m;
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && a[y * w + x] >= 128;
  p = new Path2D();
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const e = x < w && inside(x, y) !== inside(x, y - 1);
      if (e && run < 0) run = x;
      else if (!e && run >= 0) {
        p.moveTo(ox + run, oy + y);
        p.lineTo(ox + x, oy + y);
        run = -1;
      }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const e = y < h && inside(x, y) !== inside(x - 1, y);
      if (e && run < 0) run = y;
      else if (!e && run >= 0) {
        p.moveTo(ox + x, oy + run);
        p.lineTo(ox + x, oy + y);
        run = -1;
      }
    }
  }
  pathCache.set(m.canvas, p);
  return p;
}

const anchorCache = new WeakMap();
/** Topmost point of the mask, in original image coords. */
export function maskAnchor(m) {
  let a = anchorCache.get(m.canvas);
  if (a) return a;
  const al = maskAlpha(m);
  a = { x: m.x + m.w / 2, y: m.y };
  outer: for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (al[y * m.w + x] >= 128) {
        let x2 = x;
        while (x2 + 1 < m.w && al[y * m.w + x2 + 1] >= 128) x2++;
        a = { x: m.x + (x + x2 + 1) / 2, y: m.y + y };
        break outer;
      }
    }
  }
  anchorCache.set(m.canvas, a);
  return a;
}

/** Where a region's number badge sits, at its current position. */
export function regionAnchor(r) {
  const a = maskAnchor(r.mask);
  return r.ops.remove ? a : fwd(r, a.x, a.y);
}

const canFilter = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    return typeof c.filter === 'string';
  } catch {
    return false;
  }
})();

const featherCache = new WeakMap();
/** Mask with softened edges. Same center as the source mask. */
export function effectiveMask(m, f) {
  if (!f || !canFilter) return m;
  let per = featherCache.get(m.canvas);
  if (!per) featherCache.set(m.canvas, (per = new Map()));
  if (per.has(f)) return per.get(f);
  const pad = Math.ceil(f * 1.2) + 1;
  const c = makeCanvas(m.w + pad * 2, m.h + pad * 2);
  const x = c.getContext('2d');
  x.filter = `blur(${(f / 2).toFixed(1)}px)`;
  x.drawImage(m.canvas, pad, pad);
  const out = { id: m.id + ':f' + f, x: m.x - pad, y: m.y - pad, w: c.width, h: c.height, canvas: c };
  per.set(f, out);
  return out;
}

const dilateCache = new WeakMap();
function dilated(m, r) {
  const hit = dilateCache.get(m.canvas);
  if (hit && hit.r === r) return hit.m;
  const c = makeCanvas(m.w + r * 2, m.h + r * 2);
  const x = c.getContext('2d');
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy <= r * r) x.drawImage(m.canvas, r + dx, r + dy);
  }
  const out = { id: m.id + ':d', x: m.x - r, y: m.y - r, w: c.width, h: c.height, canvas: c };
  dilateCache.set(m.canvas, { r, m: out });
  return out;
}

// ---------- transforms ----------

export function tf(r) {
  const m = r.mask, o = r.ops;
  const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
  return { cx, cy, tx: cx + o.dx, ty: cy + o.dy, s: o.scale / 100, rot: (o.rotate * Math.PI) / 180, fx: o.flipX ? -1 : 1 };
}

export function applyTransform(ctx, r) {
  const t = tf(r);
  ctx.translate(t.tx, t.ty);
  ctx.rotate(t.rot);
  ctx.scale(t.s * t.fx, t.s);
  ctx.translate(-t.cx, -t.cy);
}

/** Original-position image coords -> current (moved) image coords. */
export function fwd(r, x, y) {
  const t = tf(r);
  const dx = (x - t.cx) * t.s * t.fx, dy = (y - t.cy) * t.s;
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  return { x: t.tx + dx * c - dy * s, y: t.ty + dx * s + dy * c };
}

/** Current image coords -> original-position image coords. */
export function inv(r, X, Y) {
  const t = tf(r);
  const dx = X - t.tx, dy = Y - t.ty;
  const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return { x: x / (t.s * t.fx) + t.cx, y: y / t.s + t.cy };
}

export function corners(r) {
  const m = r.mask;
  return [
    fwd(r, m.x, m.y), fwd(r, m.x + m.w, m.y),
    fwd(r, m.x + m.w, m.y + m.h), fwd(r, m.x, m.y + m.h),
  ];
}

/** Is the image point inside this area region (at its current position)? */
export function hitArea(r, X, Y, useOriginal = false) {
  const p = useOriginal ? { x: X, y: Y } : inv(r, X, Y);
  const m = r.mask;
  const lx = Math.floor(p.x - m.x), ly = Math.floor(p.y - m.y);
  if (lx < 0 || ly < 0 || lx >= m.w || ly >= m.h) return false;
  return maskAlpha(m)[ly * m.w + lx] >= 64;
}

// ---------- pixel work ----------

function colorize(img, alpha, o) {
  const d = img.data;
  const n = alpha.length;
  let tr = 0, tg = 0, tb = 0, th = 0, ts = 0, tl = 0, mean = 0;
  const amt = o.recolor ? o.recolorAmt / 100 : 0;
  if (amt > 0) {
    [tr, tg, tb] = hexToRgb(o.recolor).map((v) => v / 255);
    [th, ts, tl] = rgbToHsl(tr, tg, tb);
    let sum = 0, wsum = 0;
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      if (!a) continue;
      const j = i * 4;
      const l = (Math.max(d[j], d[j + 1], d[j + 2]) + Math.min(d[j], d[j + 1], d[j + 2])) / 510;
      sum += l * a;
      wsum += a;
    }
    mean = wsum ? sum / wsum : 0.5;
  }
  const hue = o.hue / 360, sat = o.sat / 100, br = o.bright / 100;
  const doHsl = hue !== 0 || sat !== 0;
  for (let i = 0; i < n; i++) {
    if (!alpha[i]) continue;
    const j = i * 4;
    let r = d[j] / 255, g = d[j + 1] / 255, b = d[j + 2] / 255;
    if (amt > 0) {
      const [, , l] = rgbToHsl(r, g, b);
      const nl = clamp(l + (tl - mean) * 0.9, 0, 1);
      const [nr, ng, nb] = hslToRgb(th, ts, nl);
      r += (nr - r) * amt;
      g += (ng - g) * amt;
      b += (nb - b) * amt;
    }
    if (doHsl) {
      let [hh, ss, ll] = rgbToHsl(r, g, b);
      hh = (hh + hue + 1) % 1;
      ss = clamp(sat >= 0 ? ss + (1 - ss) * sat * 0.9 : ss * (1 + sat), 0, 1);
      [r, g, b] = hslToRgb(hh, ss, ll);
    }
    if (br > 0) {
      r += (1 - r) * br * 0.6; g += (1 - g) * br * 0.6; b += (1 - b) * br * 0.6;
    } else if (br < 0) {
      r *= 1 + br * 0.7; g *= 1 + br * 0.7; b *= 1 + br * 0.7;
    }
    d[j] = r * 255; d[j + 1] = g * 255; d[j + 2] = b * 255;
  }
}

/** Fill the area under mask `m` on `comp` with the average surrounding color, optionally smudged. */
function fillHole(comp, m, mode) {
  const W = comp.width, H = comp.height;
  const pad = Math.round(clamp(Math.max(m.w, m.h) * 0.25, 10, 90));
  const ex = clamp(m.x - pad, 0, W), ey = clamp(m.y - pad, 0, H);
  const exr = clamp(m.x + m.w + pad, 0, W), eyb = clamp(m.y + m.h + pad, 0, H);
  const ew = exr - ex, eh = eyb - ey;
  if (ew < 1 || eh < 1) return;
  const cx = ctx2d(comp, true);
  const src = cx.getImageData(ex, ey, ew, eh).data;
  const a = maskAlpha(m);
  const step = Math.max(1, Math.floor(Math.sqrt((ew * eh) / 40000)));
  let R = 0, G = 0, B = 0, N = 0;
  for (let y = 0; y < eh; y += step) {
    for (let x = 0; x < ew; x += step) {
      const mx = x + ex - m.x, my = y + ey - m.y;
      const inMask = mx >= 0 && my >= 0 && mx < m.w && my < m.h && a[my * m.w + mx] > 20;
      if (inMask) continue;
      const j = (y * ew + x) * 4;
      if (src[j + 3] < 10) continue;
      R += src[j]; G += src[j + 1]; B += src[j + 2]; N++;
    }
  }
  const avg = N ? `rgb(${R / N | 0},${G / N | 0},${B / N | 0})` : 'rgb(128,128,128)';

  const hole = makeCanvas(m.w, m.h);
  const hx = hole.getContext('2d');
  if (mode === 'flat') {
    hx.fillStyle = avg;
    hx.fillRect(0, 0, m.w, m.h);
  } else {
    // Push-pull fill: shrink the surroundings (with the hole cut out) down a pyramid,
    // then grow back up, letting coarser levels flow into the hole.
    const tmp = makeCanvas(ew, eh);
    const tx = tmp.getContext('2d');
    tx.drawImage(comp, ex, ey, ew, eh, 0, 0, ew, eh);
    tx.globalCompositeOperation = 'destination-out';
    tx.drawImage(m.canvas, m.x - ex, m.y - ey);
    const levels = [tmp];
    let cur = tmp;
    while ((cur.width > 2 || cur.height > 2) && levels.length < 14) {
      const nx = makeCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const c2 = nx.getContext('2d');
      c2.imageSmoothingEnabled = true;
      c2.imageSmoothingQuality = 'high';
      c2.drawImage(cur, 0, 0, nx.width, nx.height);
      levels.push(nx);
      cur = nx;
    }
    let acc = makeCanvas(cur.width, cur.height);
    const ac = acc.getContext('2d');
    ac.fillStyle = avg;
    ac.fillRect(0, 0, acc.width, acc.height);
    ac.drawImage(cur, 0, 0);
    for (let i = levels.length - 2; i >= 0; i--) {
      const L = levels[i];
      const up = makeCanvas(L.width, L.height);
      const u = up.getContext('2d');
      u.imageSmoothingEnabled = true;
      u.imageSmoothingQuality = 'high';
      u.drawImage(acc, 0, 0, L.width, L.height);
      u.drawImage(L, 0, 0);
      acc = up;
    }
    hx.drawImage(acc, ex - m.x, ey - m.y);
  }
  hx.globalCompositeOperation = 'destination-in';
  hx.drawImage(m.canvas, 0, 0);
  cx.drawImage(hole, m.x, m.y);
}

/** Draw `base` into `comp`, then apply every active region in order. */
export function composite(comp, base, regions, matte) {
  const ctx = ctx2d(comp, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, comp.width, comp.height);
  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, comp.width, comp.height);
  }
  ctx.drawImage(base, 0, 0);
  for (const r of regions) {
    if (!isActive(r)) continue;
    const o = r.ops;
    const em = effectiveMask(r.mask, o.feather);
    let patch = null;
    if (!o.remove) {
      patch = makeCanvas(em.w, em.h);
      const px = ctx2d(patch, true);
      px.drawImage(comp, -em.x, -em.y);
      if (hasColorOps(o)) {
        const img = px.getImageData(0, 0, em.w, em.h);
        colorize(img, maskAlpha(em), o);
        px.putImageData(img, 0, 0);
      }
      px.globalCompositeOperation = 'destination-in';
      px.drawImage(em.canvas, 0, 0);
    }
    if (o.remove || (isMoved(o) && o.fill !== 'keep')) {
      fillHole(comp, dilated(em, 2), o.fill === 'flat' ? 'flat' : 'smudge');
    }
    if (patch) {
      ctx.save();
      applyTransform(ctx, r);
      ctx.drawImage(patch, em.x, em.y);
      ctx.restore();
    }
  }
}
