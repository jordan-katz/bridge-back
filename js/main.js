// BridgeBack: rough-edit an image, then hand it back to an AI image session with a clear edit packet.

import { clamp, makeCanvas, ctx2d, uid, canvasToBlob, loadImage, blobToCanvas, fitCanvas, rgbToHex, debounce, h, isTypingTarget } from './util.js';
import { createAdjuster } from './gl.js';
import * as R from './regions.js';
import { buildPrompt, shortSummary, regionColor, packetImages, liveRegions, kindLabel, aspectWords, isBlank } from './prompt.js';
import { makeAnnotated, makeCombined, copyCanvas, drawPinMarker, badge, drawCalloutArrow, drawTextCallout } from './export.js';
import * as store from './store.js';
import { sampleScene } from './sample.js';
import * as X from './canvasext.js';
import * as SEG from './segment.js';
import { startTour } from './tour.js';

const MAX_WORK = 2048;
const MINZ = 0.04, MAXZ = 32;
const $ = (id) => document.getElementById(id);
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const finePointer = () => window.matchMedia?.('(pointer: fine)').matches;
const coarse = () => window.matchMedia?.('(pointer: coarse)').matches;
const HIT = () => (coarse() ? 18 : 10); // handle hit radius in screen px

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
const ARROW_CHIPS = ['Move it here', 'Make it face this way', 'Make it longer', 'Look here'];
const TEXT_CHIPS = ['Make this ', 'Fix this', 'Too dark', 'Too busy', 'Sharper here'];
const CHIPS = { area: AREA_CHIPS, pin: PIN_CHIPS, arrow: ARROW_CHIPS, text: TEXT_CHIPS };
const PLACEHOLDERS = {
  area: 'What is this, and what should change? e.g. the jacket, make it worn leather',
  pin: 'What should appear here? e.g. a small potted fern',
  arrow: 'What should the AI do along this arrow? e.g. move the lamp over here',
  text: 'The note to write on the image, e.g. too dark, brighten this',
};
const NOTE_LABEL = { area: 'Note for the AI', pin: 'What to add', arrow: 'What the arrow means', text: 'Label text' };

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
  smart: '<path d="M5 19l6.5-6.5"/><path d="M14.5 3.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/><path d="M19 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  brush: '<path d="M20.5 3.5c-3.2 1.6-7.6 5.6-9.6 8.3l1.3 1.3c2.7-2 6.7-6.4 8.3-9.6z"/><path d="M10.4 12.4c-2-.3-3.6 1-3.9 2.8-.3 1.9-1.6 2.9-3 3.3 3 1.6 7.4.7 7.9-3.1z"/>',
  arrow: '<path d="M4.5 19.5L18 6"/><path d="M10 5.5h8.5V14"/>',
  text: '<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  rounds: '<rect x="3.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M8 4.5h10a2 2 0 012 2v10"/>',
  canvas: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15"/>',
};
const icon = (name, cls = 'ico') =>
  h('span', { class: cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

const TOOLS = [
  { id: 'move', key: 'V', name: 'Move', label: 'Move, scale and rotate' },
  { id: 'smart', key: 'S', name: 'Smart', label: 'Smart select: click an object to select it', sep: true },
  { id: 'lasso', key: 'L', name: 'Lasso', label: 'Lasso select: draw around it' },
  { id: 'brush', key: 'B', name: 'Brush', label: 'Brush select: paint over it' },
  { id: 'ellipse', key: 'E', name: 'Ellipse', label: 'Ellipse select' },
  { id: 'rect', key: 'M', name: 'Box', label: 'Rectangle select' },
  { id: 'wand', key: 'W', name: 'Wand', label: 'Magic wand: select by color' },
  { id: 'arrow', key: 'A', name: 'Arrow', label: 'Arrow: drag from what to where', sep: true },
  { id: 'text', key: 'T', name: 'Text', label: 'Text: write a note on the image' },
  { id: 'pin', key: 'P', name: 'Marker', label: 'Marker: ask for something new here' },
  { id: 'hand', key: 'H', name: 'Pan', label: 'Pan', sep: true },
];
const SELECT_TOOLS = ['smart', 'lasso', 'brush', 'ellipse', 'rect', 'wand'];
const CURSORS = { move: 'default', smart: 'crosshair', lasso: 'crosshair', brush: 'none', ellipse: 'crosshair', rect: 'crosshair', wand: 'crosshair', arrow: 'crosshair', text: 'text', pin: 'copy', hand: 'grab' };

const NAMES = { original: 'Original image', rough: 'Rough edit', annotated: 'Marked-up image', combined: 'Combined image', prompt: 'Prompt' };
const PANEL = { original: 'Original', rough: 'Rough edit', annotated: 'Marked-up' };

// ---------------------------------------------------------------- state

const defaultGlobal = () => ({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, warmth: 0, tint: 0, vignette: 0 });
const defaultIntent = () => ({
  fidelity: 0, realism: 0, detail: 0, dof: 0, drama: 0, mood: 0,
  light: 'unchanged', time: 'unchanged', framing: 'unchanged',
  preserve: { identity: false, text: false, composition: true, style: false },
});

const S = { doc: null, global: defaultGlobal(), intent: defaultIntent(), regions: [], note: '', round: 1, rounds: [] };
const ui = {
  tool: TOOLS.some((t) => t.id === store.prefs.get('tool')) ? store.prefs.get('tool') : 'lasso',
  selMode: 'new', wandTol: store.prefs.get('wandTol', 18), wandContig: true,
  brushSize: store.prefs.get('brushSize', 40), hover: null, viewingRound: null, smartBusy: false,
  selectedId: null, extra: new Set(), tab: 'adjust', outlines: true, comparing: false, picking: null, spaceHeld: false,
  shiftHeld: false, altHeld: false,
};
const handoff = Object.assign({ original: false, annotated: true, combine: false, legend: true, bundle: false, style: 'detailed' }, store.prefs.get('handoff', {}));
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
/** Number shown for each mark: its position among visible marks. Hidden marks get none. */
function numbers() {
  const m = new Map();
  liveRegions(S.regions).forEach((r, i) => m.set(r.id, i + 1));
  return m;
}
const OFF_COLOR = '#8b939c';
const colorOf = (nums, r) => (nums.has(r.id) ? regionColor(nums.get(r.id) - 1) : OFF_COLOR);
let baseVersion = 0; // bumps whenever the working image itself changes
const selected = () => (ui.selectedId ? byId(ui.selectedId) : null);
const isSel = (id) => id === ui.selectedId || ui.extra.has(id);
const selectedIds = () => (ui.selectedId ? [ui.selectedId, ...ui.extra] : [...ui.extra]).filter((id) => byId(id));
const multi = () => selectedIds().length > 1;
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
      R.composite(comp, S.doc.base, S.regions, matteColor());
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
  const opts = $('toolopts');
  const optsBottom = opts && !opts.hidden ? opts.offsetTop + opts.offsetHeight + 12 : 0;
  const padX = Math.min(40, r.width * 0.06), padTop = Math.max(Math.min(56, r.height * 0.1), Math.min(optsBottom, r.height * 0.22)), padBot = Math.min(56, r.height * 0.1);
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
  const past = ui.viewingRound && S.rounds.find((r) => r.n === ui.viewingRound);
  if (past?.canvas) {
    const k = Math.min(W / past.canvas.width, H / past.canvas.height);
    const pw = past.canvas.width * k, ph = past.canvas.height * k;
    vx.fillStyle = '#15171a';
    vx.fillRect(0, 0, W, H);
    vx.drawImage(past.canvas, (W - pw) / 2, (H - ph) / 2, pw, ph);
  } else {
    if (ui.comparing && matteColor()) {
      vx.fillStyle = matteColor();
      vx.fillRect(0, 0, W, H);
    }
    vx.drawImage(ui.comparing ? S.doc.base : adjuster.canvas, 0, 0);
  }
  vx.restore();
  const flag = $('compare-flag');
  flag.hidden = !ui.comparing && !past;
  if (past) {
    if (flag.dataset.round !== String(past.n)) {
      flag.dataset.round = String(past.n);
      put(flag, h('span', null, `Round ${past.n} image`), h('button', { type: 'button', class: 'flag-btn', onclick: () => viewRound(null) }, `Back to round ${S.round}`));
    }
  } else if (flag.dataset.round !== '') {
    flag.dataset.round = '';
    flag.textContent = 'Original';
  }
  if (ui.comparing || past) return;
  if (X.hasExt(S.doc.ext)) drawExtFrame();
  if (ui.outlines) drawOverlays();
  drawDragPreview();
  drawBrushCursor();
}

function drawExtFrame() {
  const e = S.doc.ext;
  const a = toScreen(e.l, e.t), b = toScreen(S.doc.W - e.r, S.doc.H - e.b);
  vx.save();
  vx.setLineDash([7, 5]);
  vx.lineWidth = 2.5;
  vx.strokeStyle = 'rgba(0,0,0,.45)';
  vx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  vx.lineWidth = 1.2;
  vx.strokeStyle = '#fff';
  vx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  vx.restore();
}

function drawBrushCursor() {
  if (ui.tool !== 'brush' || !ui.hover || ui.spaceHeld) return;
  const r = (ui.brushSize / 2) * view.zoom;
  vx.save();
  vx.beginPath();
  vx.arc(ui.hover.x, ui.hover.y, Math.max(2, r), 0, Math.PI * 2);
  vx.lineWidth = 3;
  vx.strokeStyle = 'rgba(0,0,0,.5)';
  vx.stroke();
  vx.lineWidth = 1.3;
  vx.strokeStyle = '#fff';
  vx.stroke();
  vx.restore();
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

const textBoxes = new Map(); // id -> screen rect of each label, refreshed every frame

function drawOverlays() {
  const z = view.zoom;
  const nums = numbers();
  textBoxes.clear();
  S.regions.forEach((r) => {
    if (r.kind !== 'area') return;
    const col = colorOf(nums, r);
    const sel = isSel(r.id);
    const o = r.ops;
    const path = R.maskPath(r.mask);
    const off = !r.enabled;
    vx.save();
    vx.translate(view.panX, view.panY);
    vx.scale(z, z);
    const ghost = o.remove || (R.isMoved(o) && o.fill !== 'keep');
    if (ghost || off) {
      vx.setLineDash([5 / z, 4 / z]);
      vx.lineWidth = (off ? 1.4 : 1.3) / z;
      vx.strokeStyle = col;
      vx.globalAlpha = off ? 0.45 : 0.9;
      vx.stroke(path);
      vx.setLineDash([]);
      vx.globalAlpha = 1;
    }
    if (!o.remove && !off) {
      vx.save();
      if (isBlank(r)) vx.globalAlpha = 0.75;
      R.applyTransform(vx, r);
      const k = z * (o.scale / 100);
      vx.lineJoin = 'round';
      vx.lineWidth = (sel ? 4.6 : 3.4) / k;
      vx.strokeStyle = 'rgba(0,0,0,.5)';
      vx.stroke(path);
      vx.lineWidth = (sel ? 2.6 : 1.6) / k;
      vx.strokeStyle = col;
      vx.stroke(path);
      vx.restore();
    }
    vx.restore();
    if ((o.dx || o.dy) && !off) {
      const t = R.tf(r);
      screenArrow(toScreen(t.cx, t.cy), toScreen(t.tx, t.ty), col);
    }
  });
  S.regions.forEach((r) => {
    if (r.kind !== 'arrow') return;
    const a = r.arrow, p = toScreen(a.x1, a.y1), q = toScreen(a.x2, a.y2);
    vx.save();
    if (!r.enabled) vx.globalAlpha = 0.55;
    drawCalloutArrow(vx, p.x, p.y, q.x, q.y, colorOf(nums, r), isSel(r.id) ? 5 : 4);
    vx.restore();
  });
  S.regions.forEach((r) => {
    const col = colorOf(nums, r);
    const sel = isSel(r.id);
    const n = nums.get(r.id) || (r.enabled && isBlank(r) ? '?' : '·');
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
      drawPinMarker(vx, p.x, p.y, 10, n, col);
      return;
    }
    if (r.kind === 'text') {
      const p = toScreen(r.pin.x, r.pin.y);
      vx.save();
      if (!r.enabled) vx.globalAlpha = 0.6;
      const size = clamp(view.zoom * 26, 10, 13);
      const maxW = clamp(S.doc.W * view.zoom * 0.42, 90, 220);
      textBoxes.set(r.id, drawTextCallout(vx, p.x, p.y, r.note, size, n, col, { selected: sel, maxW }));
      vx.restore();
      return;
    }
    if (r.kind === 'arrow') {
      const p = toScreen(r.arrow.x1, r.arrow.y1);
      badge(vx, p.x, p.y, sel ? 11 : 9.5, n, col);
      return;
    }
    const a = R.regionAnchor(r);
    const s = toScreen(a.x, a.y);
    const br = sel ? 11 : 9.5;
    badge(vx, s.x, s.y - br - 3, br, n, col);
  });
  const sel = selected();
  if (!sel || multi() || ui.tool !== 'move') return;
  if (sel.kind === 'area' && !sel.ops.remove) drawHandles(sel);
  if (sel.kind === 'arrow') {
    const a = sel.arrow;
    for (const pt of [toScreen(a.x1, a.y1), toScreen(a.x2, a.y2)]) {
      vx.save();
      vx.beginPath();
      vx.arc(pt.x, pt.y, coarse() ? 9 : 6, 0, Math.PI * 2);
      vx.fillStyle = '#fff';
      vx.fill();
      vx.strokeStyle = 'rgba(0,0,0,.6)';
      vx.lineWidth = 1;
      vx.stroke();
      vx.restore();
    }
  }
}

function handlePts(r) {
  const c = R.corners(r).map((p) => toScreen(p.x, p.y));
  const t = R.tf(r);
  const center = toScreen(t.tx, t.ty);
  const top = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
  const dx = top.x - center.x, dy = top.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const reach = coarse() ? 40 : 28;
  return { corners: c, top, center, rot: { x: top.x + (dx / len) * reach, y: top.y + (dy / len) * reach } };
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
  const k = coarse() ? 8 : 5;
  const knob = (p, round) => {
    vx.beginPath();
    if (round) vx.arc(p.x, p.y, k + 0.5, 0, Math.PI * 2);
    else vx.rect(p.x - k, p.y - k, k * 2, k * 2);
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
  const hit = HIT();
  if (Math.hypot(p.x - hp.rot.x, p.y - hp.rot.y) < hit + 1) return 'rotate';
  if (hp.corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y) < hit)) return 'scale';
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
  } else if (drag.type === 'brush' && drag.pts.length) {
    vx.beginPath();
    drag.pts.forEach((p, i) => {
      const s = toScreen(p.x, p.y);
      i ? vx.lineTo(s.x, s.y) : vx.moveTo(s.x, s.y);
    });
    if (drag.pts.length === 1) {
      const s = toScreen(drag.pts[0].x, drag.pts[0].y);
      vx.lineTo(s.x + 0.01, s.y);
    }
    vx.lineCap = 'round';
    vx.lineJoin = 'round';
    vx.lineWidth = ui.brushSize * view.zoom;
    vx.strokeStyle = drag.mode === 'sub' ? 'rgba(255,60,60,.38)' : 'rgba(30,167,255,.38)';
    vx.stroke();
  } else if (drag.type === 'arrow') {
    const a = toScreen(drag.a.x, drag.a.y), b = toScreen(drag.b.x, drag.b.y);
    drawCalloutArrow(vx, a.x, a.y, b.x, b.y, regionColor(liveRegions(S.regions).length), 4);
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

const MATTES = [['#ffffff', 'White'], ['#808080', 'Gray'], ['#000000', 'Black'], ['transparent', 'Keep transparent']];
const matteColor = () => (S.doc?.hasAlpha && S.doc.matte && S.doc.matte !== 'transparent' ? S.doc.matte : null);

function detectAlpha(c) {
  const d = ctx2d(c, true).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

function flattened(src) {
  const c = copyCanvas(src);
  const m = matteColor();
  if (!m) return c;
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'destination-over';
  x.fillStyle = m;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

function mkRegion(mask, { note = '', ops = {} } = {}) {
  return { id: uid(), kind: 'area', mask, pin: null, arrow: null, note, enabled: true, ops: { ...R.defaultOps(), ...ops } };
}

function mkPoint(kind, ip, note = '') {
  return { id: uid(), kind, pin: { x: Math.round(ip.x), y: Math.round(ip.y) }, mask: null, arrow: null, note, enabled: true, ops: R.defaultOps() };
}

function cloneRegion(r) {
  return { ...r, ops: { ...r.ops }, pin: r.pin ? { ...r.pin } : null, arrow: r.arrow ? { ...r.arrow } : null };
}

/** Move every mark by (dx, dy) image px. Used when the canvas grows on the top or left. */
function shiftRegions(regions, dx, dy) {
  if (!dx && !dy) return;
  for (const r of regions) {
    // A fresh canvas, because outline and anchor caches are keyed by canvas and hold absolute positions.
    if (r.mask) r.mask = { ...r.mask, id: uid(), x: r.mask.x + dx, y: r.mask.y + dy, canvas: copyCanvas(r.mask.canvas) };
    if (r.pin) r.pin = { x: r.pin.x + dx, y: r.pin.y + dy };
    if (r.arrow) r.arrow = { x1: r.arrow.x1 + dx, y1: r.arrow.y1 + dy, x2: r.arrow.x2 + dx, y2: r.arrow.y2 + dy };
  }
}

/** The working image for the document: the original, padded if the canvas was extended. */
function rebuildBase(doc) {
  doc.base = X.buildExtended(doc.base0, doc.ext);
  doc.W = doc.base.width;
  doc.H = doc.base.height;
  comp = makeCanvas(doc.W, doc.H);
  compDirty = true;
  compData = null;
  baseVersion++;
}

function setDoc(doc, st = {}) {
  doc.base0 = doc.base0 || doc.base;
  doc.ext = doc.ext || X.noExt();
  S.doc = doc;
  rebuildBase(doc);
  S.round = st.round || 1;
  S.rounds = st.rounds || [];
  ui.viewingRound = null;
  S.global = { ...defaultGlobal(), ...(st.global || {}) };
  const di = defaultIntent();
  S.intent = { ...di, ...(st.intent || {}), preserve: { ...di.preserve, ...(st.intent?.preserve || {}) } };
  S.note = st.note || '';
  S.regions = st.regions || [];
  ui.selectedId = null;
  ui.extra.clear();
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
  renderRounds();
  renderToolOpts();
  invalidate();
  $('empty').hidden = true;
}

/** A new image arrived (paste or drop) while something is open: new round or new document? */
function openIncoming(blob, name) {
  if (!S.doc) return openBlob(blob, name);
  dialog({
    title: 'What is this image?',
    body: [
      h('p', null, `If it's the AI's reply, start round ${S.round + 1}. Your marks come along, switched off, so you can check what it got right.`),
    ],
    actions: [
      { label: `Start round ${S.round + 1}`, primary: true, run: () => startNextRound(blob) },
      { label: 'Open as a new image', run: () => openBlob(blob, name) },
      { label: 'Cancel' },
    ],
  });
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
    const hasAlpha = detectAlpha(base);
    setDoc({ id: uid(), name: name || 'Pasted image', base, W: base.width, H: base.height, origW, origH, touched: true, hasAlpha, matte: '#ffffff' });
    toast(hasAlpha
      ? 'This image has a transparent background. It is shown on white, and you can change that at the top of Adjust.'
      : `Opened ${name || 'pasted image'}.`);
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
  const pin = mkPoint('pin', spots.step, 'Add a sleeping orange cat on the step');
  const sun = { ...mkPoint('arrow', spots.step), pin: null, arrow: { ...spots.sunArrow }, note: 'Lower the sun so it sits just above the mountains' };
  const sky = mkPoint('text', spots.skyNote, 'Sky is too flat. Add soft evening clouds');
  setDoc(
    { id: uid(), name: 'Sample cottage', base: canvas, W, H, origW: W, origH: H, sample: true },
    {
      global: { warmth: 25, contrast: 10 },
      intent: { time: 'golden', preserve: { composition: true, style: true } },
      note: 'Keep the flat illustration style.',
      regions: [door, tree, pin, sun, sky],
    }
  );
}

function updateDocInfo() {
  const d = S.doc;
  const el = $('docinfo');
  el.hidden = !d;
  if (!d) {
    el.textContent = '';
    return;
  }
  const b0 = d.base0 || d.base;
  const scaled = d.origW && (d.origW !== b0.width || d.origH !== b0.height);
  const extended = X.hasExt(d.ext);
  put(el,
    d.sample ? h('span', { class: 'tag' }, 'Sample') : null,
    h('span', { class: 'docname' }, d.name),
    h('span', { class: 'mono dim' }, `${d.W}×${d.H}`),
    extended ? h('span', { class: 'dim' }, `extended to ${aspectWords(d.W, d.H)}`) : scaled ? h('span', { class: 'dim' }, `working copy of ${d.origW}×${d.origH}`) : null
  );
}

// ---------------------------------------------------------------- rounds

async function blobToWorking(blob) {
  const img = await loadImage(blob);
  const origW = img.naturalWidth, origH = img.naturalHeight;
  const k = Math.min(1, MAX_WORK / Math.max(origW, origH));
  const c = makeCanvas(origW * k, origH * k);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, origW, origH };
}

function scaleRegion(r, sx, sy, W, H) {
  if (r.mask) r.mask = R.scaleMask(r.mask, sx, sy, W, H);
  if (r.pin) r.pin = { x: Math.round(r.pin.x * sx), y: Math.round(r.pin.y * sy) };
  if (r.arrow) r.arrow = { x1: Math.round(r.arrow.x1 * sx), y1: Math.round(r.arrow.y1 * sy), x2: Math.round(r.arrow.x2 * sx), y2: Math.round(r.arrow.y2 * sy) };
  return r;
}

async function archiveCurrentRound() {
  const d = S.doc;
  if (!d.baseBlob) d.baseBlob = await canvasToBlob(d.base0, 'image/png');
  return {
    n: S.round, created: Date.now(), base: d.baseBlob, W: d.base0.width, H: d.base0.height,
    thumb: await canvasToBlob(fitCanvas(copyCanvas(d.base0), 240), 'image/jpeg', 0.82),
    state: {
      global: { ...S.global }, intent: JSON.parse(JSON.stringify(S.intent)), note: S.note, ext: { ...d.ext },
      regions: await serializeRegions(S.regions),
    },
    canvas: d.base0,
  };
}

/** The AI replied: its image becomes the base of the next round, and the marks carry over, switched off. */
async function startNextRound(blob) {
  const d = S.doc;
  if (!d) return openBlob(blob);
  try {
    const { canvas, origW, origH } = await blobToWorking(blob);
    const archived = await archiveCurrentRound();
    const sx = canvas.width / d.W, sy = canvas.height / d.H;
    const carried = S.regions.map((r) => {
      const c = scaleRegion(cloneRegion(r), sx, sy, canvas.width, canvas.height);
      c.ops = R.defaultOps();
      c.enabled = false;
      c.carried = S.round;
      return c;
    }).filter((r) => r.kind !== 'area' || r.mask);
    S.rounds.push(archived);
    S.round += 1;
    d.base0 = canvas;
    d.baseBlob = null;
    d.ext = X.noExt();
    d.origW = origW;
    d.origH = origH;
    d.hasAlpha = detectAlpha(canvas);
    d.sample = false;
    d.touched = true;
    rebuildBase(d);
    S.global = defaultGlobal();
    S.regions = carried;
    ui.selectedId = null;
    ui.extra.clear();
    ui.viewingRound = null;
    promptOverride = null;
    copied.clear();
    undoStack = [snap()];
    redoStack = [];
    updateUndo();
    view.fitted = true;
    fit();
    buildAdjust();
    renderRegions();
    updateDocInfo();
    renderRounds();
    invalidate();
    showTab('regions');
    saveSoon.flush();
    toast(carried.length
      ? `Round ${S.round} started. Your ${carried.length} mark${carried.length === 1 ? ' is' : 's are'} carried over and switched off. Turn on any the AI missed.`
      : `Round ${S.round} started.`);
  } catch (e) {
    toast(e.message || 'Could not open that image.');
  }
}

async function viewRound(n) {
  if (n == null || n === S.round || ui.viewingRound === n) {
    ui.viewingRound = null;
  } else {
    const r = S.rounds.find((x) => x.n === n);
    if (!r) return;
    if (!r.canvas) r.canvas = await blobToCanvas(r.base);
    ui.viewingRound = n;
  }
  renderRounds();
  schedule();
}

function goBackToRound(n) {
  const r = S.rounds.find((x) => x.n === n);
  if (!r) return;
  const later = S.round - n;
  dialog({
    title: `Go back to round ${n}?`,
    body: [h('p', null, `This makes round ${n} current again with its image and marks. ${later === 1 ? `Round ${S.round} is` : `Rounds ${n + 1} to ${S.round} are`} deleted.`)],
    actions: [
      { label: `Go back to round ${n}`, primary: true, run: async () => {
        const base = r.canvas || (await blobToCanvas(r.base));
        const regions = await reviveRegions(r.state.regions);
        const d = S.doc;
        setDoc(
          { id: d.id, name: d.name, base, origW: r.W, origH: r.H, touched: true, baseBlob: r.base, hasAlpha: detectAlpha(base), matte: d.matte, ext: { ...(r.state.ext || X.noExt()) } },
          { global: r.state.global, intent: r.state.intent, note: r.state.note, regions, round: n, rounds: S.rounds.filter((x) => x.n < n) }
        );
        saveSoon.flush();
        toast(`Back on round ${n}.`);
      } },
      { label: 'Cancel' },
    ],
  });
}

function renderRounds() {
  const btn = $('btn-rounds');
  if (!btn) return;
  btn.hidden = !S.doc;
  if (!S.doc) return;
  put(btn, icon('rounds'), h('span', null, `Round ${S.round}`));
  btn.classList.toggle('has-history', S.rounds.length > 0);
  if (!$('rounds-pop').hidden) fillRoundsPop();
}

let roundUrls = [];
function fillRoundsPop() {
  const pop = $('rounds-pop');
  roundUrls.forEach((u) => URL.revokeObjectURL(u));
  roundUrls = [];
  const items = S.rounds.map((r) => {
    const url = r.thumb ? URL.createObjectURL(r.thumb) : '';
    if (url) roundUrls.push(url);
    const viewing = ui.viewingRound === r.n;
    return h('li', { class: 'recent' + (viewing ? ' is-current' : '') },
      h('button', { type: 'button', class: 'recent-open', onclick: () => viewRound(r.n), 'aria-pressed': String(viewing) },
        url ? h('img', { src: url, alt: '' }) : h('span', { class: 'thumb-empty' }),
        h('span', { class: 'recent-text' },
          h('span', { class: 'recent-name' }, `Round ${r.n}`),
          h('span', { class: 'recent-when' }, `${viewing ? 'Showing now · ' : ''}${(r.state?.regions || []).length} marks · ${fmtWhen(r.created)}`))
      ),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { closePop('rounds-pop'); goBackToRound(r.n); } }, 'Go back')
    );
  });
  put(pop,
    h('div', { class: 'pop-head' }, 'Rounds'),
    h('ul', { class: 'recent-list' },
      ...items,
      h('li', { class: 'recent' + (ui.viewingRound ? '' : ' is-current') },
        h('button', { type: 'button', class: 'recent-open', onclick: () => viewRound(null) },
          h('span', { class: 'thumb-empty current' }, String(S.round)),
          h('span', { class: 'recent-text' }, h('span', { class: 'recent-name' }, `Round ${S.round}`), h('span', { class: 'recent-when' }, 'Current, editing now'))))
    ),
    S.rounds.length ? null : h('p', { class: 'help' }, "When the AI replies, paste its image here and it becomes round 2. Your marks carry over so you can check each one."),
    h('div', { class: 'pop-foot' },
      h('button', { type: 'button', class: 'btn sm accent', onclick: () => { closePop('rounds-pop'); $('round-input').click(); } }, `Start round ${S.round + 1} from a file`))
  );
}

function closePop(id) {
  const pop = $(id);
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  document.querySelector(`[aria-controls="${id}"]`)?.setAttribute('aria-expanded', 'false');
}

function toggleRounds() {
  const pop = $('rounds-pop');
  const btn = $('btn-rounds');
  if (!pop.hidden) return closePop('rounds-pop');
  fillRoundsPop();
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + 'px';
  btn.setAttribute('aria-expanded', 'true');
}

// ---------------------------------------------------------------- dialog

let dialogReturn = null;
function dialog({ title, body = [], actions = [], wide = false }) {
  const root = $('dialog');
  dialogReturn = document.activeElement;
  const close = () => {
    root.hidden = true;
    put(root);
    dialogReturn?.focus?.();
  };
  const btns = actions.map((a) => h('button', {
    type: 'button', class: 'btn' + (a.primary ? ' primary' : ''),
    onclick: async () => { close(); await a.run?.(); },
  }, a.label));
  put(root,
    h('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('div', { class: 'sheet-head' },
        h('h2', { id: 'dialog-title' }, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
      ...body,
      btns.length ? h('div', { class: 'sheet-actions' }, btns) : null)
  );
  root.hidden = false;
  root.onclick = (e) => { if (e.target === root) close(); };
  root.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  (btns.find((b) => b.classList.contains('primary')) || root.querySelector('button'))?.focus();
  return close;
}

// ---------------------------------------------------------------- preview

/** Line warning that some marks are left out because they say nothing yet. */
function blankWarning() {
  const blank = S.regions.filter((r) => r.enabled !== false && isBlank(r));
  if (!blank.length) return null;
  return h('p', { class: 'warn-line' },
    h('span', null, blank.length === 1 ? '1 mark has no note or edit yet, so it is not sent.' : `${blank.length} marks have no note or edit yet, so they are not sent.`),
    h('button', { type: 'button', class: 'link', onclick: () => { $('dialog').hidden = true; put($('dialog')); showTab('regions'); select(blank[0].id); focusNote(true); } }, 'Add a note'));
}

function openPreview() {
  if (!S.doc) return;
  const st = steps();
  const items = st.map((s, i) => {
    const parts = [];
    if (s.key !== 'prompt') {
      const c = makeImage(imgKey(s.key));
      c.className = 'preview-img';
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', stepName(s.key));
      parts.push(c);
    }
    if (s.key === 'prompt' || s.key.endsWith('+prompt')) parts.push(h('pre', { class: 'preview-prompt' }, currentPrompt()));
    return h('li', { class: 'preview-step' },
      h('div', { class: 'preview-head' },
        h('span', { class: 'step-n' }, String(i + 1)),
        h('div', { class: 'step-text' }, h('div', { class: 'step-label' }, s.label), h('div', { class: 'step-sub' }, s.sub)),
        h('button', { type: 'button', class: 'btn sm accent', onclick: () => copyStep(s.key) }, 'Copy')),
      ...parts);
  });
  dialog({
    title: 'What gets sent',
    wide: true,
    body: [
      h('p', { class: 'help' }, `Paste these into your AI chat in this order. Copy for AI steps through them, one press per paste. Change what's included on the Handoff tab.`),
      blankWarning(),
      h('ol', { class: 'preview-list' }, items),
    ],
    actions: [{ label: 'Done', primary: true }],
  });
}

// ---------------------------------------------------------------- history

let undoStack = [];
let redoStack = [];

function snap() {
  return {
    global: { ...S.global },
    intent: { ...S.intent, preserve: { ...S.intent.preserve } },
    note: S.note,
    ext: { ...(S.doc?.ext || X.noExt()) },
    regions: S.regions.map(cloneRegion),
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
  S.regions = s.regions.map(cloneRegion);
  if (S.doc && !X.sameExt(S.doc.ext, s.ext)) {
    S.doc.ext = { ...s.ext };
    rebuildBase(S.doc);
    fit();
    updateDocInfo();
  }
  if (!byId(ui.selectedId)) ui.selectedId = null;
  for (const id of [...ui.extra]) if (!byId(id)) ui.extra.delete(id);
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

async function serializeRegions(regions) {
  return Promise.all(
    regions.map(async (r) => ({
      id: r.id, kind: r.kind, note: r.note, enabled: r.enabled, carried: r.carried || 0, ops: { ...r.ops },
      pin: r.pin ? { ...r.pin } : null, arrow: r.arrow ? { ...r.arrow } : null,
      mask: r.mask ? { x: r.mask.x, y: r.mask.y, w: r.mask.w, h: r.mask.h, blob: await maskBlob(r.mask) } : null,
    }))
  );
}

async function reviveRegions(list) {
  return Promise.all(
    (list || []).map(async (r) => ({
      ...r,
      arrow: r.arrow || null,
      ops: { ...R.defaultOps(), ...r.ops },
      mask: r.mask ? { id: uid(), x: r.mask.x, y: r.mask.y, w: r.mask.w, h: r.mask.h, canvas: await blobToCanvas(r.mask.blob) } : null,
    }))
  );
}

async function saveNow() {
  const d = S.doc;
  if (!d || !d.touched) return;
  if (!d.baseBlob) d.baseBlob = await canvasToBlob(d.base0, 'image/png');
  ensureRendered();
  const thumb = await canvasToBlob(fitCanvas(copyCanvas(adjuster.canvas), 240), 'image/jpeg', 0.82);
  const regions = await serializeRegions(S.regions);
  await store.put({
    id: d.id, name: d.name, updated: Date.now(), W: d.W, H: d.H, origW: d.origW, origH: d.origH, sample: !!d.sample,
    hasAlpha: !!d.hasAlpha, matte: d.matte || '#ffffff', ext: { ...d.ext },
    base: d.baseBlob, thumb,
    round: S.round,
    rounds: S.rounds.map((r) => ({ n: r.n, created: r.created, base: r.base, thumb: r.thumb, W: r.W, H: r.H, state: r.state })),
    state: { global: { ...S.global }, intent: JSON.parse(JSON.stringify(S.intent)), note: S.note, regions },
  });
  store.prefs.set('lastDoc', d.id);
  store.prune(8).catch(() => {});
}
const saveSoon = debounce(() => saveNow().catch((e) => console.warn('BridgeBack autosave failed', e)), 900);

async function loadRecord(rec) {
  const base = await blobToCanvas(rec.base);
  const regions = await reviveRegions(rec.state.regions);
  const rounds = (rec.rounds || []).map((r) => ({ ...r, canvas: null }));
  setDoc(
    {
      id: rec.id, name: rec.name, base, origW: rec.origW, origH: rec.origH, sample: rec.sample, touched: true, baseBlob: rec.base,
      hasAlpha: rec.hasAlpha ?? detectAlpha(base), matte: rec.matte || '#ffffff', ext: rec.ext ? { ...rec.ext } : X.noExt(),
    },
    { global: rec.state.global, intent: rec.state.intent, note: rec.state.note, regions, round: rec.round || rounds.length + 1, rounds }
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

function backgroundGroup() {
  const d = S.doc;
  const custom = h('input', { type: 'color', id: 'matte-custom', 'aria-label': 'Other background color', title: 'Other color' });
  custom.value = d.matte && d.matte.startsWith('#') ? d.matte : '#ffffff';
  const setMatte = (v) => {
    d.matte = v;
    d.touched = true;
    compDirty = true;
    invalidate();
    saveSoon();
  };
  custom.addEventListener('input', () => {
    setMatte(custom.value);
    document.querySelectorAll('#matte-seg .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === custom.value)));
  });
  const seg = segmented('Background', MATTES, d.matte, (v) => setMatte(v));
  seg.id = 'matte-seg';
  return h('div', { class: 'group' },
    h('div', { class: 'group-label' }, 'Transparent background'),
    h('div', { class: 'row' }, seg, h('label', { class: 'check', for: 'matte-custom' }, custom, h('span', null, 'Other'))),
    h('p', { class: 'help' }, 'Image models handle transparency unevenly, so the rough edit is flattened onto this color. Keep transparent sends it as is.')
  );
}

function extendGroup() {
  const d = S.doc;
  const w0 = d.base0.width, h0 = d.base0.height;
  const e = d.ext;
  const current = X.ASPECTS.find(([, , ratio]) => (ratio ? X.sameExt(X.clampExt(X.extForAspect(w0, h0, ratio), w0, h0), e) : !X.hasExt(e)));
  const seg = segmented('Extend to aspect ratio', X.ASPECTS.map(([k, label]) => [k, label]), current ? current[0] : '', (k) => {
    const ratio = X.ASPECTS.find((a) => a[0] === k)[2];
    applyExt(X.extForAspect(w0, h0, ratio));
    commit();
  });
  seg.classList.add('wrap');
  const side = (key, label, of) => slider({
    id: 'ext-' + key, label, min: 0, max: 100, neutral: 0, value: Math.round((e[key] / of) * 100), fmt: (v) => v + '%',
    onInput: (v) => applyExt({ ...S.doc.ext, [key]: Math.round((v / 100) * of) }, true),
    onCommit: () => { applyExt(S.doc.ext); commit(); },
  }).el;
  const det = h('details', { class: 'more', id: 'more-extend' },
    h('summary', null, 'Extend the canvas', X.hasExt(e) ? h('span', { class: 'val' }, aspectWords(d.W, d.H)) : null),
    h('div', { class: 'stack' },
      h('p', { class: 'help' }, 'Add space on any side and the AI fills it in. The new area gets a blurred placeholder in the rough edit.'),
      seg,
      h('div', { class: 'sliders two' }, side('t', 'Top', h0), side('b', 'Bottom', h0), side('l', 'Left', w0), side('r', 'Right', w0))));
  det.open = X.hasExt(e) || ui.moreExtend;
  det.addEventListener('toggle', () => { ui.moreExtend = det.open; });
  return det;
}

/** Change the canvas extension. Marks shift so they stay on the same content. */
function applyExt(next, live = false) {
  const d = S.doc;
  if (!d) return;
  const e1 = X.clampExt(next, d.base0.width, d.base0.height);
  if (X.sameExt(e1, d.ext)) return;
  shiftRegions(S.regions, e1.l - d.ext.l, e1.t - d.ext.t);
  d.ext = e1;
  d.touched = true;
  rebuildBase(d);
  fit();
  updateDocInfo();
  invalidate();
  if (!live) buildAdjust();
}

const MAIN_GLOBALS = ['exposure', 'contrast', 'saturation', 'warmth'];

function globalSlider(d) {
  return slider({
    id: 'g-' + d.key, label: d.label, lo: d.lo, hi: d.hi, value: S.global[d.key],
    onInput: (v) => {
      S.global[d.key] = v;
      adjDirty = true;
      schedule();
      changed();
    },
    onCommit: () => commit(),
  }).el;
}

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
    S.doc?.hasAlpha ? backgroundGroup() : null,
    h('div', { class: 'sliders' }, GLOBAL_DEFS.filter((d) => MAIN_GLOBALS.includes(d.key)).map(globalSlider)),
    (() => {
      const extra = GLOBAL_DEFS.filter((d) => !MAIN_GLOBALS.includes(d.key));
      const set = extra.filter((d) => S.global[d.key]).length;
      const det = h('details', { class: 'more', id: 'more-adjust' },
        h('summary', null, 'More: highlights, shadows, tint, vignette', set ? h('span', { class: 'val' }, `${set} set`) : null),
        h('div', { class: 'sliders' }, extra.map(globalSlider)));
      det.open = !!set || ui.moreAdjust;
      det.addEventListener('toggle', () => { ui.moreAdjust = det.open; });
      return det;
    })(),
    adjuster.gpu ? null : h('p', { class: 'warn' }, "This browser can't run WebGL, so these sliders only shape the prompt."),
    S.doc ? extendGroup() : null
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
        h('p', { class: 'help' }, 'Click an object with Smart select (S), or mark it with the lasso (L), brush (B), box (M) or wand (W). Then recolor, move, shrink or remove it here.'),
        h('p', { class: 'help' }, 'To point at something, drag an Arrow (A) or write a note with Text (T). To ask for something new, drop a Marker (P).')
      )
    );
    return;
  }
  const carried = S.regions.filter((r) => r.carried);
  const banner = carried.length
    ? h('div', { class: 'banner' },
      h('p', null, `${carried.length} mark${carried.length === 1 ? '' : 's'} carried over from round ${S.round - 1}, switched off.`),
      h('p', { class: 'help' }, "Turn back on (eye icon) any change the AI didn't get right. It goes in the prompt as still needed."),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => {
          const ids = new Set(S.regions.filter((r) => r.carried && !r.enabled).map((r) => r.id));
          S.regions = S.regions.filter((r) => !ids.has(r.id));
          for (const r of S.regions) r.carried = 0;
          ui.selectedId = null; ui.extra.clear();
          invalidate(); renderRegions(); commit();
        } }, 'Clear the ones left off'),
        h('button', { type: 'button', class: 'link', onclick: () => { for (const r of S.regions) r.carried = 0; renderRegions(); commit(); } }, 'Dismiss')
      ))
    : null;
  put(p, panelHead('Regions'), banner, regionListEl, regionEditorEl);
  renderRegionList();
  renderRegionEditor();
}

function renderRegionList() {
  if (!regionListEl) return;
  $('region-count').textContent = S.regions.length;
  const nums = numbers();
  put(regionListEl,
    ...S.regions.map((r) => {
      const sel = isSel(r.id);
      const n = nums.get(r.id);
      const label = n ? String(n) : 'hidden';
      return h('li', { class: 'region-item' + (sel ? ' is-selected' : '') + (r.enabled ? '' : ' is-off') },
        h('button', {
          type: 'button', class: 'region-pick', 'aria-pressed': String(sel), title: 'Shift-click to select several',
          onclick: (e) => (e.shiftKey ? toggleExtra(r.id) : select(sel && !multi() ? null : r.id)),
        },
          h('span', { class: 'num' + (n ? '' : ' off'), style: { '--c': colorOf(nums, r) } }, n || '–'),
          h('span', { class: 'region-text' },
            h('span', { class: 'region-kind' }, kindLabel(r), r.enabled && isBlank(r) ? h('span', { class: 'tag sm warn' }, 'Not sent yet') : null),
            h('span', { class: 'region-sum' }, shortSummary(r))
          )
        ),
        h('button', {
          type: 'button', class: 'icon-btn sm', title: r.enabled ? 'Leave out of the handoff' : 'Include in the handoff',
          'aria-label': `${r.enabled ? 'Hide' : 'Show'} mark ${label}`, 'aria-pressed': String(!r.enabled),
          onclick: () => { r.enabled = !r.enabled; invalidate(); renderRegionList(); renderRegionEditor(); commit(); },
        }, icon(r.enabled ? 'eye' : 'eyeoff')),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete', 'aria-label': `Delete mark ${label}`, onclick: () => deleteRegion(r.id) }, icon('trash'))
      );
    })
  );
}

function noteField(r) {
  const ta = h('textarea', { id: 'r-note', rows: 3, placeholder: PLACEHOLDERS[r.kind] || PLACEHOLDERS.area });
  ta.value = r.note || '';
  ta.addEventListener('input', () => {
    r.note = ta.value;
    renderRegionList();
    changed();
    if (r.kind === 'text') schedule();
    commitSoon();
  });
  const chips = (CHIPS[r.kind] || AREA_CHIPS).map((text) =>
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
        schedule();
        commitSoon();
      },
    }, text.endsWith(' ') ? text.trim() + '…' : text)
  );
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: 'r-note' }, NOTE_LABEL[r.kind] || NOTE_LABEL.area),
    ta,
    h('div', { class: 'chips' }, chips)
  );
}

function renderMultiEditor(ids) {
  const regs = ids.map(byId);
  const areas = regs.filter((r) => r.kind === 'area');
  const pins = regs.length - areas.length;
  const others = pins;
  put(regionEditorEl,
    h('div', { class: 'editor-head' },
      h('div', { class: 'num-row' }, regs.map((r) => { const nm = numbers(); return h('span', { class: 'num', style: { '--c': colorOf(nm, r) } }, nm.get(r.id) || '–'); })),
      h('h3', null, `${regs.length} selected`),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Clear selection', title: 'Deselect (Esc)', onclick: () => select(null) }, icon('close'))
    ),
    h('p', { class: 'help' },
      areas.length >= 2
        ? 'Combine them into one area so they share one number and one note. The combined area keeps the edits of the first one you picked.'
        : 'Shift-click another area to add it to the group.'),
    others ? h('p', { class: 'help' }, `Arrows, labels and markers stay separate when you combine. ${others === 1 ? 'One is' : others + ' are'} in this selection.`) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn accent', disabled: areas.length < 2, onclick: combineSelected }, `Combine ${areas.length >= 2 ? areas.length + ' areas' : 'areas'}`),
      h('button', { type: 'button', class: 'btn', onclick: () => deleteRegions(ids) }, 'Delete all')
    ),
    h('p', { class: 'help' }, 'Drag any of them with Move (V) to move them together. Arrow keys nudge the group.')
  );
}

function renderRegionEditor() {
  if (!regionEditorEl) return;
  const ids = selectedIds();
  if (ids.length > 1) return renderMultiEditor(ids);
  const r = selected();
  if (!r) {
    put(regionEditorEl, h('p', { class: 'help pad' }, 'Pick a region above or click one on the image with the Move tool (V) to edit it.'));
    return;
  }
  const nums = numbers();
  const n = nums.get(r.id);
  const head = h('div', { class: 'editor-head' },
    h('span', { class: 'num lg' + (n ? '' : ' off'), style: { '--c': colorOf(nums, r) } }, n || '–'),
    h('h3', null, `${kindLabel(r)} ${n || ''}`.trim(), n ? null : r.enabled !== false && isBlank(r) ? h('span', { class: 'tag sm warn' }, 'Not sent yet') : h('span', { class: 'tag sm' }, 'Left out')),
    h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Close editor', title: 'Deselect (Esc)', onclick: () => select(null) }, icon('close'))
  );
  const offNote = r.enabled ? null : h('p', { class: 'help warnish' }, 'This mark is left out of the handoff. Turn it on with the eye icon in the list.');
  const hints = {
    pin: 'Drag the marker with Move (V) to reposition it.',
    text: 'The note is written on the marked-up copy and listed in the prompt as an instruction. Drag it with Move (V).',
    arrow: 'Drag the arrow with Move (V), or drag either end to re-aim it.',
  };
  if (r.kind !== 'area') {
    put(regionEditorEl, head, offNote, noteField(r), h('p', { class: 'help' }, hints[r.kind]));
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
    offNote,
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
  ui.extra.clear();
  renderRegionList();
  renderRegionEditor();
  if (id && ui.tab !== 'regions') showTab('regions');
  schedule();
}

function toggleExtra(id) {
  if (!ui.selectedId) return select(id);
  if (id === ui.selectedId) {
    const next = [...ui.extra][0] || null;
    if (next) ui.extra.delete(next);
    ui.selectedId = next;
  } else if (ui.extra.has(id)) ui.extra.delete(id);
  else ui.extra.add(id);
  renderRegionList();
  renderRegionEditor();
  if (ui.tab !== 'regions') showTab('regions');
  schedule();
}

function combineSelected() {
  const ids = selectedIds();
  const areas = ids.map(byId).filter((r) => r.kind === 'area');
  if (areas.length < 2) return;
  const base = areas[0];
  let mask = base.mask;
  for (const r of areas.slice(1)) {
    const local = R.toRegionSpace(base, R.placedMask(r));
    if (local) mask = R.combineMasks(mask, local, 'add') || mask;
  }
  const notes = areas.map((r) => (r.note || '').trim()).filter(Boolean);
  base.mask = mask;
  base.note = notes.join('; ');
  const drop = new Set(areas.slice(1).map((r) => r.id));
  S.regions = S.regions.filter((r) => !drop.has(r.id));
  ui.extra.clear();
  ui.selectedId = base.id;
  invalidate();
  renderRegions();
  commit();
  toast(`Combined ${areas.length} areas into one. Add the note for all of them.`);
  focusNote();
}

function deleteRegions(ids) {
  const set = new Set(ids);
  S.regions = S.regions.filter((r) => !set.has(r.id));
  ui.selectedId = null;
  ui.extra.clear();
  invalidate();
  renderRegions();
  commit();
  if (ids.length) toast(ids.length === 1 ? 'Mark deleted.' : `${ids.length} marks deleted.`, { label: 'Undo', run: undo });
}

function focusNote(force = false) {
  if (!force && !finePointer()) return;
  requestAnimationFrame(() => $('r-note')?.focus());
}

function deleteRegion(id) {
  S.regions = S.regions.filter((r) => r.id !== id);
  ui.extra.delete(id);
  if (ui.selectedId === id) ui.selectedId = null;
  invalidate();
  renderRegions();
  commit();
  toast('Mark deleted.', { label: 'Undo', run: undo });
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

function addArrow(a, b) {
  const r = { id: uid(), kind: 'arrow', pin: null, mask: null, arrow: { x1: Math.round(a.x), y1: Math.round(a.y), x2: Math.round(b.x), y2: Math.round(b.y) }, note: '', enabled: true, ops: R.defaultOps() };
  S.regions.push(r);
  renderRegions();
  changed();
  commit();
  select(r.id);
  focusNote();
  schedule();
}

/** Smart select: analyze the image once, then each click returns the object under it. */
async function runSmart(ip, mode) {
  if (ui.smartBusy) return;
  const d = S.doc;
  const key = `${d.id}:${baseVersion}`;
  ui.smartBusy = true;
  renderToolOpts();
  try {
    if (!SEG.isReady()) {
      setSmartStatus('Downloading the selection model, about 14 MB, one time only…');
      await SEG.ensureModel((loaded, total) => setSmartStatus(`Downloading the selection model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB…`));
    }
    if (!SEG.isAnalyzed(key)) {
      setSmartStatus('Analyzing the image. This takes a few seconds once per image…');
      await SEG.analyze(key, flattened(d.base));
    }
    setSmartStatus('Selecting…');
    const res = await SEG.pick(key, [{ x: ip.x, y: ip.y, label: 1 }]);
    const full = makeCanvas(d.W, d.H);
    const fx = full.getContext('2d');
    fx.imageSmoothingEnabled = true;
    fx.drawImage(res.canvas, 0, 0, d.W, d.H);
    const mask = R.makeMask(full, 0, 0);
    if (!mask) toast('Nothing to select there. Try clicking closer to the middle of the object.');
    else applySelection(mask, mode);
  } catch (err) {
    console.warn('BridgeBack smart select failed', err);
    toast("Smart select couldn't load. Check your connection, or use the lasso or brush instead.");
  } finally {
    ui.smartBusy = false;
    setSmartStatus(null);
    renderToolOpts();
  }
}

let smartStatus = null;
function setSmartStatus(text) {
  smartStatus = text;
  if (ui.tool === 'smart') renderToolOpts();
}

/** Start the model download early, while the person is still looking at the tool. */
function warmSmart() {
  if (SEG.isReady() || ui.smartBusy || !S.doc) return;
  SEG.ensureModel((loaded, total) => {
    if (ui.tool === 'smart' && !ui.smartBusy) setSmartStatus(`Getting smart select ready: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB…`);
  }).then(() => {
    if (!ui.smartBusy) setSmartStatus(null);
    const d = S.doc;
    if (d) SEG.analyze(`${d.id}:${baseVersion}`, flattened(d.base)).catch(() => {});
  }, () => {
    if (!ui.smartBusy) setSmartStatus(null);
  });
}

function addPin(ip, kind = 'pin') {
  const r = mkPoint(kind, ip);
  S.regions.push(r);
  renderRegions();
  changed();
  commit();
  select(r.id);
  focusNote(kind === 'text');
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

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitTest(p, ip) {
  const tol = coarse() ? 8 : 0;
  for (let i = S.regions.length - 1; i >= 0; i--) {
    const r = S.regions[i];
    if (r.kind === 'pin') {
      const s = toScreen(r.pin.x, r.pin.y);
      if (Math.hypot(p.x - s.x, p.y - (s.y - 19)) < 13 + tol || Math.hypot(p.x - s.x, p.y - s.y) < 8 + tol) return r;
    }
    if (r.kind === 'text') {
      const b = textBoxes.get(r.id);
      if (b && p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return r;
    }
    if (r.kind === 'arrow') {
      const a = r.arrow;
      if (segDist(p, toScreen(a.x1, a.y1), toScreen(a.x2, a.y2)) < 8 + tol) return r;
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
    ...TOOLS.flatMap((t) => [
      t.sep ? h('span', { class: 'tool-sep', 'aria-hidden': 'true' }) : null,
      h('button', {
        type: 'button', class: 'tool', 'data-tool': t.id, 'aria-pressed': String(ui.tool === t.id),
        title: `${t.label} (${t.key})`, 'aria-label': `${t.label} (${t.key})`,
        onclick: () => setTool(t.id),
      }, icon(t.id), h('span', { class: 'tool-name' }, t.name), h('span', { class: 'tool-key' }, t.key)),
    ])
  );
}

function setTool(id) {
  ui.tool = id;
  ui.picking = null;
  store.prefs.set('tool', id);
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
  renderToolOpts();
  updateCursor();
  if (id === 'smart') warmSmart();
  schedule();
}

function setBrushSize(v) {
  ui.brushSize = clamp(Math.round(v), 4, 400);
  store.prefs.set('brushSize', ui.brushSize);
  const el = $('brush-size');
  if (el) {
    el.value = ui.brushSize;
    el.dispatchEvent(new Event('input'));
  }
  schedule();
}

const effectiveMode = () => (ui.shiftHeld ? 'add' : ui.altHeld ? 'sub' : ui.selMode);

function showModifierMode() {
  const m = effectiveMode();
  document.querySelectorAll('#toolopts .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === m)));
}

function renderToolOpts() {
  const el = $('toolopts');
  el.hidden = !S.doc;
  if (ui.picking) {
    put(el, h('span', { class: 'opt-hint' }, 'Click the image to pick a color. Esc cancels.'));
    return;
  }
  const t = ui.tool;
  if (SELECT_TOOLS.includes(t)) {
    const kids = [
      segmented('Selection mode', [['new', 'New'], ['add', 'Add'], ['sub', 'Subtract']], effectiveMode(), (v) => { ui.selMode = v; }),
    ];
    if (t === 'smart') {
      kids.push(h('span', { class: 'opt-hint' + (smartStatus ? ' busy' : '') }, smartStatus || 'Click an object to select it. Shift-click adds the next object, Alt-click cuts one away.'));
    } else if (t === 'brush') {
      const s = slider({
        id: 'brush-size', label: 'Size', min: 4, max: 400, value: ui.brushSize, neutral: 4, fmt: (v) => v + ' px',
        onInput: (v) => { ui.brushSize = v; schedule(); }, onCommit: (v) => store.prefs.set('brushSize', v),
      });
      s.el.classList.add('compact');
      kids.push(s.el, h('span', { class: 'opt-hint' }, 'Paint over it. [ and ] change the size.'));
    } else if (t === 'wand') {
      const s = slider({
        id: 'wand-tol', label: 'Tolerance', min: 1, max: 100, value: ui.wandTol, neutral: 1, fmt: (v) => String(v),
        onInput: (v) => { ui.wandTol = v; }, onCommit: (v) => store.prefs.set('wandTol', v),
      });
      s.el.classList.add('compact');
      kids.push(s.el, checkbox('wand-contig', 'Connected only', ui.wandContig, (v) => { ui.wandContig = v; }));
    } else {
      kids.push(h('span', { class: 'opt-hint' }, 'Hold Shift to add another piece to the selected area, Alt to cut one away.'));
    }
    put(el, ...kids);
    return;
  }
  const hints = {
    move: 'Drag to move. Shift-click to pick several parts, then combine them under one note.',
    arrow: 'Drag from the thing to where it should go, then say what the arrow means.',
    text: 'Click where the note should go, then type it. It is written on the marked-up copy.',
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
  else if (ui.tool === 'smart' && ui.smartBusy) c = 'progress';
  else if (ui.tool === 'move' && p && S.doc) {
    const sel = selected();
    const hnd = sel && !multi() && sel.kind === 'area' && !sel.ops.remove ? hitHandle(sel, p) : null;
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
      if (sel && !multi() && !e.shiftKey && sel.kind === 'area' && !sel.ops.remove) {
        const hnd = hitHandle(sel, p);
        if (hnd) {
          const c = handlePts(sel).center;
          drag = hnd === 'rotate'
            ? { type: 'rotate', id: sel.id, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: sel.ops.rotate, c }
            : { type: 'scale', id: sel.id, d0: Math.max(4, dist(p, c)), s0: sel.ops.scale, c };
          return;
        }
      }
      if (sel && !multi() && !e.shiftKey && sel.kind === 'arrow') {
        const a = sel.arrow;
        const end = dist(p, toScreen(a.x2, a.y2)) < HIT() ? 2 : dist(p, toScreen(a.x1, a.y1)) < HIT() ? 1 : 0;
        if (end) {
          drag = { type: 'arrowEnd', id: sel.id, end, moved: false };
          return;
        }
      }
      const hit = hitTest(p, ip);
      if (hit && e.shiftKey) {
        toggleExtra(hit.id);
      } else if (hit) {
        if (!isSel(hit.id)) select(hit.id);
        drag = {
          type: 'move', sx: ip.x, sy: ip.y, moved: false,
          items: selectedIds().map((id) => {
            const r = byId(id);
            if (r.pin) return { id, px: r.pin.x, py: r.pin.y };
            if (r.arrow) return { id, a0: { ...r.arrow } };
            return { id, dx0: r.ops.dx, dy0: r.ops.dy };
          }),
        };
      } else {
        if (ui.selectedId && !e.shiftKey) select(null);
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
    case 'smart':
      runSmart(ip, mode);
      break;
    case 'brush':
      drag = { type: 'brush', mode, pts: [ip], sp: p };
      break;
    case 'arrow':
      drag = { type: 'arrow', a: ip, b: ip, sp: p };
      break;
    case 'text': {
      const hit = hitTest(p, ip);
      if (hit && hit.kind === 'text') {
        select(hit.id);
        focusNote(true);
      } else addPin(ip, 'text');
      break;
    }
    case 'pin':
      addPin(ip);
      break;
  }
  schedule();
});

vc.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos(e));
  const p = pos(e);
  ui.hover = e.pointerType === 'mouse' ? p : null;
  if (!drag) {
    if (e.pointerType === 'mouse') updateCursor(p);
    if (ui.tool === 'brush') schedule();
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
      const ddx = ip.x - drag.sx, ddy = ip.y - drag.sy;
      for (const it of drag.items) {
        const r = byId(it.id);
        if (!r) continue;
        if (r.pin) {
          r.pin.x = Math.round(clamp(it.px + ddx, 0, W));
          r.pin.y = Math.round(clamp(it.py + ddy, 0, H));
        } else if (r.arrow) {
          r.arrow = { x1: Math.round(it.a0.x1 + ddx), y1: Math.round(it.a0.y1 + ddy), x2: Math.round(it.a0.x2 + ddx), y2: Math.round(it.a0.y2 + ddy) };
        } else {
          r.ops.dx = Math.round(it.dx0 + ddx);
          r.ops.dy = Math.round(it.dy0 + ddy);
        }
      }
      drag.moved = true;
      invalidate();
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
    case 'lasso':
    case 'brush': {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(ip.x - last.x, ip.y - last.y) * view.zoom > 2) drag.pts.push(ip);
      break;
    }
    case 'arrow':
      drag.b = ip;
      break;
    case 'arrowEnd': {
      const r = byId(drag.id);
      if (!r) break;
      const x = Math.round(clamp(ip.x, 0, W)), y = Math.round(clamp(ip.y, 0, H));
      r.arrow = drag.end === 1 ? { ...r.arrow, x1: x, y1: y } : { ...r.arrow, x2: x, y2: y };
      drag.moved = true;
      changed();
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
    case 'brush': {
      if (e.type === 'pointercancel') break;
      applySelection(R.rasterStroke(d.pts, ui.brushSize, W, H), d.mode);
      break;
    }
    case 'arrow': {
      if (e.type === 'pointercancel') break;
      if (dist(toScreen(d.a.x, d.a.y), toScreen(d.b.x, d.b.y)) < 14) {
        const hit = hitTest(p, toImage(p.x, p.y));
        if (hit) select(hit.id);
        else toast('Drag to draw an arrow: start on the thing, end where it should go.');
        break;
      }
      addArrow(d.a, d.b);
      break;
    }
    case 'arrowEnd':
    case 'move':
      if (d.moved) {
        commit();
        renderRegionEditor();
        renderRegionList();
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
  const live = liveRegions(S.regions).length;
  const imgs = packetImages(handoff, live);
  const list = [];
  const d = S.doc;
  const sub = {
    original: 'Unedited, for reference',
    rough: d ? `${d.W}×${d.H} PNG` : '',
    annotated: `${live} numbered change${live === 1 ? '' : 's'}`,
  };
  if (handoff.combine && imgs.length > 1) list.push({ key: 'combined', label: NAMES.combined, sub: imgs.map((k) => PANEL[k]).join(' + ') });
  else imgs.forEach((k) => list.push({ key: k, label: NAMES[k], sub: sub[k] }));
  const words = currentPrompt().split(/\s+/).filter(Boolean).length;
  const promptSub = `${{ detailed: 'Detailed', short: 'Short', json: 'JSON' }[handoff.style]}, ${words} words`;
  if (handoff.bundle) {
    const last = list[list.length - 1];
    last.key += '+prompt';
    last.label = stepName(last.key);
    last.sub = `One paste: image plus prompt (${promptSub.toLowerCase()})`;
  } else {
    list.push({ key: 'prompt', label: NAMES.prompt, sub: promptSub });
  }
  return list;
}

const imgKey = (key) => key.replace('+prompt', '');
const stepName = (key) => (key.endsWith('+prompt') ? `${NAMES[imgKey(key)]} with prompt` : NAMES[key]);

function copyBundle(key) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return Promise.reject(new Error('no image clipboard'));
  const img = Promise.resolve().then(() => canvasToBlob(makeImage(imgKey(key))));
  const text = new Blob([currentPrompt()], { type: 'text/plain' });
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': img, 'text/plain': text })]);
}

function currentPrompt() {
  if (!S.doc) return '';
  return promptOverride ?? buildPrompt(S, handoff);
}

function makeImage(key) {
  ensureRendered();
  const rough = copyCanvas(adjuster.canvas);
  if (key === 'rough') return rough;
  if (key === 'original') return flattened(S.doc.base0);
  if (key === 'annotated') return makeAnnotated(rough, S.regions, { legend: handoff.legend, ext: S.doc.ext });
  if (key === 'combined') {
    const imgs = packetImages(handoff, liveRegions(S.regions).length);
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
    else if (key.endsWith('+prompt')) await copyBundle(key);
    else await copyImageTo(() => canvasToBlob(makeImage(key)));
    copied.add(key);
    const next = st.find((s) => !copied.has(s.key));
    const bundleNote = key.endsWith('+prompt') ? ' If your chat keeps only the image, use Copy on the prompt too.' : '';
    toast(
      next
        ? `Copied the ${stepName(key).toLowerCase()} (${idx + 1} of ${st.length}). Paste it into your chat, then come back for the ${stepName(next.key).toLowerCase()}.`
        : `Copied the ${stepName(key).toLowerCase()}. That's the whole packet.${bundleNote}`,
      null, 8000
    );
  } catch (err) {
    console.warn('BridgeBack copy failed', err);
    toast(`This browser blocked copying the ${stepName(key).toLowerCase()}. Save it as a file instead.`, { label: 'Save', run: () => saveStep(key) });
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
  else if (nx) label.textContent = `Next: ${stepName(nx.key).toLowerCase()} · ${st.indexOf(nx) + 1} of ${st.length}`;
  else label.textContent = 'Copied. Start over';
  $('btn-handoff').title = nx ? `Copies the ${stepName(nx.key).toLowerCase()} (Ctrl+Shift+C)` : 'Copy the packet again (Ctrl+Shift+C)';
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
  if (key.endsWith('+prompt')) {
    await saveStep(imgKey(key));
    return saveStep('prompt');
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
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn sm', onclick: openPreview }, 'Preview everything')),
    h('div', { id: 'blank-warning' }),
    h('ol', { class: 'steps', id: 'steps' }),
    h('fieldset', { class: 'group' },
      h('legend', { class: 'group-label' }, 'What to send'),
      h('div', { class: 'checks' },
        checkbox('h-annotated', 'Marked-up image', handoff.annotated, setOpt('annotated'), 'Numbered outlines on each change'),
        checkbox('h-legend', 'Legend strip', handoff.legend, setOpt('legend'), 'Lists the changes under the marked-up copy'),
        checkbox('h-original', 'Original image', handoff.original, setOpt('original'), 'Useful when the chat never saw it'),
        checkbox('h-combine', 'Combine into one image', handoff.combine, setOpt('combine'), 'For chats that take one image per message'),
        checkbox('h-bundle', 'Copy the prompt with the last image', handoff.bundle, setOpt('bundle'), 'One paste carries the marked-up copy and the prompt that explains each marking. Some chats keep only the image.')
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
      h('div', { class: 'group-label' }, 'When the AI replies'),
      h('p', { class: 'help' }, 'Paste its image anywhere here (Ctrl+V) or pick the file. It becomes the next round, and your marks carry over so you can check each one.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn sm', id: 'btn-next-round', onclick: () => $('round-input').click() }, 'Start the next round'))
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
  const bw = $('blank-warning');
  if (bw) put(bw, blankWarning());
  put(el,
    ...st.map((s, i) => {
      const done = copied.has(s.key);
      let thumb;
      if (s.key === 'prompt') thumb = h('div', { class: 'thumb text', 'aria-hidden': 'true' }, 'Aa');
      else {
        let src = thumbs.map.get(s.key);
        if (!src) {
          src = fitCanvas(makeImage(imgKey(s.key)), 180);
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
function toast(msg, action, ms) {
  const t = $('toast');
  put(t, 
    h('span', null, msg),
    action ? h('button', { type: 'button', class: 'btn sm', onclick: () => { t.hidden = true; action.run(); } }, action.label) : null
  );
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || (action ? 8000 : 4200));
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

// ---------------------------------------------------------------- tour

function runTour() {
  toggleHelp(false);
  const first = () => S.regions[0];
  startTour([
    {
      target: '#stage', title: 'Rough it out here',
      text: 'BridgeBack is for the back-and-forth with an AI image generator. Paste its image, mark what should change, then hand it back. This sample has a few changes marked already.',
      before: () => { if (!S.doc?.sample) loadSample(); setTool('move'); },
    },
    {
      target: '#toolrail', title: 'Mark what should change',
      text: 'Smart select picks an object with one click. Lasso, Brush, Box and Wand cover everything else. Arrow and Text let you point at things and write notes on the image.',
    },
    {
      target: '#panel', title: 'Each mark gets a number and a note',
      text: 'Recolor it, move it, shrink it or remove it here. The rough edit shows the change, and the prompt explains it so the AI knows what you meant.',
      before: () => { showTab('regions'); if (first()) select(first().id); },
    },
    {
      target: '#tabs', title: 'The overall look',
      text: 'Adjust changes the whole image: exposure, color, and extending the canvas. Direction only shapes the prompt: lighting, mood, realism and what to keep exactly.',
      before: () => { select(null); showTab('adjust'); },
    },
    {
      target: () => $('handoff-bar'), title: 'Hand it back',
      text: 'Each press of Copy for AI copies the next piece. Paste each one into your chat. Preview shows exactly what gets sent before you copy anything.',
    },
    {
      target: '#btn-rounds', title: 'Keep going, round by round',
      text: "When the AI replies, paste its image here. It becomes the next round, and your marks carry over so you can check what it got right.",
    },
  ], {
    onEnd: () => {
      store.prefs.set('toured', true);
      select(null);
    },
  });
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
  $('btn-preview').addEventListener('click', () => openPreview());
  $('btn-rounds').addEventListener('click', () => toggleRounds());
  $('round-input').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) startNextRound(f);
    e.target.value = '';
  });
  $('empty-open').addEventListener('click', () => $('file-input').click());
  $('empty-sample').addEventListener('click', () => loadSample());
  $('empty-tour').addEventListener('click', () => runTour());
  $('help-tour').addEventListener('click', () => runTour());

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
    const rp = $('rounds-pop');
    if (!rp.hidden && !rp.contains(e.target) && !$('btn-rounds').contains(e.target)) closePop('rounds-pop');
  });

  document.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!img) return;
    if (isTypingTarget(e.target) && items.some((i) => i.type === 'text/plain')) return;
    e.preventDefault();
    const f = img.getAsFile();
    if (f) openIncoming(f, f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? f.name : 'Pasted image');
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
    if (f) openIncoming(f, f.name);
    else toast('Drop an image file: PNG, JPEG, WebP or GIF.');
  });

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Alt') {
      ui.shiftHeld = e.shiftKey;
      ui.altHeld = e.altKey;
      showModifierMode();
    }
    if (e.key === ' ') { ui.spaceHeld = false; updateCursor(); }
    if (e.key === '\\' && ui.comparing) { ui.comparing = false; $('btn-compare').setAttribute('aria-pressed', 'false'); schedule(); }
  });
  window.addEventListener('blur', () => { ui.spaceHeld = false; ui.shiftHeld = false; ui.altHeld = false; showModifierMode(); if (ui.comparing) { ui.comparing = false; schedule(); } });
}

function nudge(dx, dy) {
  const ids = selectedIds();
  if (!ids.length) return;
  for (const id of ids) {
    const r = byId(id);
    if (r.pin) {
      r.pin.x = clamp(r.pin.x + dx, 0, S.doc.W);
      r.pin.y = clamp(r.pin.y + dy, 0, S.doc.H);
    } else if (r.arrow) {
      r.arrow = { x1: r.arrow.x1 + dx, y1: r.arrow.y1 + dy, x2: r.arrow.x2 + dx, y2: r.arrow.y2 + dy };
    } else {
      r.ops.dx += dx;
      r.ops.dy += dy;
    }
  }
  invalidate();
  commitSoon();
  renderRegionList();
}

function onKey(e) {
  const k = e.key;
  if (k === 'Shift' || k === 'Alt') {
    ui.shiftHeld = e.shiftKey;
    ui.altHeld = e.altKey;
    showModifierMode();
    if (k === 'Alt' && !isTypingTarget(e.target)) e.preventDefault();
  }
  const mod = e.ctrlKey || e.metaKey;
  if (k === 'Escape') {
    if (!$('help').hidden) return toggleHelp(false);
    if (!$('recent-pop').hidden) return toggleRecent(false);
    if (!$('rounds-pop').hidden) return closePop('rounds-pop');
    if (ui.viewingRound) return viewRound(null);
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
  const toolKeys = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));
  if (k === '[' || k === ']') {
    if (ui.tool === 'brush') setBrushSize(ui.brushSize * (k === ']' ? 1.25 : 0.8));
    return;
  }
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
      if (ui.selectedId) { e.preventDefault(); deleteRegions(selectedIds()); }
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
  updateDocInfo();
  updateHandoffButton();
  let savedCount = 0;
  try {
    const all = await store.all();
    savedCount = all.length;
    const recent = all.find((r) => !r.sample);
    if (recent) {
      const btn = $('empty-resume');
      btn.textContent = `Resume ${recent.name}`;
      btn.title = `Last edited ${fmtWhen(recent.updated)}`;
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        try {
          await loadRecord(recent);
        } catch {
          toast('That saved image could not be read.');
        }
      });
    }
  } catch {
    /* storage unavailable: stay blank */
  }
  document.fonts?.load?.('600 16px "Schibsted Grotesk"').then(() => schedule()).catch(() => {});
  if (!store.prefs.get('toured', false) && !savedCount && !matchMedia('(max-width: 820px)').matches) {
    setTimeout(() => { if (!S.doc) runTour(); }, 400);
  }
}

boot();
