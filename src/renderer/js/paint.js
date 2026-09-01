// Drawing primitives shared by every tool.
//
// Two ideas carry most of the weight here:
//   * paintOp() routes drawing through a small scratch canvas when a selection
//     exists, so a mask clip costs work proportional to the dab, not the page.
//   * StrokeRecorder snapshots only the 128x128 tiles a stroke actually touches,
//     which keeps undo cheap even for long strokes on large documents.

import { makeCanvas, normalizeRect, unionRect, inflateRect, clamp } from './util.js';
import { toCss } from './color.js';
import { replaceRegion } from './history.js';
import { scanlineFill, featherMask } from './selection.js';

/* ---------- scratch canvas pool ---------- */

let scratch = makeCanvas(256, 256);
let scratchCtx = scratch.getContext('2d');

function getScratch(w, h) {
  if (scratch.width < w || scratch.height < h) {
    scratch = makeCanvas(Math.max(w, scratch.width), Math.max(h, scratch.height));
    scratchCtx = scratch.getContext('2d');
  }
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.globalCompositeOperation = 'source-over';
  scratchCtx.globalAlpha = 1;
  scratchCtx.filter = 'none';
  scratchCtx.clearRect(0, 0, w, h);
  return { canvas: scratch, ctx: scratchCtx };
}

/**
 * Runs `drawFn(ctx)` against `layer`, honouring the active selection mask.
 * `bbox` is the document-space bounding box the drawing can touch.
 * Returns the clipped dirty rect, or null when nothing could be drawn.
 */
export function paintOp(app, layer, bbox, drawFn, { compositeOp = 'source-over', alpha = 1 } = {}) {
  const doc = app.doc;
  const sel = app.selection;
  let clip = normalizeRect(bbox, doc.width, doc.height);
  if (sel.active) clip = normalizeRect(intersect(clip, sel.bounds), doc.width, doc.height);
  if (!clip) return null;

  if (!sel.active) {
    const ctx = layer.ctx;
    ctx.save();
    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = alpha;
    drawFn(ctx);
    ctx.restore();
  } else {
    const { canvas: sc, ctx: sctx } = getScratch(clip.w, clip.h);
    sctx.save();
    sctx.translate(-clip.x, -clip.y);
    sctx.globalAlpha = alpha;
    drawFn(sctx);
    sctx.restore();

    // Knock out everything outside the selection, then composite in one go.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(sel.maskCanvas(), clip.x, clip.y, clip.w, clip.h, 0, 0, clip.w, clip.h);
    sctx.globalCompositeOperation = 'source-over';

    const ctx = layer.ctx;
    ctx.save();
    ctx.globalCompositeOperation = compositeOp;
    ctx.drawImage(sc, 0, 0, clip.w, clip.h, clip.x, clip.y, clip.w, clip.h);
    ctx.restore();
  }

  layer.touch();
  doc.invalidate(clip);
  return clip;
}

function intersect(a, b) {
  if (!a) return null;
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

/* ---------- stroke recording ---------- */

const TILE = 128;

/** GPU-side copy of one tile; avoids a getImageData readback per stroke tile. */
function copyTile(srcCanvas, r) {
  const c = makeCanvas(r.w, r.h);
  c.getContext('2d').drawImage(srcCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

export class StrokeRecorder {
  constructor(doc, layer) {
    this.doc = doc;
    this.layer = layer;
    this.before = new Map();  // "tx,ty" -> ImageData captured before any edit
    this.dirty = null;
    this.bytes = 0;
  }

  /** Call with the rect about to be modified, *before* modifying it. */
  touch(r) {
    if (!r) return;
    const rc = normalizeRect(r, this.doc.width, this.doc.height);
    if (!rc) return;
    this.dirty = unionRect(this.dirty, rc);
    const tx0 = Math.floor(rc.x / TILE), ty0 = Math.floor(rc.y / TILE);
    const tx1 = Math.floor((rc.x + rc.w - 1) / TILE), ty1 = Math.floor((rc.y + rc.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        if (this.before.has(key)) continue;
        const t = this._tileRect(tx, ty);
        if (!t) continue;
        this.before.set(key, { rect: t, canvas: copyTile(this.layer.canvas, t) });
        this.bytes += t.w * t.h * 4;
      }
    }
  }

  _tileRect(tx, ty) {
    const x = tx * TILE, y = ty * TILE;
    const w = Math.min(TILE, this.doc.width - x);
    const h = Math.min(TILE, this.doc.height - y);
    if (w <= 0 || h <= 0 || x < 0 || y < 0) return null;
    return { x, y, w, h };
  }

  /** Produces a history entry, or null if the stroke changed nothing. */
  finish(label) {
    if (!this.dirty || this.before.size === 0) return null;
    const layer = this.layer, doc = this.doc;
    const layerId = layer.id;
    const beforeTiles = [...this.before.values()];
    const afterTiles = beforeTiles.map((t) => ({ rect: t.rect, canvas: copyTile(layer.canvas, t.rect) }));
    const dirty = this.dirty;
    const apply = (tiles) => {
      // Resolved by id: a structural undo in between rebuilds the layer stack.
      const target = doc.layers.find((l) => l.id === layerId);
      if (!target) return;
      for (const t of tiles) replaceRegion(target, t.rect, t.canvas);
      doc.invalidate(dirty);
    };
    return { label, bytes: this.bytes * 2, undo: () => apply(beforeTiles), redo: () => apply(afterTiles) };
  }
}

/* ---------- flood fill (paint bucket) ---------- */

/**
 * Scanline flood fill directly into a layer's pixels. Honours the selection by
 * refusing to cross out of it, which matches how Paint.NET constrains the tool.
 */
export function floodFill(app, layer, sx, sy, color, {
  tolerance = 30, global = false, sampleMerged = false, contiguous = true, alphaBlend = true, feather = 0
} = {}) {
  const doc = app.doc;
  const w = doc.width, h = doc.height;
  sx = clamp(Math.floor(sx), 0, w - 1);
  sy = clamp(Math.floor(sy), 0, h - 1);

  const sampleSrc = sampleMerged ? doc.flatten() : layer.canvas;
  const sctx = sampleSrc.getContext('2d', { willReadFrequently: true });
  const sample = sctx.getImageData(0, 0, w, h).data;

  const si = (sy * w + sx) * 4;
  const sr = sample[si], sg = sample[si + 1], sb = sample[si + 2], sa = sample[si + 3];
  const tol = (tolerance / 100) * 255;
  const tolSq = tol * tol * 4;
  const sel = app.selection;

  const matches = (i) => {
    const dr = sample[i] - sr, dg = sample[i + 1] - sg, db = sample[i + 2] - sb, da = sample[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= tolSq;
  };

  const hit = new Uint8Array(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const mark = (x, y) => {
    hit[y * w + x] = 255;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  if (global || !contiguous) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (matches((y * w + x) * 4) && sel.coverageAt(x, y) > 0) mark(x, y);
      }
    }
  } else {
    if (sel.coverageAt(sx, sy) === 0) return null;
    scanlineFill(
      w, h, sx, sy,
      (x, y) => x >= 0 && y >= 0 && x < w && y < h &&
        hit[y * w + x] === 0 && matches((y * w + x) * 4) && sel.coverageAt(x, y) > 0,
      mark
    );
  }

  if (maxX < 0) return null;
  let rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  // Feathering softens the edge of the filled region. The blur runs on a crop
  // of the hit mask rather than the whole page, so the cost tracks the size of
  // the fill instead of the size of the document. The crop is grown by the
  // radius first, giving the blur room to spread outwards.
  let soft = null;
  if (feather > 0) {
    rect = normalizeRect(inflateRect(rect, Math.ceil(feather) + 1), w, h);
    const crop = new Uint8Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) {
      const from = (rect.y + y) * w + rect.x;
      crop.set(hit.subarray(from, from + rect.w), y * rect.w);
    }
    // The blur clamps at the crop edges, so a fill running off the canvas stays
    // solid there instead of fading against the document border.
    soft = featherMask(crop, rect.w, rect.h, feather);
  }

  // Build the fill as an RGBA patch, modulated by the hit mask (softened when
  // feathering) and by the selection's own coverage.
  const patch = makeCanvas(rect.w, rect.h);
  const pctx = patch.getContext('2d');
  const img = pctx.createImageData(rect.w, rect.h);
  const d = img.data;
  const cr = color.r, cg = color.g, cb = color.b, ca = color.a;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const local = y * rect.w + x;
      const amount = soft ? soft[local] : hit[(y + rect.y) * w + (x + rect.x)];
      if (!amount) continue;
      const cov = sel.coverageAt(x + rect.x, y + rect.y) / 255;
      const p = local * 4;
      d[p] = cr; d[p + 1] = cg; d[p + 2] = cb;
      d[p + 3] = Math.round(255 * ca * cov * (amount / 255));
    }
  }
  pctx.putImageData(img, 0, 0);

  const ctx = layer.ctx;
  ctx.save();
  if (!alphaBlend) ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(patch, rect.x, rect.y);
  ctx.restore();
  layer.touch();
  doc.invalidate(rect);
  return rect;
}

/* ---------- brush stamping ---------- */

/**
 * Builds a radial-gradient brush tip. Cached by (radius, hardness, colour) so a
 * stroke reuses one bitmap for every dab.
 */
const tipCache = new Map();

export function brushTip(radius, hardness, color) {
  const key = `${radius.toFixed(2)}|${hardness}|${color.r},${color.g},${color.b}`;
  const cached = tipCache.get(key);
  if (cached) return cached;

  const r = Math.max(0.5, radius);
  const size = Math.ceil(r * 2) + 2;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const cx = size / 2;

  if (hardness >= 0.999) {
    g.fillStyle = toCss({ ...color, a: 1 });
    g.beginPath();
    g.arc(cx, cx, r, 0, Math.PI * 2);
    g.fill();
  } else {
    const inner = Math.max(0, r * hardness);
    const grad = g.createRadialGradient(cx, cx, inner, cx, cx, r);
    const base = `${color.r},${color.g},${color.b}`;
    grad.addColorStop(0, `rgba(${base},1)`);
    // A couple of intermediate stops keep the falloff smooth rather than linear.
    grad.addColorStop(0.55, `rgba(${base},0.72)`);
    grad.addColorStop(0.85, `rgba(${base},0.25)`);
    grad.addColorStop(1, `rgba(${base},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }

  const tip = { canvas: c, size, radius: r };
  if (tipCache.size > 64) tipCache.clear();
  tipCache.set(key, tip);
  return tip;
}
