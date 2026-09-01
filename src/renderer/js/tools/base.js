// Tool contract. Pointer coordinates arrive already converted to document
// space; tools never see screen pixels except in drawOverlay().

export class Tool {
  static id = 'tool';
  static label = 'Tool';
  static shortcut = '';
  static icon = '';
  static cursor = 'crosshair';

  constructor(app) {
    this.app = app;
    this.options = {};
    this.active = false;
  }

  /** Controls rendered into the options bar. See ui/toolOptions.js. */
  get schema() { return []; }

  get cursor() { return this.constructor.cursor; }

  /**
   * True while an operation is in progress that Escape should abort — a shape
   * drag, a brush stroke, an open text box. When nothing is in progress,
   * Escape falls through to clearing the selection.
   */
  get busy() { return !!(this.dragging || this.drawing); }

  activate() { this.active = true; }
  deactivate() { this.active = false; this.cancel(); }

  onDown(_pt, _e) {}
  onMove(_pt, _e) {}
  onUp(_pt, _e) {}
  onDoubleClick(_pt, _e) {}
  onKeyDown(_e) { return false; }
  cancel() {}
  commit() {}

  drawOverlay(_g, _view) {}

  /* helpers */
  get doc() { return this.app.doc; }
  get layer() { return this.app.doc.activeLayer; }
  get selection() { return this.app.selection; }
}

/** Snaps a drag to 0/45/90 degrees, used when Shift is held. */
export function constrainAngle(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const a = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(a / step) * step;
  const len = Math.hypot(dx, dy);
  // Along a diagonal, project so the result stays on the 45-degree line.
  return { x: x0 + Math.cos(snapped) * len, y: y0 + Math.sin(snapped) * len };
}

/** Squares off a drag rectangle when Shift is held. */
export function constrainSquare(x0, y0, x1, y1) {
  const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return { x: x0 + Math.sign(x1 - x0 || 1) * s, y: y0 + Math.sign(y1 - y0 || 1) * s };
}

export const ICONS = {
  rectSelect: '<rect x="2.5" y="4.5" width="13" height="10" stroke-dasharray="2 2"/>',
  ellipseSelect: '<ellipse cx="9" cy="9" rx="6.5" ry="5" stroke-dasharray="2 2"/>',
  lasso: '<path d="M4 12c-2-3 0-8 5-8s6 4 5 6-4 2-4 4 2 2 2 2"/><circle cx="12" cy="16" r="1.4"/>',
  wand: '<path d="M3 15l8-8"/><path d="M12.5 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  move: '<path d="M9 2v14M2 9h14M9 2l-2 2M9 2l2 2M9 16l-2-2M9 16l2-2M2 9l2-2M2 9l2 2M16 9l-2-2M16 9l-2 2"/>',
  moveSel: '<rect x="3.5" y="3.5" width="11" height="11" stroke-dasharray="2 2"/><path d="M9 6v6M6 9h6"/>',
  pencil: '<path d="M3 15l1-3.5L12 3.5l2.5 2.5L6.5 14 3 15z"/><path d="M11 4.5L13.5 7"/>',
  brush: '<path d="M14.5 2.5c-1 0-6 4-7.5 6.5 0 0 1 .5 1.5 1s1 1.5 1 1.5C12 10 16 5 16 4c0-.8-.7-1.5-1.5-1.5z"/><path d="M6.5 10.5c-1.5.5-2 2-2 3.5-1 .5-2 .5-2 .5s1-1 1-2 .5-2 3-2z"/>',
  eraser: '<path d="M7 15h8"/><path d="M3.5 11.5l5-5 5 5-3 3H6.5z"/>',
  bucket: '<path d="M8 2.5l6 6-5.5 5.5a1.5 1.5 0 01-2 0L3 10.5a1.5 1.5 0 010-2z"/><path d="M6 4.5L4.5 3"/><path d="M15 11c1 1.5 1.5 2.2 1.5 3a1.5 1.5 0 01-3 0c0-.8.5-1.5 1.5-3z"/>',
  gradient: '<rect x="2.5" y="3.5" width="13" height="11"/><defs><linearGradient id="gi" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".85"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="2.5" y="3.5" width="13" height="11" fill="url(#gi)" stroke="none"/>',
  picker: '<path d="M12.5 2.5a2 2 0 013 3L9 12l-3.5.5L6 9z"/><path d="M4 14l2-2"/>',
  clone: '<path d="M6 7.5V5a2 2 0 014 0v2.5"/><rect x="3.5" y="7.5" width="9" height="7"/><path d="M12 3.5h3v3"/>',
  recolor: '<circle cx="7" cy="7" r="4.5"/><circle cx="11" cy="11" r="4.5"/>',
  text: '<path d="M3.5 4.5V3h11v1.5M9 3v12M6.5 15h5"/>',
  line: '<path d="M3 15L15 3"/><circle cx="3" cy="15" r="1.5"/><circle cx="15" cy="3" r="1.5"/>',
  rectShape: '<rect x="2.5" y="4.5" width="13" height="9"/>',
  ellipseShape: '<ellipse cx="9" cy="9" rx="6.5" ry="5"/>',
  polygon: '<path d="M9 2.5l6 4.5-2.3 7H5.3L3 7z"/>',
  pan: '<path d="M9 15c-3 0-5-2-5-4.5V7a1 1 0 012 0v2V4a1 1 0 012 0v4V3a1 1 0 012 0v5V5a1 1 0 012 0v5.5C14 13 12 15 9 15z"/>',
  zoom: '<circle cx="8" cy="8" r="5"/><path d="M11.5 11.5L16 16M6 8h4M8 6v4"/>'
};

export function iconSvg(paths) {
  return `<svg viewBox="0 0 18 18" aria-hidden="true">${paths}</svg>`;
}
