// Selections are 8-bit coverage masks over the whole document. That single
// representation covers rectangles, ellipses, lassos and magic-wand results
// alike, keeps anti-aliased edges, and makes boolean combining trivial.

import { makeCanvas, clamp } from './util.js';

/**
 * Above this many boundary runs the marching-ants path becomes too expensive to
 * stroke every frame, and we switch to a cached edge bitmap instead.
 */
const OUTLINE_RUN_CAP = 20000;

export const COMBINE = { REPLACE: 'replace', ADD: 'add', SUBTRACT: 'subtract', INTERSECT: 'intersect', XOR: 'xor' };

export class Selection {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.mask = null;            // Uint8Array | null — null means "everything"
    this.bounds = null;          // tight integer bounds of non-zero coverage
    this._maskCanvas = null;
    this._outline = undefined;   // undefined = not computed yet, null = none
  }

  get active() { return this.mask !== null; }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.clear();
  }

  clear() {
    this.mask = null;
    this.bounds = null;
    this._maskCanvas = null;
    this._outline = undefined;
  }

  /** The rect drawing should be limited to: the selection, or the whole page. */
  clipRect() {
    return this.bounds || { x: 0, y: 0, w: this.width, h: this.height };
  }

  coverageAt(x, y) {
    if (!this.mask) return 255;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[y * this.width + x];
  }

  contains(x, y) { return this.coverageAt(Math.floor(x), Math.floor(y)) >= 128; }

  selectAll() {
    this.clear();
  }

  invert() {
    const n = this.width * this.height;
    if (!this.mask) {
      // Inverting "everything" yields an empty selection, which we normalize
      // back to a zeroed mask so the user sees that nothing is selected.
      this.mask = new Uint8Array(n);
    } else {
      for (let i = 0; i < n; i++) this.mask[i] = 255 - this.mask[i];
    }
    this._afterMaskChange();
  }

  /**
   * Fast path for a rectangular selection. Rasterising a Path2D costs a
   * document-sized canvas plus a full getImageData readback, which is far too
   * much to do on every frame of a resize drag; filling the rows directly is
   * a few milliseconds even on a large page.
   */
  setRect(x, y, w, h) {
    const W = this.width, H = this.height;
    const x0 = clamp(Math.round(x), 0, W), y0 = clamp(Math.round(y), 0, H);
    const x1 = clamp(Math.round(x + w), 0, W), y1 = clamp(Math.round(y + h), 0, H);
    const mask = new Uint8Array(W * H);
    if (x1 > x0 && y1 > y0) {
      for (let row = y0; row < y1; row++) mask.fill(255, row * W + x0, row * W + x1);
    }
    this.mask = mask;
    this._afterMaskChange(x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null);
  }

  /** Rasterizes a Path2D (document coordinates) and combines it into the mask. */
  setFromPath(path, mode = COMBINE.REPLACE, evenOdd = false) {
    const c = makeCanvas(this.width, this.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fill(path, evenOdd ? 'evenodd' : 'nonzero');
    const data = g.getImageData(0, 0, this.width, this.height).data;
    const next = new Uint8Array(this.width * this.height);
    for (let i = 0, p = 3; i < next.length; i++, p += 4) next[i] = data[p];
    this.combine(next, mode);
  }

  setFromMask(next, mode = COMBINE.REPLACE) {
    this.combine(next, mode);
  }

  combine(next, mode = COMBINE.REPLACE) {
    const n = this.width * this.height;
    const cur = this.mask;
    let out;

    if (mode === COMBINE.REPLACE) {
      out = next;
    } else if (!cur) {
      // A null mask means "everything is selected"; combine against that.
      switch (mode) {
        case COMBINE.ADD:
          return;                                  // everything ∪ x is still everything
        case COMBINE.INTERSECT:
          out = next;                              // everything ∩ x is x
          break;
        case COMBINE.SUBTRACT:
        case COMBINE.XOR:
          out = new Uint8Array(n);                 // everything − x is the inverse of x
          for (let i = 0; i < n; i++) out[i] = 255 - next[i];
          break;
        default:
          out = next;
      }
    } else {
      out = new Uint8Array(n);
      switch (mode) {
        case COMBINE.ADD: for (let i = 0; i < n; i++) out[i] = Math.max(cur[i], next[i]); break;
        case COMBINE.SUBTRACT: for (let i = 0; i < n; i++) out[i] = Math.max(0, cur[i] - next[i]); break;
        case COMBINE.INTERSECT: for (let i = 0; i < n; i++) out[i] = Math.min(cur[i], next[i]); break;
        case COMBINE.XOR: for (let i = 0; i < n; i++) out[i] = Math.abs(cur[i] - next[i]); break;
        default: out = next;
      }
    }

    this.mask = out;
    this._afterMaskChange();
  }

  /**
   * Shifts the whole mask, used when dragging a selection outline around.
   *
   * This runs on every pointer move, so it avoids the two full-page scans the
   * obvious implementation needs: rows are copied with a typed-array memcpy
   * rather than pixel by pixel, the new bounds are derived by shifting the old
   * ones instead of rescanning, and the cached marching-ants geometry is
   * translated rather than rebuilt.
   */
  translate(dx, dy) {
    if (!this.mask) return;
    const idx = Math.round(dx), idy = Math.round(dy);
    if (idx === 0 && idy === 0) return;

    const { width: w, height: h } = this;
    const out = new Uint8Array(w * h);

    // Copy only the overlapping window, one row at a time.
    const xFrom = Math.max(0, idx);
    const xTo = Math.min(w, w + idx);
    const span = xTo - xFrom;
    if (span > 0) {
      const yFrom = Math.max(0, idy);
      const yTo = Math.min(h, h + idy);
      for (let y = yFrom; y < yTo; y++) {
        const srcStart = (y - idy) * w + (xFrom - idx);
        out.set(this.mask.subarray(srcStart, srcStart + span), y * w + xFrom);
      }
    }

    const prevBounds = this.bounds;
    const prevOutline = this._outline;
    // Translation only moves the shape, so the new bounds are the old ones
    // shifted and clipped to the page.
    const shifted = prevBounds && {
      x: Math.max(0, prevBounds.x + idx),
      y: Math.max(0, prevBounds.y + idy),
      w: 0, h: 0
    };
    if (shifted) {
      shifted.w = Math.min(w, prevBounds.x + prevBounds.w + idx) - shifted.x;
      shifted.h = Math.min(h, prevBounds.y + prevBounds.h + idy) - shifted.y;
    }

    this.mask = out;
    this._afterMaskChange(shifted && shifted.w > 0 && shifted.h > 0 ? shifted : null);

    // Reuse the outline only while the selection stays fully on the page; once
    // it clips, the boundary genuinely changes and has to be rebuilt.
    const clipped = !prevBounds
      || prevBounds.x + idx < 0 || prevBounds.y + idy < 0
      || prevBounds.x + prevBounds.w + idx > w || prevBounds.y + prevBounds.h + idy > h;
    if (!clipped && prevOutline) {
      this._outline = prevOutline.edge
        ? { edge: { ...prevOutline.edge, x: prevOutline.edge.x + idx, y: prevOutline.edge.y + idy } }
        : { path: translatedPath(prevOutline.path, idx, idy), runCount: prevOutline.runCount };
    }
  }

  clone() {
    const s = new Selection(this.width, this.height);
    if (this.mask) {
      s.mask = new Uint8Array(this.mask);
      s._afterMaskChange();
    }
    return s;
  }

  restore(snapshot) {
    this.mask = snapshot ? new Uint8Array(snapshot) : null;
    this._afterMaskChange();
  }

  snapshot() { return this.mask ? new Uint8Array(this.mask) : null; }

  /** White-on-transparent canvas used as a `destination-in` clip source. */
  maskCanvas() {
    if (!this.mask) return null;
    if (this._maskCanvas) return this._maskCanvas;
    const c = makeCanvas(this.width, this.height);
    const g = c.getContext('2d');
    const img = g.createImageData(this.width, this.height);
    const d = img.data;
    for (let i = 0, p = 0; i < this.mask.length; i++, p += 4) {
      d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = this.mask[i];
    }
    g.putImageData(img, 0, 0);
    this._maskCanvas = c;
    return c;
  }

  /**
   * Marching-ants geometry.
   *
   * Boundary edges are emitted as merged runs, not one segment per pixel: a
   * rectangular selection becomes 4 segments instead of 4x its perimeter. A
   * magic-wand selection over noisy pixels can still have a boundary with
   * hundreds of thousands of runs, so past a cap we stop building a path and
   * fall back to a cached edge bitmap that costs one blit per frame.
   *
   * Returns { path } for simple selections, { edge } for complex ones, or null.
   */
  outline() {
    if (this._outline !== undefined) return this._outline;
    if (!this.mask || !this.bounds) return (this._outline = null);

    const runs = this._edgeRuns(OUTLINE_RUN_CAP);
    if (runs) {
      const p = new Path2D();
      for (let i = 0; i < runs.length; i += 4) {
        p.moveTo(runs[i], runs[i + 1]);
        p.lineTo(runs[i + 2], runs[i + 3]);
      }
      this._outline = { path: p, runCount: runs.length / 4 };
    } else {
      this._outline = { edge: this._buildEdgeBitmap() };
    }
    return this._outline;
  }

  /**
   * Collects boundary edges as merged runs, flattened into
   * [x0, y0, x1, y1, ...]. Returns null once `cap` runs are exceeded.
   */
  _edgeRuns(cap) {
    const w = this.width, h = this.height, m = this.mask;
    const b = this.bounds;
    const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? false : m[y * w + x] >= 128);
    const out = [];
    const xEnd = b.x + b.w, yEnd = b.y + b.h;

    // Horizontal runs: the top and bottom edges of each row of selected pixels.
    for (let y = b.y; y < yEnd; y++) {
      for (const [dy, edgeY] of [[-1, y], [1, y + 1]]) {
        let runStart = -1;
        for (let x = b.x; x <= xEnd; x++) {
          const isEdge = x < xEnd && on(x, y) && !on(x, y + dy);
          if (isEdge && runStart < 0) runStart = x;
          else if (!isEdge && runStart >= 0) {
            out.push(runStart, edgeY, x, edgeY);
            runStart = -1;
            if (out.length > cap * 4) return null;
          }
        }
      }
    }

    // Vertical runs: the left and right edges of each column.
    for (let x = b.x; x < xEnd; x++) {
      for (const [dx, edgeX] of [[-1, x], [1, x + 1]]) {
        let runStart = -1;
        for (let y = b.y; y <= yEnd; y++) {
          const isEdge = y < yEnd && on(x, y) && !on(x + dx, y);
          if (isEdge && runStart < 0) runStart = y;
          else if (!isEdge && runStart >= 0) {
            out.push(edgeX, runStart, edgeX, y);
            runStart = -1;
            if (out.length > cap * 4) return null;
          }
        }
      }
    }
    return out;
  }

  /** One-pixel-wide edge mask, drawn as a bitmap when the path would be huge. */
  _buildEdgeBitmap() {
    const w = this.width, h = this.height, m = this.mask;
    const b = this.bounds;
    const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? false : m[y * w + x] >= 128);
    const c = makeCanvas(b.w, b.h);
    const g = c.getContext('2d');
    const img = g.createImageData(b.w, b.h);
    const d = img.data;
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const gx = b.x + x, gy = b.y + y;
        if (!on(gx, gy)) continue;
        if (on(gx - 1, gy) && on(gx + 1, gy) && on(gx, gy - 1) && on(gx, gy + 1)) continue;
        const i = (y * b.w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas: c, x: b.x, y: b.y, w: b.w, h: b.h };
  }

  _afterMaskChange(knownBounds) {
    this._maskCanvas = null;
    this._outline = undefined;
    // computeBounds scans the whole page; callers that already know the answer
    // (translate) pass it in.
    this.bounds = knownBounds !== undefined ? knownBounds : computeBounds(this.mask, this.width, this.height);
    // A mask that covers the entire page is the same thing as no mask at all,
    // and the null form is much cheaper for every downstream operation.
    if (this.bounds &&
        this.bounds.x === 0 && this.bounds.y === 0 &&
        this.bounds.w === this.width && this.bounds.h === this.height &&
        isFullyOpaque(this.mask)) {
      this.mask = null;
      this.bounds = null;
    }
  }
}

/** O(1) copy of a Path2D under a translation. */
function translatedPath(path, dx, dy) {
  const p = new Path2D();
  p.addPath(path, new DOMMatrix().translateSelf(dx, dy));
  return p;
}

function isFullyOpaque(mask) {
  if (!mask) return true;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 255) return false;
  return true;
}

export function computeBounds(mask, w, h) {
  if (!mask) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Span-based scanline flood fill.
 *
 * `inside(x, y)` must return false for out-of-bounds pixels and for pixels
 * already handed to `set`, which is what bounds the work: every pixel is
 * tested a constant number of times. The obvious per-pixel-seed version is
 * quadratic in the span width — on a 4000px-wide photo it never finishes.
 */
export function scanlineFill(width, height, startX, startY, inside, set) {
  if (!inside(startX, startY)) return;

  // Spans are stored flat as (x1, x2, y, dy) to keep this allocation-free.
  const stack = [startX, startX, startY, 1, startX, startX, startY - 1, -1];

  while (stack.length) {
    const dy = stack.pop();
    const y = stack.pop();
    const x2 = stack.pop();
    let x1 = stack.pop();
    if (y < 0 || y >= height) continue;

    let x = x1;
    if (inside(x, y)) {
      // Walk left off the start of the parent span.
      while (inside(x - 1, y)) { set(x - 1, y); x--; }
      if (x < x1) stack.push(x, x1 - 1, y - dy, -dy);
    }

    while (x1 <= x2) {
      while (inside(x1, y)) { set(x1, y); x1++; }
      if (x1 > x) stack.push(x, x1 - 1, y + dy, dy);
      if (x1 - 1 > x2) stack.push(x2 + 1, x1 - 1, y - dy, -dy);
      x1++;
      while (x1 < x2 && !inside(x1, y)) x1++;
      x = x1;
    }
  }
}

/**
 * Magic wand. Scanline flood fill over an RGBA buffer; `global` mode skips the
 * flood and simply tests every pixel, which is what Paint.NET's "Global" flood
 * mode does.
 */
export function magicWandMask(data, w, h, sx, sy, tolerance, global = false, sampleAlpha = true) {
  const out = new Uint8Array(w * h);
  sx = clamp(Math.floor(sx), 0, w - 1);
  sy = clamp(Math.floor(sy), 0, h - 1);
  const si = (sy * w + sx) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
  // Tolerance is a 0-100 slider; square it into the same distance space we test.
  const tol = (tolerance / 100) * 255;
  const tolSq = tol * tol * (sampleAlpha ? 4 : 3);

  const matches = (i) => {
    const dr = data[i] - sr, dg = data[i + 1] - sg, db = data[i + 2] - sb;
    let d = dr * dr + dg * dg + db * db;
    if (sampleAlpha) { const da = data[i + 3] - sa; d += da * da; }
    return d <= tolSq;
  };

  if (global) {
    for (let i = 0, p = 0; i < out.length; i++, p += 4) if (matches(p)) out[i] = 255;
    return out;
  }

  scanlineFill(
    w, h, sx, sy,
    (x, y) => x >= 0 && y >= 0 && x < w && y < h && out[y * w + x] === 0 && matches((y * w + x) * 4),
    (x, y) => { out[y * w + x] = 255; }
  );
  return out;
}

/**
 * Feathers a mask with a separable box blur, approximating a Gaussian.
 *
 * `radius` is the width of the soft band in pixels, which is what the UI
 * sliders promise. Three box passes of half-width r give a Gaussian of
 * sigma ~= r, and a Gaussian edge ramps over roughly +/-2 sigma, so the box
 * half-width has to be a quarter of the requested band — using the radius
 * directly would produce an edge about four times softer than asked for.
 */
export function featherMask(mask, w, h, radius) {
  if (radius <= 0) return mask;
  let src = mask, tmp = new Uint8Array(w * h);
  const r = Math.max(1, Math.round(radius / 4));
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / (2 * r + 1);
        sum -= src[row + clamp(x - r, 0, w - 1)];
        sum += src[row + clamp(x + r + 1, 0, w - 1)];
      }
    }
    // vertical
    const t2 = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        t2[y * w + x] = sum / (2 * r + 1);
        sum -= tmp[clamp(y - r, 0, h - 1) * w + x];
        sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x];
      }
    }
    src = t2;
    tmp = new Uint8Array(w * h);
  }
  return src;
}
