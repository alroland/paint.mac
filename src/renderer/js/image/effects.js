// Effects. Same (src, dst, w, h, params) contract as the adjustments.
// Convolutions and blurs run on plain typed arrays; the blur is a three-pass
// separable box blur, which is visually indistinguishable from a Gaussian and
// runs in O(pixels) regardless of radius.

import { clamp, lerp } from '../util.js';
import { luminance } from '../color.js';

/* ---------- blurs ---------- */

function boxBlurPass(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h;
  const outer = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const jump = horizontal ? w * 4 : 4;
  const div = r * 2 + 1;

  for (let o = 0; o < outer; o++) {
    const base = o * jump;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let k = -r; k <= r; k++) {
      const i = base + clamp(k, 0, len - 1) * stride;
      a0 += src[i]; a1 += src[i + 1]; a2 += src[i + 2]; a3 += src[i + 3];
    }
    for (let p = 0; p < len; p++) {
      const o1 = base + p * stride;
      dst[o1] = a0 / div; dst[o1 + 1] = a1 / div; dst[o1 + 2] = a2 / div; dst[o1 + 3] = a3 / div;
      const rem = base + clamp(p - r, 0, len - 1) * stride;
      const add = base + clamp(p + r + 1, 0, len - 1) * stride;
      a0 += src[add] - src[rem];
      a1 += src[add + 1] - src[rem + 1];
      a2 += src[add + 2] - src[rem + 2];
      a3 += src[add + 3] - src[rem + 3];
    }
  }
}

export function blurInto(src, dst, w, h, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) { dst.set(src); return; }
  const tmp = new Uint8ClampedArray(src.length);
  let a = src, b = dst;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(a, tmp, w, h, r, true);
    boxBlurPass(tmp, b, w, h, r, false);
    a = b;
    b = b === dst ? tmp : dst;
  }
  if (a !== dst) dst.set(a);
}

export function gaussianBlur(src, dst, w, h, { radius = 5 }) {
  blurInto(src, dst, w, h, radius);
}

export function motionBlur(src, dst, w, h, { angle = 0, distance = 20, centered = true }) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = -Math.sin(rad);
  const n = Math.max(1, Math.round(distance));
  const from = centered ? -Math.floor(n / 2) : 0;
  const to = centered ? Math.ceil(n / 2) : n;
  const count = to - from;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = from; k < to; k++) {
        const sx = clamp(Math.round(x + dx * k), 0, w - 1);
        const sy = clamp(Math.round(y + dy * k), 0, h - 1);
        const i = (sy * w + sx) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
      }
      const o = (y * w + x) * 4;
      dst[o] = r / count; dst[o + 1] = g / count; dst[o + 2] = b / count; dst[o + 3] = a / count;
    }
  }
}

export function zoomBlur(src, dst, w, h, { amount = 20, cx = 0.5, cy = 0.5 }) {
  const centerX = cx * w, centerY = cy * h;
  const steps = 12;
  const k = amount / 400;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < steps; s++) {
        const t = 1 - (s / steps) * k;
        const sx = clamp(Math.round(centerX + (x - centerX) * t), 0, w - 1);
        const sy = clamp(Math.round(centerY + (y - centerY) * t), 0, h - 1);
        const i = (sy * w + sx) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
      }
      const o = (y * w + x) * 4;
      dst[o] = r / steps; dst[o + 1] = g / steps; dst[o + 2] = b / steps; dst[o + 3] = a / steps;
    }
  }
}

export function pixelate(src, dst, w, h, { size = 8 }) {
  const s = Math.max(1, Math.round(size));
  for (let by = 0; by < h; by += s) {
    for (let bx = 0; bx < w; bx += s) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const ey = Math.min(h, by + s), ex = Math.min(w, bx + s);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      r /= n; g /= n; b /= n; a /= n;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4;
          dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
        }
      }
    }
  }
}

/* ---------- convolution helpers ---------- */

function convolve(src, dst, w, h, kernel, k, divisor, offset, keepAlpha = true) {
  const half = (k - 1) / 2;
  const div = divisor || kernel.reduce((a, b) => a + b, 0) || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < k; ky++) {
        const sy = clamp(y + ky - half, 0, h - 1);
        for (let kx = 0; kx < k; kx++) {
          const sx = clamp(x + kx - half, 0, w - 1);
          const wgt = kernel[ky * k + kx];
          if (wgt === 0) continue;
          const i = (sy * w + sx) * 4;
          r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt;
        }
      }
      const o = (y * w + x) * 4;
      dst[o] = clamp(r / div + offset, 0, 255);
      dst[o + 1] = clamp(g / div + offset, 0, 255);
      dst[o + 2] = clamp(b / div + offset, 0, 255);
      dst[o + 3] = keepAlpha ? src[o + 3] : 255;
    }
  }
}

export function sharpen(src, dst, w, h, { amount = 50 }) {
  const a = amount / 100;
  const k = [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0];
  convolve(src, dst, w, h, k, 3, 1, 0);
}

export function unsharpMask(src, dst, w, h, { radius = 4, amount = 80, threshold = 0 }) {
  const blurred = new Uint8ClampedArray(src.length);
  blurInto(src, blurred, w, h, radius);
  const a = amount / 100;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = src[i + c] - blurred[i + c];
      dst[i + c] = Math.abs(diff) < threshold ? src[i + c] : clamp(src[i + c] + diff * a, 0, 255);
    }
    dst[i + 3] = src[i + 3];
  }
}

export function edgeDetect(src, dst, w, h, { amount = 100 }) {
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const a = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = 0, sy = 0;
      for (let ky = 0; ky < 3; ky++) {
        const py = clamp(y + ky - 1, 0, h - 1);
        for (let kx = 0; kx < 3; kx++) {
          const px = clamp(x + kx - 1, 0, w - 1);
          const i = (py * w + px) * 4;
          const l = luminance(src[i], src[i + 1], src[i + 2]);
          sx += l * gx[ky * 3 + kx];
          sy += l * gy[ky * 3 + kx];
        }
      }
      const mag = clamp(Math.hypot(sx, sy) * a, 0, 255);
      const o = (y * w + x) * 4;
      dst[o] = dst[o + 1] = dst[o + 2] = mag;
      dst[o + 3] = src[o + 3];
    }
  }
}

export function emboss(src, dst, w, h, { angle = 45 }) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad), dy = -Math.sin(rad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ax = clamp(Math.round(x + dx), 0, w - 1), ay = clamp(Math.round(y + dy), 0, h - 1);
      const bx = clamp(Math.round(x - dx), 0, w - 1), by = clamp(Math.round(y - dy), 0, h - 1);
      const ia = (ay * w + ax) * 4, ib = (by * w + bx) * 4;
      const d = luminance(src[ia], src[ia + 1], src[ia + 2]) - luminance(src[ib], src[ib + 1], src[ib + 2]);
      const v = clamp(128 + d, 0, 255);
      const o = (y * w + x) * 4;
      dst[o] = dst[o + 1] = dst[o + 2] = v;
      dst[o + 3] = src[o + 3];
    }
  }
}

export function outline(src, dst, w, h, { thickness = 2, intensity = 50 }) {
  const t = Math.max(1, Math.round(thickness));
  const a = intensity / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mn = 255, mx = 0;
      for (let ky = -t; ky <= t; ky++) {
        const py = clamp(y + ky, 0, h - 1);
        for (let kx = -t; kx <= t; kx++) {
          const px = clamp(x + kx, 0, w - 1);
          const i = (py * w + px) * 4;
          const l = luminance(src[i], src[i + 1], src[i + 2]);
          if (l < mn) mn = l;
          if (l > mx) mx = l;
        }
      }
      const edge = clamp(255 - (mx - mn) * a * 2, 0, 255);
      const o = (y * w + x) * 4;
      dst[o] = clamp(lerp(src[o], edge, a), 0, 255);
      dst[o + 1] = clamp(lerp(src[o + 1], edge, a), 0, 255);
      dst[o + 2] = clamp(lerp(src[o + 2], edge, a), 0, 255);
      dst[o + 3] = src[o + 3];
    }
  }
}

/** Kuwahara-style oil painting: most common quantised colour in the window. */
export function oilPainting(src, dst, w, h, { radius = 3, levels = 20 }) {
  const r = Math.max(1, Math.round(radius));
  const lv = Math.max(2, Math.round(levels));
  const counts = new Uint32Array(lv);
  const sums = new Float64Array(lv * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      counts.fill(0);
      sums.fill(0);
      for (let ky = -r; ky <= r; ky++) {
        const py = clamp(y + ky, 0, h - 1);
        for (let kx = -r; kx <= r; kx++) {
          const px = clamp(x + kx, 0, w - 1);
          const i = (py * w + px) * 4;
          const bin = Math.min(lv - 1, Math.floor((luminance(src[i], src[i + 1], src[i + 2]) / 256) * lv));
          counts[bin]++;
          sums[bin * 3] += src[i];
          sums[bin * 3 + 1] += src[i + 1];
          sums[bin * 3 + 2] += src[i + 2];
        }
      }
      let best = 0;
      for (let k = 1; k < lv; k++) if (counts[k] > counts[best]) best = k;
      const n = Math.max(1, counts[best]);
      const o = (y * w + x) * 4;
      dst[o] = sums[best * 3] / n;
      dst[o + 1] = sums[best * 3 + 1] / n;
      dst[o + 2] = sums[best * 3 + 2] / n;
      dst[o + 3] = src[o + 3];
    }
  }
}

/* ---------- photo ---------- */

export function glow(src, dst, w, h, { radius = 8, brightness = 20, contrast = 10 }) {
  const blurred = new Uint8ClampedArray(src.length);
  blurInto(src, blurred, w, h, radius);
  const b = brightness / 100, c = 1 + contrast / 100;
  for (let i = 0; i < src.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      // Screen the blurred copy over the original, then push contrast back up.
      const s = 255 - ((255 - src[i + k]) * (255 - blurred[i + k])) / 255;
      dst[i + k] = clamp(((s * (1 + b) - 128) * c) + 128, 0, 255);
    }
    dst[i + 3] = src[i + 3];
  }
}

export function vignette(src, dst, w, h, { radius = 60, softness = 50, amount = 70 }) {
  const cx = w / 2, cy = h / 2;
  const maxD = Math.hypot(cx, cy);
  const inner = (radius / 100) * maxD;
  const outer = inner + (softness / 100) * maxD + 1;
  const a = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const t = clamp((d - inner) / (outer - inner), 0, 1);
      const f = 1 - t * t * a;
      const i = (y * w + x) * 4;
      dst[i] = src[i] * f;
      dst[i + 1] = src[i + 1] * f;
      dst[i + 2] = src[i + 2] * f;
      dst[i + 3] = src[i + 3];
    }
  }
}

/* ---------- noise ---------- */

export function addNoise(src, dst, w, h, { intensity = 30, colorSaturation = 40, coverage = 100 }) {
  const amp = (intensity / 100) * 128;
  const sat = colorSaturation / 100;
  const cov = coverage / 100;
  for (let i = 0; i < src.length; i += 4) {
    if (Math.random() > cov) {
      dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3];
      continue;
    }
    const mono = (Math.random() - 0.5) * 2 * amp;
    for (let k = 0; k < 3; k++) {
      const chroma = (Math.random() - 0.5) * 2 * amp * sat;
      dst[i + k] = clamp(src[i + k] + mono * (1 - sat) + chroma, 0, 255);
    }
    dst[i + 3] = src[i + 3];
  }
}

export function median(src, dst, w, h, { radius = 2 }) {
  const r = Math.max(1, Math.round(radius));
  const buf = new Uint8Array((r * 2 + 1) * (r * 2 + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let ky = -r; ky <= r; ky++) {
          const py = clamp(y + ky, 0, h - 1);
          for (let kx = -r; kx <= r; kx++) {
            const px = clamp(x + kx, 0, w - 1);
            buf[n++] = src[(py * w + px) * 4 + c];
          }
        }
        const slice = buf.subarray(0, n);
        slice.sort();
        dst[(y * w + x) * 4 + c] = slice[n >> 1];
      }
      dst[(y * w + x) * 4 + 3] = src[(y * w + x) * 4 + 3];
    }
  }
}

/** Edge-preserving smoothing: a cheap bilateral filter. */
export function reduceNoise(src, dst, w, h, { radius = 3, strength = 40 }) {
  const r = Math.max(1, Math.round(radius));
  const sigma = Math.max(1, (strength / 100) * 60);
  const sigma2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (y * w + x) * 4;
      const cl = luminance(src[ci], src[ci + 1], src[ci + 2]);
      let wr = 0, ar = 0, ag = 0, ab = 0;
      for (let ky = -r; ky <= r; ky++) {
        const py = clamp(y + ky, 0, h - 1);
        for (let kx = -r; kx <= r; kx++) {
          const px = clamp(x + kx, 0, w - 1);
          const i = (py * w + px) * 4;
          const d = luminance(src[i], src[i + 1], src[i + 2]) - cl;
          const wt = Math.exp(-(d * d) / sigma2);
          wr += wt; ar += src[i] * wt; ag += src[i + 1] * wt; ab += src[i + 2] * wt;
        }
      }
      dst[ci] = ar / wr; dst[ci + 1] = ag / wr; dst[ci + 2] = ab / wr; dst[ci + 3] = src[ci + 3];
    }
  }
}

/* ---------- distort ---------- */

function sampleBilinear(src, w, h, x, y, out, o) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = clamp(x0 + 1, 0, w - 1), y1 = clamp(y0 + 1, 0, h - 1);
  const cx0 = clamp(x0, 0, w - 1), cy0 = clamp(y0, 0, h - 1);
  const i00 = (cy0 * w + cx0) * 4, i10 = (cy0 * w + x1) * 4;
  const i01 = (y1 * w + cx0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
    const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
    out[o + c] = top + (bot - top) * fy;
  }
}

export function bulge(src, dst, w, h, { amount = 45 }) {
  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(cx, cy);
  const k = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (d > maxR || d === 0) {
        dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2]; dst[o + 3] = src[o + 3];
        continue;
      }
      const t = d / maxR;
      const f = 1 - k * (1 - t * t);
      sampleBilinear(src, w, h, cx + dx * f, cy + dy * f, dst, o);
    }
  }
}

export function twist(src, dst, w, h, { angle = 60, radiusPct = 80 }) {
  const cx = w / 2, cy = h / 2;
  const maxR = (radiusPct / 100) * Math.min(cx, cy);
  const rad = (angle * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const o = (y * w + x) * 4;
      if (d > maxR) {
        dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2]; dst[o + 3] = src[o + 3];
        continue;
      }
      const t = 1 - d / maxR;
      const a = Math.atan2(dy, dx) + rad * t * t;
      sampleBilinear(src, w, h, cx + Math.cos(a) * d, cy + Math.sin(a) * d, dst, o);
    }
  }
}

export function tileReflection(src, dst, w, h, { size = 64, curvature = 40 }) {
  const s = Math.max(4, Math.round(size));
  const k = curvature / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = (x % s) / s - 0.5;
      const ty = (y % s) / s - 0.5;
      const sx = x - tx * s * k;
      const sy = y - ty * s * k;
      sampleBilinear(src, w, h, clamp(sx, 0, w - 1), clamp(sy, 0, h - 1), dst, (y * w + x) * 4);
    }
  }
}

/* ---------- render ---------- */

/** Value-noise fBm, seeded so a given seed always renders the same clouds. */
export function clouds(src, dst, w, h, { scale = 120, roughness = 50, seed = 1, blend = 100 }, colorA = [0, 0, 0], colorB = [255, 255, 255]) {
  const rough = roughness / 100;
  const mix = blend / 100;
  const hash = (x, y) => {
    let n = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let amp = 1, freq = 1 / Math.max(2, scale), sum = 0, norm = 0;
      for (let oct = 0; oct < 6; oct++) {
        sum += noise(x * freq, y * freq) * amp;
        norm += amp;
        amp *= rough;
        freq *= 2;
      }
      const t = sum / norm;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = lerp(colorA[c], colorB[c], t);
        dst[o + c] = clamp(lerp(src[o + c], v, mix), 0, 255);
      }
      dst[o + 3] = Math.max(src[o + 3], Math.round(255 * mix));
    }
  }
}

export function julia(src, dst, w, h, { cRe = -0.4, cIm = 0.6, zoom = 1, iterations = 80, blend = 100 }) {
  const mix = blend / 100;
  const maxI = Math.max(8, Math.round(iterations));
  const scale = 3 / (Math.min(w, h) * zoom);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let zx = (x - w / 2) * scale;
      let zy = (y - h / 2) * scale;
      let i = 0;
      while (zx * zx + zy * zy < 4 && i < maxI) {
        const t = zx * zx - zy * zy + cRe;
        zy = 2 * zx * zy + cIm;
        zx = t;
        i++;
      }
      const t = i / maxI;
      const o = (y * w + x) * 4;
      const r = 255 * Math.min(1, t * 1.6);
      const g = 255 * Math.min(1, Math.max(0, t * 2 - 0.4));
      const b = 255 * Math.min(1, Math.max(0, t * 3 - 1.2));
      dst[o] = clamp(lerp(src[o], r, mix), 0, 255);
      dst[o + 1] = clamp(lerp(src[o + 1], g, mix), 0, 255);
      dst[o + 2] = clamp(lerp(src[o + 2], b, mix), 0, 255);
      dst[o + 3] = Math.max(src[o + 3], Math.round(255 * mix));
    }
  }
}
