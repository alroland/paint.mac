// The document model: an ordered stack of layers plus a cached composite.
//
// Performance note: the composite is kept at document resolution and only the
// dirty rectangle is recomposed. A brush dab therefore costs work proportional
// to the dab's bounding box, not to the canvas size, no matter how many layers
// the document has.

import { makeCanvas, unionRect, normalizeRect, uid, Emitter } from './util.js';

export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'],
  ['color-burn', 'Color Burn'],
  ['hard-light', 'Hard Light'],
  ['soft-light', 'Soft Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
  ['lighter', 'Additive']
];

export class Layer {
  constructor(width, height, name = 'Layer') {
    this.id = uid('layer');
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.blendMode = 'source-over';
    this.canvas = makeCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'high';
    this._thumb = null;
    this._thumbDirty = true;
  }

  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  /** Small cached preview for the layers panel; regenerated lazily. */
  thumbnail(w = 76, h = 60) {
    if (this._thumb && !this._thumbDirty && this._thumb.width === w) return this._thumb;
    const c = this._thumb && this._thumb.width === w ? this._thumb : makeCanvas(w, h);
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const scale = Math.min(w / this.width, h / this.height);
    const dw = this.width * scale, dh = this.height * scale;
    g.imageSmoothingQuality = 'low';
    g.drawImage(this.canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    this._thumb = c;
    this._thumbDirty = false;
    return c;
  }

  touch() { this._thumbDirty = true; }

  clone(name) {
    const l = new Layer(this.width, this.height, name ?? `${this.name} copy`);
    l.visible = this.visible;
    l.opacity = this.opacity;
    l.blendMode = this.blendMode;
    l.ctx.drawImage(this.canvas, 0, 0);
    return l;
  }

  /** Swaps in a differently-sized bitmap (used by resize / rotate / crop). */
  replaceCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'high';
    this.touch();
  }
}

export class PaintDocument extends Emitter {
  constructor(width, height) {
    super();
    this.width = width;
    this.height = height;
    this.layers = [];
    this.activeIndex = 0;
    this.filePath = null;
    this.fileName = 'Untitled';
    this.dirty = false;

    this.composite = makeCanvas(width, height);
    this.compositeCtx = this.composite.getContext('2d');
    this._dirtyRect = { x: 0, y: 0, w: width, h: height };

    // Transient bitmap drawn between two layers: in-progress brush strokes,
    // shape previews and floating (moved) selections all ride on this, which
    // keeps live previews pixel-accurate without touching layer bitmaps.
    // Shape: { canvas, x, y, alpha, op, aboveIndex }
    this.overlay = null;
  }

  static blank(width, height, fill = '#ffffff') {
    const doc = new PaintDocument(width, height);
    const bg = new Layer(width, height, 'Background');
    if (fill) {
      bg.ctx.fillStyle = fill;
      bg.ctx.fillRect(0, 0, width, height);
    }
    doc.layers.push(bg);
    return doc;
  }

  get activeLayer() { return this.layers[this.activeIndex] || null; }

  indexOfLayer(layer) { return this.layers.indexOf(layer); }

  setActive(i) {
    const n = Math.max(0, Math.min(this.layers.length - 1, i));
    if (n === this.activeIndex) return;
    this.activeIndex = n;
    this.emit('active-changed', n);
  }

  /** Marks a document-space rect (or the whole page, if omitted) for recompositing. */
  invalidate(r) {
    const full = { x: 0, y: 0, w: this.width, h: this.height };
    const next = r ? normalizeRect(r, this.width, this.height) : full;
    if (!next) return;
    this._dirtyRect = unionRect(this._dirtyRect, next);
    this.activeLayer?.touch();
    this.emit('pixels-changed', next);
  }

  invalidateAll() {
    this._dirtyRect = { x: 0, y: 0, w: this.width, h: this.height };
    for (const l of this.layers) l.touch();
    this.emit('pixels-changed', this._dirtyRect);
  }

  /** Recomposites only what changed since the last call, then returns the canvas. */
  getComposite() {
    const r = this._dirtyRect;
    if (r) {
      const g = this.compositeCtx;
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      g.clearRect(r.x, r.y, r.w, r.h);
      for (let i = 0; i < this.layers.length; i++) {
        const layer = this.layers[i];
        if (layer.visible && layer.opacity !== 0) {
          g.globalAlpha = layer.opacity;
          g.globalCompositeOperation = layer.blendMode;
          g.drawImage(layer.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        }
        const ov = this.overlay;
        if (ov && ov.aboveIndex === i) {
          g.globalAlpha = (layer.opacity ?? 1) * (ov.alpha ?? 1);
          g.globalCompositeOperation = ov.op || layer.blendMode;
          g.drawImage(ov.canvas, ov.x || 0, ov.y || 0);
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.restore();
      this._dirtyRect = null;
    }
    return this.composite;
  }

  /** Flat RGBA snapshot of every visible layer — used by copy-merged and export. */
  flatten(includeHidden = false) {
    const c = makeCanvas(this.width, this.height);
    const g = c.getContext('2d');
    for (const layer of this.layers) {
      if (!includeHidden && (!layer.visible || layer.opacity === 0)) continue;
      g.globalAlpha = layer.opacity;
      g.globalCompositeOperation = layer.blendMode;
      g.drawImage(layer.canvas, 0, 0);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  addLayer(layer, index = this.activeIndex + 1) {
    const i = Math.max(0, Math.min(this.layers.length, index));
    this.layers.splice(i, 0, layer);
    this.activeIndex = i;
    this.invalidateAll();
    this.emit('layers-changed');
    return layer;
  }

  removeLayerAt(i) {
    if (this.layers.length <= 1) return null;
    const [removed] = this.layers.splice(i, 1);
    this.activeIndex = Math.max(0, Math.min(this.layers.length - 1, i - 1));
    this.invalidateAll();
    this.emit('layers-changed');
    return removed;
  }

  moveLayer(from, to) {
    if (to < 0 || to >= this.layers.length || from === to) return false;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.activeIndex = to;
    this.invalidateAll();
    this.emit('layers-changed');
    return true;
  }

  /** Resizes the page itself; layer bitmaps are swapped in by the caller. */
  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.composite = makeCanvas(width, height);
    this.compositeCtx = this.composite.getContext('2d');
    this.invalidateAll();
    this.emit('size-changed');
  }

  markDirty(dirty = true) {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.emit('dirty-changed', dirty);
  }
}
