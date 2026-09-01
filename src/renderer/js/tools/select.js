// Selection tools: rectangle, ellipse, lasso, magic wand, plus the two move
// tools (move selected pixels / move the selection outline).

import { Tool, ICONS, constrainSquare } from './base.js';
import { COMBINE, magicWandMask, featherMask } from '../selection.js';
import { selectionEdit } from '../history.js';
import { rectFromPoints, normalizeRect, makeCanvas } from '../util.js';

/** Shift adds, Alt subtracts, Shift+Alt intersects — the Paint.NET convention. */
function combineModeFor(e, fallback) {
  if (e.shiftKey && e.altKey) return COMBINE.INTERSECT;
  if (e.shiftKey) return COMBINE.ADD;
  if (e.altKey) return COMBINE.SUBTRACT;
  return fallback || COMBINE.REPLACE;
}

class ShapeSelectTool extends Tool {
  constructor(app) {
    super(app);
    this.options = { mode: COMBINE.REPLACE, feather: 0, antialias: true };
    this.start = null;
    this.current = null;
    this.dragging = false;
  }

  get schema() {
    return [
      { type: 'segmented', key: 'mode', label: 'Mode', items: [
        [COMBINE.REPLACE, 'Replace'], [COMBINE.ADD, 'Add'], [COMBINE.SUBTRACT, 'Subtract'], [COMBINE.INTERSECT, 'Intersect']
      ] },
      { type: 'range', key: 'feather', label: 'Feather', min: 0, max: 40, step: 1, unit: 'px' },
      { type: 'toggle', key: 'antialias', label: 'Antialias' }
    ];
  }

  onDown(pt, e) {
    this.app.commitFloating();
    this._before = this.selection.snapshot();
    this._mode = combineModeFor(e, this.options.mode);
    this.start = { x: pt.x, y: pt.y };
    this.current = { x: pt.x, y: pt.y };
    this.dragging = true;
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    this.current = e.shiftKey
      ? constrainSquare(this.start.x, this.start.y, pt.x, pt.y)
      : { x: pt.x, y: pt.y };
    this.app.view.render();
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const r = rectFromPoints(this.start.x, this.start.y, this.current.x, this.current.y);
    if (r.w < 0.5 || r.h < 0.5) {
      // A click with no drag clears the selection, like clicking empty space.
      if (this._mode === COMBINE.REPLACE) {
        this.selection.clear();
        this.app.pushHistory(selectionEdit(this.doc, this.selection, this._before, 'Deselect'));
        this.doc.emit('selection-changed');
      }
      this.start = this.current = null;
      this.app.view.render();
      return;
    }
    const path = this.buildPath(r);
    this.selection.setFromPath(path, this._mode);
    if (this.options.feather > 0 && this.selection.mask) {
      this.selection.setFromMask(
        featherMask(this.selection.mask, this.doc.width, this.doc.height, this.options.feather),
        COMBINE.REPLACE
      );
    }
    this.app.pushHistory(selectionEdit(this.doc, this.selection, this._before, this.constructor.label));
    this.doc.emit('selection-changed');
    this.start = this.current = null;
    this.app.view.render();
  }

  cancel() {
    this.dragging = false;
    this.start = this.current = null;
  }

  drawOverlay(g, view) {
    if (!this.dragging || !this.start) return;
    const r = rectFromPoints(this.start.x, this.start.y, this.current.x, this.current.y);
    const a = view.toScreen(r.x, r.y);
    const b = view.toScreen(r.x + r.w, r.y + r.h);
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    this.strokePreview(g, a.x, a.y, b.x - a.x, b.y - a.y);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.lineWidth = 1;
    this.strokePreview(g, a.x + 1, a.y + 1, b.x - a.x, b.y - a.y);
  }
}

export class RectangleSelectTool extends ShapeSelectTool {
  static id = 'select-rect';
  static hint = 'Select a rectangular area. ⇧ adds to the selection, ⌥ subtracts.';
  static label = 'Rectangle Select';
  static shortcut = 'S';
  static icon = ICONS.rectSelect;

  buildPath(r) {
    const p = new Path2D();
    p.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    return p;
  }

  strokePreview(g, x, y, w, h) { g.strokeRect(x + 0.5, y + 0.5, w, h); }
}

export class EllipseSelectTool extends ShapeSelectTool {
  static id = 'select-ellipse';
  static hint = 'Select an elliptical area. ⇧ adds to the selection, ⌥ subtracts.';
  static label = 'Ellipse Select';
  static shortcut = 'D';
  static icon = ICONS.ellipseSelect;

  buildPath(r) {
    const p = new Path2D();
    p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return p;
  }

  strokePreview(g, x, y, w, h) {
    g.beginPath();
    g.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    g.stroke();
  }
}

export class LassoSelectTool extends Tool {
  static id = 'select-lasso';
  static hint = 'Draw a freehand selection outline.';
  static label = 'Lasso Select';
  static shortcut = 'L';
  static icon = ICONS.lasso;

  constructor(app) {
    super(app);
    this.options = { mode: COMBINE.REPLACE, feather: 0 };
    this.points = [];
    this.dragging = false;
  }

  get schema() {
    return [
      { type: 'segmented', key: 'mode', label: 'Mode', items: [
        [COMBINE.REPLACE, 'Replace'], [COMBINE.ADD, 'Add'], [COMBINE.SUBTRACT, 'Subtract'], [COMBINE.INTERSECT, 'Intersect']
      ] },
      { type: 'range', key: 'feather', label: 'Feather', min: 0, max: 40, step: 1, unit: 'px' }
    ];
  }

  onDown(pt, e) {
    this.app.commitFloating();
    this._before = this.selection.snapshot();
    this._mode = combineModeFor(e, this.options.mode);
    this.points = [[pt.x, pt.y]];
    this.dragging = true;
  }

  onMove(pt) {
    if (!this.dragging) return;
    const last = this.points[this.points.length - 1];
    // Skip sub-pixel jitter; keeps the path light without visible corners.
    if (Math.hypot(pt.x - last[0], pt.y - last[1]) < 1) return;
    this.points.push([pt.x, pt.y]);
    this.app.view.render();
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.points.length > 2) {
      const p = new Path2D();
      p.moveTo(this.points[0][0], this.points[0][1]);
      for (let i = 1; i < this.points.length; i++) p.lineTo(this.points[i][0], this.points[i][1]);
      p.closePath();
      this.selection.setFromPath(p, this._mode);
      if (this.options.feather > 0 && this.selection.mask) {
        this.selection.setFromMask(
          featherMask(this.selection.mask, this.doc.width, this.doc.height, this.options.feather),
          COMBINE.REPLACE
        );
      }
      this.app.pushHistory(selectionEdit(this.doc, this.selection, this._before, 'Lasso Select'));
      this.doc.emit('selection-changed');
    }
    this.points = [];
    this.app.view.render();
  }

  cancel() { this.dragging = false; this.points = []; }

  drawOverlay(g, view) {
    if (this.points.length < 2) return;
    g.beginPath();
    for (let i = 0; i < this.points.length; i++) {
      const s = view.toScreen(this.points[i][0], this.points[i][1]);
      i === 0 ? g.moveTo(s.x, s.y) : g.lineTo(s.x, s.y);
    }
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,.65)';
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.stroke();
    g.setLineDash([]);
  }
}

export class MagicWandTool extends Tool {
  static id = 'magic-wand';
  static hint = 'Select regions of similar colour. Raise the tolerance to catch more.';
  static label = 'Magic Wand';
  static shortcut = 'W';
  static icon = ICONS.wand;

  constructor(app) {
    super(app);
    this.options = { tolerance: 32, mode: COMBINE.REPLACE, sampleMerged: false, global: false, feather: 0 };
  }

  get schema() {
    return [
      { type: 'segmented', key: 'mode', label: 'Mode', items: [
        [COMBINE.REPLACE, 'Replace'], [COMBINE.ADD, 'Add'], [COMBINE.SUBTRACT, 'Subtract'], [COMBINE.INTERSECT, 'Intersect']
      ] },
      { type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 100, step: 1, unit: '%' },
      { type: 'toggle', key: 'sampleMerged', label: 'Sample Merged' },
      { type: 'toggle', key: 'global', label: 'Global' },
      { type: 'range', key: 'feather', label: 'Feather', min: 0, max: 40, step: 1, unit: 'px' }
    ];
  }

  onDown(pt, e) {
    this.app.commitFloating();
    const { width: w, height: h } = this.doc;
    if (pt.x < 0 || pt.y < 0 || pt.x >= w || pt.y >= h) return;

    const before = this.selection.snapshot();
    const src = this.options.sampleMerged ? this.doc.flatten() : this.layer.canvas;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    const data = sctx.getImageData(0, 0, w, h).data;

    let mask = magicWandMask(data, w, h, pt.x, pt.y, this.options.tolerance, this.options.global);
    if (this.options.feather > 0) mask = featherMask(mask, w, h, this.options.feather);

    this.selection.setFromMask(mask, combineModeFor(e, this.options.mode));
    this.app.pushHistory(selectionEdit(this.doc, this.selection, before, 'Magic Wand'));
    this.doc.emit('selection-changed');
    this.app.view.render();
  }
}

/**
 * Moves the pixels inside the selection. The first drag "lifts" them onto a
 * floating layer so repeated drags don't smear the source, exactly like
 * Paint.NET's Move Selected Pixels.
 */
export class MoveSelectionTool extends Tool {
  static id = 'move-pixels';
  static hint = 'Drag the selected pixels to a new spot. Arrow keys nudge.';
  static label = 'Move Selected Pixels';
  static shortcut = 'M';
  static icon = ICONS.move;
  static cursor = 'move';

  constructor(app) {
    super(app);
    this.options = { interpolation: 'smooth' };
    this.dragging = false;
  }

  get schema() {
    return [{ type: 'select', key: 'interpolation', label: 'Sampling', items: [['smooth', 'Smooth'], ['nearest', 'Nearest Neighbour']] }];
  }

  onDown(pt) {
    this.app.liftFloating();
    if (!this.app.floating) return;
    this.dragging = true;
    this._grab = { x: pt.x, y: pt.y };
    this._origin = { x: this.app.floating.x, y: this.app.floating.y };
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    let dx = pt.x - this._grab.x, dy = pt.y - this._grab.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    this.app.moveFloating(this._origin.x + dx, this._origin.y + dy);
  }

  onUp() { this.dragging = false; }

  onKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;
    const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = deltas[e.key];
    if (!d) return false;
    this.app.liftFloating();
    if (!this.app.floating) return false;
    this.app.moveFloating(this.app.floating.x + d[0], this.app.floating.y + d[1]);
    return true;
  }

  drawOverlay(g, view) {
    const f = this.app.floating;
    if (!f) return;
    const a = view.toScreen(f.x, f.y);
    const b = view.toScreen(f.x + f.canvas.width, f.y + f.canvas.height);
    g.strokeStyle = 'rgba(80,160,255,.9)';
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    g.setLineDash([]);
  }
}

/** Moves only the selection outline, leaving pixels where they are. */
export class MoveSelectionOutlineTool extends Tool {
  static id = 'move-selection';
  static hint = 'Drag the selection outline, leaving the pixels where they are.';
  static label = 'Move Selection';
  static shortcut = 'N';
  static icon = ICONS.moveSel;
  static cursor = 'move';

  onDown(pt) {
    this.app.commitFloating();
    if (!this.selection.active) return;
    this.dragging = true;
    this._grab = { x: pt.x, y: pt.y };
    this._before = this.selection.snapshot();
    this._applied = { x: 0, y: 0 };
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    let dx = Math.round(pt.x - this._grab.x), dy = Math.round(pt.y - this._grab.y);
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    // translate() is absolute-from-current, so apply only the delta since last move.
    this.selection.translate(dx - this._applied.x, dy - this._applied.y);
    this._applied = { x: dx, y: dy };
    this.doc.emit('selection-changed');
    this.app.view.render();
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this._applied.x || this._applied.y) {
      this.app.pushHistory(selectionEdit(this.doc, this.selection, this._before, 'Move Selection'));
    }
  }

  onKeyDown(e) {
    if (!this.selection.active) return false;
    const step = e.shiftKey ? 10 : 1;
    const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = deltas[e.key];
    if (!d) return false;
    const before = this.selection.snapshot();
    this.selection.translate(d[0], d[1]);
    this.app.pushHistory(selectionEdit(this.doc, this.selection, before, 'Move Selection'));
    this.doc.emit('selection-changed');
    this.app.view.render();
    return true;
  }
}

/** Extracts the selected pixels of `layer` into a tightly-cropped canvas. */
export function extractSelection(doc, selection, layer) {
  const bounds = selection.active
    ? selection.bounds
    : { x: 0, y: 0, w: doc.width, h: doc.height };
  const r = normalizeRect(bounds, doc.width, doc.height);
  if (!r) return null;
  const c = makeCanvas(r.w, r.h);
  const g = c.getContext('2d');
  g.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  if (selection.active) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(selection.maskCanvas(), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    g.globalCompositeOperation = 'source-over';
  }
  return { canvas: c, rect: r };
}

/** Clears the selected pixels from `layer` (used by cut / move-lift / delete). */
export function eraseSelection(doc, selection, layer) {
  const r = normalizeRect(selection.active ? selection.bounds : { x: 0, y: 0, w: doc.width, h: doc.height },
    doc.width, doc.height);
  if (!r) return null;
  const ctx = layer.ctx;
  ctx.save();
  if (selection.active) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(selection.maskCanvas(), r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  } else {
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }
  ctx.restore();
  layer.touch();
  doc.invalidate(r);
  return r;
}

export const SELECT_TOOLS = [
  RectangleSelectTool, EllipseSelectTool, LassoSelectTool, MagicWandTool,
  MoveSelectionTool, MoveSelectionOutlineTool
];
