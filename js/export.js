// Builds the images that go back to the AI: annotated copy and combined panels.

import { makeCanvas } from './util.js';
import { maskPath, applyTransform, isMoved, tf, regionAnchor } from './regions.js';
import { regionColor, shortSummary } from './prompt.js';

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

/** Rough edit with numbered outlines, move arrows, pins, and an optional legend strip. */
export function makeAnnotated(rough, regions, { legend = true } = {}) {
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

  regions.forEach((r, i) => {
    const col = regionColor(i);
    if (r.kind === 'pin') return;
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

  // Badges on top of all outlines.
  regions.forEach((r, i) => {
    const col = regionColor(i);
    if (r.kind === 'pin') {
      drawPinMarker(ctx, r.pin.x, r.pin.y, br, i + 1, col);
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
