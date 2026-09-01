// Navigation tools. Panning and zooming are also available from any tool via
// the space bar and ⌘-scroll, so these are mostly for explicit use.

import { Tool, ICONS } from './base.js';
import { rectFromPoints } from '../util.js';

export class PanTool extends Tool {
  static id = 'pan';
  static hint = 'Drag to move around the canvas. Space pans from any tool.';
  static label = 'Pan';
  static shortcut = 'H';
  static icon = ICONS.pan;
  static cursor = 'grab';

  onDown(_pt, e) {
    this.dragging = true;
    this.origin = { x: e.clientX, y: e.clientY };
    this.app.viewport.style.cursor = 'grabbing';
  }

  onMove(_pt, e) {
    if (!this.dragging) return;
    this.app.view.panBy(e.clientX - this.origin.x, e.clientY - this.origin.y);
    this.origin = { x: e.clientX, y: e.clientY };
  }

  onUp() {
    this.dragging = false;
    this.app.viewport.style.cursor = 'grab';
  }
}

export class ZoomTool extends Tool {
  static id = 'zoom';
  static hint = 'Click to zoom in, ⌥-click to zoom out, drag to zoom to a region.';
  static label = 'Zoom';
  static shortcut = 'Z';
  static icon = ICONS.zoom;
  static cursor = 'zoom-in';

  onDown(pt, e) {
    this.start = { x: pt.x, y: pt.y };
    this.current = { x: pt.x, y: pt.y };
    this.screenStart = { x: e.offsetX, y: e.offsetY };
    this.dragging = true;
    this.zoomOut = e.altKey || e.button === 2;
  }

  onMove(pt) {
    if (!this.dragging) return;
    this.current = { x: pt.x, y: pt.y };
    this.app.view.render();
  }

  onUp(_pt, e) {
    if (!this.dragging) return;
    this.dragging = false;
    const r = rectFromPoints(this.start.x, this.start.y, this.current.x, this.current.y);
    const view = this.app.view;
    if (r.w > 4 && r.h > 4) {
      // Drag: zoom so the marqueed region fills the viewport.
      const z = Math.min(view.viewWidth / r.w, view.viewHeight / r.h);
      view.setZoom(z);
      view.offsetX = view.viewWidth / 2 - (r.x + r.w / 2) * view.zoom;
      view.offsetY = view.viewHeight / 2 - (r.y + r.h / 2) * view.zoom;
      view.clampPan();
      view.render();
      this.app.emit('view-changed');
    } else {
      const anchor = { x: e.offsetX, y: e.offsetY };
      this.zoomOut ? view.zoomOut(anchor) : view.zoomIn(anchor);
    }
  }

  drawOverlay(g, view) {
    if (!this.dragging) return;
    const r = rectFromPoints(this.start.x, this.start.y, this.current.x, this.current.y);
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    g.strokeStyle = '#4b9bff';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    g.setLineDash([]);
  }
}

export const NAV_TOOLS = [PanTool, ZoomTool];
