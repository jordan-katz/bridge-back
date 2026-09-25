// BridgeBack: rough-edit an image, then hand it back to an AI image session with a clear edit packet.

import { clamp, makeCanvas, ctx2d, uid, canvasToBlob, loadImage, blobToCanvas, fitCanvas, rgbToHex, debounce, h, isTypingTarget } from './util.js';
import { createAdjuster } from './gl.js';
import * as R from './regions.js';
import { buildPrompt, shortSummary, regionColor, packetImages } from './prompt.js';
import { makeAnnotated, makeCombined, copyCanvas, drawPinMarker, badge } from './export.js';
import * as store from './store.js';
import { sampleScene } from './sample.js';

const MAX_WORK = 2048;
const MINZ = 0.04, MAXZ = 32;
const $ = (id) => document.getElementById(id);
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const finePointer = () => window.matchMedia?.('(pointer: fine)').matches;

// ---------------------------------------------------------------- definitions

const GLOBAL_DEFS = [
  { key: 'exposure', label: 'Exposure', lo: 'Darker', hi: 'Brighter' },
  { key: 'contrast', label: 'Contrast', lo: 'Flatter', hi: 'Punchier' },
  { key: 'highlights', label: 'Highlights', lo: 'Recover', hi: 'Boost' },
  { key: 'shadows', label: 'Shadows', lo: 'Deepen', hi: 'Lift' },
  { key: 'saturation', label: 'Saturation', lo: 'Muted', hi: 'Vivid' },
  { key: 'warmth', label: 'Warmth', lo: 'Cooler', hi: 'Warmer' },
  { key: 'tint', label: 'Tint', lo: 'Green', hi: 'Magenta' },
  { key: 'vignette', label: 'Vignette', lo: 'Lighter edges', hi: 'Darker edges' },
];

const INTENT_DEFS = [
  { key: 'fidelity', label: 'Follow my edit', lo: 'Loosely', hi: 'Closely' },
  { key: 'realism', label: 'Realism', lo: 'Stylized', hi: 'Photoreal' },
  { key: 'detail', label: 'Detail', lo: 'Simpler', hi: 'Intricate' },
  { key: 'dof', label: 'Depth of field', lo: 'All sharp', hi: 'Soft background' },
  { key: 'drama', label: 'Lighting', lo: 'Soft', hi: 'Dramatic' },
  { key: 'mood', label: 'Mood', lo: 'Somber', hi: 'Cheerful' },
];

const SELECTS = [
  { key: 'light', label: 'Light direction', options: [['unchanged', 'Unchanged'], ['left', 'From the left'], ['right', 'From the right'], ['above', 'From above'], ['front', 'Soft front light'], ['back', 'Backlit']] },
  { key: 'time', label: 'Time of day', options: [['unchanged', 'Unchanged'], ['sunrise', 'Sunrise'], ['midday', 'Midday'], ['golden', 'Golden hour'], ['blue', 'Blue hour'], ['night', 'Night']] },
  { key: 'framing', label: 'Framing', options: [['unchanged', 'Unchanged'], ['closer', 'Tighter on subject'], ['wider', 'Wider'], ['lower', 'Lower angle'], ['higher', 'Higher angle']] },
];

const PRESERVE = [['identity', 'Faces and identity'], ['text', 'Text and logos'], ['composition', 'Composition'], ['style', 'Art style']];

const AREA_CHIPS = ['Replace it with ', 'Make it more detailed', "Match the scene's lighting", 'Fix its shape', 'Change the material to '];
const PIN_CHIPS = ['Add ', 'Put this text here: ', 'Extend the background here', 'Add a shadow here'];

const ICONS = {
  move: '<path d="M6 3.5l11.5 7-5.3 1.4L9.6 17z"/><path d="M12.4 12l4.6 6"/>',
  lasso: '<path d="M12 4.5c-4.7 0-8.5 2.2-8.5 5s3.8 5 8.5 5 8.5-2.2 8.5-5-3.8-5-8.5-5z" stroke-dasharray="3 2.4"/><path d="M7.2 14.2c-1.4 1.4-1 3.6 1 3.6 1.3 0 1.8-1 1.3-2"/><path d="M9.5 15.8c.6 2 2 3.3 3.8 3.9"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2.4"/>',
  rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="1" stroke-dasharray="3 2.4"/>',
  wand: '<path d="M4 20l10.5-10.5"/><path d="M13 8l3 3"/><path d="M16 3.5v2.5M19.5 7h-2.5M18.8 4.2l-1.6 1.6M20 11.5l-.01.01M11 3.5l-.01.01"/>',
  pin: '<path d="M12 21s-6.5-5.7-6.5-11.2a6.5 6.5 0 0113 0C18.5 15.3 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  hand: '<path d="M8 13.5V6.8a1.5 1.5 0 013 0V12m0-6.5V4.8a1.5 1.5 0 013 0V12m0-5.2a1.5 1.5 0 013 0v6.7c0 4-2.5 6.8-6.3 6.8-2.8 0-4.3-1.3-5.8-3.5L4 14a1.5 1.5 0 012.5-1.6L8 14.2"/>',
  undo: '<path d="M9 5L4 10l5 5"/><path d="M4 10h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 5l5 5-5 5"/><path d="M20 10H9.5a5.5 5.5 0 000 11H13"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeoff: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><path d="M4 20L20 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (name, cls = 'ico') =>
  h('span', { class: cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

const TOOLS = [
  { id: 'move', key: 'V', label: 'Move, scale and rotate' },
  { id: 'lasso', key: 'L', label: 'Lasso select' },
  { id: 'ellipse', key: 'E', label: 'Ellipse select' },
  { id: 'rect', key: 'M', label: 'Rectangle select' },
  { id: 'wand', key: 'W', label: 'Magic wand (select by color)' },
  { id: 'pin', key: 'P', label: 'Drop a marker' },
  { id: 'hand', key: 'H', label: 'Pan' },
];
const CURSORS = { move: 'default', lasso: 'crosshair', ellipse: 'crosshair', rect: 'crosshair', wand: 'crosshair', pin: 'copy', hand: 'grab' };

const NAMES = { original: 'Original image', rough: 'Rough edit', annotated: 'Marked-up copy', combined: 'Combined image', prompt: 'Prompt' };
const PANEL = { original: 'Original', rough: 'Rough edit', annotated: 'Marked-up' };

// ---------------------------------------------------------------- state

const defaultGlobal = () => ({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, warmth: 0, tint: 0, vignette: 0 });
const defaultIntent = () => ({
  fidelity: 0, realism: 0, detail: 0, dof: 0, drama: 0, mood: 0,
  light: 'unchanged', time: 'unchanged', framing: 'unchanged',
  preserve: { identity: false, text: false, composition: true, style: false },
});

const S = { doc: null, global: defaultGlobal(), intent: defaultIntent(), regions: [], note: '' };
const ui = {
  tool: store.prefs.get('tool', 'lasso'), selMode: 'new', wandTol: store.prefs.get('wandTol', 18), wandContig: true,
  selectedId: null, tab: 'adjust', outlines: true, comparing: false, picking: null, spaceHeld: false,
};
const handoff = Object.assign({ original: false, annotated: true, combine: false, legend: true, style: 'detailed' }, store.prefs.get('handoff', {}));
let promptOverride = null;
const copied = new Set();
let version = 0;

const view = { zoom: 1, panX: 0, panY: 0, fitted: true };
const adjuster = createAdjuster();
let comp = makeCanvas(2, 2);
let compData = null;
let compDirty = true, adjDirty = true, frame = 0;
let drag = null;
const pointers = new Map();

const byId = (id) => S.regions.find((r) => r.id === id);
const selected = () => (ui.selectedId ? byId(ui.selectedId) : null);
const indexOf = (id) => S.regions.findIndex((r) => r.id === id);

// ---------------------------------------------------------------- rendering

const vc = $('view');
const vx = vc.getContext('2d');
let dpr = 1;

const checker = (() => {
  const c = makeCanvas(16, 16);
  const x = c.getContext('2d');
  x.fillStyle = '#e9e9ea';
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#d3d4d6';
  x.fillRect(0, 0, 8, 8);
  x.fillRect(8, 8, 8, 8);
  return vx.createPattern(c, 'repeat');
})();

function schedule() {
  if (!frame) frame = requestAnimationFrame(tick);
}

function tick() {
  frame = 0;
  if (S.doc) {
    if (compDirty) {
      R.composite(comp, S.doc.base, S.regions);
      adjuster.upload(comp);
      compDirty = false;
      adjDirty = true;
    }
    if (adjDirty) {
      adjuster.render(S.global);
      adjDirty = false;
    }
  }
  draw();
}

function ensureRendered() {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  tick();
}

/** Region pixels changed. */
function invalidate() {
  compDirty = true;
  compData = null;
  adjDirty = true;
  schedule();
  changed();
}

/** Anything the prompt or packet depends on changed. */
function changed() {
  version++;
  copied.clear();
  updateHandoffButton();
  refreshHandoffSoon();
}

const toScreen = (x, y) => ({ x: view.panX + x * view.zoom, y: view.panY + y * view.zoom });
const toImage = (x, y) => ({ x: (x - view.panX) / view.zoom, y: (y - view.panY) / view.zoom });

function resizeView() {
  const r = $('stage').getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  vc.width = Math.max(1, Math.round(r.width * dpr));
  vc.height = Math.max(1, Math.round(r.height * dpr));
  if (view.fitted) fit();
  schedule();
}

function fit() {
  if (!S.doc) return;
  const r = $('stage').getBoundingClientRect();
  const padX = Math.min(40, r.width * 0.06), padTop = Math.min(56, r.height * 0.1), padBot = Math.min(56, r.height * 0.1);
  const z = Math.min((r.width - padX * 2) / S.doc.W, (r.height - padTop - padBot) / S.doc.H);
  view.zoom = clamp(z > 0 ? z : 1, MINZ, MAXZ);
  view.panX = (r.width - S.doc.W * view.zoom) / 2;
  view.panY = padTop + (r.height - padTop - padBot - S.doc.H * view.zoom) / 2;
  view.fitted = true;
  updateZoomLabel();
}

function zoomAt(sx, sy, factor) {
  const p = toImage(sx, sy);
  view.zoom = clamp(view.zoom * factor, MINZ, MAXZ);
  view.panX = sx - p.x * view.zoom;
  view.panY = sy - p.y * view.zoom;
  view.fitted = false;
  updateZoomLabel();
  schedule();
}

function zoomCenter(factor) {
  const r = $('stage').getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, factor);
}

function updateZoomLabel() {
  const el = $('zoom-level');
  if (el) el.textContent = Math.round(view.zoom * 100) + '%';
}

function draw() {
  vx.setTransform(1, 0, 0, 1, 0, 0);
  vx.clearRect(0, 0, vc.width, vc.height);
  if (!S.doc) return;
  vx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { W, H } = S.doc;
  const x0 = view.panX, y0 = view.panY;
  vx.save();
  vx.shadowColor = 'rgba(0,0,0,.28)';
  vx.shadowBlur = 22;
  vx.shadowOffsetY = 4;
  vx.fillStyle = checker;
  vx.fillRect(x0, y0, W * view.zoom, H * view.zoom);
  vx.restore();
  vx.save();
  vx.translate(x0, y0);
  vx.scale(view.zoom, view.zoom);
  vx.imageSmoothingEnabled = view.zoom < 2;
  vx.imageSmoothingQuality = 'high';
  vx.drawImage(ui.comparing ? S.doc.base : adjuster.canvas, 0, 0);
  vx.restore();
  $('compare-flag').hidden = !ui.comparing;
  if (ui.comparing) return;
  if (ui.outlines) drawOverlays();
  drawDragPreview();
}

function screenArrow(a, b, col) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 14) return;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  vx.save();
  vx.strokeStyle = col;
  vx.fillStyle = col;
  vx.lineWidth = 1.6;
  vx.setLineDash([5, 4]);
  vx.beginPath();
  vx.moveTo(a.x, a.y);
  vx.lineTo(b.x - Math.cos(ang) * 8, b.y - Math.sin(ang) * 8);
  vx.stroke();
  vx.setLineDash([]);
  vx.beginPath();
  vx.moveTo(b.x, b.y);
  vx.lineTo(b.x - Math.cos(ang - 0.45) * 10, b.y - Math.sin(ang - 0.45) * 10);
  vx.lineTo(b.x - Math.cos(ang + 0.45) * 10, b.y - Math.sin(ang + 0.45) * 10);
  vx.closePath();
  vx.fill();
  vx.restore();
}

function drawOverlays() {
  const z = view.zoom;
  S.regions.forEach((r, i) => {
    if (r.kind === 'pin') return;
    const col = regionColor(i);
    const sel = r.id === ui.selectedId;
    const o = r.ops;
    const path = R.maskPath(r.mask);
    vx.save();
    vx.translate(view.panX, view.panY);
    vx.scale(z, z);
    const ghost = o.remove || (R.isMoved(o) && o.fill !== 'keep');
    if (ghost) {
      vx.setLineDash([5 / z, 4 / z]);
      vx.lineWidth = 1.3 / z;
      vx.strokeStyle = col;
      vx.globalAlpha = r.enabled ? 0.9 : 0.4;
      vx.stroke(path);
      vx.setLineDash([]);
      vx.globalAlpha = 1;
    }
    if (!o.remove) {
      vx.save();
      R.applyTransform(vx, r);
      const k = z * (o.scale / 100);
      vx.lineJoin = 'round';
      vx.lineWidth = (sel ? 4.6 : 3.4) / k;
      vx.strokeStyle = 'rgba(0,0,0,.5)';
      vx.stroke(path);
      vx.lineWidth = (sel ? 2.6 : 1.6) / k;
      vx.strokeStyle = col;
      vx.globalAlpha = r.enabled ? 1 : 0.45;
      vx.stroke(path);
      vx.restore();
    }
    vx.restore();
    if (o.dx || o.dy) {
      const t = R.tf(r);
      screenArrow(toScreen(t.cx, t.cy), toScreen(t.tx, t.ty), col);
    }
  });
  S.regions.forEach((r, i) => {
    const col = regionColor(i);
    const sel = r.id === ui.selectedId;
    if (r.kind === 'pin') {
      const p = toScreen(r.pin.x, r.pin.y);
      if (sel) {
        vx.save();
        vx.strokeStyle = col;
        vx.lineWidth = 2;
        vx.beginPath();
        vx.arc(p.x, p.y - 19, 15, 0, Math.PI * 2);
        vx.stroke();
        vx.restore();
      }
      drawPinMarker(vx, p.x, p.y, 10, i + 1, col);
      return;
    }
    const a = R.regionAnchor(r);
    const s = toScreen(a.x, a.y);
    const br = sel ? 11 : 9.5;
    badge(vx, s.x, s.y - br - 3, br, i + 1, col);
  });
  const sel = selected();
  if (sel && sel.kind === 'area' && !sel.ops.remove && ui.tool === 'move') drawHandles(sel);
}

function handlePts(r) {
  const c = R.corners(r).map((p) => toScreen(p.x, p.y));
  const t = R.tf(r);
  const center = toScreen(t.tx, t.ty);
  const top = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
  const dx = top.x - center.x, dy = top.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  return { corners: c, top, center, rot: { x: top.x + (dx / len) * 28, y: top.y + (dy / len) * 28 } };
}

function drawHandles(r) {
  const hp = handlePts(r);
  vx.save();
  vx.strokeStyle = 'rgba(255,255,255,.9)';
  vx.lineWidth = 1;
  vx.setLineDash([4, 3]);
  vx.beginPath();
  hp.corners.forEach((p, i) => (i ? vx.lineTo(p.x, p.y) : vx.moveTo(p.x, p.y)));
  vx.closePath();
  vx.stroke();
  vx.setLineDash([]);
  vx.beginPath();
  vx.moveTo(hp.top.x, hp.top.y);
  vx.lineTo(hp.rot.x, hp.rot.y);
  vx.stroke();
  const knob = (p, round) => {
    vx.beginPath();
    if (round) vx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    else vx.rect(p.x - 5, p.y - 5, 10, 10);
    vx.fillStyle = '#fff';
    vx.fill();
    vx.strokeStyle = 'rgba(0,0,0,.6)';
    vx.stroke();
  };
  hp.corners.forEach((p) => knob(p, false));
  knob(hp.rot, true);
  vx.restore();
}

function hitHandle(r, p) {
  const hp = handlePts(r);
  if (Math.hypot(p.x - hp.rot.x, p.y - hp.rot.y) < 11) return 'rotate';
  if (hp.corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < 10)) return 'scale';
  return null;
}

function drawDragPreview() {
  if (!drag) return;
  const stroke = () => {
    vx.lineWidth = 3;
    vx.strokeStyle = 'rgba(0,0,0,.55)';
    vx.stroke();
    vx.lineWidth = 1.5;
    vx.strokeStyle = '#fff';
    vx.setLineDash([6, 4]);
    vx.stroke();
    vx.setLineDash([]);
  };
  vx.save();
  if (drag.type === 'lasso' && drag.pts.length > 1) {
    vx.beginPath();
    drag.pts.forEach((p, i) => {
      const s = toScreen(p.x, p.y);
      i ? vx.lineTo(s.x, s.y) : vx.moveTo(s.x, s.y);
    });
    stroke();
  } else if (drag.type === 'ellipse' || drag.type === 'rect') {
    const a = toScreen(drag.a.x, drag.a.y), b = toScreen(drag.b.x, drag.b.y);
    vx.beginPath();
    if (drag.type === 'rect') vx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else vx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    stroke();
  }
  vx.restore();
}

// ---------------------------------------------------------------- documents

function mkRegion(mask, { note = '', ops = {} } = {}) {
  return { id: uid(), kind: 'area', mask, pin: null, note, enabled: true, ops: { ...R.defaultOps(), ...ops } };
}

function setDoc(doc, st = {}) {
  S.doc = doc;
  S.global = { ...defaultGlobal(), ...(st.global || {}) };
  const di = defaultIntent();
  S.intent = { ...di, ...(st.intent || {}), preserve: { ...di.preserve, ...(st.intent?.preserve || {}) } };
  S.note = st.note || '';
  S.regions = st.regions || [];
  comp = makeCanvas(doc.W, doc.H);
  compDirty = true;
  compData = null;
  ui.selectedId = null;
  promptOverride = null;
  copied.clear();
  undoStack = [snap()];
  redoStack = [];
  updateUndo();
  view.fitted = true;
  fit();
  buildAdjust();
  buildDirection();
  renderRegions();
  updateDocInfo();
  invalidate();
  $('empty').hidden = true;
}

async function openBlob(blob, name) {
  try {
    const img = await loadImage(blob);
    const origW = img.naturalWidth, origH = img.naturalHeight;
    const k = Math.min(1, MAX_WORK / Math.max(origW, origH));
    const base = makeCanvas(origW * k, origH * k);
    const bx = base.getContext('2d');
    bx.imageSmoothingQuality = 'high';
    bx.drawImage(img, 0, 0, base.width, base.height);
    setDoc({ id: uid(), name: name || 'Pasted image', base, W: base.width, H: base.height, origW, origH, touched: true });
    toast(`Opened ${name || 'pasted image'}.`);
    saveSoon.flush();
  } catch (e) {
    toast(e.message || 'Could not open that image.');
  }
}

function loadSample() {
  const { canvas, spots } = sampleScene();
  const W = canvas.width, H = canvas.height;
  const door = mkRegion(R.rasterRect(spots.door.a, spots.door.b, W, H), { note: 'The front door', ops: { recolor: '#1f3a8a' } });
  const tree = mkRegion(R.rasterEllipse(spots.tree.a, spots.tree.b, W, H), { note: 'The tree', ops: { scale: 80, dx: -60, dy: 40 } });
  const pin = { id: uid(), kind: 'pin', pin: { ...spots.step }, mask: null, note: 'Add a sleeping orange cat on the step', enabled: true, ops: R.defaultOps() };
  setDoc(
    { id: uid(), name: 'Sample cottage', base: canvas, W, H, origW: W, origH: H, sample: true },
    {
      global: { warmth: 25, contrast: 10 },
      intent: { time: 'golden', preserve: { composition: true, style: true } },
      note: 'Keep the flat illustration style.',
      regions: [door, tree, pin],
    }
  );
}

function updateDocInfo() {
  const d = S.doc;
  const el = $('docinfo');
  if (!d) {
    el.textContent = '';
    return;
  }
  const scaled = d.origW && (d.origW !== d.W || d.origH !== d.H);
  put(el, 
    d.sample ? h('span', { class: 'tag' }, 'Sample') : null,
    h('span', { class: 'docname' }, d.name),
    h('span', { class: 'mono dim' }, `${d.W}×${d.H}`),
    scaled ? h('span', { class: 'dim' }, `working copy of ${d.origW}×${d.origH}`) : null
  );
}

// ---------------------------------------------------------------- history

let undoStack = [];
let redoStack = [];

function snap() {
  return {
    global: { ...S.global },
    intent: { ...S.intent, preserve: { ...S.intent.preserve } },
    note: S.note,
    regions: S.regions.map((r) => ({ ...r, ops: { ...r.ops }, pin: r.pin ? { ...r.pin } : null })),
  };
}

const sig = (s) => JSON.stringify(s, (k, v) => (k === 'mask' && v ? v.id : v));

function commit() {
  const s = snap();
  const last = undoStack[undoStack.length - 1];
  if (last && sig(last) === sig(s)) return;
  undoStack.push(s);
  if (undoStack.length > 150) undoStack.shift();
  redoStack = [];
  if (S.doc) S.doc.touched = true;
  updateUndo();
  saveSoon();
  changed();
}
const commitSoon = debounce(commit, 500);

function restore(s) {
  S.global = { ...s.global };
  S.intent = { ...s.intent, preserve: { ...s.intent.preserve } };
  S.note = s.note;
  S.regions = s.regions.map((r) => ({ ...r, ops: { ...r.ops }, pin: r.pin ? { ...r.pin } : null }));
  if (!byId(ui.selectedId)) ui.selectedId = null;
  buildAdjust();
  buildDirection();
  renderRegions();
  invalidate();
  saveSoon();
}

function undo() {
  if (undoStack.length < 2) return;
  redoStack.push(undoStack.pop());
  restore(undoStack[undoStack.length - 1]);
  updateUndo();
}

function redo() {
  if (!redoStack.length) return;
  const s = redoStack.pop();
  undoStack.push(s);
  restore(s);
  updateUndo();
}

function updateUndo() {
  $('btn-undo').disabled = undoStack.length < 2;
  $('btn-redo').disabled = !redoStack.length;
}

// ---------------------------------------------------------------- persistence

const maskBlobs = new WeakMap();
async function maskBlob(m) {
  let b = maskBlobs.get(m.canvas);
  if (!b) {
    b = await canvasToBlob(m.canvas);
    maskBlobs.set(m.canvas, b);
  }
  return b;
}

async function saveNow() {
  const d = S.doc;
  if (!d || !d.touched) return;
  if (!d.baseBlob) d.baseBlob = await canvasToBlob(d.base, 'image/png');
  ensureRendered();
  const thumb = await canvasToBlob(fitCanvas(copyCanvas(adjuster.canvas), 240), 'image/jpeg', 0.82);
  const regions = await Promise.all(
    S.regions.map(async (r) => ({
      id: r.id, kind: r.kind, note: r.note, enabled: r.enabled, ops: { ...r.ops }, pin: r.pin ? { ...r.pin } : null,
      mask: r.mask ? { x: r.mask.x, y: r.mask.y, w: r.mask.w, h: r.mask.h, blob: await maskBlob(r.mask) } : null,
    }))
  );
  await store.put({
    id: d.id, name: d.name, updated: Date.now(), W: d.W, H: d.H, origW: d.origW, origH: d.origH, sample: !!d.sample,
    base: d.baseBlob, thumb,
    state: { global: { ...S.global }, intent: JSON.parse(JSON.stringify(S.intent)), note: S.note, regions },
  });
  store.prefs.set('lastDoc', d.id);
  store.prune(8).catch(() => {});
}
const saveSoon = debounce(() => saveNow().catch((e) => console.warn('BridgeBack autosave failed', e)), 900);

async function loadRecord(rec) {
  const base = await blobToCanvas(rec.base);
  const regions = await Promise.all(
    (rec.state.regions || []).map(async (r) => ({
      ...r,
      ops: { ...R.defaultOps(), ...r.ops },
      mask: r.mask ? { id: uid(), x: r.mask.x, y: r.mask.y, w: r.mask.w, h: r.mask.h, canvas: await blobToCanvas(r.mask.blob) } : null,
    }))
  );
  setDoc(
    { id: rec.id, name: rec.name, base, W: base.width, H: base.height, origW: rec.origW, origH: rec.origH, sample: rec.sample, touched: true, baseBlob: rec.base },
    { global: rec.state.global, intent: rec.state.intent, note: rec.state.note, regions }
  );
  store.prefs.set('lastDoc', rec.id);
}

// ---------------------------------------------------------------- UI pieces

function slider({ id, label, min = -100, max = 100, step = 1, value = 0, neutral = 0, lo, hi, fmt, onInput, onCommit }) {
  fmt = fmt || ((v) => (v > 0 ? '+' + v : String(v)));
  const input = h('input', { type: 'range', id, min, max, step, value });
  input.value = value;
  const out = h('output', { for: id, class: 'val' });
  const head = h('div', { class: 'slider-head', title: 'Double-click to reset' }, h('label', { for: id }, label), out);
  const wrap = h('div', { class: 'slider' }, head, input, lo || hi ? h('div', { class: 'ends', 'aria-hidden': 'true' }, h('span', null, lo || ''), h('span', null, hi || '')) : null);
  const pn = ((neutral - min) / (max - min)) * 100;
  wrap.style.setProperty('--n', pn + '%');
  const paint = (v) => {
    const pv = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--a', Math.min(pn, pv) + '%');
    input.style.setProperty('--b', Math.max(pn, pv) + '%');
    out.textContent = fmt(v);
    wrap.classList.toggle('is-set', v !== neutral);
  };
  input.addEventListener('input', () => {
    const v = +input.value;
    paint(v);
    onInput(v);
  });
  input.addEventListener('change', () => onCommit && onCommit(+input.value));
  head.addEventListener('dblclick', () => {
    input.value = neutral;
    paint(neutral);
    onInput(neutral);
    onCommit && onCommit(neutral);
  });
  paint(value);
  return { el: wrap, input, set: (v) => { input.value = v; paint(v); } };
}

function segmented(name, options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
  const btns = options.map(([v, label]) =>
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value), class: 'seg-btn',
      onclick: () => {
        btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));
        onChange(v);
      },
      'data-v': v,
    }, label)
  );
  wrap.append(...btns);
  return wrap;
}

function checkbox(id, label, checked, onChange, hint) {
  const input = h('input', { type: 'checkbox', id, checked });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check', for: id }, input, h('span', null, label, hint ? h('small', null, hint) : null));
}

function panelHead(title, onReset) {
  return h('div', { class: 'panel-head' }, h('h2', null, title), onReset ? h('button', { type: 'button', class: 'link', onclick: onReset }, 'Reset') : null);
}

// ---------------------------------------------------------------- panels: adjust + direction

function buildAdjust() {
  const p = $('tab-adjust');
  put(p, 
    panelHead('Adjust', () => {
      S.global = defaultGlobal();
      buildAdjust();
      adjDirty = true;
      schedule();
      commit();
    }),
    h('p', { class: 'help' }, 'These change the rough edit you send, and the prompt describes them so the AI keeps the look.'),
    h('div', { class: 'sliders' },
      GLOBAL_DEFS.map((d) =>
        slider({
          id: 'g-' + d.key, label: d.label, lo: d.lo, hi: d.hi, value: S.global[d.key],
          onInput: (v) => {
            S.global[d.key] = v;
            adjDirty = true;
            schedule();
            changed();
          },
          onCommit: () => commit(),
        }).el
      )
    ),
    adjuster.gpu ? null : h('p', { class: 'warn' }, "This browser can't run WebGL, so these sliders only shape the prompt.")
  );
}

function buildDirection() {
  const p = $('tab-direction');
  const note = h('textarea', { id: 'global-note', rows: 4, placeholder: 'Anything the sliders don’t cover. e.g. Keep the brushstroke texture and make the sky stormier.' });
  note.value = S.note;
  note.addEventListener('input', () => {
    S.note = note.value;
    changed();
    commitSoon();
  });
  put(p, 
    panelHead('Direction', () => {
      S.intent = defaultIntent();
      buildDirection();
      commit();
    }),
    h('p', { class: 'help' }, "These don't touch the image. They only shape the prompt."),
    h('div', { class: 'sliders' },
      INTENT_DEFS.map((d) =>
        slider({
          id: 'i-' + d.key, label: d.label, lo: d.lo, hi: d.hi, value: S.intent[d.key],
          onInput: (v) => {
            S.intent[d.key] = v;
            changed();
          },
          onCommit: () => commit(),
        }).el
      )
    ),
    h('div', { class: 'selects' },
      SELECTS.map((d) => {
        const sel = h('select', { id: 'i-' + d.key }, d.options.map(([v, t]) => h('option', { value: v }, t)));
        sel.value = S.intent[d.key];
        sel.addEventListener('change', () => {
          S.intent[d.key] = sel.value;
          commit();
        });
        return h('label', { class: 'field', for: 'i-' + d.key }, h('span', { class: 'field-label' }, d.label), sel);
      })
    ),
    h('fieldset', { class: 'group' },
      h('legend', { class: 'group-label' }, 'Keep exactly'),
      h('div', { class: 'checks two' },
        PRESERVE.map(([k, t]) => checkbox('p-' + k, t, S.intent.preserve[k], (v) => { S.intent.preserve[k] = v; commit(); }))
      )
    ),
    h('label', { class: 'field', for: 'global-note' }, h('span', { class: 'field-label' }, 'Notes for the AI'), note)
  );
}

// ---------------------------------------------------------------- panels: regions

let regionListEl, regionEditorEl;

function renderRegions() {
  const p = $('tab-regions');
  $('region-count').textContent = S.regions.length;
  if (!regionListEl) {
    regionListEl = h('ol', { class: 'region-list', id: 'region-list' });
    regionEditorEl = h('div', { class: 'region-editor', id: 'region-editor' });
  }
  if (!S.regions.length) {
    put(p, 
      panelHead('Regions'),
      h('div', { class: 'empty-note' },
        h('p', null, 'Nothing marked yet.'),
        h('p', { class: 'help' }, 'Draw around something with the lasso (L), ellipse (E) or rectangle (M), or click a color with the wand (W). Then recolor, move, shrink or remove it here. To ask for something new, drop a marker (P) and describe it.')
      )
    );
    return;
  }
  put(p, panelHead('Regions'), regionListEl, regionEditorEl);
  renderRegionList();
  renderRegionEditor();
}

function renderRegionList() {
  if (!regionListEl) return;
  $('region-count').textContent = S.regions.length;
  put(regionListEl, 
    ...S.regions.map((r, i) => {
      const sel = r.id === ui.selectedId;
      return h('li', { class: 'region-item' + (sel ? ' is-selected' : '') + (r.enabled ? '' : ' is-off') },
        h('button', { type: 'button', class: 'region-pick', 'aria-pressed': String(sel), onclick: () => select(sel ? null : r.id) },
          h('span', { class: 'num', style: { '--c': regionColor(i) } }, i + 1),
          h('span', { class: 'region-text' },
            h('span', { class: 'region-kind' }, r.kind === 'pin' ? 'Marker' : 'Area'),
            h('span', { class: 'region-sum' }, shortSummary(r))
          )
        ),
        r.kind === 'area'
          ? h('button', {
            type: 'button', class: 'icon-btn sm', title: r.enabled ? 'Hide this edit' : 'Show this edit',
            'aria-label': `${r.enabled ? 'Hide' : 'Show'} edit ${i + 1}`,
            onclick: () => { r.enabled = !r.enabled; invalidate(); renderRegionList(); commit(); },
          }, icon(r.enabled ? 'eye' : 'eyeoff'))
          : null,
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete', 'aria-label': `Delete ${i + 1}`, onclick: () => deleteRegion(r.id) }, icon('trash'))
      );
    })
  );
}

function noteField(r) {
  const ta = h('textarea', {
    id: 'r-note', rows: 3,
    placeholder: r.kind === 'pin' ? 'What should appear here? e.g. a small potted fern' : 'What is this, and what should change? e.g. the jacket, make it worn leather',
  });
  ta.value = r.note || '';
  ta.addEventListener('input', () => {
    r.note = ta.value;
    renderRegionList();
    changed();
    commitSoon();
  });
  const chips = (r.kind === 'pin' ? PIN_CHIPS : AREA_CHIPS).map((text) =>
    h('button', {
      type: 'button', class: 'chip',
      onclick: () => {
        const cur = ta.value.trim();
        ta.value = cur ? cur.replace(/[.\s]*$/, '. ') + text : text;
        r.note = ta.value;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        renderRegionList();
        changed();
        commitSoon();
      },
    }, text.endsWith(' ') ? text.trim() + '…' : text)
  );
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: 'r-note' }, r.kind === 'pin' ? 'What to add' : 'Note for the AI'),
    ta,
    h('div', { class: 'chips' }, chips)
  );
}

function renderRegionEditor() {
  if (!regionEditorEl) return;
  const r = selected();
  if (!r) {
    put(regionEditorEl, h('p', { class: 'help pad' }, 'Pick a region above or click one on the image with the Move tool (V) to edit it.'));
    return;
  }
  const i = indexOf(r.id);
  const head = h('div', { class: 'editor-head' },
    h('span', { class: 'num lg', style: { '--c': regionColor(i) } }, i + 1),
    h('h3', null, r.kind === 'pin' ? `Marker ${i + 1}` : `Area ${i + 1}`),
    h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Close editor', title: 'Deselect (Esc)', onclick: () => select(null) }, icon('close'))
  );
  if (r.kind === 'pin') {
    put(regionEditorEl, head, noteField(r), h('p', { class: 'help' }, 'Drag the marker with the Move tool (V) to reposition it.'));
    return;
  }
  const o = r.ops;
  const upd = (fn, recomposite = true) => (v) => {
    fn(v);
    if (recomposite) invalidate();
    renderRegionList();
  };
  const color = h('input', { type: 'color', id: 'r-recolor', 'aria-label': 'Recolor to' });
  color.value = o.recolor || '#2450c8';
  color.disabled = !o.recolor;
  color.addEventListener('input', () => {
    o.recolor = color.value;
    invalidate();
    renderRegionList();
  });
  color.addEventListener('change', () => commit());
  const pickBtn = h('button', {
    type: 'button', class: 'btn sm', disabled: !o.recolor,
    onclick: () => { ui.picking = r.id; renderToolOpts(); updateCursor(); toast('Click anywhere on the image to pick that color.'); },
  }, 'Pick from image');
  const recolorToggle = checkbox('r-recolor-on', 'Recolor', !!o.recolor, (on) => {
    o.recolor = on ? color.value : null;
    color.disabled = !on;
    pickBtn.disabled = !on;
    invalidate();
    renderRegionList();
    commit();
  });
  const sl = (id, label, key, opts = {}) =>
    slider({ id, label, value: o[key], onInput: upd((v) => { o[key] = v; }), onCommit: () => commit(), ...opts }).el;

  const fillSel = h('select', { id: 'r-fill' },
    h('option', { value: 'smudge' }, 'Blend from surroundings'),
    h('option', { value: 'flat' }, 'Flat average color'),
    h('option', { value: 'keep' }, 'Keep the original (copy it)')
  );
  fillSel.value = o.fill;
  fillSel.addEventListener('change', () => { o.fill = fillSel.value; invalidate(); renderRegionList(); commit(); });

  const moved = o.dx || o.dy;
  put(regionEditorEl, 
    head,
    noteField(r),
    h('div', { class: 'group' + (o.remove ? ' is-muted' : '') },
      h('div', { class: 'group-label' }, 'Color'),
      h('div', { class: 'row' }, recolorToggle, color, pickBtn),
      sl('r-amt', 'Recolor strength', 'recolorAmt', { min: 0, max: 100, neutral: 0, fmt: (v) => v + '%' }),
      sl('r-hue', 'Hue shift', 'hue', { min: -180, max: 180, fmt: (v) => (v > 0 ? '+' : '') + v + '°' }),
      sl('r-sat', 'Saturation', 'sat', { lo: 'Muted', hi: 'Vivid' }),
      sl('r-bright', 'Brightness', 'bright', { lo: 'Darker', hi: 'Brighter' })
    ),
    h('div', { class: 'group' + (o.remove ? ' is-muted' : '') },
      h('div', { class: 'group-label' }, 'Size and position'),
      sl('r-scale', 'Scale', 'scale', { min: 10, max: 300, neutral: 100, fmt: (v) => v + '%' }),
      sl('r-rot', 'Rotate', 'rotate', { min: -180, max: 180, fmt: (v) => (v > 0 ? '+' : '') + v + '°' }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(o.flipX), onclick: () => { o.flipX = !o.flipX; invalidate(); renderRegionEditor(); renderRegionList(); commit(); } }, o.flipX ? 'Mirrored' : 'Mirror'),
        h('button', { type: 'button', class: 'btn sm', disabled: !moved, onclick: () => { o.dx = 0; o.dy = 0; invalidate(); renderRegionEditor(); renderRegionList(); commit(); } }, 'Reset position'),
        h('span', { class: 'mono dim small' }, moved ? `moved ${o.dx > 0 ? '+' : ''}${o.dx}, ${o.dy > 0 ? '+' : ''}${o.dy} px` : 'Drag it with Move (V)')
      ),
      h('label', { class: 'field', for: 'r-fill' }, h('span', { class: 'field-label' }, 'Where it used to be'), fillSel)
    ),
    h('div', { class: 'group' },
      checkbox('r-remove', 'Remove it', o.remove, (v) => { o.remove = v; invalidate(); renderRegionEditor(); renderRegionList(); commit(); }, 'Fills the spot and asks the AI to erase it cleanly.'),
      sl('r-feather', 'Soften edges', 'feather', { min: 0, max: 40, neutral: 0, fmt: (v) => v + ' px' })
    ),
    h('p', { class: 'help' }, 'Hold Shift while selecting to add to this area, Alt to subtract.')
  );
}

function select(id) {
  ui.selectedId = id;
  renderRegionList();
  renderRegionEditor();
  if (id && ui.tab !== 'regions') showTab('regions');
  schedule();
}

function focusNote() {
  if (!finePointer()) return;
  requestAnimationFrame(() => $('r-note')?.focus());
}

function deleteRegion(id) {
  S.regions = S.regions.filter((r) => r.id !== id);
  if (ui.selectedId === id) ui.selectedId = null;
  invalidate();
  renderRegions();
  commit();
}

function applySelection(mask, mode) {
  if (!mask) return;
  const sel = selected();
  if (mode !== 'new' && sel && sel.kind === 'area') {
    const local = R.toRegionSpace(sel, mask);
    const m = local ? R.combineMasks(sel.mask, local, mode) : sel.mask;
    if (!m) {
      deleteRegion(sel.id);
      toast('That removed the whole area.');
      return;
    }
    sel.mask = m;
    invalidate();
    renderRegionList();
    commit();
    return;
  }
  if (mode === 'sub') {
    toast('Select an area first, then subtract from it.');
    return;
  }
  const r = mkRegion(mask);
  S.regions.push(r);
  invalidate();
  renderRegions();
  commit();
  select(r.id);
}

function addPin(ip) {
  const r = { id: uid(), kind: 'pin', pin: { x: Math.round(ip.x), y: Math.round(ip.y) }, mask: null, note: '', enabled: true, ops: R.defaultOps() };
  S.regions.push(r);
  renderRegions();
  changed();
  commit();
  select(r.id);
  focusNote();
  schedule();
}

function runWand(ip, mode) {
  ensureRendered();
  const { W, H } = S.doc;
  if (!compData) compData = ctx2d(comp, true).getImageData(0, 0, W, H);
  const m = R.wandMask(compData, Math.floor(ip.x), Math.floor(ip.y), ui.wandTol, ui.wandContig);
  if (m && m.w * m.h > W * H * 0.85 && mode === 'new') toast('That grabbed most of the image. Lower the tolerance to be pickier.');
  applySelection(m, mode);
}

function pickColor(ip) {
  const r = byId(ui.picking);
  ui.picking = null;
  renderToolOpts();
  updateCursor();
  if (!r) return;
  ensureRendered();
  const t = makeCanvas(1, 1);
  const tx = ctx2d(t, true);
  tx.drawImage(adjuster.canvas, Math.floor(ip.x), Math.floor(ip.y), 1, 1, 0, 0, 1, 1);
  const [cr, cg, cb] = tx.getImageData(0, 0, 1, 1).data;
  r.ops.recolor = rgbToHex(cr, cg, cb);
  if (!r.ops.recolorAmt) r.ops.recolorAmt = 100;
  invalidate();
  renderRegionEditor();
  renderRegionList();
  commit();
}

function hitTest(p, ip) {
  for (let i = S.regions.length - 1; i >= 0; i--) {
    const r = S.regions[i];
    if (r.kind === 'pin') {
      const s = toScreen(r.pin.x, r.pin.y);
      if (Math.hypot(p.x - s.x, p.y - (s.y - 19)) < 13 || Math.hypot(p.x - s.x, p.y - s.y) < 8) return r;
    }
  }
  for (let i = S.regions.length - 1; i >= 0; i--) {
    const r = S.regions[i];
    if (r.kind === 'area' && R.hitArea(r, ip.x, ip.y, r.ops.remove)) return r;
  }
  return null;
}

// ---------------------------------------------------------------- tools + pointer

function buildToolRail() {
  const rail = $('toolrail');
  put(rail, 
    ...TOOLS.map((t) =>
      h('button', {
        type: 'button', class: 'tool', 'data-tool': t.id, 'aria-pressed': String(ui.tool === t.id),
        title: `${t.label} (${t.key})`, 'aria-label': t.label,
        onclick: () => setTool(t.id),
      }, icon(t.id), h('span', { class: 'tool-key' }, t.key))
    )
  );
}

function setTool(id) {
  ui.tool = id;
  ui.picking = null;
  store.prefs.set('tool', id);
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
  renderToolOpts();
  updateCursor();
  schedule();
}

function renderToolOpts() {
  const el = $('toolopts');
  if (ui.picking) {
    put(el, h('span', { class: 'opt-hint' }, 'Click the image to pick a color. Esc cancels.'));
    return;
  }
  const t = ui.tool;
  if (['lasso', 'ellipse', 'rect', 'wand'].includes(t)) {
    const kids = [
      segmented('Selection mode', [['new', 'New'], ['add', 'Add'], ['sub', 'Subtract']], ui.selMode, (v) => { ui.selMode = v; }),
    ];
    if (t === 'wand') {
      const s = slider({
        id: 'wand-tol', label: 'Tolerance', min: 1, max: 100, value: ui.wandTol, neutral: 1, fmt: (v) => String(v),
        onInput: (v) => { ui.wandTol = v; }, onCommit: (v) => store.prefs.set('wandTol', v),
      });
      s.el.classList.add('compact');
      kids.push(s.el, checkbox('wand-contig', 'Connected only', ui.wandContig, (v) => { ui.wandContig = v; }));
    } else {
      kids.push(h('span', { class: 'opt-hint' }, t === 'lasso' ? 'Draw around it freehand.' : 'Drag to select. Click an area to pick it.'));
    }
    put(el, ...kids);
    return;
  }
  const hints = {
    move: 'Drag an area to move it. Corners scale, the round handle rotates (Shift snaps). Arrow keys nudge.',
    pin: 'Click where something new should go, then describe it.',
    hand: 'Drag to pan. Scroll or pinch to zoom.',
  };
  put(el, h('span', { class: 'opt-hint' }, hints[t]));
}

function updateCursor(p) {
  let c = CURSORS[ui.tool];
  if (ui.picking) c = 'crosshair';
  else if (ui.spaceHeld) c = drag?.type === 'pan' ? 'grabbing' : 'grab';
  else if (drag?.type === 'pan') c = 'grabbing';
  else if (ui.tool === 'move' && p && S.doc) {
    const sel = selected();
    const hnd = sel && sel.kind === 'area' && !sel.ops.remove ? hitHandle(sel, p) : null;
    if (hnd === 'rotate') c = 'alias';
    else if (hnd === 'scale') c = 'nwse-resize';
    else if (hitTest(p, toImage(p.x, p.y))) c = 'move';
  }
  vc.style.cursor = c;
}

const pos = (e) => {
  const r = vc.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function startPan(p) {
  drag = { type: 'pan', sx: p.x, sy: p.y, px: view.panX, py: view.panY };
  updateCursor();
}

vc.addEventListener('pointerdown', (e) => {
  vc.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, pos(e));
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { type: 'pinch', d0: Math.max(10, dist(a, b)), z0: view.zoom, m0: mid(a, b), p0: { x: view.panX, y: view.panY } };
    schedule();
    return;
  }
  if (pointers.size > 2) return;
  if (!S.doc) {
    $('file-input').click();
    return;
  }
  const p = pos(e), ip = toImage(p.x, p.y);
  if (ui.picking) {
    pickColor(ip);
    return;
  }
  if (e.button === 1 || ui.spaceHeld || ui.tool === 'hand') {
    e.preventDefault();
    startPan(p);
    return;
  }
  if (e.button !== 0) return;
  const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : ui.selMode;
  switch (ui.tool) {
    case 'move': {
      const sel = selected();
      if (sel && sel.kind === 'area' && !sel.ops.remove) {
        const hnd = hitHandle(sel, p);
        if (hnd) {
          const c = handlePts(sel).center;
          drag = hnd === 'rotate'
            ? { type: 'rotate', id: sel.id, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: sel.ops.rotate, c }
            : { type: 'scale', id: sel.id, d0: Math.max(4, dist(p, c)), s0: sel.ops.scale, c };
          return;
        }
      }
      const hit = hitTest(p, ip);
      if (hit) {
        if (hit.id !== ui.selectedId) select(hit.id);
        drag = hit.kind === 'pin'
          ? { type: 'pin', id: hit.id, ox: hit.pin.x - ip.x, oy: hit.pin.y - ip.y, moved: false }
          : { type: 'move', id: hit.id, sx: ip.x, sy: ip.y, dx0: hit.ops.dx, dy0: hit.ops.dy, moved: false };
      } else {
        if (ui.selectedId) select(null);
        startPan(p);
      }
      break;
    }
    case 'lasso':
      drag = { type: 'lasso', mode, pts: [ip], sp: p };
      break;
    case 'ellipse':
    case 'rect':
      drag = { type: ui.tool, mode, a: ip, b: ip, sp: p };
      break;
    case 'wand':
      runWand(ip, mode);
      break;
    case 'pin':
      addPin(ip);
      break;
  }
  schedule();
});

vc.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos(e));
  const p = pos(e);
  if (!drag) {
    if (e.pointerType === 'mouse') updateCursor(p);
    return;
  }
  const ip = toImage(p.x, p.y);
  const W = S.doc?.W || 0, H = S.doc?.H || 0;
  switch (drag.type) {
    case 'pinch': {
      const pts = [...pointers.values()];
      if (pts.length < 2) return;
      const m = mid(pts[0], pts[1]);
      const z = clamp((drag.z0 * dist(pts[0], pts[1])) / drag.d0, MINZ, MAXZ);
      const ix = (drag.m0.x - drag.p0.x) / drag.z0, iy = (drag.m0.y - drag.p0.y) / drag.z0;
      view.zoom = z;
      view.panX = m.x - ix * z;
      view.panY = m.y - iy * z;
      view.fitted = false;
      updateZoomLabel();
      break;
    }
    case 'pan':
      view.panX = drag.px + p.x - drag.sx;
      view.panY = drag.py + p.y - drag.sy;
      view.fitted = false;
      break;
    case 'move': {
      const r = byId(drag.id);
      if (!r) break;
      r.ops.dx = Math.round(drag.dx0 + ip.x - drag.sx);
      r.ops.dy = Math.round(drag.dy0 + ip.y - drag.sy);
      drag.moved = true;
      invalidate();
      break;
    }
    case 'pin': {
      const r = byId(drag.id);
      if (!r) break;
      r.pin.x = Math.round(clamp(ip.x + drag.ox, 0, W));
      r.pin.y = Math.round(clamp(ip.y + drag.oy, 0, H));
      drag.moved = true;
      changed();
      break;
    }
    case 'scale': {
      const r = byId(drag.id);
      if (!r) break;
      r.ops.scale = clamp(Math.round((drag.s0 * dist(p, drag.c)) / drag.d0), 5, 500);
      invalidate();
      break;
    }
    case 'rotate': {
      const r = byId(drag.id);
      if (!r) break;
      let a = ((Math.atan2(p.y - drag.c.y, p.x - drag.c.x) - drag.a0) * 180) / Math.PI + drag.r0;
      a = ((((a + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      r.ops.rotate = Math.round(a);
      invalidate();
      break;
    }
    case 'lasso': {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(ip.x - last.x, ip.y - last.y) * view.zoom > 2) drag.pts.push(ip);
      break;
    }
    case 'ellipse':
    case 'rect':
      drag.b = ip;
      break;
  }
  schedule();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  const d = drag;
  if (d.type === 'pinch') {
    if (!pointers.size) drag = null;
    return;
  }
  drag = null;
  updateCursor();
  if (!S.doc) return;
  const { W, H } = S.doc;
  const p = pos(e);
  const tiny = d.sp && dist(d.sp, p) < 4;
  switch (d.type) {
    case 'lasso':
    case 'ellipse':
    case 'rect': {
      if (tiny || e.type === 'pointercancel') {
        const hit = e.type === 'pointercancel' ? null : hitTest(p, toImage(p.x, p.y));
        select(hit ? hit.id : null);
        break;
      }
      const m = d.type === 'lasso' ? R.rasterPolygon(d.pts, W, H) : d.type === 'ellipse' ? R.rasterEllipse(d.a, d.b, W, H) : R.rasterRect(d.a, d.b, W, H);
      applySelection(m, d.mode);
      break;
    }
    case 'move':
    case 'pin':
      if (d.moved) {
        commit();
        renderRegionEditor();
      }
      break;
    case 'scale':
    case 'rotate':
      commit();
      renderRegionEditor();
      renderRegionList();
      break;
  }
  schedule();
}
vc.addEventListener('pointerup', endPointer);
vc.addEventListener('pointercancel', endPointer);
vc.addEventListener('contextmenu', (e) => e.preventDefault());

vc.addEventListener('wheel', (e) => {
  if (!S.doc) return;
  e.preventDefault();
  const p = pos(e);
  const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || mouseWheel) {
    const k = e.ctrlKey && !mouseWheel ? 0.01 : 0.0018;
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : k)));
  } else {
    view.panX -= e.deltaX;
    view.panY -= e.deltaY;
    view.fitted = false;
    schedule();
  }
}, { passive: false });

// ---------------------------------------------------------------- handoff

function steps() {
  const imgs = packetImages(handoff, S.regions.length);
  const list = [];
  const d = S.doc;
  const sub = {
    original: 'Unedited, for reference',
    rough: d ? `${d.W}×${d.H} PNG` : '',
    annotated: `${S.regions.length} numbered change${S.regions.length === 1 ? '' : 's'}`,
  };
  if (handoff.combine && imgs.length > 1) list.push({ key: 'combined', label: NAMES.combined, sub: imgs.map((k) => PANEL[k]).join(' + ') });
  else imgs.forEach((k) => list.push({ key: k, label: NAMES[k], sub: sub[k] }));
  const words = currentPrompt().split(/\s+/).filter(Boolean).length;
  list.push({ key: 'prompt', label: NAMES.prompt, sub: `${{ detailed: 'Detailed', short: 'Short', json: 'JSON' }[handoff.style]}, ${words} words` });
  return list;
}

function currentPrompt() {
  if (!S.doc) return '';
  return promptOverride ?? buildPrompt(S, handoff);
}

function makeImage(key) {
  ensureRendered();
  const rough = copyCanvas(adjuster.canvas);
  if (key === 'rough') return rough;
  if (key === 'original') return copyCanvas(S.doc.base);
  if (key === 'annotated') return makeAnnotated(rough, S.regions, { legend: handoff.legend });
  if (key === 'combined') {
    const imgs = packetImages(handoff, S.regions.length);
    return makeCombined(imgs.map((k) => ({ label: PANEL[k], canvas: k === 'rough' ? rough : makeImage(k) })));
  }
  return rough;
}

function copyImageTo(makeBlob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.reject(new Error('no image clipboard'));
  const blob = Promise.resolve().then(makeBlob);
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through */
  }
  const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand && document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy refused');
}

async function copyStep(key) {
  if (!S.doc) {
    $('file-input').click();
    return;
  }
  const st = steps();
  const idx = st.findIndex((s) => s.key === key);
  try {
    if (key === 'prompt') await copyText(currentPrompt());
    else await copyImageTo(() => canvasToBlob(makeImage(key)));
    copied.add(key);
    const next = st.find((s) => !copied.has(s.key));
    toast(
      next
        ? `Copied ${NAMES[key].toLowerCase()} (${idx + 1} of ${st.length}). Paste it into your chat, then copy the ${NAMES[next.key].toLowerCase()}.`
        : `Copied ${NAMES[key].toLowerCase()}. That's the whole packet.`
    );
  } catch (err) {
    console.warn('BridgeBack copy failed', err);
    toast(`This browser blocked copying the ${NAMES[key].toLowerCase()}. Save it as a file instead.`, { label: 'Save', run: () => saveStep(key) });
  }
  renderSteps();
  updateHandoffButton();
}

function nextStep() {
  const st = steps();
  let nx = st.find((s) => !copied.has(s.key));
  if (!nx) {
    copied.clear();
    nx = st[0];
  }
  return copyStep(nx.key);
}

function updateHandoffButton() {
  const label = $('handoff-label');
  if (!label) return;
  if (!S.doc) {
    label.textContent = 'Open an image';
    return;
  }
  const st = steps();
  const nx = st.find((s) => !copied.has(s.key));
  if (!copied.size) label.textContent = 'Copy for AI';
  else if (nx) label.textContent = `Copy ${NAMES[nx.key].toLowerCase()} (${st.indexOf(nx) + 1}/${st.length})`;
  else label.textContent = 'Copied. Start over';
  $('btn-handoff').title = nx ? `Copies the ${NAMES[nx.key].toLowerCase()} (Ctrl+Shift+C)` : 'Copy the packet again (Ctrl+Shift+C)';
}

let dlCap = null;
if (window.claude?.use) {
  window.claude.use('downloads').then((d) => { dlCap = d; }).catch(() => {});
}

async function saveBlob(blob, filename) {
  if (dlCap) {
    try {
      await dlCap.save({ filename, data: blob });
      return;
    } catch (e) {
      if (e?.code === 'declined') return;
      toast('Saving files is not available here.');
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function fileBase() {
  const n = (S.doc?.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return 'bridgeback-' + (n || 'image');
}

async function saveStep(key) {
  if (!S.doc) return;
  if (key === 'prompt') {
    const json = handoff.style === 'json';
    return saveBlob(new Blob([currentPrompt()], { type: 'text/plain' }), `${fileBase()}-prompt.${json ? 'json' : 'txt'}`);
  }
  const blob = await canvasToBlob(makeImage(key));
  return saveBlob(blob, `${fileBase()}-${key}.png`);
}

function buildHandoff() {
  const p = $('tab-handoff');
  const ta = h('textarea', { id: 'prompt-text', class: 'prompt', rows: 14, spellcheck: 'false' });
  ta.addEventListener('input', () => {
    promptOverride = ta.value;
    $('prompt-edited').hidden = false;
    $('prompt-reset').hidden = false;
    copied.delete('prompt');
    updateHandoffButton();
  });
  const setOpt = (k) => (v) => {
    handoff[k] = v;
    store.prefs.set('handoff', handoff);
    copied.clear();
    refreshHandoff(true);
    updateHandoffButton();
  };
  put(p, 
    panelHead('Handoff'),
    h('p', { class: 'help' }, 'Paste these into your AI chat in order. The Copy for AI button steps through them, one press per paste.'),
    h('ol', { class: 'steps', id: 'steps' }),
    h('fieldset', { class: 'group' },
      h('legend', { class: 'group-label' }, 'What to send'),
      h('div', { class: 'checks' },
        checkbox('h-annotated', 'Marked-up copy', handoff.annotated, setOpt('annotated'), 'Numbered outlines on each change'),
        checkbox('h-legend', 'Legend strip', handoff.legend, setOpt('legend'), 'Lists the changes under the marked-up copy'),
        checkbox('h-original', 'Original image', handoff.original, setOpt('original'), 'Useful when the chat never saw it'),
        checkbox('h-combine', 'Combine into one image', handoff.combine, setOpt('combine'), 'For chats that take one image per message')
      )
    ),
    h('div', { class: 'group' },
      h('div', { class: 'group-label' }, 'Prompt style'),
      segmented('Prompt style', [['detailed', 'Detailed'], ['short', 'Short'], ['json', 'JSON']], handoff.style, (v) => {
        handoff.style = v;
        store.prefs.set('handoff', handoff);
        promptOverride = null;
        copied.delete('prompt');
        refreshHandoff(true);
        updateHandoffButton();
      })
    ),
    h('div', { class: 'field prompt-field' },
      h('div', { class: 'prompt-head' },
        h('label', { class: 'field-label', for: 'prompt-text' }, 'Prompt'),
        h('span', { class: 'tag', id: 'prompt-edited', hidden: true }, 'Edited'),
        h('button', { type: 'button', class: 'link', id: 'prompt-reset', hidden: true, onclick: () => { promptOverride = null; refreshHandoff(true); } }, 'Use generated'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => copyStep('prompt') }, 'Copy')
      ),
      ta
    ),
    h('div', { class: 'group' },
      h('div', { class: 'group-label' }, 'Save as files'),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => saveStep('rough') }, 'Rough edit'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => saveStep('annotated') }, 'Marked-up'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => saveStep(handoff.combine ? 'combined' : 'original') }, handoff.combine ? 'Combined' : 'Original'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => saveStep('prompt') }, 'Prompt')
      )
    )
  );
}

const thumbs = { version: -1, map: new Map() };

function renderSteps() {
  const el = $('steps');
  if (!el || !S.doc) return;
  if (thumbs.version !== version) {
    thumbs.version = version;
    thumbs.map.clear();
  }
  const st = steps();
  put(el, 
    ...st.map((s, i) => {
      const done = copied.has(s.key);
      let thumb;
      if (s.key === 'prompt') thumb = h('div', { class: 'thumb text', 'aria-hidden': 'true' }, 'Aa');
      else {
        let src = thumbs.map.get(s.key);
        if (!src) {
          src = fitCanvas(makeImage(s.key), 180);
          thumbs.map.set(s.key, src);
        }
        thumb = makeCanvas(src.width, src.height);
        thumb.getContext('2d').drawImage(src, 0, 0);
        thumb.className = 'thumb';
      }
      return h('li', { class: 'step' + (done ? ' is-done' : '') },
        h('span', { class: 'step-n' }, done ? '✓' : String(i + 1)),
        thumb,
        h('div', { class: 'step-text' }, h('div', { class: 'step-label' }, s.label), h('div', { class: 'step-sub' }, s.sub)),
        h('button', { type: 'button', class: 'btn sm' + (done ? '' : ' accent'), onclick: () => copyStep(s.key) }, done ? 'Again' : 'Copy')
      );
    })
  );
}

function refreshHandoff(force) {
  if (!S.doc) return;
  if (ui.tab !== 'handoff' && !force) return;
  const ta = $('prompt-text');
  if (ta) {
    if (promptOverride == null) {
      if (document.activeElement !== ta) ta.value = buildPrompt(S, handoff);
      $('prompt-edited').hidden = true;
      $('prompt-reset').hidden = true;
    }
  }
  renderSteps();
}
const refreshHandoffSoon = debounce(() => refreshHandoff(false), 250);

// ---------------------------------------------------------------- tabs, popovers, toasts

function showTab(name) {
  ui.tab = name;
  document.querySelectorAll('#tabs [role=tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  for (const t of ['adjust', 'direction', 'regions', 'handoff']) $('tab-' + t).hidden = t !== name;
  if (name === 'handoff') refreshHandoff(true);
}

let toastTimer = 0;
function toast(msg, action) {
  const t = $('toast');
  put(t, 
    h('span', null, msg),
    action ? h('button', { type: 'button', class: 'btn sm', onclick: () => { t.hidden = true; action.run(); } }, action.label) : null
  );
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 4200);
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let recentUrls = [];
async function toggleRecent(force) {
  const pop = $('recent-pop');
  const btn = $('btn-recent');
  if (!pop.hidden || force === false) {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    recentUrls.forEach((u) => URL.revokeObjectURL(u));
    recentUrls = [];
    return;
  }
  let list = [];
  try {
    list = await store.all();
  } catch {
    list = null;
  }
  const items = (list || []).map((rec) => {
    const url = rec.thumb ? URL.createObjectURL(rec.thumb) : '';
    if (url) recentUrls.push(url);
    return h('li', { class: 'recent' + (rec.id === S.doc?.id ? ' is-current' : '') },
      h('button', {
        type: 'button', class: 'recent-open',
        onclick: async () => {
          toggleRecent(false);
          try {
            await loadRecord(rec);
          } catch (e) {
            toast('That saved image could not be read.');
          }
        },
      },
        url ? h('img', { src: url, alt: '' }) : h('span', { class: 'thumb-empty' }),
        h('span', { class: 'recent-text' }, h('span', { class: 'recent-name' }, rec.name), h('span', { class: 'recent-when' }, `${fmtWhen(rec.updated)} · ${(rec.state?.regions || []).length} marks`))
      ),
      h('button', {
        type: 'button', class: 'icon-btn sm', 'aria-label': `Forget ${rec.name}`, title: 'Forget',
        onclick: async () => {
          await store.del(rec.id).catch(() => {});
          toggleRecent(false);
          toggleRecent();
        },
      }, icon('trash'))
    );
  });
  put(pop, 
    h('div', { class: 'pop-head' }, 'Recent in this browser'),
    list === null
      ? h('p', { class: 'help' }, "This browser isn't letting BridgeBack save, so nothing is kept between visits.")
      : items.length
        ? h('ul', { class: 'recent-list' }, items)
        : h('p', { class: 'help' }, 'Images you open are kept here, with their edits, so you can pick up where you left off.'),
    h('div', { class: 'pop-foot' }, h('button', { type: 'button', class: 'btn sm', onclick: () => { toggleRecent(false); loadSample(); } }, 'Open the sample'))
  );
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 336)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
}

function toggleHelp(show) {
  const el = $('help');
  el.hidden = show === undefined ? !el.hidden : !show;
  if (!el.hidden) el.querySelector('button')?.focus();
}

// ---------------------------------------------------------------- global wiring

function wire() {
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) openBlob(f, f.name);
    e.target.value = '';
  });
  $('btn-recent').addEventListener('click', () => toggleRecent());
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-help').addEventListener('click', () => toggleHelp());
  $('help').addEventListener('click', (e) => { if (e.target === $('help') || e.target.closest('[data-close]')) toggleHelp(false); });
  $('btn-handoff').addEventListener('click', () => nextStep());
  $('empty-open').addEventListener('click', () => $('file-input').click());
  $('empty-sample').addEventListener('click', () => loadSample());

  const cmp = $('btn-compare');
  const on = (e) => { e.preventDefault(); ui.comparing = true; cmp.setAttribute('aria-pressed', 'true'); schedule(); };
  const off = () => { if (!ui.comparing) return; ui.comparing = false; cmp.setAttribute('aria-pressed', 'false'); schedule(); };
  cmp.addEventListener('pointerdown', on);
  cmp.addEventListener('pointerup', off);
  cmp.addEventListener('pointerleave', off);
  cmp.addEventListener('pointercancel', off);
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') on(e); });
  cmp.addEventListener('keyup', off);

  const outl = $('btn-outlines');
  outl.addEventListener('click', () => {
    ui.outlines = !ui.outlines;
    outl.setAttribute('aria-pressed', String(ui.outlines));
    schedule();
  });

  $('zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('zoom-out').addEventListener('click', () => zoomCenter(0.8));
  $('zoom-fit').addEventListener('click', () => { fit(); schedule(); });
  $('zoom-level').addEventListener('click', () => {
    const r = $('stage').getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / view.zoom);
  });

  const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus();
      showTab(n.dataset.tab);
    });
  });

  document.addEventListener('pointerdown', (e) => {
    const pop = $('recent-pop');
    if (!pop.hidden && !pop.contains(e.target) && !$('btn-recent').contains(e.target)) toggleRecent(false);
  });

  document.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!img) return;
    if (isTypingTarget(e.target) && items.some((i) => i.type === 'text/plain')) return;
    e.preventDefault();
    const f = img.getAsFile();
    if (f) openBlob(f, f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? f.name : 'Pasted image');
  });

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('dropzone').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) $('dropzone').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('dropzone').hidden = true;
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) openBlob(f, f.name);
    else toast('Drop an image file: PNG, JPEG, WebP or GIF.');
  });

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { ui.spaceHeld = false; updateCursor(); }
    if (e.key === '\\' && ui.comparing) { ui.comparing = false; $('btn-compare').setAttribute('aria-pressed', 'false'); schedule(); }
  });
  window.addEventListener('blur', () => { ui.spaceHeld = false; if (ui.comparing) { ui.comparing = false; schedule(); } });
}

function nudge(dx, dy) {
  const r = selected();
  if (!r) return;
  if (r.kind === 'pin') {
    r.pin.x = clamp(r.pin.x + dx, 0, S.doc.W);
    r.pin.y = clamp(r.pin.y + dy, 0, S.doc.H);
    changed();
    schedule();
  } else {
    r.ops.dx += dx;
    r.ops.dy += dy;
    invalidate();
  }
  commitSoon();
  renderRegionList();
}

function onKey(e) {
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (k === 'Escape') {
    if (!$('help').hidden) return toggleHelp(false);
    if (!$('recent-pop').hidden) return toggleRecent(false);
    if (ui.picking) { ui.picking = null; renderToolOpts(); updateCursor(); return; }
    if (drag && drag.type !== 'pinch') { drag = null; schedule(); return; }
    if (!isTypingTarget(e.target) && ui.selectedId) select(null);
    else if (isTypingTarget(e.target)) e.target.blur();
    return;
  }
  if (mod && e.shiftKey && k.toLowerCase() === 'c') {
    e.preventDefault();
    nextStep();
    return;
  }
  if (isTypingTarget(e.target)) return;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === 'o') { e.preventDefault(); $('file-input').click(); return; }
  if (mod || e.altKey) return;
  const toolKeys = { v: 'move', l: 'lasso', e: 'ellipse', m: 'rect', w: 'wand', p: 'pin', h: 'hand' };
  const lower = k.toLowerCase();
  if (toolKeys[lower] && !e.repeat) { setTool(toolKeys[lower]); return; }
  const step = e.shiftKey ? 10 : 1;
  switch (k) {
    case ' ':
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      if (!ui.spaceHeld) { ui.spaceHeld = true; updateCursor(); }
      break;
    case '\\':
      if (!ui.comparing) { ui.comparing = true; $('btn-compare').setAttribute('aria-pressed', 'true'); schedule(); }
      break;
    case 'o':
    case 'O':
      $('btn-outlines').click();
      break;
    case '0': fit(); schedule(); break;
    case '1': { const r = $('stage').getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / view.zoom); break; }
    case '+': case '=': zoomCenter(1.25); break;
    case '-': case '_': zoomCenter(0.8); break;
    case '?': toggleHelp(); break;
    case 'Delete': case 'Backspace':
      if (ui.selectedId) { e.preventDefault(); deleteRegion(ui.selectedId); }
      break;
    case 'ArrowLeft': if (ui.selectedId) { e.preventDefault(); nudge(-step, 0); } break;
    case 'ArrowRight': if (ui.selectedId) { e.preventDefault(); nudge(step, 0); } break;
    case 'ArrowUp': if (ui.selectedId) { e.preventDefault(); nudge(0, -step); } break;
    case 'ArrowDown': if (ui.selectedId) { e.preventDefault(); nudge(0, step); } break;
  }
}

// ---------------------------------------------------------------- boot

async function boot() {
  buildToolRail();
  buildHandoff();
  renderRegions();
  buildAdjust();
  buildDirection();
  renderToolOpts();
  wire();
  updateCursor();
  new ResizeObserver(() => resizeView()).observe($('stage'));
  resizeView();
  let restored = false;
  try {
    const id = store.prefs.get('lastDoc', null);
    if (id) {
      const rec = await store.get(id);
      if (rec) {
        await loadRecord(rec);
        restored = true;
      }
    }
  } catch (e) {
    console.warn('BridgeBack: could not restore the last session', e);
  }
  if (!restored) loadSample();
  document.fonts?.load?.('600 16px "Schibsted Grotesk"').then(() => schedule()).catch(() => {});
  window.__bb = { S, ui, handoff, view, steps, currentPrompt, makeImage };
}

boot();
