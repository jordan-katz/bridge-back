// Turns the editor state into text an image model can follow. Deterministic, no network.

import { hexToRgb } from './util.js';
import { isMoved } from './regions.js';

export const REGION_COLORS = ['#ff2d6f', '#1ea7ff', '#ffb000', '#1fbf5b', '#a95cff', '#ff6a1a', '#00c7b0', '#f24fd0'];
export const regionColor = (i) => REGION_COLORS[i % REGION_COLORS.length];

/** Marks that go out with the packet. Hidden ones are left out and the rest are numbered in order. */
const hasAreaEdit = (o) => !!(o.remove || o.dx || o.dy || o.scale !== 100 || o.rotate || o.flipX || (o.recolor && o.recolorAmt > 0) || o.hue || o.sat || o.bright);
/** A mark that tells the AI nothing yet: an area with no note and no edit, or an empty text note. */
export const isBlank = (r) => !(r.note || '').trim() && (r.kind === 'text' || (r.kind === 'area' && !hasAreaEdit(r.ops)));
export const liveRegions = (regions) => regions.filter((r) => r.enabled !== false && !isBlank(r));

const KIND_LABEL = { area: 'Area', pin: 'Marker', arrow: 'Arrow', text: 'Label' };
export const kindLabel = (r) => KIND_LABEL[r.kind] || 'Mark';

const NAMED = [
  ['black', '#111111'], ['charcoal', '#36454f'], ['dark gray', '#555555'], ['gray', '#8a8a8a'],
  ['silver', '#c0c0c0'], ['white', '#ffffff'], ['off-white', '#f3efe6'], ['cream', '#fff5cc'],
  ['beige', '#d9c7a7'], ['tan', '#d2b48c'], ['brown', '#7b4a2a'], ['dark brown', '#4a2c1a'],
  ['maroon', '#7a0f1a'], ['burgundy', '#800020'], ['red', '#d62828'], ['crimson', '#b0172b'],
  ['coral', '#ff7f50'], ['salmon', '#fa8072'], ['pink', '#ff9ec4'], ['hot pink', '#ff3e9a'],
  ['magenta', '#d0208c'], ['purple', '#7b2cbf'], ['lavender', '#b8a1e3'], ['violet', '#8f00ff'],
  ['navy', '#1f2a5a'], ['dark blue', '#10307a'], ['blue', '#1f5fd6'], ['royal blue', '#2b50c8'],
  ['sky blue', '#87ceeb'], ['light blue', '#add8e6'], ['teal', '#0f8b8d'], ['turquoise', '#30d5c8'],
  ['cyan', '#00bcd4'], ['mint', '#98e0b8'], ['green', '#2e9e44'], ['forest green', '#1f5f2e'],
  ['olive', '#6b7d2a'], ['lime', '#9bd12e'], ['yellow', '#f5d90a'], ['mustard', '#d4a017'],
  ['gold', '#d4af37'], ['orange', '#f28c28'], ['burnt orange', '#cc5500'], ['peach', '#ffcba4'],
  ['rust', '#b7410e'],
].map(([n, hex]) => [n, hexToRgb(hex)]);

export function colorName(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = NAMED[0][0], bd = Infinity;
  for (const [n, [R, G, B]] of NAMED) {
    const rm = (r + R) / 2;
    const d = (2 + rm / 256) * (r - R) ** 2 + 4 * (g - G) ** 2 + (2 + (255 - rm) / 256) * (b - B) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

export function where(cx, cy, W, H) {
  const col = cx < W / 3 ? 0 : cx < (2 * W) / 3 ? 1 : 2;
  const row = cy < H / 3 ? 0 : cy < (2 * H) / 3 ? 1 : 2;
  return [
    ['top left', 'top center', 'top right'],
    ['left side', 'center', 'right side'],
    ['bottom left', 'bottom center', 'bottom right'],
  ][row][col];
}

const word = (v) => (Math.abs(v) <= 33 ? 'slight' : Math.abs(v) <= 66 ? 'moderate' : 'strong');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s) => {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? cap(t) : cap(t) + '.';
};

export const GLOBAL_PHRASES = {
  exposure: ['darker overall', 'brighter overall'],
  contrast: ['lower contrast, flatter', 'more contrast'],
  highlights: ['softer, recovered highlights', 'brighter highlights'],
  shadows: ['deeper shadows', 'lifted shadows'],
  saturation: ['more muted color', 'more saturated color'],
  warmth: ['cooler color temperature', 'warmer color temperature'],
  tint: ['a green tint', 'a magenta tint'],
  vignette: ['lightened edges', 'darkened edges (vignette)'],
};

const INTENT_PHRASES = {
  realism: ['more stylized and less photographic', 'more photorealistic'],
  detail: ['simpler, with less fine detail', 'more fine detail and texture'],
  dof: ['deeper focus, with everything sharp', 'shallower depth of field, with a softer background'],
  drama: ['softer, flatter lighting', 'more dramatic, higher-contrast lighting'],
  mood: ['a moodier, more somber feel', 'a lighter, more cheerful mood'],
};

const LIGHT = {
  left: 'Light the scene from the left.', right: 'Light the scene from the right.',
  above: 'Light the scene from above.', front: 'Use soft frontal light.', back: 'Backlight the main subject.',
};
const TIME = {
  sunrise: 'Set the time of day to sunrise.', midday: 'Set the time of day to midday.',
  golden: 'Set the time of day to golden hour.', blue: 'Set the time of day to blue hour, just after sunset.',
  night: 'Set the scene at night.',
};
const FRAMING = {
  closer: 'Frame slightly tighter on the main subject.', wider: 'Pull back to a slightly wider framing.',
  lower: 'Use a lower camera angle.', higher: 'Use a higher camera angle.',
};
const PRESERVE = {
  identity: 'faces and the identity of any people', text: 'any text, logos and lettering',
  composition: 'the overall composition and aspect ratio', style: 'the art style and rendering technique',
};

function globalLines(g) {
  return Object.keys(GLOBAL_PHRASES)
    .filter((k) => g[k])
    .map((k) => `${cap(GLOBAL_PHRASES[k][g[k] > 0 ? 1 : 0])} (${word(g[k])})`);
}

function directionLines(it) {
  const out = [];
  for (const k of Object.keys(INTENT_PHRASES)) {
    if (it[k]) out.push(`Make it ${INTENT_PHRASES[k][it[k] > 0 ? 1 : 0]} (${word(it[k])}).`);
  }
  if (LIGHT[it.light]) out.push(LIGHT[it.light]);
  if (TIME[it.time]) out.push(TIME[it.time]);
  if (FRAMING[it.framing]) out.push(FRAMING[it.framing]);
  return out;
}

function fidelityLine(f) {
  if (f >= 34) return "Follow the rough edit's layout, sizes, placement and colors closely.";
  if (f <= -34) return 'Treat the rough edit as a loose guide. You can reinterpret details freely as long as each requested change comes through.';
  return 'Follow the rough edit for placement, size and color, and render every change cleanly.';
}

function moveWords(o, W, H) {
  const parts = [];
  const px = Math.round((Math.abs(o.dx) / W) * 100), py = Math.round((Math.abs(o.dy) / H) * 100);
  if (px >= 1) parts.push(`${o.dx > 0 ? 'right' : 'left'} about ${px}% of the frame width`);
  if (py >= 1) parts.push(`${o.dy > 0 ? 'down' : 'up'} about ${py}% of the frame height`);
  return parts.join(' and ');
}

/** Sentences describing what was done to one area region. */
export function regionEdits(r, W, H) {
  const o = r.ops;
  const out = [];
  if (!r.enabled) return out;
  if (o.remove) {
    out.push('Remove it completely and fill the space so it matches its surroundings.');
    return out;
  }
  if (o.recolor && o.recolorAmt > 0) {
    const strength = o.recolorAmt < 90 ? `, blended at about ${o.recolorAmt}%` : '';
    out.push(`Recolor it to ${colorName(o.recolor)} (${o.recolor.toLowerCase()})${strength}. Keep its texture, shading and highlights.`);
  }
  if (o.hue) out.push(`Shift its hue ${o.hue > 0 ? '+' : ''}${o.hue}° to match the color shown in the rough edit.`);
  if (o.sat) out.push(`Make its color ${o.sat > 0 ? 'more saturated' : 'more muted'} (${word(o.sat)}).`);
  if (o.bright) out.push(`Make it ${o.bright > 0 ? 'brighter' : 'darker'} (${word(o.bright)}).`);
  if (o.scale !== 100) out.push(o.scale < 100 ? `Shrink it to about ${o.scale}% of its size.` : `Enlarge it to about ${o.scale}% of its size.`);
  if (o.rotate) out.push(`Rotate it about ${Math.abs(o.rotate)}° ${o.rotate > 0 ? 'clockwise' : 'counterclockwise'}.`);
  if (o.flipX) out.push('Mirror it horizontally.');
  const mv = moveWords(o, W, H);
  if (mv) out.push(`Move it ${mv}.`);
  if (isMoved(o)) {
    if (o.fill === 'keep') out.push('Keep the original in place too. This is a copy, placed where the rough edit shows it.');
    else out.push(`The ${o.fill === 'flat' ? 'flat' : 'blended'} patch at its old spot is only a placeholder. Fill that area so it matches the surrounding scene.`);
  }
  return out;
}

/** One-line label for lists and the legend strip. */
export function shortSummary(r) {
  if (r.kind === 'pin') return r.note ? r.note.trim() : 'Marker with no note';
  if (r.kind === 'arrow') return r.note ? r.note.trim() : 'Arrow with no note';
  if (r.kind === 'text') return r.note ? r.note.trim() : 'Empty label';
  const o = r.ops;
  const bits = [];
  if (o.remove) bits.push('remove');
  else {
    if (o.recolor && o.recolorAmt > 0) bits.push(`recolor ${colorName(o.recolor)}`);
    if (o.hue) bits.push(`hue ${o.hue > 0 ? '+' : ''}${o.hue}°`);
    if (o.sat) bits.push(o.sat > 0 ? 'more saturated' : 'muted');
    if (o.bright) bits.push(o.bright > 0 ? 'brighter' : 'darker');
    if (o.scale !== 100) bits.push(`${o.scale}%`);
    if (o.rotate) bits.push(`${o.rotate > 0 ? '+' : ''}${o.rotate}°`);
    if (o.flipX) bits.push('mirrored');
    if (o.dx || o.dy) bits.push(o.fill === 'keep' ? 'copied' : 'moved');
  }
  const ops = bits.join(', ');
  const note = (r.note || '').trim();
  if (note && ops) return `${note} · ${ops}`;
  return note || ops || 'Needs a note';
}

function arrowWords(a, W, H) {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
  const dir = [];
  if (Math.abs(dy) > Math.abs(dx) * 0.4) dir.push(dy < 0 ? 'up' : 'down');
  if (Math.abs(dx) > Math.abs(dy) * 0.4) dir.push(dx < 0 ? 'left' : 'right');
  const len = Math.round(Math.hypot(dx / W, dy / H) * 100);
  return `pointing ${dir.join(' and ') || 'across'}, about ${Math.max(1, len)}% of the frame long`;
}

function regionLine(r, i, W, H) {
  const n = i + 1;
  const again = r.carried ? 'Still needed from the last round: ' : '';
  if (r.kind === 'pin') {
    return `${n}. Marker at the ${where(r.pin.x, r.pin.y, W, H)}: ${again}${sentence(r.note) || 'Point of interest (no note given).'}`;
  }
  if (r.kind === 'text') {
    return `${n}. Note written on the image at the ${where(r.pin.x, r.pin.y, W, H)}: ${again}${sentence(r.note) || '(empty)'} This note is an instruction, not text to keep in the image.`;
  }
  if (r.kind === 'arrow') {
    const a = r.arrow;
    return `${n}. Arrow from the ${where(a.x1, a.y1, W, H)} to the ${where(a.x2, a.y2, W, H)} (${arrowWords(a, W, H)}): ${again}${sentence(r.note) || 'Move what is at the tail of the arrow to where it points.'}`;
  }
  const m = r.mask;
  const place = where(m.x + m.w / 2, m.y + m.h / 2, W, H);
  const pw = Math.max(1, Math.round((m.w / W) * 100));
  const ph = Math.max(1, Math.round((m.h / H) * 100));
  const parts = [];
  if (r.note && r.note.trim()) parts.push(sentence(r.note));
  parts.push(...regionEdits(r, W, H));
  if (!parts.length) parts.push('Marked for attention, no specific change requested.');
  return `${n}. The ${place} area (about ${pw}% wide, ${ph}% tall): ${again}${parts.join(' ')}`;
}

/** Which images go out, in order. */
export function packetImages(handoff, regionCount) {
  const list = [];
  if (handoff.original) list.push('original');
  list.push('rough');
  if (handoff.annotated && regionCount > 0) list.push('annotated');
  return list;
}

const IMG_DESC = {
  original: 'the original image',
  rough: 'my rough edit, a quick mock-up of the changes I want',
  annotated: 'the same rough edit with each change numbered and outlined',
};
const PANEL_NAME = { original: 'Original', rough: 'Rough edit', annotated: 'Marked-up' };

function intro(images, combine) {
  if (combine && images.length > 1) {
    const labels = images.map((k, i) => `${'ABC'[i]} (${PANEL_NAME[k]})`).join(', ');
    const roughLetter = 'ABC'[images.indexOf('rough')];
    return `The attached image has ${images.length} labeled panels: ${labels}. Panel ${roughLetter} is a quick mock-up of the changes I want${images.includes('annotated') ? ' and the marked-up panel numbers each change' : ''}. Return a single finished image based on panel ${roughLetter}, not a multi-panel image.`;
  }
  if (images.length === 1) return `The attached image is ${IMG_DESC.rough}.`;
  const parts = images.map((k, i) => `Image ${i + 1} is ${IMG_DESC[k]}`);
  return `I've attached ${images.length} images. ${parts.join('. ')}.`;
}

const MATTE_NAMES = { '#ffffff': 'white', '#808080': 'gray', '#000000': 'black' };

function backgroundLine(doc) {
  if (!doc.hasAlpha) return '';
  if (!doc.matte || doc.matte === 'transparent') return 'The image has a transparent background. Keep it transparent.';
  const name = MATTE_NAMES[doc.matte] || `${colorName(doc.matte)} (${doc.matte})`;
  return `The original has a transparent background, filled with ${name} in these mock-ups. Keep the background a plain, even ${name}.`;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export function aspectWords(W, H) {
  const common = [[1, 1], [4, 5], [5, 4], [3, 2], [2, 3], [4, 3], [3, 4], [16, 9], [9, 16], [21, 9], [2, 1], [1, 2]];
  const r = W / H;
  for (const [a, b] of common) if (Math.abs(r - a / b) / (a / b) < 0.02) return `${a}:${b}`;
  const g = gcd(W, H);
  return W / g <= 40 ? `${W / g}:${H / g}` : `about ${r.toFixed(2)}:1`;
}

/** Sentence asking the model to extend the canvas, or '' when nothing was added. */
function extendLine(doc) {
  const e = doc.ext;
  if (!e || !(e.t || e.r || e.b || e.l)) return '';
  const w0 = doc.W - e.l - e.r, h0 = doc.H - e.t - e.b;
  const sides = [];
  const pct = (v, of) => `about ${Math.max(1, Math.round((v / of) * 100))}%`;
  if (e.t) sides.push(`${pct(e.t, h0)} at the top`);
  if (e.b) sides.push(`${pct(e.b, h0)} at the bottom`);
  if (e.l) sides.push(`${pct(e.l, w0)} on the left`);
  if (e.r) sides.push(`${pct(e.r, w0)} on the right`);
  const list = sides.length > 1 ? sides.slice(0, -1).join(', ') + ' and ' + sides[sides.length - 1] : sides[0];
  return `Extend the canvas: add ${list}, for a ${aspectWords(doc.W, doc.H)} image. The soft, blurred border in the rough edit is only a placeholder for that new space. Continue the scene into it naturally.`;
}

function outputLine(doc) {
  const e = doc.ext;
  const extended = e && (e.t || e.r || e.b || e.l);
  return extended
    ? `Output one image at the new ${aspectWords(doc.W, doc.H)} aspect ratio.`
    : 'Output one image at the same aspect ratio.';
}

function roundLine(s) {
  if (!s.round || s.round < 2) return '';
  return `This is round ${s.round} of edits. The image I'm attaching is based on your last result, so keep everything you already got right.`;
}

export function buildPrompt(s, handoff) {
  const { W, H } = s.doc;
  const bg = backgroundLine(s.doc);
  const ext = extendLine(s.doc);
  const rnd = roundLine(s);
  const live = liveRegions(s.regions);
  const images = packetImages(handoff, live.length);
  const g = globalLines(s.global);
  const dir = directionLines(s.intent);
  const regs = live.map((r, i) => regionLine(r, i, W, H));
  const keep = Object.keys(PRESERVE).filter((k) => s.intent.preserve[k]).map((k) => PRESERVE[k]);
  const note = (s.note || '').trim();

  if (handoff.style === 'json') {
    const obj = {
      task: 'Turn my rough edit into a clean, finished image',
      images: handoff.combine && images.length > 1
        ? images.map((k, i) => ({ panel: 'ABC'[i], shows: PANEL_NAME[k] }))
        : images.map((k, i) => ({ image: i + 1, shows: IMG_DESC[k] })),
      fidelity: fidelityLine(s.intent.fidelity),
      look_already_applied: g,
      direction: dir,
      round: s.round > 1 ? s.round : undefined,
      extend_canvas: ext || undefined,
      changes: live.map((r, i) => {
        const base = { number: i + 1 };
        if (r.carried) base.still_needed_from_last_round = true;
        if (r.kind === 'pin') return { ...base, type: 'marker', position: where(r.pin.x, r.pin.y, W, H), note: r.note || '' };
        if (r.kind === 'text') return { ...base, type: 'note_on_image', position: where(r.pin.x, r.pin.y, W, H), note: r.note || '' };
        if (r.kind === 'arrow') {
          const a = r.arrow;
          return { ...base, type: 'arrow', from: where(a.x1, a.y1, W, H), to: where(a.x2, a.y2, W, H), note: r.note || '' };
        }
        const m = r.mask;
        return {
          ...base,
          type: 'area',
          position: where(m.x + m.w / 2, m.y + m.h / 2, W, H),
          size: `${Math.round((m.w / W) * 100)}% wide, ${Math.round((m.h / H) * 100)}% tall`,
          note: r.note || '',
          edits: regionEdits(r, W, H),
        };
      }),
      preserve: keep,
      notes: note,
      output: `${outputLine(s.doc)} Do not copy mock-up artifacts such as hard edges, flat patches, outlines, arrows or written notes.`,
    };
    if (!g.length) delete obj.look_already_applied;
    if (!dir.length) delete obj.direction;
    if (!obj.changes.length) delete obj.changes;
    if (!keep.length) delete obj.preserve;
    if (!note) delete obj.notes;
    if (bg) obj.background = bg;
    return JSON.stringify(obj, null, 2);
  }

  if (handoff.style === 'short') {
    const bits = [intro(images, handoff.combine), 'Turn it into a clean, finished image.', fidelityLine(s.intent.fidelity)];
    if (rnd) bits.push(rnd);
    if (ext) bits.push(ext);
    if (g.length) bits.push(`Keep the adjusted look: ${g.map((x) => x.toLowerCase()).join('; ')}.`);
    if (dir.length) bits.push(dir.join(' '));
    if (regs.length) bits.push('Changes: ' + regs.join(' '));
    if (note) bits.push(sentence(note));
    if (bg) bits.push(bg);
    bits.push(keep.length ? `Keep everything else as it is, especially ${keep.join(', ')}.` : 'Keep everything else as it is.');
    bits.push(outputLine(s.doc));
    return bits.join(' ');
  }

  const out = [];
  out.push(`${intro(images, handoff.combine)} Please produce a clean, finished version of the image with these changes.${rnd ? ' ' + rnd : ''}`);
  out.push(`${fidelityLine(s.intent.fidelity)} Don't copy the mock-up's artifacts (hard cut-out edges, flat or smeared patches, uneven color, and any outlines, arrows or written notes). Every change should look like it was always part of the image.`);
  if (ext) out.push(ext);
  if (g.length) out.push('Overall look, already applied in the rough edit. Keep it:\n' + g.map((x) => `- ${x}`).join('\n'));
  if (dir.length) out.push('Direction:\n' + dir.map((x) => `- ${x}`).join('\n'));
  if (regs.length) {
    const head = images.includes('annotated')
      ? 'Changes, numbered to match the marked-up image:'
      : 'Changes:';
    out.push(head + '\n' + regs.join('\n'));
  }
  if (note) out.push('Also: ' + sentence(note));
  if (bg) out.push(bg);
  out.push(
    keep.length
      ? `Keep everything I haven't mentioned the same as the original, especially ${keep.join(', ')}. ${outputLine(s.doc)}`
      : `Keep everything I haven't mentioned the same as the original. ${outputLine(s.doc)}`
  );
  return out.join('\n\n');
}
