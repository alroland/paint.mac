// Undo/redo. Two granularities are used deliberately:
//
//  * Pixel edits store only the ImageData of the touched rectangle, so a brush
//    stroke costs a few KB rather than a full-canvas copy.
//  * Structural edits (resize, rotate, layer reordering) store a whole-document
//    snapshot. Those are rare enough that the cost is fine, and it keeps the
//    restore logic simple and always correct.

import { Emitter, makeCanvas } from './util.js';
import { Layer } from './document.js';

const MEMORY_BUDGET = 512 * 1024 * 1024; // ~512 MB of retained undo bitmaps
const MAX_ENTRIES = 120;

export class History extends Emitter {
  constructor() {
    super();
    this.entries = [];
    this.index = -1;      // index of the last applied entry
    this.bytes = 0;
    this.savedIndex = -1; // where the document last matched its file on disk
  }

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.entries.length - 1; }

  push(entry) {
    // Anything previously undone is discarded once a new edit lands.
    if (this.index < this.entries.length - 1) {
      const dropped = this.entries.splice(this.index + 1);
      for (const d of dropped) this.bytes -= d.bytes || 0;
      if (this.savedIndex > this.index) this.savedIndex = -2; // saved state is unreachable
    }
    this.entries.push(entry);
    this.bytes += entry.bytes || 0;
    this.index = this.entries.length - 1;
    this._trim();
    this.emit('changed');
  }

  _trim() {
    while (this.entries.length > MAX_ENTRIES || (this.bytes > MEMORY_BUDGET && this.entries.length > 1)) {
      const removed = this.entries.shift();
      this.bytes -= removed.bytes || 0;
      this.index--;
      this.savedIndex--;
    }
  }

  undo() {
    if (!this.canUndo) return null;
    const e = this.entries[this.index];
    e.undo();
    this.index--;
    this.emit('changed');
    return e;
  }

  redo() {
    if (!this.canRedo) return null;
    const e = this.entries[this.index + 1];
    e.redo();
    this.index++;
    this.emit('changed');
    return e;
  }

  /** Jumps to an arbitrary point, replaying or rewinding as needed. */
  goTo(targetIndex) {
    const t = Math.max(-1, Math.min(this.entries.length - 1, targetIndex));
    while (this.index > t) { this.entries[this.index].undo(); this.index--; }
    while (this.index < t) { this.entries[this.index + 1].redo(); this.index++; }
    this.emit('changed');
  }

  clear() {
    this.entries = [];
    this.index = -1;
    this.bytes = 0;
    this.savedIndex = -1;
    this.emit('changed');
  }

  markSaved() { this.savedIndex = this.index; this.emit('changed'); }
  get isAtSavedPoint() { return this.savedIndex === this.index; }
}

/* ------------------------------------------------------------------ */
/* Entry factories                                                     */
/* ------------------------------------------------------------------ */

/** Whole-document snapshot, including layer stack, page size and selection. */
/**
 * Layers are addressed by id, never by object reference: restoreDocState()
 * rebuilds the layer stack, so an entry captured before a structural undo must
 * still resolve to the live layer afterwards.
 */
function resolveLayer(doc, layerId) {
  return doc.layers.find((l) => l.id === layerId) || null;
}

export function captureDocState(doc, selection) {
  return {
    width: doc.width,
    height: doc.height,
    activeIndex: doc.activeIndex,
    selection: selection ? selection.snapshot() : null,
    layers: doc.layers.map((l) => {
      const c = makeCanvas(l.width, l.height);
      c.getContext('2d').drawImage(l.canvas, 0, 0);
      return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode, canvas: c };
    })
  };
}

export function restoreDocState(doc, selection, state) {
  doc.layers = state.layers.map((s) => {
    const l = new Layer(s.canvas.width, s.canvas.height, s.name);
    l.id = s.id;
    l.visible = s.visible;
    l.opacity = s.opacity;
    l.blendMode = s.blendMode;
    l.ctx.drawImage(s.canvas, 0, 0);
    return l;
  });
  doc.activeIndex = Math.min(state.activeIndex, doc.layers.length - 1);
  if (doc.width !== state.width || doc.height !== state.height) {
    doc.setSize(state.width, state.height);
    selection.resize(state.width, state.height);
  }
  selection.restore(state.selection);
  doc.invalidateAll();
  doc.emit('layers-changed');
  doc.emit('selection-changed');
}

export function docStateEdit(doc, selection, before, label) {
  const after = captureDocState(doc, selection);
  const bytes = estimateStateBytes(before) + estimateStateBytes(after);
  return {
    label,
    bytes,
    undo: () => restoreDocState(doc, selection, before),
    redo: () => restoreDocState(doc, selection, after)
  };
}

function estimateStateBytes(s) {
  return s.layers.reduce((n, l) => n + l.canvas.width * l.canvas.height * 4, 0);
}

/** Selection-only change; cheap enough to always snapshot in full. */
export function selectionEdit(doc, selection, before, label) {
  const after = selection.snapshot();
  const bytes = (before?.length || 0) + (after?.length || 0);
  const apply = (m) => {
    selection.restore(m);
    doc.emit('selection-changed');
  };
  return { label, bytes, undo: () => apply(before), redo: () => apply(after) };
}

/** Layer metadata (name / opacity / blend / visibility) change. */
export function metaEdit(doc, layer, before, label) {
  const after = { name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode };
  const layerId = layer.id;
  const apply = (m) => {
    const target = resolveLayer(doc, layerId);
    if (!target) return;
    Object.assign(target, m);
    target.touch();
    doc.invalidateAll();
    doc.emit('layers-changed');
  };
  return { label, bytes: 0, undo: () => apply(before), redo: () => apply(after) };
}

/**
 * Region edit backed by canvases rather than ImageData. Cheaper than
 * getImageData for large areas because both capture and restore stay on the GPU.
 */
export function regionEdit(doc, layer, rect, beforeCanvas, label) {
  const afterCanvas = makeCanvas(rect.w, rect.h);
  afterCanvas.getContext('2d').drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const bytes = rect.w * rect.h * 8;
  const layerId = layer.id;
  const apply = (src) => {
    const target = resolveLayer(doc, layerId);
    if (!target) return;
    replaceRegion(target, rect, src);
    doc.invalidate(rect);
  };
  return { label, bytes, undo: () => apply(beforeCanvas), redo: () => apply(afterCanvas) };
}

/**
 * Replaces exactly `rect` on a layer with `src`. clearRect + source-over rather
 * than 'copy', because 'copy' clears the entire canvas, not just the drawn area.
 */
export function replaceRegion(layer, rect, src) {
  const g = layer.ctx;
  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();
  g.clearRect(rect.x, rect.y, rect.w, rect.h);
  g.drawImage(src, rect.x, rect.y);
  g.restore();
  layer.touch();
}
