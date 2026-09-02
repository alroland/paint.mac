// Application shell: owns the document, selection, history, view and tools,
// and routes all pointer/keyboard input to the active tool.

import { Emitter, makeCanvas, unionRect, clamp } from './util.js';
import { PaintDocument, Layer } from './document.js';
import { Selection, COMBINE } from './selection.js';
import { History, captureDocState, docStateEdit } from './history.js';
import { View, Rulers } from './view.js';
import { ALL_TOOLS, toolByShortcut } from './tools/index.js';
import { extractSelection, eraseSelection } from './tools/select.js';
import { rgba } from './color.js';

export class App extends Emitter {
  constructor() {
    super();
    this.viewport = document.getElementById('viewport');
    this.overlayHost = document.getElementById('overlay-host');

    this.doc = PaintDocument.blank(1200, 800);
    this.selection = new Selection(this.doc.width, this.doc.height);
    this.history = new History();

    this.view = new View(this, document.getElementById('view'), this.viewport);
    this.rulers = new Rulers(this.view, document.getElementById('ruler-h'), document.getElementById('ruler-v'));

    this.primaryColor = rgba(0, 0, 0, 1);
    this.secondaryColor = rgba(255, 255, 255, 1);
    this.activeSwatch = 'primary';

    this.tools = new Map(ALL_TOOLS.map((T) => [T.id, new T(this)]));
    this.activeToolId = null;
    this.previousToolId = null;

    this.floating = null;
    this.lastEffect = null;
    this._spacePan = null;
    this._overlayInUse = false;

    this.overlayCanvas = makeCanvas(this.doc.width, this.doc.height);
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this._bindDocument();
    this._bindPointer();
    this._bindKeyboard();
    this._bindWheel();

    this.setTool('brush');
    this.on('view-changed', () => this.rulers.draw());
  }

  get activeTool() { return this.tools.get(this.activeToolId) || null; }

  /* ---------- document lifecycle ---------- */

  setDocument(doc, { path = null, name = null } = {}) {
    this.commitFloating();
    this.doc = doc;
    this.selection = new Selection(doc.width, doc.height);
    this.history.clear();
    this.doc.filePath = path;
    this.doc.fileName = name || doc.fileName || 'Untitled';
    this.doc.markDirty(false);
    this.overlayCanvas = makeCanvas(doc.width, doc.height);
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this._bindDocument();
    this.emit('document-changed', doc);
    this.view.fitToWindow();
    this.updateTitle();
    this.updateStatus();
    window.api.setRepresentedFile(path || '');
  }

  _bindDocument() {
    this.doc.on('pixels-changed', () => { this.doc.markDirty(true); this.view.render(); });
    this.doc.on('layers-changed', () => { this.doc.markDirty(true); this.view.render(); });
    this.doc.on('size-changed', () => {
      this.overlayCanvas = makeCanvas(this.doc.width, this.doc.height);
      this.overlayCtx = this.overlayCanvas.getContext('2d');
      this.view.clampPan();
      this.updateStatus();
    });
    this.doc.on('selection-changed', () => { this.updateStatus(); this.view.render(); });
    this.doc.on('dirty-changed', () => this.updateTitle());
  }

  pushHistory(entry) {
    if (!entry) return;
    this.history.push(entry);
    this.doc.markDirty(!this.history.isAtSavedPoint);
  }

  undo() {
    this.commitFloating();
    const e = this.history.undo();
    if (e) this.setStatus(`Undo: ${e.label}`);
    this.doc.markDirty(!this.history.isAtSavedPoint);
    this.view.render();
  }

  redo() {
    this.commitFloating();
    const e = this.history.redo();
    if (e) this.setStatus(`Redo: ${e.label}`);
    this.doc.markDirty(!this.history.isAtSavedPoint);
    this.view.render();
  }

  /* ---------- tools ---------- */

  setTool(id, { remember = true } = {}) {
    const tool = this.tools.get(id);
    if (!tool || id === this.activeToolId) return;
    if (this.activeTool) {
      if (remember) this.previousToolId = this.activeToolId;
      this.activeTool.deactivate();
    }
    this.activeToolId = id;
    tool.activate();
    this.viewport.style.cursor = tool.cursor;
    document.getElementById('status-tool').textContent = tool.constructor.label;
    this.emit('tool-changed', id);
    this.view.render();
  }

  /* ---------- colours ---------- */

  setPrimaryColor(c) { this.primaryColor = { a: 1, ...c }; this.emit('color-changed'); this.activeTool?.refresh?.(); }
  setSecondaryColor(c) { this.secondaryColor = { a: 1, ...c }; this.emit('color-changed'); this.activeTool?.refresh?.(); }
  swapColors() {
    const t = this.primaryColor;
    this.primaryColor = this.secondaryColor;
    this.secondaryColor = t;
    this.emit('color-changed');
  }

  /* ---------- transient overlay buffer ---------- */

  beginOverlay(aboveIndex, { alpha = 1, op = 'source-over' } = {}) {
    this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.overlayCtx.globalCompositeOperation = 'source-over';
    this.overlayCtx.globalAlpha = 1;
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.doc.overlay = { canvas: this.overlayCanvas, x: 0, y: 0, alpha, op, aboveIndex };
    this._overlayInUse = true;
    return { canvas: this.overlayCanvas, ctx: this.overlayCtx };
  }

  endOverlay() {
    if (!this._overlayInUse) return;
    this.doc.overlay = null;
    this._overlayInUse = false;
  }

  /* ---------- floating (moved) selection ---------- */

  /** Lifts the selected pixels off the active layer so they can be dragged. */
  liftFloating() {
    if (this.floating) return;
    const layer = this.doc.activeLayer;
    if (!layer) return;
    const ext = extractSelection(this.doc, this.selection, layer);
    if (!ext) return;

    this._floatBefore = captureDocState(this.doc, this.selection);
    eraseSelection(this.doc, this.selection, layer);
    this.floating = {
      // `source` stays pristine: every resize re-samples from it, so scaling
      // down and back up again does not accumulate blur.
      source: ext.canvas,
      canvas: ext.canvas,
      x: ext.rect.x, y: ext.rect.y,
      w: ext.rect.w, h: ext.rect.h,
      startX: ext.rect.x, startY: ext.rect.y,
      layer
    };
    this.doc.overlay = {
      canvas: ext.canvas, x: ext.rect.x, y: ext.rect.y,
      alpha: 1, op: 'source-over', aboveIndex: this.doc.activeIndex
    };
    this.doc.invalidate(ext.rect);
    this.view.render();
  }

  /**
   * Drops an image in as a floating selection: marquee around it, and
   * immediately draggable with the move tool. Committing happens when the user
   * does anything else, exactly as it does after moving selected pixels.
   */
  pasteFloating(canvas, x, y) {
    this.commitFloating();
    const layer = this.doc.activeLayer;
    if (!layer) return null;

    const px = Math.round(x), py = Math.round(y);
    this._floatBefore = captureDocState(this.doc, this.selection);

    const marquee = new Path2D();
    marquee.rect(px, py, canvas.width, canvas.height);
    this.selection.setFromPath(marquee, COMBINE.REPLACE);

    this.floating = {
      source: canvas, canvas,
      x: px, y: py, w: canvas.width, h: canvas.height,
      startX: px, startY: py, layer,
      // Pasted pixels are new, so they must be recorded even if never dragged.
      label: 'Paste', commitAlways: true
    };
    this.doc.overlay = {
      canvas, x: px, y: py, alpha: 1, op: 'source-over', aboveIndex: this.doc.activeIndex
    };
    this.doc.invalidate({ x: px, y: py, w: canvas.width, h: canvas.height });
    this.doc.emit('selection-changed');
    this.view.render();
    return { x: px, y: py, w: canvas.width, h: canvas.height };
  }

  moveFloating(x, y) {
    const f = this.floating;
    if (!f) return;
    const nx = Math.round(x), ny = Math.round(y);
    const dx = nx - f.x, dy = ny - f.y;
    if (dx === 0 && dy === 0) return;

    const prev = { x: f.x, y: f.y, w: f.w, h: f.h };
    f.x = nx;
    f.y = ny;
    this.doc.overlay.x = nx;
    this.doc.overlay.y = ny;

    // The marquee travels with the pixels. Leaving it behind until the drop
    // makes it look as though the drag has come loose from the selection.
    if (this.selection.active) {
      this.selection.translate(dx, dy);
      this.doc.emit('selection-changed');
    }

    this.doc.invalidate(unionRect(prev, { x: nx, y: ny, w: f.w, h: f.h }));
    this.view.render();
  }

  /**
   * Scales the floating pixels to a new rectangle, marquee included. Always
   * re-samples from the untouched source rather than from the last scaled
   * result, so dragging a handle back and forth costs nothing in quality.
   */
  resizeFloating(rect) {
    const f = this.floating;
    if (!f) return;
    const w = Math.max(1, Math.round(rect.w));
    const h = Math.max(1, Math.round(rect.h));
    const x = Math.round(rect.x), y = Math.round(rect.y);
    if (x === f.x && y === f.y && w === f.w && h === f.h) return;

    const prev = { x: f.x, y: f.y, w: f.w, h: f.h };
    const scaled = makeCanvas(w, h);
    const g = scaled.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(f.source, 0, 0, f.source.width, f.source.height, 0, 0, w, h);

    f.canvas = scaled;
    f.x = x; f.y = y; f.w = w; f.h = h;
    f.transformed = true;

    this.doc.overlay.canvas = scaled;
    this.doc.overlay.x = x;
    this.doc.overlay.y = y;

    this.selection.setRect(x, y, w, h);
    this.doc.emit('selection-changed');
    this.doc.invalidate(unionRect(prev, { x, y, w, h }));
    this.view.render();
  }

  commitFloating() {
    const f = this.floating;
    if (!f) return;
    this.floating = null;
    this.doc.overlay = null;

    const dx = f.x - f.startX, dy = f.y - f.startY;
    f.layer.ctx.drawImage(f.canvas, f.x, f.y);
    f.layer.touch();
    // The selection already followed the pixels during the drag.
    this.doc.invalidateAll();
    this.doc.emit('selection-changed');

    if (dx || dy || f.transformed || f.commitAlways) {
      const label = f.label || (f.transformed ? 'Resize Selected Pixels' : 'Move Selected Pixels');
      this.pushHistory(docStateEdit(this.doc, this.selection, this._floatBefore, label));
    } else if (this._floatBefore) {
      // Lifted then dropped in place: nothing changed, so drop the snapshot.
      this._floatBefore = null;
    }
    this._floatBefore = null;
    this.view.render();
  }

  /* ---------- input ---------- */

  _docPoint(e) {
    const r = this.viewport.getBoundingClientRect();
    return this.view.toDoc(e.clientX - r.left, e.clientY - r.top);
  }

  _localEvent(e) {
    const r = this.viewport.getBoundingClientRect();
    // Tools that need screen coordinates expect them relative to the viewport,
    // so hand them a plain snapshot rather than the raw DOM event.
    return {
      offsetX: e.clientX - r.left,
      offsetY: e.clientY - r.top,
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      pointerType: e.pointerType,
      pressure: e.pressure
    };
  }

  _bindPointer() {
    const vp = this.viewport;
    let active = false;

    vp.addEventListener('contextmenu', (e) => e.preventDefault());

    vp.addEventListener('pointerdown', (e) => {
      if (document.querySelector('.modal-backdrop')) return;
      vp.setPointerCapture(e.pointerId);
      const pt = this._docPoint(e);

      // Space bar or middle mouse pans from any tool.
      if (this._spaceDown || e.button === 1) {
        this._spacePan = { x: e.clientX, y: e.clientY };
        vp.style.cursor = 'grabbing';
        return;
      }
      active = true;
      this.activeTool?.onDown(pt, this._localEvent(e));
    });

    vp.addEventListener('pointermove', (e) => {
      const pt = this._docPoint(e);
      this.rulers.mouse = pt;
      this.rulers.draw();
      this.updatePositionStatus(pt);

      if (this._spacePan) {
        this.view.panBy(e.clientX - this._spacePan.x, e.clientY - this._spacePan.y);
        this._spacePan = { x: e.clientX, y: e.clientY };
        return;
      }
      if (!active) {
        this.activeTool?.onHover?.(pt, this._localEvent(e));
        return;
      }
      this.activeTool?.onMove(pt, this._localEvent(e));
    });

    const finish = (e) => {
      if (this._spacePan) {
        this._spacePan = null;
        vp.style.cursor = this._spaceDown ? 'grab' : (this.activeTool?.cursor || 'crosshair');
        return;
      }
      if (!active) return;
      active = false;
      this.activeTool?.onUp(this._docPoint(e), this._localEvent(e));
    };

    vp.addEventListener('pointerup', finish);
    vp.addEventListener('pointercancel', finish);
    vp.addEventListener('dblclick', (e) => this.activeTool?.onDoubleClick(this._docPoint(e), this._localEvent(e)));
    vp.addEventListener('pointerleave', () => {
      this.rulers.mouse = null;
      this.rulers.draw();
      document.getElementById('status-pos').textContent = '—';
    });
  }

  _bindWheel() {
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.viewport.getBoundingClientRect();
      const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      // Trackpad pinch arrives as ctrlKey+wheel in Chromium.
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        this.view.setZoom(this.view.zoom * factor, anchor);
      } else if (e.shiftKey) {
        this.view.panBy(-e.deltaY, 0);
      } else {
        this.view.panBy(-e.deltaX, -e.deltaY);
      }
    }, { passive: false });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target) || document.querySelector('.modal-backdrop')) return;

      if (e.code === 'Space' && !this._spaceDown) {
        this._spaceDown = true;
        this.viewport.style.cursor = 'grab';
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Abort whatever is in progress first; only a "quiet" Escape deselects,
        // so cancelling a shape drag never also drops the selection.
        if (this.activeTool?.busy) {
          this.activeTool.cancel();
          this.view.render();
          return;
        }
        if (this.selection.active || this.floating) {
          this.run?.('select.none');   // undoable, and drops any floating pixels in place
          return;
        }
        this.activeTool?.cancel();
        this.view.render();
        return;
      }
      if (this.activeTool?.onKeyDown(e)) { e.preventDefault(); return; }

      // Forward delete (fn+Delete) erases too; the main Delete key reaches us
      // as the Backspace menu accelerator.
      if (e.key === 'Delete') {
        this.run?.('edit.eraseSelection');
        e.preventDefault();
        return;
      }

      if (e.metaKey || e.ctrlKey) return; // menu accelerators own these

      // Bracket keys nudge brush-like sizes, the way most editors do.
      if (e.key === '[' || e.key === ']') {
        const tool = this.activeTool;
        if (tool && 'size' in (tool.options || {})) {
          const delta = e.key === ']' ? 1 : -1;
          const step = tool.options.size < 10 ? 1 : tool.options.size < 50 ? 5 : 20;
          tool.options.size = clamp(tool.options.size + delta * step, 1, 500);
          this.emit('tool-options-changed');
          this.setStatus(`Size ${tool.options.size}px`);
        }
        e.preventDefault();
        return;
      }
      if (e.key.toUpperCase() === 'X' && !e.shiftKey) {
        this.swapColors();
        e.preventDefault();
        return;
      }
      const T = toolByShortcut(e.key);
      if (T) {
        this.setTool(T.id);
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this._spaceDown = false;
        if (!this._spacePan) this.viewport.style.cursor = this.activeTool?.cursor || 'crosshair';
      }
    });

    window.addEventListener('blur', () => { this._spaceDown = false; });
  }

  /* ---------- chrome ---------- */

  updateTitle() {
    const name = this.doc.fileName || 'Untitled';
    const dims = `${this.doc.width} × ${this.doc.height}`;
    document.getElementById('tb-title').textContent = `${this.doc.dirty ? '• ' : ''}${name} — ${dims}`;
    window.api.setTitle(name, this.doc.dirty);
  }

  updatePositionStatus(pt) {
    document.getElementById('status-pos').textContent = `${Math.floor(pt.x)}, ${Math.floor(pt.y)}`;
  }

  updateStatus() {
    document.getElementById('status-size').textContent = `${this.doc.width} × ${this.doc.height}`;
    const sel = this.selection;
    const el = document.getElementById('status-sel');
    if (!sel.active) el.textContent = 'No selection';
    else if (!sel.bounds) el.textContent = 'Empty selection';
    else el.textContent = `Selection ${sel.bounds.w} × ${sel.bounds.h} at ${sel.bounds.x}, ${sel.bounds.y}`;
    this.updateTitle();
  }

  setStatus(msg) {
    const el = document.getElementById('status-msg');
    el.textContent = msg || '';
    clearTimeout(this._statusTimer);
    if (msg) this._statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  /* ---------- layer helpers used by commands ---------- */

  addLayer(name) {
    const before = captureDocState(this.doc, this.selection);
    const layer = new Layer(this.doc.width, this.doc.height, name || `Layer ${this.doc.layers.length + 1}`);
    this.doc.addLayer(layer);
    this.pushHistory(docStateEdit(this.doc, this.selection, before, 'Add Layer'));
    return layer;
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
