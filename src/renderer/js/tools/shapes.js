// Shape tools. Each drag renders into the shared overlay buffer so the preview
// is pixel-identical to the committed result, including selection clipping.

import { Tool, ICONS, constrainAngle, constrainSquare } from './base.js';
import { regionEdit } from '../history.js';
import { toCss } from '../color.js';
import { rectFromPoints, normalizeRect, makeCanvas, unionRect, inflateRect } from '../util.js';

/** Dash patterns, scaled by line width so they read the same at any weight. */
export const BORDER_STYLES = [
  ['solid', 'Solid'],
  ['dash', 'Dashed'],
  ['dot', 'Dotted'],
  ['dashdot', 'Dash-dot'],
  ['dashdotdot', 'Dash-dot-dot']
];

export function dashPattern(style, width) {
  const w = Math.max(1, width);
  switch (style) {
    case 'dash': return [w * 3, w * 2];
    // A zero-length segment with a round cap renders as a dot.
    case 'dot': return [0.01, w * 2];
    case 'dashdot': return [w * 3, w * 1.6, 0.01, w * 1.6];
    case 'dashdotdot': return [w * 3, w * 1.6, 0.01, w * 1.6, 0.01, w * 1.6];
    default: return [];
  }
}

class ShapeTool extends Tool {
  constructor(app) {
    super(app);
    this.options = {
      width: 3,
      style: 'outline',
      antialias: true,
      border: 'solid',
      // null means "follow the palette": outline tracks primary, fill secondary.
      strokeColor: null,
      fillColor: null
    };
    this.dragging = false;
  }

  get schema() {
    return [
      { type: 'segmented', key: 'style', label: 'Style', items: [['outline', 'Outline'], ['fill', 'Interior'], ['both', 'Both']] },
      { type: 'color', key: 'strokeColor', label: 'Outline', fallback: 'primary', role: 'stroke' },
      { type: 'color', key: 'fillColor', label: 'Fill', fallback: 'secondary', role: 'fill' },
      { type: 'range', key: 'width', label: 'Width', min: 1, max: 100, step: 1, unit: 'px', number: true },
      { type: 'select', key: 'border', label: 'Border', items: BORDER_STYLES },
      { type: 'toggle', key: 'antialias', label: 'Antialias' }
    ];
  }

  /** Stroke cap; overridden by the Line tool, which exposes it as an option. */
  lineCap() { return 'round'; }

  /** Right-dragging swaps the two roles, pinned colours included. */
  colors() {
    const stroke = this.options.strokeColor || this.app.primaryColor;
    const fill = this.options.fillColor || this.app.secondaryColor;
    return this.swapColors ? { stroke: fill, fill: stroke } : { stroke, fill };
  }

  onDown(pt, e) {
    this.app.commitFloating();
    if (!this.layer) return;
    this.dragging = true;
    this.swapColors = e.button === 2;
    this.start = { x: pt.x, y: pt.y };
    this.end = { x: pt.x, y: pt.y };
    this.app.beginOverlay(this.doc.activeIndex);
    this.paint();
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    this.end = this.constrain(pt, e);
    this.altCenter = e.altKey;
    this.paint();
  }

  onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const buf = this.app.overlayCanvas;
    const dirty = normalizeRect(inflateRect(this.bounds(), this.options.width + 2), this.doc.width, this.doc.height);
    this.app.endOverlay();
    if (!dirty) return;

    const before = makeCanvas(dirty.w, dirty.h);
    // The overlay still holds the finished shape; the layer is untouched, so
    // capture "before" from the layer and then bake the overlay into it.
    before.getContext('2d').drawImage(this.layer.canvas, dirty.x, dirty.y, dirty.w, dirty.h, 0, 0, dirty.w, dirty.h);
    // Already masked during preview; a second mask would double-apply feathering.
    this.layer.ctx.drawImage(buf, dirty.x, dirty.y, dirty.w, dirty.h, dirty.x, dirty.y, dirty.w, dirty.h);
    this.layer.touch();
    this.doc.invalidate(dirty);
    this.app.pushHistory(regionEdit(this.doc, this.layer, dirty, before, this.constructor.label));
  }

  cancel() {
    if (!this.dragging) return;
    this.dragging = false;
    this.app.endOverlay();
  }

  constrain(pt, e) {
    return e.shiftKey ? constrainSquare(this.start.x, this.start.y, pt.x, pt.y) : { x: pt.x, y: pt.y };
  }

  bounds() {
    return rectFromPoints(this.start.x, this.start.y, this.end.x, this.end.y);
  }

  paint() {
    const ctx = this.app.overlayCtx;
    const prev = this._painted;
    ctx.save();
    if (prev) ctx.clearRect(prev.x, prev.y, prev.w, prev.h);
    ctx.imageSmoothingEnabled = this.options.antialias;

    const { stroke, fill } = this.colors();
    ctx.lineWidth = this.options.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = this.lineCap();
    ctx.strokeStyle = toCss(stroke);
    ctx.fillStyle = toCss(fill);
    ctx.setLineDash(dashPattern(this.options.border, this.options.width));
    if (!this.options.antialias) ctx.filter = 'none';

    const path = this.buildPath();
    if (this.options.style !== 'outline') ctx.fill(path);
    if (this.options.style !== 'fill') ctx.stroke(path);

    if (this.selection.active) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.selection.maskCanvas(), 0, 0);
    }
    ctx.restore();

    const now = normalizeRect(inflateRect(this.bounds(), this.options.width + 2), this.doc.width, this.doc.height);
    this._painted = now;
    this.doc.invalidate(unionRect(prev, now));
    this.app.view.render();
  }
}

export class LineTool extends ShapeTool {
  static id = 'line';
  static hint = 'Draw a straight line. ⇧ snaps to 45°.';
  static label = 'Line';
  static shortcut = 'O';
  static icon = ICONS.line;

  get schema() {
    return [
      { type: 'color', key: 'strokeColor', label: 'Colour', fallback: 'primary' },
      { type: 'range', key: 'width', label: 'Width', min: 1, max: 100, step: 1, unit: 'px', number: true },
      { type: 'select', key: 'border', label: 'Style', items: BORDER_STYLES },
      { type: 'select', key: 'cap', label: 'Ends', items: [['round', 'Round'], ['butt', 'Flat'], ['square', 'Square'], ['arrow', 'Arrowhead']] },
      { type: 'toggle', key: 'antialias', label: 'Antialias' }
    ];
  }

  constructor(app) {
    super(app);
    this.options = {
      width: 3, cap: 'round', antialias: true, style: 'outline',
      border: 'solid', strokeColor: null, fillColor: null
    };
  }

  constrain(pt, e) {
    return e.shiftKey ? constrainAngle(this.start.x, this.start.y, pt.x, pt.y) : { x: pt.x, y: pt.y };
  }

  buildPath() {
    const p = new Path2D();
    p.moveTo(this.start.x, this.start.y);
    p.lineTo(this.end.x, this.end.y);
    if (this.options.cap === 'arrow') {
      const a = Math.atan2(this.end.y - this.start.y, this.end.x - this.start.x);
      const len = Math.max(8, this.options.width * 3.5);
      for (const s of [-1, 1]) {
        p.moveTo(this.end.x, this.end.y);
        p.lineTo(this.end.x - Math.cos(a + s * 0.5) * len, this.end.y - Math.sin(a + s * 0.5) * len);
      }
    }
    return p;
  }

  lineCap() {
    // Dots and dash-dots are zero-length segments, which only render with a
    // round cap, so those border styles force it.
    const dotted = this.options.border !== 'solid' && this.options.border !== 'dash';
    return (this.options.cap === 'arrow' || dotted) ? 'round' : this.options.cap;
  }
}

export class RectangleTool extends ShapeTool {
  static id = 'shape-rect';
  static hint = 'Draw a rectangle. ⇧ constrains to a square.';
  static label = 'Rectangle';
  static shortcut = 'U';
  static icon = ICONS.rectShape;

  buildPath() {
    const r = this.bounds();
    const p = new Path2D();
    p.rect(r.x, r.y, r.w, r.h);
    return p;
  }
}

export class RoundedRectangleTool extends ShapeTool {
  static id = 'shape-round-rect';
  static hint = 'Draw a rectangle with rounded corners.';
  static label = 'Rounded Rectangle';
  static shortcut = '';
  static icon = '<rect x="2.5" y="4.5" width="13" height="9" rx="3"/>';

  constructor(app) {
    super(app);
    this.options = { ...this.options, radius: 12 };
  }

  get schema() {
    return [...super.schema, { type: 'range', key: 'radius', label: 'Corner radius', min: 0, max: 120, step: 1, unit: 'px' }];
  }

  buildPath() {
    const r = this.bounds();
    const rad = Math.min(this.options.radius, r.w / 2, r.h / 2);
    const p = new Path2D();
    p.roundRect(r.x, r.y, r.w, r.h, rad);
    return p;
  }
}

export class EllipseTool extends ShapeTool {
  static id = 'shape-ellipse';
  static hint = 'Draw an ellipse. ⇧ constrains to a circle.';
  static label = 'Ellipse';
  static shortcut = 'I';
  static icon = ICONS.ellipseShape;

  buildPath() {
    const r = this.bounds();
    const p = new Path2D();
    p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return p;
  }
}

export class PolygonTool extends ShapeTool {
  static id = 'shape-polygon';
  static hint = 'Draw a polygon or star with any number of sides.';
  static label = 'Polygon / Star';
  static shortcut = 'Y';
  static icon = ICONS.polygon;

  constructor(app) {
    super(app);
    this.options = { ...this.options, sides: 5, star: false, innerRatio: 45 };
  }

  get schema() {
    return [
      ...super.schema,
      { type: 'range', key: 'sides', label: 'Sides', min: 3, max: 24, step: 1, number: true },
      { type: 'toggle', key: 'star', label: 'Star' },
      { type: 'range', key: 'innerRatio', label: 'Inner radius', min: 5, max: 95, step: 1, unit: '%' }
    ];
  }

  buildPath() {
    const r = this.bounds();
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = r.w / 2, ry = r.h / 2;
    const n = Math.max(3, Math.round(this.options.sides));
    const p = new Path2D();
    const total = this.options.star ? n * 2 : n;
    for (let i = 0; i < total; i++) {
      const a = (-Math.PI / 2) + (i / total) * Math.PI * 2;
      const k = this.options.star && i % 2 === 1 ? this.options.innerRatio / 100 : 1;
      const x = cx + Math.cos(a) * rx * k;
      const y = cy + Math.sin(a) * ry * k;
      i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }
}

/** Freehand outline that closes into a filled/stroked shape on release. */
export class FreeformShapeTool extends ShapeTool {
  static id = 'shape-freeform';
  static hint = 'Draw a freehand shape that closes when you release.';
  static label = 'Freeform Shape';
  static shortcut = '';
  static icon = '<path d="M3 12c0-5 4-8 7-8s5 3 4 6-5 3-5 5 2 2 3 2"/>';

  onDown(pt, e) {
    this.points = [[pt.x, pt.y]];
    super.onDown(pt, e);
  }

  onMove(pt, e) {
    if (!this.dragging) return;
    const last = this.points[this.points.length - 1];
    if (Math.hypot(pt.x - last[0], pt.y - last[1]) < 1.2) return;
    this.points.push([pt.x, pt.y]);
    this.end = { x: pt.x, y: pt.y };
    this.paint();
  }

  bounds() {
    if (!this.points?.length) return { x: 0, y: 0, w: 0, h: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of this.points) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  buildPath() {
    const p = new Path2D();
    if (!this.points.length) return p;
    p.moveTo(this.points[0][0], this.points[0][1]);
    for (let i = 1; i < this.points.length; i++) p.lineTo(this.points[i][0], this.points[i][1]);
    if (this.options.style !== 'outline') p.closePath();
    return p;
  }
}

export const SHAPE_TOOLS = [LineTool, RectangleTool, RoundedRectangleTool, EllipseTool, PolygonTool, FreeformShapeTool];
