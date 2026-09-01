// Filter application with live preview.
//
// A session snapshots the affected region once, then every parameter change
// re-runs the filter from that pristine copy straight into the document. The
// user sees the real result on the real canvas rather than a thumbnail, and
// cancelling is just a blit of the snapshot back.

import { makeCanvas, normalizeRect, rafThrottle } from '../util.js';
import { regionEdit, replaceRegion } from '../history.js';

export class EffectSession {
  constructor(app, label) {
    this.app = app;
    this.label = label;
    this.doc = app.doc;
    this.layer = app.doc.activeLayer;
    this.rect = normalizeRect(app.selection.clipRect(), this.doc.width, this.doc.height);
    this.ok = !!this.rect && !!this.layer;
    if (!this.ok) return;

    const { x, y, w, h } = this.rect;
    this.before = makeCanvas(w, h);
    this.before.getContext('2d').drawImage(this.layer.canvas, x, y, w, h, 0, 0, w, h);
    this.srcData = this.before.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);

    this.scratch = makeCanvas(w, h);
    this.scratchCtx = this.scratch.getContext('2d');
    this._request = rafThrottle(() => this._run());
    this._pending = null;
  }

  /** Queues a filter run; repeated calls within a frame collapse into one. */
  preview(filterFn, params) {
    if (!this.ok) return;
    this._pending = { filterFn, params };
    this._request();
  }

  /** Runs synchronously — used right before committing. */
  flush() {
    if (this._pending) this._run();
  }

  _run() {
    const job = this._pending;
    if (!job || !this.ok) return;
    const { w, h } = this.rect;
    const out = new ImageData(new Uint8ClampedArray(this.srcData.data), w, h);
    job.filterFn(this.srcData.data, out.data, w, h, job.params || {});
    blendWithSelection(this.app.selection, this.srcData.data, out.data, this.rect);

    this.scratchCtx.putImageData(out, 0, 0);
    replaceRegion(this.layer, this.rect, this.scratch);
    this.doc.invalidate(this.rect);
    this.app.view.render();
  }

  commit() {
    if (!this.ok) return;
    this.flush();
    this.app.pushHistory(regionEdit(this.doc, this.layer, this.rect, this.before, this.label));
  }

  cancel() {
    if (!this.ok) return;
    replaceRegion(this.layer, this.rect, this.before);
    this.doc.invalidate(this.rect);
    this.app.view.render();
  }
}

/** Fades filtered pixels back toward the original wherever coverage < 255. */
function blendWithSelection(selection, src, dst, rect) {
  if (!selection.active) return;
  const { x, y, w, h } = rect;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const cov = selection.coverageAt(x + px, y + py);
      if (cov === 255) continue;
      const i = (py * w + px) * 4;
      if (cov === 0) {
        dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3];
      } else {
        const t = cov / 255;
        dst[i] = src[i] + (dst[i] - src[i]) * t;
        dst[i + 1] = src[i + 1] + (dst[i + 1] - src[i + 1]) * t;
        dst[i + 2] = src[i + 2] + (dst[i + 2] - src[i + 2]) * t;
        dst[i + 3] = src[i + 3] + (dst[i + 3] - src[i + 3]) * t;
      }
    }
  }
}

/** One-shot application with no dialog (Invert, Auto Level, …). */
export function applyFilter(app, filterFn, params, label) {
  const session = new EffectSession(app, label);
  if (!session.ok) return false;
  session.preview(filterFn, params);
  session.commit();
  return true;
}
