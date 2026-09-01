// Painting tools: pencil, paintbrush, eraser, paint bucket, gradient,
// colour picker, clone stamp and recolour.

import { Tool, ICONS, constrainAngle } from './base.js';
import { paintOp, StrokeRecorder, floodFill, brushTip } from '../paint.js';
import { regionEdit } from '../history.js';
import { toCss } from '../color.js';
import { walkSegment, unionRect, normalizeRect, makeCanvas, clamp } from '../util.js';

/** Shared stroke plumbing: recorder lifecycle, colour choice, dab spacing. */
class StrokeTool extends Tool {
  constructor(app) {
    super(app);
    this.recorder = null;
    this.last = null;
    this.drawing = false;
  }

  colorFor(e) {
    return e.button === 2 || e.buttons === 2 ? this.app.secondaryColor : this.app.primaryColor;
  }

  beginStroke(pt, e) {
    this.app.commitFloating();
    if (!this.layer) return false;
    if (!this.layer.visible) {
      this.app.setStatus('The active layer is hidden — nothing was drawn.');
      return false;
    }
    this.recorder = new StrokeRecorder(this.doc, this.layer);
    this.drawing = true;
    this.last = { x: pt.x, y: pt.y };
    this.color = this.colorFor(e);
    return true;
  }

  endStroke(label) {
    if (!this.drawing) return;
    this.drawing = false;
    const entry = this.recorder?.finish(label);
    if (entry) this.app.pushHistory(entry);
    this.recorder = null;
    this.last = null;
  }

  cancel() {
    if (!this.drawing) return;
    // Roll back to the pre-stroke pixels without recording anything.
    const entry = this.recorder?.finish('cancel');
    entry?.undo();
    this.drawing = false;
    this.recorder = null;
    this.last = null;
  }
}

export class PaintbrushTool extends StrokeTool {
  static id = 'brush';
  static hint = 'Paint soft strokes. [ and ] change the width.';
  static label = 'Paintbrush';
  static shortcut = 'B';
  static icon = ICONS.brush;

  constructor(app) {
    super(app);
    this.options = { size: 24, hardness: 65, flow: 100, pressure: true };
  }

  get schema() {
    return [
      { type: 'range', key: 'size', label: 'Brush width', min: 1, max: 500, step: 1, unit: 'px', number: true },
      { type: 'range', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'range', key: 'flow', label: 'Flow', min: 1, max: 100, step: 1, unit: '%' },
      { type: 'toggle', key: 'pressure', label: 'Pen pressure' }
    ];
  }

  radiusFor(e) {
    let r = this.options.size / 2;
    if (this.options.pressure && e.pointerType === 'pen' && e.pressure > 0) r *= 0.25 + 0.75 * e.pressure;
    return Math.max(0.5, r);
  }

  onDown(pt, e) {
    if (!this.beginStroke(pt, e)) return;
    this.stamp([[pt.x, pt.y]], this.radiusFor(e));
  }

  onMove(pt, e) {
    if (!this.drawing) return;
    const r = this.radiusFor(e);
    const spacing = Math.max(0.7, r * 0.18);
    const pts = [];
    for (const [x, y] of walkSegment(this.last.x, this.last.y, pt.x, pt.y, spacing)) pts.push([x, y]);
    if (!pts.length) return;
    this.stamp(pts, r);
    this.last = { x: pt.x, y: pt.y };
  }

  onUp() { this.endStroke('Paintbrush'); }

  stamp(points, radius) {
    const tip = brushTip(radius, this.options.hardness / 100, this.color);
    const half = tip.size / 2;
    let bbox = null;
    for (const [x, y] of points) {
      bbox = unionRect(bbox, { x: x - half, y: y - half, w: tip.size, h: tip.size });
    }
    this.recorder.touch(bbox);
    const alpha = this.color.a * (this.options.flow / 100);
    paintOp(this.app, this.layer, bbox, (ctx) => {
      for (const [x, y] of points) ctx.drawImage(tip.canvas, x - half, y - half);
    }, { alpha });
  }
}

export class PencilTool extends StrokeTool {
  static id = 'pencil';
  static hint = 'Draw hard-edged pixels with no antialiasing.';
  static label = 'Pencil';
  static shortcut = 'P';
  static icon = ICONS.pencil;

  constructor(app) {
    super(app);
    this.options = { size: 1 };
  }

  get schema() {
    return [{ type: 'range', key: 'size', label: 'Width', min: 1, max: 32, step: 1, unit: 'px', number: true }];
  }

  onDown(pt, e) {
    if (!this.beginStroke(pt, e)) return;
    this.plot([[Math.floor(pt.x), Math.floor(pt.y)]]);
  }

  onMove(pt) {
    if (!this.drawing) return;
    const pts = bresenham(Math.floor(this.last.x), Math.floor(this.last.y), Math.floor(pt.x), Math.floor(pt.y));
    this.plot(pts);
    this.last = { x: pt.x, y: pt.y };
  }

  onUp() { this.endStroke('Pencil'); }

  /** Hard-edged, no antialiasing — one exact pixel (or square) per plot. */
  plot(points) {
    const s = Math.max(1, Math.round(this.options.size));
    const off = Math.floor((s - 1) / 2);
    let bbox = null;
    for (const [x, y] of points) bbox = unionRect(bbox, { x: x - off, y: y - off, w: s, h: s });
    this.recorder.touch(bbox);
    const css = toCss({ ...this.color, a: 1 });
    paintOp(this.app, this.layer, bbox, (ctx) => {
      ctx.fillStyle = css;
      for (const [x, y] of points) ctx.fillRect(x - off, y - off, s, s);
    }, { alpha: this.color.a });
  }
}

export class EraserTool extends StrokeTool {
  static id = 'eraser';
  static hint = 'Erase to transparency. [ and ] change the width.';
  static label = 'Eraser';
  static shortcut = 'E';
  static icon = ICONS.eraser;

  constructor(app) {
    super(app);
    this.options = { size: 32, hardness: 60, flow: 100 };
  }

  get schema() {
    return [
      { type: 'range', key: 'size', label: 'Width', min: 1, max: 500, step: 1, unit: 'px', number: true },
      { type: 'range', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'range', key: 'flow', label: 'Strength', min: 1, max: 100, step: 1, unit: '%' }
    ];
  }

  onDown(pt, e) {
    if (!this.beginStroke(pt, e)) return;
    this.erase([[pt.x, pt.y]]);
  }

  onMove(pt) {
    if (!this.drawing) return;
    const r = this.options.size / 2;
    const pts = [];
    for (const [x, y] of walkSegment(this.last.x, this.last.y, pt.x, pt.y, Math.max(0.7, r * 0.18))) pts.push([x, y]);
    this.erase(pts);
    this.last = { x: pt.x, y: pt.y };
  }

  onUp() { this.endStroke('Eraser'); }

  erase(points) {
    const r = Math.max(0.5, this.options.size / 2);
    const tip = brushTip(r, this.options.hardness / 100, { r: 0, g: 0, b: 0 });
    const half = tip.size / 2;
    let bbox = null;
    for (const [x, y] of points) bbox = unionRect(bbox, { x: x - half, y: y - half, w: tip.size, h: tip.size });
    this.recorder.touch(bbox);
    paintOp(this.app, this.layer, bbox, (ctx) => {
      for (const [x, y] of points) ctx.drawImage(tip.canvas, x - half, y - half);
    }, { compositeOp: 'destination-out', alpha: this.options.flow / 100 });
  }
}

export class PaintBucketTool extends Tool {
  static id = 'bucket';
  static hint = 'Fill an area of similar colour. Feather softens the edge; right-click fills with the secondary colour.';
  static label = 'Paint Bucket';
  static shortcut = 'F';
  static icon = ICONS.bucket;

  constructor(app) {
    super(app);
    this.options = { tolerance: 30, mode: 'contiguous', sampleMerged: false, feather: 0 };
  }

  get schema() {
    return [
      { type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'segmented', key: 'mode', label: 'Fill', items: [['contiguous', 'Contiguous'], ['global', 'Global']] },
      { type: 'range', key: 'feather', label: 'Feather', min: 0, max: 40, step: 1, unit: 'px' },
      { type: 'toggle', key: 'sampleMerged', label: 'Sample Merged' }
    ];
  }

  onDown(pt, e) {
    this.app.commitFloating();
    const layer = this.layer;
    if (!layer) return;
    if (pt.x < 0 || pt.y < 0 || pt.x >= this.doc.width || pt.y >= this.doc.height) return;

    const color = e.button === 2 ? this.app.secondaryColor : this.app.primaryColor;
    const recorder = new StrokeRecorder(this.doc, layer);
    // Fill area is unknown until the flood runs, so record the whole clip rect.
    recorder.touch(this.selection.clipRect());
    const r = floodFill(this.app, layer, pt.x, pt.y, color, {
      tolerance: this.options.tolerance,
      global: this.options.mode === 'global',
      sampleMerged: this.options.sampleMerged,
      feather: this.options.feather
    });
    if (!r) { this.app.setStatus('Nothing to fill there.'); return; }
    const entry = recorder.finish('Paint Bucket');
    if (entry) this.app.pushHistory(entry);
  }
}

export class GradientTool extends Tool {
  static id = 'gradient';
  static hint = 'Drag to draw a gradient. ⇧ snaps the angle.';
  static label = 'Gradient';
  static shortcut = 'G';
  static icon = ICONS.gradient;

  constructor(app) {
    super(app);
    this.options = { type: 'linear', mode: 'color', repeat: 'clamp' };
    this.dragging = false;
  }

  get schema() {
    return [
      { type: 'segmented', key: 'type', label: 'Type', items: [
        ['linear', 'Linear'], ['reflected', 'Reflected'], ['radial', 'Radial'], ['conical', 'Conical']
      ] },
      { type: 'segmented', key: 'mode', label: 'Colour', items: [['color', 'Primary → Secondary'], ['alpha', 'Primary → Transparent']] }
    ];
  }

  onDown(pt, e) {
    this.app.commitFloating();
    if (!this.layer) return;
    this.dragging = true;
    this.start = { x: pt.x, y: pt.y };
    this.end = { x: pt.x, y: pt.y };
    this.reversed = e.button === 2;
    this.clip = normalizeRect(this.selection.clipRect(), this.doc.width, this.doc.height);
    this.beforeCanvas = makeCanvas(this.clip.w, this.clip.h);
    this.beforeCanvas.getContext('2d')
      .drawImage(this.layer.canvas, this.clip.x, this.clip.y, this.clip.w, this.clip.h, 0, 0, this.clip.w, this.clip.h);
    this.overlay = this.app.beginOverlay(this.doc.activeIndex);
    this.paint();
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    this.end = e.shiftKey ? constrainAngle(this.start.x, this.start.y, pt.x, pt.y) : { x: pt.x, y: pt.y };
    this.paint();
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const buf = this.app.overlayCanvas;
    this.app.endOverlay();
    // The overlay was already masked while previewing, so bake it down with a
    // plain draw — masking again would square the coverage at feathered edges.
    const c = this.clip;
    this.layer.ctx.drawImage(buf, c.x, c.y, c.w, c.h, c.x, c.y, c.w, c.h);
    this.layer.touch();
    this.doc.invalidate(c);
    this.app.pushHistory(regionEdit(this.doc, this.layer, this.clip, this.beforeCanvas, 'Gradient'));
    this.beforeCanvas = null;
  }

  cancel() {
    if (!this.dragging) return;
    this.dragging = false;
    this.app.endOverlay();
    this.beforeCanvas = null;
  }

  buildGradient(ctx) {
    const { start: s, end: t } = this;
    const a = this.reversed ? this.app.secondaryColor : this.app.primaryColor;
    const b = this.options.mode === 'alpha'
      ? { ...a, a: 0 }
      : (this.reversed ? this.app.primaryColor : this.app.secondaryColor);

    const dx = t.x - s.x, dy = t.y - s.y;
    const len = Math.max(0.001, Math.hypot(dx, dy));
    let grad;
    switch (this.options.type) {
      case 'radial':
        grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, len);
        break;
      case 'conical':
        grad = ctx.createConicGradient(Math.atan2(dy, dx), s.x, s.y);
        grad.addColorStop(0, toCss(a));
        grad.addColorStop(0.5, toCss(b));
        grad.addColorStop(1, toCss(a));
        return grad;
      case 'reflected':
        grad = ctx.createLinearGradient(s.x - dx, s.y - dy, t.x, t.y);
        grad.addColorStop(0, toCss(b));
        grad.addColorStop(0.5, toCss(a));
        grad.addColorStop(1, toCss(b));
        return grad;
      default:
        grad = ctx.createLinearGradient(s.x, s.y, t.x, t.y);
    }
    grad.addColorStop(0, toCss(a));
    grad.addColorStop(1, toCss(b));
    return grad;
  }

  paint() {
    const ctx = this.app.overlayCtx;
    ctx.save();
    ctx.clearRect(this.clip.x, this.clip.y, this.clip.w, this.clip.h);
    ctx.fillStyle = this.buildGradient(ctx);
    ctx.fillRect(this.clip.x, this.clip.y, this.clip.w, this.clip.h);
    if (this.selection.active) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.selection.maskCanvas(), 0, 0);
    }
    ctx.restore();
    this.doc.invalidate(this.clip);
    this.app.view.render();
  }

  drawOverlay(g, view) {
    if (!this.dragging) return;
    const a = view.toScreen(this.start.x, this.start.y);
    const b = view.toScreen(this.end.x, this.end.y);
    g.strokeStyle = 'rgba(0,0,0,.7)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.stroke();
    for (const p of [a, b]) {
      g.fillStyle = '#fff';
      g.strokeStyle = '#000';
      g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
}

export class ColorPickerTool extends Tool {
  static id = 'picker';
  static hint = 'Pick a colour from the canvas. Right-click sets the secondary colour.';
  static label = 'Colour Picker';
  static shortcut = 'K';
  static icon = ICONS.picker;

  constructor(app) {
    super(app);
    this.options = { sample: 'image', switchBack: true };
  }

  get schema() {
    return [
      { type: 'segmented', key: 'sample', label: 'Sample', items: [['image', 'Image'], ['layer', 'Layer']] },
      { type: 'toggle', key: 'switchBack', label: 'Switch to previous tool after picking' }
    ];
  }

  pick(pt, e) {
    const x = Math.floor(pt.x), y = Math.floor(pt.y);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return null;
    const src = this.options.sample === 'layer' ? this.layer.canvas : this.doc.getComposite();
    const d = src.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    const c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    if (e.button === 2) this.app.setSecondaryColor(c); else this.app.setPrimaryColor(c);
    return c;
  }

  onDown(pt, e) { this._picked = this.pick(pt, e); }
  onMove(pt, e) { if (e.buttons) this.pick(pt, e); }

  onUp() {
    if (this._picked && this.options.switchBack && this.app.previousToolId) {
      this.app.setTool(this.app.previousToolId, { remember: false });
    }
  }
}

export class CloneStampTool extends StrokeTool {
  static id = 'clone';
  static hint = 'Copy pixels from elsewhere. ⌘-click or ⌥-click sets the source.';
  static label = 'Clone Stamp';
  static shortcut = 'C';
  static icon = ICONS.clone;

  constructor(app) {
    super(app);
    this.options = { size: 48, hardness: 70, aligned: true, sampleMerged: false };
    this.source = null;
    this.offset = null;
  }

  get schema() {
    return [
      { type: 'range', key: 'size', label: 'Width', min: 1, max: 500, step: 1, unit: 'px', number: true },
      { type: 'range', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'toggle', key: 'aligned', label: 'Aligned' },
      { type: 'toggle', key: 'sampleMerged', label: 'Sample Merged' },
      { type: 'note', text: '⌘-click or ⌥-click to set the clone source.' }
    ];
  }

  onDown(pt, e) {
    if (e.metaKey || e.altKey) {
      this.source = { x: pt.x, y: pt.y };
      this.offset = null;
      this.app.setStatus(`Clone source set to ${Math.round(pt.x)}, ${Math.round(pt.y)}`);
      return;
    }
    if (!this.source) {
      this.app.setStatus('Set a clone source first: ⌘-click or ⌥-click the area to copy from.');
      return;
    }
    if (!this.beginStroke(pt, e)) return;
    if (!this.offset || !this.options.aligned) {
      this.offset = { x: this.source.x - pt.x, y: this.source.y - pt.y };
    }
    // Freeze the source pixels so the stamp never samples what it just painted.
    this.snapshot = this.options.sampleMerged ? this.doc.flatten() : this.layer.canvas;
    if (!this.options.sampleMerged) {
      const c = makeCanvas(this.doc.width, this.doc.height);
      c.getContext('2d').drawImage(this.layer.canvas, 0, 0);
      this.snapshot = c;
    }
    this.stampAt([[pt.x, pt.y]]);
  }

  onMove(pt) {
    if (!this.drawing) return;
    const r = this.options.size / 2;
    const pts = [];
    for (const [x, y] of walkSegment(this.last.x, this.last.y, pt.x, pt.y, Math.max(1, r * 0.25))) pts.push([x, y]);
    this.stampAt(pts);
    this.last = { x: pt.x, y: pt.y };
  }

  onUp() {
    this.endStroke('Clone Stamp');
    this.snapshot = null;
  }

  stampAt(points) {
    const r = Math.max(0.5, this.options.size / 2);
    // A soft-edged alpha mask shaped like the brush, filled with source pixels.
    const mask = brushTip(r, this.options.hardness / 100, { r: 255, g: 255, b: 255 });
    const size = mask.size, half = size / 2;
    let bbox = null;
    for (const [x, y] of points) bbox = unionRect(bbox, { x: x - half, y: y - half, w: size, h: size });
    this.recorder.touch(bbox);

    const patch = makeCanvas(size, size);
    const pg = patch.getContext('2d');
    paintOp(this.app, this.layer, bbox, (ctx) => {
      for (const [x, y] of points) {
        pg.clearRect(0, 0, size, size);
        pg.drawImage(this.snapshot, x + this.offset.x - half, y + this.offset.y - half, size, size, 0, 0, size, size);
        pg.globalCompositeOperation = 'destination-in';
        pg.drawImage(mask.canvas, 0, 0);
        pg.globalCompositeOperation = 'source-over';
        ctx.drawImage(patch, x - half, y - half);
      }
    });
  }

  drawOverlay(g, view) {
    if (!this.source) return;
    const s = view.toScreen(this.source.x, this.source.y);
    g.strokeStyle = 'rgba(90,180,255,.9)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(s.x, s.y, 6, 0, Math.PI * 2);
    g.moveTo(s.x - 9, s.y); g.lineTo(s.x + 9, s.y);
    g.moveTo(s.x, s.y - 9); g.lineTo(s.x, s.y + 9);
    g.stroke();
  }
}

export class RecolorTool extends StrokeTool {
  static id = 'recolor';
  static hint = 'Paint the primary colour over pixels matching the secondary one.';
  static label = 'Recolour';
  static shortcut = 'R';
  static icon = ICONS.recolor;

  constructor(app) {
    super(app);
    this.options = { size: 40, tolerance: 40, hardness: 80 };
  }

  get schema() {
    return [
      { type: 'range', key: 'size', label: 'Width', min: 1, max: 400, step: 1, unit: 'px', number: true },
      { type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'range', key: 'hardness', label: 'Hardness', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'note', text: 'Paints primary over pixels near the secondary colour. Right-drag to swap roles.' }
    ];
  }

  onDown(pt, e) {
    if (!this.beginStroke(pt, e)) return;
    this.swap = e.button === 2;
    this.apply([[pt.x, pt.y]]);
  }

  onMove(pt) {
    if (!this.drawing) return;
    const r = this.options.size / 2;
    const pts = [];
    for (const [x, y] of walkSegment(this.last.x, this.last.y, pt.x, pt.y, Math.max(1, r * 0.3))) pts.push([x, y]);
    this.apply(pts);
    this.last = { x: pt.x, y: pt.y };
  }

  onUp() { this.endStroke('Recolour'); }

  apply(points) {
    const r = Math.max(0.5, this.options.size / 2);
    const from = this.swap ? this.app.primaryColor : this.app.secondaryColor;
    const to = this.swap ? this.app.secondaryColor : this.app.primaryColor;
    const tol = (this.options.tolerance / 100) * 255;
    const tolSq = tol * tol * 3;
    const soft = this.options.hardness / 100;

    for (const [px, py] of points) {
      const box = normalizeRect({ x: px - r - 1, y: py - r - 1, w: r * 2 + 2, h: r * 2 + 2 }, this.doc.width, this.doc.height);
      if (!box) continue;
      this.recorder.touch(box);
      const ctx = this.layer.ctx;
      const img = ctx.getImageData(box.x, box.y, box.w, box.h);
      const d = img.data;
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          const gx = box.x + x, gy = box.y + y;
          const dd = Math.hypot(gx + 0.5 - px, gy + 0.5 - py);
          if (dd > r) continue;
          const cov = soft >= 1 ? 1 : clamp((r - dd) / Math.max(0.001, r * (1 - soft)), 0, 1);
          const sel = this.selection.coverageAt(gx, gy) / 255;
          if (sel === 0) continue;
          const i = (y * box.w + x) * 4;
          const dr = d[i] - from.r, dg = d[i + 1] - from.g, db = d[i + 2] - from.b;
          if (dr * dr + dg * dg + db * db > tolSq) continue;
          const t = cov * sel * to.a;
          d[i] = d[i] + (to.r - d[i]) * t;
          d[i + 1] = d[i + 1] + (to.g - d[i + 1]) * t;
          d[i + 2] = d[i + 2] + (to.b - d[i + 2]) * t;
          d[i + 3] = Math.max(d[i + 3], Math.round(255 * t));
        }
      }
      ctx.putImageData(img, box.x, box.y);
      this.layer.touch();
      this.doc.invalidate(box);
    }
  }
}

function bresenham(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return pts;
}

export const DRAW_TOOLS = [
  PencilTool, PaintbrushTool, EraserTool, PaintBucketTool,
  GradientTool, ColorPickerTool, CloneStampTool, RecolorTool
];
