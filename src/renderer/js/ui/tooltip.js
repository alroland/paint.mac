// In-page tooltips.
//
// Native `title` tooltips are drawn by the OS: they're slow, unstyled, can't be
// positioned, and never appear in a captured frame. This replaces them with a
// single reusable element driven by data attributes:
//
//   data-tip       heading text (required — presence is what opts an element in)
//   data-tip-key   keyboard shortcut, rendered as a badge
//   data-tip-desc  one-line description
//   data-tip-place preferred side: right | bottom | top | left (default auto)

import { formatKeys } from '../platform.js';

let showDelay = 420;
let repeatWindow = 500;      // re-show instantly while moving along a toolbar
const GAP = 8;               // distance from the anchor
const EDGE = 6;              // minimum distance from the window edge

/** Adjusts the hover timings (used to keep the UI tests fast and deterministic). */
export function configureTooltips({ showDelay: d, repeatWindow: r } = {}) {
  if (typeof d === 'number') showDelay = d;
  if (typeof r === 'number') repeatWindow = r;
}

let el = null;
let titleEl = null;
let keyEl = null;
let descEl = null;

let showTimer = null;
let current = null;
let lastHiddenAt = 0;

function ensureElement() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'tooltip';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  titleEl = document.createElement('div');
  titleEl.className = 'tip-title';
  keyEl = document.createElement('kbd');
  keyEl.className = 'tip-key';
  descEl = document.createElement('div');
  descEl.className = 'tip-desc';
  const head = document.createElement('div');
  head.className = 'tip-head';
  head.append(titleEl, keyEl);
  el.append(head, descEl);
  document.body.appendChild(el);
  return el;
}

export function showTooltip(anchor) {
  const tip = anchor.dataset.tip;
  if (!tip) return;
  ensureElement();
  current = anchor;

  titleEl.textContent = formatKeys(tip);
  const key = formatKeys(anchor.dataset.tipKey || '');
  keyEl.textContent = key;
  keyEl.hidden = !key;
  const desc = formatKeys(anchor.dataset.tipDesc || '');
  descEl.textContent = desc;
  descEl.hidden = !desc;

  el.hidden = false;
  el.style.visibility = 'hidden';   // measure before placing
  position(anchor);
  el.style.visibility = '';
  el.classList.add('on');
}

export function hideTooltip() {
  clearTimeout(showTimer);
  showTimer = null;
  if (!el || el.hidden) { current = null; return; }
  el.hidden = true;
  el.classList.remove('on');
  current = null;
  lastHiddenAt = performance.now();
}

/** Places the tooltip beside its anchor, flipping and clamping to stay onscreen. */
function position(anchor) {
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const preferred = anchor.dataset.tipPlace
    || (a.left < vw * 0.15 ? 'right' : a.top < vh * 0.25 ? 'bottom' : 'top');

  const fits = {
    right: a.right + GAP + w <= vw - EDGE,
    left: a.left - GAP - w >= EDGE,
    bottom: a.bottom + GAP + h <= vh - EDGE,
    top: a.top - GAP - h >= EDGE
  };
  // Fall back through the other sides when the preferred one doesn't fit.
  const order = [preferred, 'right', 'bottom', 'top', 'left'];
  const place = order.find((p) => fits[p]) || preferred;

  let x, y;
  if (place === 'right') { x = a.right + GAP; y = a.top + a.height / 2 - h / 2; }
  else if (place === 'left') { x = a.left - GAP - w; y = a.top + a.height / 2 - h / 2; }
  else if (place === 'bottom') { x = a.left + a.width / 2 - w / 2; y = a.bottom + GAP; }
  else { x = a.left + a.width / 2 - w / 2; y = a.top - GAP - h; }

  x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
  y = Math.max(EDGE, Math.min(y, vh - h - EDGE));

  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.dataset.place = place;
}

/** Convenience for building elements: sets the data attributes in one call. */
export function setTip(node, { title, key, desc, place } = {}) {
  if (title) node.dataset.tip = title; else delete node.dataset.tip;
  if (key) node.dataset.tipKey = key; else delete node.dataset.tipKey;
  if (desc) node.dataset.tipDesc = desc; else delete node.dataset.tipDesc;
  if (place) node.dataset.tipPlace = place;
  // A native title on the same node would produce a second, OS-drawn tooltip.
  node.removeAttribute('title');
  return node;
}

export function installTooltips(root = document) {
  // Anything that shipped with a native title becomes a styled tooltip instead.
  for (const node of root.querySelectorAll('[title]')) {
    setTip(node, { title: node.getAttribute('title') });
  }

  const schedule = (anchor) => {
    clearTimeout(showTimer);
    const warm = performance.now() - lastHiddenAt < repeatWindow;
    if (warm) { showTooltip(anchor); return; }
    showTimer = setTimeout(() => showTooltip(anchor), showDelay);
  };

  document.addEventListener('pointerover', (e) => {
    const anchor = e.target.closest?.('[data-tip]');
    if (!anchor || anchor === current) return;
    if (current) hideTooltip();
    schedule(anchor);
  });

  document.addEventListener('pointerout', (e) => {
    const anchor = e.target.closest?.('[data-tip]');
    if (!anchor) return;
    // Ignore moves between descendants of the same anchor.
    if (e.relatedTarget && anchor.contains(e.relatedTarget)) return;
    hideTooltip();
  });

  // Keyboard focus shows immediately — waiting out a hover delay makes no sense
  // when the user tabbed here deliberately.
  document.addEventListener('focusin', (e) => {
    const anchor = e.target.closest?.('[data-tip]');
    if (anchor) showTooltip(anchor);
  });
  document.addEventListener('focusout', hideTooltip);

  // Any real interaction dismisses it.
  for (const evt of ['pointerdown', 'wheel', 'keydown']) {
    document.addEventListener(evt, hideTooltip, { passive: true });
  }
  window.addEventListener('blur', hideTooltip);
}
