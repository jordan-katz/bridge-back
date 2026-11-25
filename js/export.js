// Builds the images that go back to the AI: annotated copy and combined panels.

import { makeCanvas } from './util.js';
import { maskPath, applyTransform, isMoved, tf, regionAnchor } from './regions.js';
import { regionColor, shortSummary, liveRegions } from './prompt.js';

const FONT = '"Schibsted Grotesk", "Segoe UI", system-ui, sans-serif';
const MONO = '"Martian Mono", ui-monospace, "Cascadia Mono", Menlo, monospace';

export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function badge(ctx, x, y, r, n, color) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = r * 0.5;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(r * 1.15)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + r * 0.04);
  ctx.restore();
}

export function drawPinMarker(ctx, x, y, r, n, color) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - r * 0.62, y - r * 1.25);
  ctx.lineTo(x + r * 0.62, y - r * 1.25);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  badge(ctx, x, y - r * 1.9, r, n, color);
}

function arrow(ctx, x0, y0, x1, y1, color, lw) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < lw * 6) return;
  const head = Math.min(len * 0.35, lw * 5);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 2.5, lw * 2]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(a) * head * 0.8, y1 - Math.sin(a) * head * 0.8);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a - 0.45) * head, y1 - Math.sin(a - 0.45) * head);
  ctx.lineTo(x1 - Math.cos(a + 0.45) * head, y1 - Math.sin(a + 0.45) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A solid callout arrow: thick shaft, filled head. `lw` is the shaft width. */
export function drawCalloutArrow(ctx, x0, y0, x1, y1, color, lw) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 2) return;
  const head = Math.min(len * 0.45, lw * 4.2);
  const bx = x1 - Math.cos(a) * head * 0.85, by = y1 - Math.sin(a) * head * 0.85;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pass = (stroke, width) => {
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 + Math.cos(a) * (width - lw) * 0.6, y1 + Math.sin(a) * (width - lw) * 0.6);
    ctx.lineTo(x1 - Math.cos(a - 0.5) * head, y1 - Math.sin(a - 0.5) * head);
    ctx.lineTo(x1 - Math.cos(a + 0.5) * head, y1 - Math.sin(a + 0.5) * head);
    ctx.closePath();
    ctx.fill();
    if (width > lw) {
      ctx.lineWidth = width - lw;
      ctx.stroke();
    }
  };
  pass('rgba(0,0,0,.5)', lw + Math.max(2, lw * 0.6));
  pass(color, lw);
  ctx.restore();
}

/** Wrap text to lines no wider than maxW with the context's current font. */
function wrap(ctx, text, maxW, maxLines = 4) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines.length ? lines : [''];
}

/**
 * A note written on the image: a label card with a numbered badge on its left edge.
 * (x, y) is the card's top-left. Returns its box so callers can hit-test it.
 */
export function drawTextCallout(ctx, x, y, text, size, n, color, { selected = false, maxW } = {}) {
  ctx.save();
  ctx.font = `600 ${Math.round(size)}px ${FONT}`;
  const pad = size * 0.55;
  const br = size * 0.78;
  const lines = wrap(ctx, text || 'Label', maxW || size * 16);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const lh = size * 1.25;
  const w = tw + pad * 2 + br * 1.4, h = lines.length * lh + pad * 1.4;
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = size * 0.6;
  ctx.shadowOffsetY = size * 0.12;
  ctx.fillStyle = 'rgba(255,255,255,.96)';
  const r = size * 0.35;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = Math.max(1.5, size * (selected ? 0.18 : 0.12));
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = text ? '#15171a' : '#7a828c';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, x + pad + br * 1.4, y + pad * 0.7 + lh * (i + 0.5)));
  ctx.restore();
  badge(ctx, x, y + Math.min(h / 2, br * 1.2), br, n, color);
  return { x: x - br, y, w: w + br, h };
}

/** Rough edit with numbered outlines, move arrows, pins, arrows, labels, and an optional legend strip. */
export function makeAnnotated(rough, allRegions, { legend = true, ext = null } = {}) {
  const regions = liveRegions(allRegions);
  const W = rough.width, H = rough.height;
  const unit = Math.max(W, H);
  const lw = Math.max(2, unit / 420);
  const br = Math.max(11, unit / 58);

  const rows = legend ? regions.length : 0;
  const lineH = Math.round(br * 1.9);
  const legendH = rows ? Math.round(rows * lineH + br * 1.4) : 0;
  const c = makeCanvas(W, H + legendH);
  const ctx = c.getContext('2d');
  ctx.drawImage(rough, 0, 0);

  if (ext && (ext.t || ext.r || ext.b || ext.l)) {
    const fx = ext.l, fy = ext.t, fw = W - ext.l - ext.r, fh = H - ext.t - ext.b;
    ctx.save();
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.lineWidth = lw * 1.4;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeRect(fx, fy, fw, fh);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = lw * 0.8;
    ctx.strokeRect(fx, fy, fw, fh);
    ctx.setLineDash([]);
    ctx.font = `600 ${Math.round(br * 0.95)}px ${FONT}`;
    ctx.textBaseline = 'top';
    const label = 'Extend the scene outside this frame';
    const tw = ctx.measureText(label).width;
    const lx = Math.max(br * 0.5, Math.min(W - tw - br * 1.5, fx + br * 0.5));
    const ly = fy > br * 2.2 ? fy - br * 1.9 : fy + br * 0.5;
    ctx.fillStyle = 'rgba(21,23,26,.82)';
    ctx.fillRect(lx - br * 0.4, ly - br * 0.25, tw + br * 0.8, br * 1.5);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, lx, ly);
    ctx.restore();
  }

  regions.forEach((r, i) => {
    const col = regionColor(i);
    if (r.kind !== 'area') return;
    const path = maskPath(r.mask);
    const moved = isMoved(r.ops) && (r.ops.dx || r.ops.dy);
    if (r.ops.remove || (moved && r.ops.fill !== 'keep')) {
      ctx.save();
      ctx.setLineDash([lw * 2.5, lw * 2]);
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke(path);
      ctx.strokeStyle = col;
      ctx.lineWidth = lw * 0.7;
      ctx.stroke(path);
      ctx.restore();
    }
    if (!r.ops.remove) {
      const s = r.ops.scale / 100;
      ctx.save();
      applyTransform(ctx, r);
      ctx.lineJoin = 'round';
      ctx.lineWidth = (lw * 2.2) / s;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke(path);
      ctx.lineWidth = (lw * 1.3) / s;
      ctx.strokeStyle = col;
      ctx.stroke(path);
      ctx.restore();
    }
    if (moved) {
      const t = tf(r);
      arrow(ctx, t.cx, t.cy, t.tx, t.ty, col, lw);
    }
  });

  // Callout arrows sit above the area outlines.
  regions.forEach((r, i) => {
    if (r.kind !== 'arrow') return;
    const a = r.arrow;
    drawCalloutArrow(ctx, a.x1, a.y1, a.x2, a.y2, regionColor(i), lw * 2.2);
  });

  // Badges and labels on top of everything.
  regions.forEach((r, i) => {
    const col = regionColor(i);
    if (r.kind === 'pin') {
      drawPinMarker(ctx, r.pin.x, r.pin.y, br, i + 1, col);
      return;
    }
    if (r.kind === 'arrow') {
      const a = r.arrow;
      badge(ctx, Math.max(br + 2, Math.min(W - br - 2, a.x1)), Math.max(br + 2, Math.min(H - br - 2, a.y1)), br, i + 1, col);
      return;
    }
    if (r.kind === 'text') {
      const size = br * 0.95;
      drawTextCallout(ctx, Math.min(r.pin.x, W - size * 6), Math.min(r.pin.y, H - size * 3), r.note, size, i + 1, col, { maxW: Math.min(size * 16, W * 0.45) });
      return;
    }
    const a = regionAnchor(r);
    const x = Math.max(br + 2, Math.min(W - br - 2, a.x));
    const y = Math.max(br + 2, Math.min(H - br - 2, a.y - br - lw * 2));
    badge(ctx, x, y, br, i + 1, col);
  });

  if (legendH) {
    ctx.fillStyle = '#15171a';
    ctx.fillRect(0, H, W, legendH);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    regions.forEach((r, i) => {
      const cy = H + br * 0.7 + lineH * (i + 0.5);
      const bx = br * 1.4;
      badge(ctx, bx, cy, br * 0.72, i + 1, regionColor(i));
      ctx.fillStyle = '#eef0f2';
      ctx.font = `500 ${Math.round(br * 0.95)}px ${FONT}`;
      const maxW = W - bx * 2 - br;
      let text = shortSummary(r);
      if (ctx.measureText(text).width > maxW) {
        while (text.length > 4 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
        text += '…';
      }
      ctx.fillText(text, bx + br * 1.2, cy);
    });
  }
  return c;
}

/** Side-by-side (or stacked, for wide images) labeled panels in one PNG. */
export function makeCombined(items) {
  // items: [{label, canvas}]
  const base = items[0].canvas;
  const W = base.width;
  const wide = W / base.height > 1.25;
  const unit = Math.max(W, base.height);
  const labelH = Math.round(Math.max(30, unit / 26));
  const gap = Math.round(labelH * 0.4);
  const sizes = items.map((it) => ({ w: W, h: Math.round((it.canvas.height * W) / it.canvas.width) }));
  let cw, ch;
  if (wide) {
    cw = W;
    ch = sizes.reduce((a, s) => a + s.h + labelH, 0) + gap * (items.length - 1);
  } else {
    cw = W * items.length + gap * (items.length - 1);
    ch = Math.max(...sizes.map((s) => s.h)) + labelH;
  }
  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, cw, ch);
  let x = 0, y = 0;
  items.forEach((it, i) => {
    ctx.fillStyle = '#eef0f2';
    ctx.font = `600 ${Math.round(labelH * 0.5)}px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${'ABC'[i]}  ${it.label.toUpperCase()}`, x + labelH * 0.4, y + labelH / 2);
    ctx.drawImage(it.canvas, x, y + labelH, sizes[i].w, sizes[i].h);
    if (wide) y += labelH + sizes[i].h + gap;
    else x += W + gap;
  });
  return c;
}
