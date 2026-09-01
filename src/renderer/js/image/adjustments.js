// Colour adjustments. Every function has the signature
// (src, dst, w, h, params) and works on premultiplied-free RGBA bytes.

import { clamp } from '../util.js';
import { rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, luminance } from '../color.js';

/** Builds a 256-entry lookup table and maps RGB through it, leaving alpha be. */
function mapLut(src, dst, lut) {
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = lut[src[i]];
    dst[i + 1] = lut[src[i + 1]];
    dst[i + 2] = lut[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}

export function invert(src, dst) {
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = 255 - src[i];
    dst[i + 1] = 255 - src[i + 1];
    dst[i + 2] = 255 - src[i + 2];
    dst[i + 3] = src[i + 3];
  }
}

export function blackAndWhite(src, dst) {
  for (let i = 0; i < src.length; i += 4) {
    const y = luminance(src[i], src[i + 1], src[i + 2]);
    dst[i] = dst[i + 1] = dst[i + 2] = y;
    dst[i + 3] = src[i + 3];
  }
}

export function sepia(src, dst) {
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i], g = src[i + 1], b = src[i + 2];
    dst[i] = clamp(0.393 * r + 0.769 * g + 0.189 * b, 0, 255);
    dst[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b, 0, 255);
    dst[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b, 0, 255);
    dst[i + 3] = src[i + 3];
  }
}

export function brightnessContrast(src, dst, w, h, { brightness = 0, contrast = 0 }) {
  const b = brightness * 2.55;
  // Standard S-curve contrast factor; c = 0 leaves the image untouched.
  const c = clamp(contrast, -100, 100);
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp(f * (i + b - 128) + 128, 0, 255);
  mapLut(src, dst, lut);
}

export function hueSaturation(src, dst, w, h, { hue = 0, saturation = 100, lightness = 0 }) {
  const satF = saturation / 100;
  const lightF = lightness / 100;
  for (let i = 0; i < src.length; i += 4) {
    const { h: hh, s, l } = rgbToHsl(src[i], src[i + 1], src[i + 2]);
    let nl = l;
    if (lightF > 0) nl = l + (1 - l) * lightF;
    else if (lightF < 0) nl = l * (1 + lightF);
    const { r, g, b } = hslToRgb(hh + hue, clamp(s * satF, 0, 1), clamp(nl, 0, 1));
    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = src[i + 3];
  }
}

export function levels(src, dst, w, h, { inLow = 0, inHigh = 255, gamma = 1, outLow = 0, outHigh = 255 }) {
  const lut = new Uint8ClampedArray(256);
  const span = Math.max(1, inHigh - inLow);
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < 256; i++) {
    let v = (i - inLow) / span;
    v = clamp(v, 0, 1);
    v = Math.pow(v, invGamma);
    lut[i] = clamp(outLow + v * (outHigh - outLow), 0, 255);
  }
  mapLut(src, dst, lut);
}

/** Stretches each channel so its darkest/brightest samples hit 0 and 255. */
export function autoLevel(src, dst) {
  const lo = [255, 255, 255], hi = [0, 0, 0];
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < 8) continue;
    for (let c = 0; c < 3; c++) {
      const v = src[i + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  const luts = [0, 1, 2].map((c) => {
    const span = Math.max(1, hi[c] - lo[c]);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp(((i - lo[c]) / span) * 255, 0, 255);
    return lut;
  });
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = luts[0][src[i]];
    dst[i + 1] = luts[1][src[i + 1]];
    dst[i + 2] = luts[2][src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}

export function posterize(src, dst, w, h, { levels: n = 6 }) {
  const steps = Math.max(2, Math.round(n));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.round((i / 255) * (steps - 1)) * (255 / (steps - 1)));
  }
  mapLut(src, dst, lut);
}

/** Warm/cool shift plus an optional tint along the green–magenta axis. */
export function temperature(src, dst, w, h, { temp = 0, tint = 0 }) {
  const rGain = 1 + temp / 200;
  const bGain = 1 - temp / 200;
  const gGain = 1 + tint / 300;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = clamp(src[i] * rGain, 0, 255);
    dst[i + 1] = clamp(src[i + 1] * gGain, 0, 255);
    dst[i + 2] = clamp(src[i + 2] * bGain, 0, 255);
    dst[i + 3] = src[i + 3];
  }
}

/** `points` is a sorted list of [in, out] control points in 0-255. */
export function curves(src, dst, w, h, { points = [[0, 0], [255, 255]], channel = 'rgb' }) {
  const lut = buildCurveLut(points);
  if (channel === 'rgb') { mapLut(src, dst, lut); return; }
  const off = { r: 0, g: 1, b: 2 }[channel] ?? 0;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3];
    dst[i + off] = lut[src[i + off]];
  }
}

/** Monotone cubic interpolation so dragging a point never makes the curve loop. */
export function buildCurveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8ClampedArray(256);
  if (pts.length === 0) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 255) pts.push([255, pts[pts.length - 1][1]]);

  for (let i = 0; i < 256; i++) {
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1][0] < i) k++;
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const t = x1 === x0 ? 0 : (i - x0) / (x1 - x0);
    // Smoothstep between neighbouring control points.
    const s = t * t * (3 - 2 * t);
    lut[i] = clamp(y0 + (y1 - y0) * s, 0, 255);
  }
  return lut;
}

/** 256-bin luminance histogram, used by the Levels and Curves dialogs. */
export function histogram(data) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    bins[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
  }
  return bins;
}

export { rgbToHsv, hsvToRgb };
