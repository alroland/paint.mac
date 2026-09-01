// Small shared helpers. Kept dependency-free so every module can import it.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);

let idCounter = 0;
export const uid = (prefix = 'id') => `${prefix}_${++idCounter}_${Date.now().toString(36)}`;

/** Creates a detached canvas sized in device pixels (no CSS scaling applied). */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: false, ...opts });
  return ctx;
}

/** Copies a canvas (or a sub-rect of it) into a fresh canvas. */
export function cloneCanvas(src, rect) {
  const r = rect || { x: 0, y: 0, w: src.width, h: src.height };
  const c = makeCanvas(r.w, r.h);
  c.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

/* ---------- rectangles (all in document pixel space) ---------- */

export const rect = (x, y, w, h) => ({ x, y, w, h });

export function rectFromPoints(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function intersectRect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

/** Snaps a rect outward to integers and clips it to a w×h page. */
export function normalizeRect(r, w, h) {
  if (!r) return null;
  let x = Math.floor(r.x), y = Math.floor(r.y);
  let x2 = Math.ceil(r.x + r.w), y2 = Math.ceil(r.y + r.h);
  x = clamp(x, 0, w); y = clamp(y, 0, h);
  x2 = clamp(x2, 0, w); y2 = clamp(y2, 0, h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export function inflateRect(r, n) {
  return r ? { x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 } : null;
}

/* ---------- formatting ---------- */

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Frame-coalescing wrapper: many calls in one frame collapse into one run. */
export function rafThrottle(fn) {
  let queued = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

/** Minimal event emitter used by the document / app state. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._h.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const set = this._h.get(evt);
    if (set) for (const fn of [...set]) fn(payload);
    const all = this._h.get('*');
    if (all) for (const fn of [...all]) fn(evt, payload);
  }
}

/** Points sampled along a segment, used to space brush dabs evenly. */
export function* walkSegment(x0, y0, x1, y1, step) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d === 0) { yield [x0, y0, 0]; return; }
  const n = Math.max(1, Math.ceil(d / step));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    yield [lerp(x0, x1, t), lerp(y0, y1, t), t];
  }
}
