// Viewport: owns the document -> screen transform and the per-frame draw.
//
// Everything is drawn with a handful of GPU-backed drawImage calls: the cached
// document composite is blitted once, then overlays are stroked on top. Idle
// cost is zero because renders are demand-driven; only marching ants schedule
// a low-rate repaint.

import { clamp, rafThrottle } from './util.js';

const ZOOM_STEPS = [0.05, 0.08, 0.125, 0.17, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const ANTS_PERIOD_MS = 90;

export class View {
  constructor(app, canvasEl, hostEl) {
    this.app = app;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d', { alpha: false });
    this.host = hostEl;

    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.showGrid = false;
    this.showPixelGrid = true;
    this.showRulers = true;
    this.gridSize = 16;

    this._dpr = window.devicePixelRatio || 1;
    this._antsOffset = 0;
    this._antsTimer = null;
    this._checker = makeCheckerPattern();

    this.render = rafThrottle(() => this._render());

    const ro = new ResizeObserver(() => { this._resizeBackingStore(); this.render(); });
    ro.observe(hostEl);
    this._resizeBackingStore();
  }

  /* ---------- transform ---------- */

  toScreen(dx, dy) { return { x: dx * this.zoom + this.offsetX, y: dy * this.zoom + this.offsetY }; }
  toDoc(sx, sy) { return { x: (sx - this.offsetX) / this.zoom, y: (sy - this.offsetY) / this.zoom }; }

  get viewWidth() { return this.host.clientWidth; }
  get viewHeight() { return this.host.clientHeight; }

  fitToWindow(padding = 32) {
    const doc = this.app.doc;
    const z = Math.min(
      (this.viewWidth - padding) / doc.width,
      (this.viewHeight - padding) / doc.height
    );
    this.zoom = clamp(z, 0.01, 64);
    this.centerDocument();
    this.render();
    this.app.emit('view-changed');
  }

  centerDocument() {
    const doc = this.app.doc;
    this.offsetX = Math.round((this.viewWidth - doc.width * this.zoom) / 2);
    this.offsetY = Math.round((this.viewHeight - doc.height * this.zoom) / 2);
  }

  /** Zooms while keeping the document point under `anchor` (screen px) fixed. */
  setZoom(z, anchor) {
    const next = clamp(z, 0.01, 64);
    if (next === this.zoom) return;
    const ax = anchor ? anchor.x : this.viewWidth / 2;
    const ay = anchor ? anchor.y : this.viewHeight / 2;
    const before = this.toDoc(ax, ay);
    this.zoom = next;
    this.offsetX = ax - before.x * next;
    this.offsetY = ay - before.y * next;
    this.clampPan();
    this.render();
    this.app.emit('view-changed');
  }

  zoomIn(anchor) { this.setZoom(nextZoomStep(this.zoom, 1), anchor); }
  zoomOut(anchor) { this.setZoom(nextZoomStep(this.zoom, -1), anchor); }

  panBy(dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clampPan();
    this.render();
    this.app.emit('view-changed');
  }

  /** Keeps at least a sliver of the document reachable on screen. */
  clampPan() {
    const doc = this.app.doc;
    const dw = doc.width * this.zoom, dh = doc.height * this.zoom;
    const margin = 60;
    this.offsetX = clamp(this.offsetX, -dw + margin, this.viewWidth - margin);
    this.offsetY = clamp(this.offsetY, -dh + margin, this.viewHeight - margin);
  }

  /* ---------- rendering ---------- */

  _resizeBackingStore() {
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    const w = Math.max(1, Math.round(this.viewWidth * dpr));
    const h = Math.max(1, Math.round(this.viewHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _render() {
    const g = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this._dpr) this._resizeBackingStore();

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1a1a1a';
    g.fillRect(0, 0, this.viewWidth, this.viewHeight);

    const doc = this.app.doc;
    const dw = doc.width * this.zoom, dh = doc.height * this.zoom;
    const ox = Math.round(this.offsetX), oy = Math.round(this.offsetY);

    // Drop shadow + transparency checkerboard behind the artwork.
    g.save();
    g.shadowColor = 'rgba(0,0,0,.55)';
    g.shadowBlur = 14;
    g.shadowOffsetY = 3;
    g.fillStyle = '#2a2a2a';
    g.fillRect(ox, oy, dw, dh);
    g.restore();

    g.save();
    g.beginPath();
    g.rect(ox, oy, dw, dh);
    g.clip();
    g.fillStyle = this._checker;
    g.save();
    g.translate(ox, oy);
    g.fillRect(0, 0, dw, dh);
    g.restore();

    // The artwork itself: one blit of the cached composite.
    g.imageSmoothingEnabled = this.zoom < 1;
    g.imageSmoothingQuality = 'high';
    g.drawImage(doc.getComposite(), ox, oy, dw, dh);
    g.imageSmoothingEnabled = true;
    g.restore();

    if (this.showPixelGrid && this.zoom >= 8) this._drawPixelGrid(g, ox, oy, dw, dh);
    if (this.showGrid) this._drawGrid(g, ox, oy, dw, dh);

    // Document border.
    g.strokeStyle = 'rgba(255,255,255,.22)';
    g.lineWidth = 1;
    g.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);

    this._drawSelection(g);

    // Tool-owned overlay (drag rectangles, shape previews, handles…).
    const tool = this.app.activeTool;
    if (tool?.drawOverlay) {
      g.save();
      tool.drawOverlay(g, this);
      g.restore();
    }
  }

  _drawPixelGrid(g, ox, oy, dw, dh) {
    const doc = this.app.doc;
    g.save();
    g.beginPath();
    g.rect(ox, oy, dw, dh);
    g.clip();
    g.strokeStyle = 'rgba(128,128,128,.28)';
    g.lineWidth = 1;
    g.beginPath();
    const x0 = Math.max(0, Math.floor(-this.offsetX / this.zoom));
    const x1 = Math.min(doc.width, Math.ceil((this.viewWidth - this.offsetX) / this.zoom));
    const y0 = Math.max(0, Math.floor(-this.offsetY / this.zoom));
    const y1 = Math.min(doc.height, Math.ceil((this.viewHeight - this.offsetY) / this.zoom));
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round(ox + x * this.zoom) + 0.5;
      g.moveTo(sx, oy); g.lineTo(sx, oy + dh);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round(oy + y * this.zoom) + 0.5;
      g.moveTo(ox, sy); g.lineTo(ox + dw, sy);
    }
    g.stroke();
    g.restore();
  }

  _drawGrid(g, ox, oy, dw, dh) {
    const step = this.gridSize * this.zoom;
    if (step < 4) return;
    g.save();
    g.beginPath();
    g.rect(ox, oy, dw, dh);
    g.clip();
    g.strokeStyle = 'rgba(90,160,255,.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x * this.gridSize <= this.app.doc.width; x++) {
      const sx = Math.round(ox + x * step) + 0.5;
      g.moveTo(sx, oy); g.lineTo(sx, oy + dh);
    }
    for (let y = 0; y * this.gridSize <= this.app.doc.height; y++) {
      const sy = Math.round(oy + y * step) + 0.5;
      g.moveTo(ox, sy); g.lineTo(ox + dw, sy);
    }
    g.stroke();
    g.restore();
  }

  _drawSelection(g) {
    const sel = this.app.selection;
    const outline = sel.active ? sel.outline() : null;
    if (!outline) { this._stopAnts(); return; }

    // Complex boundary (typically a magic wand over noisy pixels): one blit of
    // a cached edge bitmap instead of stroking a path with 100k+ segments.
    if (outline.edge) {
      const e = outline.edge;
      const x = this.offsetX + e.x * this.zoom;
      const y = this.offsetY + e.y * this.zoom;
      const w = e.w * this.zoom, h = e.h * this.zoom;
      g.save();
      g.imageSmoothingEnabled = false;
      g.globalAlpha = 0.55;
      g.drawImage(e.canvas, x + 1, y + 1, w, h);   // dark offset copy for contrast
      g.globalCompositeOperation = 'difference';
      g.globalAlpha = 1;
      g.drawImage(e.canvas, x, y, w, h);
      g.restore();
      this._stopAnts();
      return;
    }

    g.save();
    g.translate(this.offsetX, this.offsetY);
    g.scale(this.zoom, this.zoom);
    g.lineWidth = 1 / this.zoom;

    // Two passes give the classic black/white marching-ants look at any zoom.
    g.strokeStyle = '#000';
    g.setLineDash([4 / this.zoom, 4 / this.zoom]);
    g.lineDashOffset = -this._antsOffset / this.zoom;
    g.stroke(outline.path);

    g.strokeStyle = '#fff';
    g.lineDashOffset = (-this._antsOffset + 4) / this.zoom;
    g.stroke(outline.path);
    g.restore();

    this._startAnts();
  }

  _startAnts() {
    if (this._antsTimer) return;
    this._antsTimer = setInterval(() => {
      this._antsOffset = (this._antsOffset + 1) % 8;
      this.render();
    }, ANTS_PERIOD_MS);
  }

  _stopAnts() {
    if (this._antsTimer) { clearInterval(this._antsTimer); this._antsTimer = null; }
  }

  /* ---------- helpers for tools ---------- */

  /** Screen-space line width that always reads as 1 device pixel. */
  hairline() { return 1; }

  /** Runs `fn` with the context transformed into document space. */
  inDocSpace(g, fn) {
    g.save();
    g.translate(this.offsetX, this.offsetY);
    g.scale(this.zoom, this.zoom);
    fn(g);
    g.restore();
  }
}

function nextZoomStep(current, dir) {
  if (dir > 0) {
    for (const z of ZOOM_STEPS) if (z > current + 1e-6) return z;
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 1e-6) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

export { ZOOM_STEPS };

function makeCheckerPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#cccccc';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return g.createPattern(c, 'repeat');
}

/* ------------------------------------------------------------------ */
/* Rulers                                                              */
/* ------------------------------------------------------------------ */

export class Rulers {
  constructor(view, hEl, vEl) {
    this.view = view;
    this.h = hEl;
    this.v = vEl;
    this.hCtx = hEl.getContext('2d');
    this.vCtx = vEl.getContext('2d');
    this.mouse = null;
    this.draw = rafThrottle(() => this._draw());
  }

  _sizeCanvas(el) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(el.clientWidth * dpr));
    const h = Math.max(1, Math.round(el.clientHeight * dpr));
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
    return dpr;
  }

  _tickStep() {
    // Pick a 1/2/5/10 step that keeps labels at least ~60 px apart.
    const target = 60 / this.view.zoom;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
    for (const m of [1, 2, 5, 10]) if (pow * m >= target) return pow * m;
    return pow * 10;
  }

  _draw() {
    const view = this.view;
    if (!view.showRulers) return;
    const step = this._tickStep();

    // Horizontal
    let dpr = this._sizeCanvas(this.h);
    let g = this.hCtx;
    const hw = this.h.clientWidth, hh = this.h.clientHeight;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, hw, hh);
    g.fillStyle = '#2b2b2b';
    g.fillRect(0, 0, hw, hh);
    g.strokeStyle = '#6a6a6a';
    g.fillStyle = '#9a9a9a';
    g.font = '9px -apple-system, sans-serif';
    g.textBaseline = 'top';
    g.beginPath();
    const dx0 = Math.floor(view.toDoc(0, 0).x / step) * step;
    const dx1 = view.toDoc(hw, 0).x;
    for (let d = dx0; d <= dx1; d += step) {
      const sx = Math.round(view.toScreen(d, 0).x) + 0.5;
      g.moveTo(sx, hh - 6); g.lineTo(sx, hh);
      if (step * view.zoom > 34) g.fillText(String(Math.round(d)), sx + 2, 1);
      for (let k = 1; k < 5; k++) {
        const sub = Math.round(view.toScreen(d + (step * k) / 5, 0).x) + 0.5;
        g.moveTo(sub, hh - 3); g.lineTo(sub, hh);
      }
    }
    g.stroke();
    if (this.mouse) {
      g.strokeStyle = '#4b9bff';
      g.beginPath();
      const mx = Math.round(view.toScreen(this.mouse.x, 0).x) + 0.5;
      g.moveTo(mx, 0); g.lineTo(mx, hh);
      g.stroke();
    }

    // Vertical
    dpr = this._sizeCanvas(this.v);
    g = this.vCtx;
    const vw = this.v.clientWidth, vh = this.v.clientHeight;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, vh);
    g.fillStyle = '#2b2b2b';
    g.fillRect(0, 0, vw, vh);
    g.strokeStyle = '#6a6a6a';
    g.fillStyle = '#9a9a9a';
    g.font = '9px -apple-system, sans-serif';
    g.beginPath();
    const dy0 = Math.floor(view.toDoc(0, 0).y / step) * step;
    const dy1 = view.toDoc(0, vh).y;
    for (let d = dy0; d <= dy1; d += step) {
      const sy = Math.round(view.toScreen(0, d).y) + 0.5;
      g.moveTo(vw - 6, sy); g.lineTo(vw, sy);
      if (step * view.zoom > 34) {
        g.save();
        g.translate(1, sy + 2);
        g.rotate(-Math.PI / 2);
        g.textBaseline = 'top';
        g.fillText(String(Math.round(d)), -28, 0);
        g.restore();
      }
      for (let k = 1; k < 5; k++) {
        const sub = Math.round(view.toScreen(0, d + (step * k) / 5).y) + 0.5;
        g.moveTo(vw - 3, sub); g.lineTo(vw, sub);
      }
    }
    g.stroke();
    if (this.mouse) {
      g.strokeStyle = '#4b9bff';
      g.beginPath();
      const my = Math.round(view.toScreen(0, this.mouse.y).y) + 0.5;
      g.moveTo(0, my); g.lineTo(vw, my);
      g.stroke();
    }
  }
}
