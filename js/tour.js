// A short guided tour: a spotlight over one part of the screen and a card that explains it.

import { h } from './util.js';

/**
 * steps: [{ target: selector | () => Element, title, text, before?: () => void | Promise }]
 * Returns a function that ends the tour.
 */
export function startTour(steps, { onEnd } = {}) {
  let i = -1;
  let ended = false;
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text' });
  const count = h('span', { class: 'tour-count' });
  const back = h('button', { type: 'button', class: 'btn sm' }, 'Back');
  const next = h('button', { type: 'button', class: 'btn sm primary' }, 'Next');
  const skip = h('button', { type: 'button', class: 'link' }, 'Skip tour');
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title' },
    title, text, h('div', { class: 'tour-actions' }, skip, h('span', { class: 'spacer' }), count, back, next));
  const root = h('div', { class: 'tour' }, spot, card);
  document.body.append(root);

  const targetOf = (s) => (typeof s.target === 'function' ? s.target() : document.querySelector(s.target));

  function place() {
    if (ended || i < 0) return;
    const el = targetOf(steps[i]);
    const vw = window.innerWidth, vh = window.innerHeight;
    let r = el?.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) r = { left: vw / 2, top: vh / 2, width: 0, height: 0, right: vw / 2, bottom: vh / 2 };
    const pad = 6;
    Object.assign(spot.style, {
      left: r.left - pad + 'px', top: r.top - pad + 'px',
      width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px',
    });
    const cw = Math.min(340, vw - 32);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    const gap = 14;
    let x, y;
    if (r.right + gap + cw <= vw - 16) { x = r.right + gap; y = r.top; }
    else if (r.left - gap - cw >= 16) { x = r.left - gap - cw; y = r.top; }
    else if (r.bottom + gap + ch <= vh - 16) { x = r.left; y = r.bottom + gap; }
    else if (r.top - gap - ch >= 16) { x = r.left; y = r.top - gap - ch; }
    else { x = (vw - cw) / 2; y = vh - ch - 16; }
    card.style.left = Math.max(16, Math.min(vw - cw - 16, x)) + 'px';
    card.style.top = Math.max(16, Math.min(vh - ch - 16, y)) + 'px';
  }

  async function go(n) {
    if (n < 0 || ended) return;
    if (n >= steps.length) return end(true);
    i = n;
    const s = steps[i];
    await s.before?.();
    count.textContent = `${i + 1} of ${steps.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    requestAnimationFrame(() => {
      place();
      next.focus();
    });
  }

  function end(finished = false) {
    if (ended) return;
    ended = true;
    root.remove();
    window.removeEventListener('resize', place);
    window.removeEventListener('keydown', onKey, true);
    onEnd?.(finished);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(i - 1); }
  }

  next.addEventListener('click', () => go(i + 1));
  back.addEventListener('click', () => go(i - 1));
  skip.addEventListener('click', () => end(false));
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey, true);
  go(0);
  return () => end(false);
}
