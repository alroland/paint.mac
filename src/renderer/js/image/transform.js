// Whole-document and whole-layer geometry: crop, resize, rotate, flip, flatten.
// These all go through a document-state snapshot for undo, which is the right
// trade-off: they're infrequent and touch everything.

import { makeCanvas, normalizeRect, clamp } from '../util.js';
import { Layer } from '../document.js';
import { captureDocState, docStateEdit } from '../history.js';

/** Wraps a structural mutation so undo/redo and repaint are handled once. */
function structural(app, label, mutate) {
  const before = captureDocState(app.doc, app.selection);
  const changed = mutate();
  if (changed === false) return false;
  app.doc.invalidateAll();
  app.doc.emit('layers-changed');
  app.doc.emit('selection-changed');
  app.pushHistory(docStateEdit(app.doc, app.selection, before, label));
  return true;
}

function drawScaled(srcCanvas, w, h, smooth = true) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, w, h);
  return c;
}

export function resizeImage(app, width, height, { smooth = true } = {}) {
  const w = clamp(Math.round(width), 1, 20000);
  const h = clamp(Math.round(height), 1, 20000);
  const doc = app.doc;
  if (w === doc.width && h === doc.height) return false;
  return structural(app, 'Resize Image', () => {
    for (const layer of doc.layers) layer.replaceCanvas(drawScaled(layer.canvas, w, h, smooth));
    doc.setSize(w, h);
    app.selection.resize(w, h);
  });
}

const ANCHORS = {
  'top-left': [0, 0], 'top': [0.5, 0], 'top-right': [1, 0],
  'left': [0, 0.5], 'center': [0.5, 0.5], 'right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom': [0.5, 1], 'bottom-right': [1, 1]
};

export function resizeCanvas(app, width, height, anchor = 'center') {
  const w = clamp(Math.round(width), 1, 20000);
  const h = clamp(Math.round(height), 1, 20000);
  const doc = app.doc;
  if (w === doc.width && h === doc.height) return false;
  const [ax, ay] = ANCHORS[anchor] || ANCHORS.center;
  const dx = Math.round((w - doc.width) * ax);
  const dy = Math.round((h - doc.height) * ay);
  return structural(app, 'Canvas Size', () => {
    for (const layer of doc.layers) {
      const c = makeCanvas(w, h);
      c.getContext('2d').drawImage(layer.canvas, dx, dy);
      layer.replaceCanvas(c);
    }
    doc.setSize(w, h);
    app.selection.resize(w, h);
  });
}

/** Crops to the selection's bounding box and clears anything outside the mask. */
export function cropToSelection(app) {
  const sel = app.selection;
  const doc = app.doc;
  if (!sel.active || !sel.bounds) return false;
  const r = normalizeRect(sel.bounds, doc.width, doc.height);
  if (!r) return false;
  const maskCanvas = sel.maskCanvas();
  return structural(app, 'Crop to Selection', () => {
    for (const layer of doc.layers) {
      const c = makeCanvas(r.w, r.h);
      const g = c.getContext('2d');
      g.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      if (maskCanvas) {
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(maskCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      }
      layer.replaceCanvas(c);
    }
    doc.setSize(r.w, r.h);
    sel.resize(r.w, r.h);
  });
}

/** Shrinks the canvas to the bounding box of non-transparent pixels. */
export function trimTransparent(app) {
  const doc = app.doc;
  const flat = doc.flatten();
  const data = flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
  let minX = doc.width, minY = doc.height, maxX = -1, maxY = -1;
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      if (data[(y * doc.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false;
  const r = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  if (r.w === doc.width && r.h === doc.height) return false;
  return structural(app, 'Trim Transparent Edges', () => {
    for (const layer of doc.layers) {
      const c = makeCanvas(r.w, r.h);
      c.getContext('2d').drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      layer.replaceCanvas(c);
    }
    doc.setSize(r.w, r.h);
    app.selection.resize(r.w, r.h);
  });
}

function flipCanvas(src, horizontal) {
  const c = makeCanvas(src.width, src.height);
  const g = c.getContext('2d');
  g.translate(horizontal ? src.width : 0, horizontal ? 0 : src.height);
  g.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
  g.drawImage(src, 0, 0);
  return c;
}

export function flipImage(app, horizontal) {
  return structural(app, horizontal ? 'Flip Horizontal' : 'Flip Vertical', () => {
    for (const layer of app.doc.layers) layer.replaceCanvas(flipCanvas(layer.canvas, horizontal));
    app.selection.clear();
  });
}

export function flipLayer(app, horizontal) {
  const layer = app.doc.activeLayer;
  if (!layer) return false;
  return structural(app, horizontal ? 'Flip Layer Horizontal' : 'Flip Layer Vertical', () => {
    layer.replaceCanvas(flipCanvas(layer.canvas, horizontal));
  });
}

/** quarters: 1 = 90° CW, 2 = 180°, 3 = 90° CCW. */
export function rotateImage(app, quarters) {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return false;
  const doc = app.doc;
  const swap = q % 2 === 1;
  const nw = swap ? doc.height : doc.width;
  const nh = swap ? doc.width : doc.height;
  const label = q === 1 ? 'Rotate 90° Clockwise' : q === 2 ? 'Rotate 180°' : 'Rotate 90° Counter-clockwise';
  return structural(app, label, () => {
    for (const layer of doc.layers) {
      const c = makeCanvas(nw, nh);
      const g = c.getContext('2d');
      g.translate(nw / 2, nh / 2);
      g.rotate((q * Math.PI) / 2);
      g.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
      layer.replaceCanvas(c);
    }
    doc.setSize(nw, nh);
    app.selection.resize(nw, nh);
  });
}

export function rotateImageArbitrary(app, degrees, { expand = true, smooth = true } = {}) {
  const doc = app.doc;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const nw = expand ? Math.ceil(doc.width * cos + doc.height * sin) : doc.width;
  const nh = expand ? Math.ceil(doc.width * sin + doc.height * cos) : doc.height;
  return structural(app, `Rotate ${degrees}°`, () => {
    for (const layer of doc.layers) {
      const c = makeCanvas(nw, nh);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = smooth;
      g.imageSmoothingQuality = 'high';
      g.translate(nw / 2, nh / 2);
      g.rotate(rad);
      g.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
      layer.replaceCanvas(c);
    }
    if (nw !== doc.width || nh !== doc.height) {
      doc.setSize(nw, nh);
      app.selection.resize(nw, nh);
    }
  });
}

/** Paint.NET's Rotate/Zoom: an in-place affine transform of one layer. */
export function rotateZoomLayer(app, { angle = 0, zoom = 1, panX = 0, panY = 0, smooth = true } = {}) {
  const layer = app.doc.activeLayer;
  if (!layer) return false;
  return structural(app, 'Rotate / Zoom Layer', () => {
    const { width: w, height: h } = layer;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = smooth;
    g.imageSmoothingQuality = 'high';
    g.translate(w / 2 + panX, h / 2 + panY);
    g.rotate((angle * Math.PI) / 180);
    g.scale(zoom, zoom);
    g.drawImage(layer.canvas, -w / 2, -h / 2);
    layer.replaceCanvas(c);
  });
}

export function flattenImage(app) {
  const doc = app.doc;
  if (doc.layers.length <= 1) return false;
  return structural(app, 'Flatten', () => {
    const flat = doc.flatten();
    const l = new Layer(doc.width, doc.height, 'Background');
    l.ctx.drawImage(flat, 0, 0);
    doc.layers = [l];
    doc.activeIndex = 0;
  });
}

export function mergeLayerDown(app) {
  const doc = app.doc;
  const i = doc.activeIndex;
  if (i <= 0) return false;
  return structural(app, 'Merge Layer Down', () => {
    const upper = doc.layers[i];
    const lower = doc.layers[i - 1];
    const g = lower.ctx;
    g.save();
    g.globalAlpha = upper.opacity;
    g.globalCompositeOperation = upper.blendMode;
    g.drawImage(upper.canvas, 0, 0);
    g.restore();
    lower.touch();
    doc.layers.splice(i, 1);
    doc.activeIndex = i - 1;
  });
}

export { structural };
