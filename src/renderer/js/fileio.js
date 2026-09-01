// File I/O: the layered .pmac document format, flat image import/export, and
// clipboard interchange.
//
// .pmac layout:
//   "PMAC1"          5 bytes magic
//   uint32 (LE)      length of the JSON header
//   <json header>    document metadata + per-layer byte lengths
//   <png blobs>      one PNG per layer, concatenated in stack order
//
// Layer bitmaps stay as PNG so the format is compact and every layer can be
// recovered with a standard decoder if anything ever goes wrong.

import { PaintDocument, Layer } from './document.js';
import { makeCanvas } from './util.js';

const MAGIC = 'PMAC1';
export const DOC_EXT = 'pmac';

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function canvasToBytes(canvas, type = 'image/png', quality) {
  const blob = await canvasToBlob(canvas, type, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- .pmac ---------- */

export async function serializeDocument(doc) {
  const blobs = [];
  const layers = [];
  for (const layer of doc.layers) {
    const bytes = await canvasToBytes(layer.canvas);
    blobs.push(bytes);
    layers.push({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      length: bytes.length
    });
  }
  const header = JSON.stringify({
    version: 1,
    app: 'Paint.mac',
    width: doc.width,
    height: doc.height,
    activeIndex: doc.activeIndex,
    layers
  });
  const headerBytes = new TextEncoder().encode(header);

  const total = MAGIC.length + 4 + headerBytes.length + blobs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  out.set(new TextEncoder().encode(MAGIC), off); off += MAGIC.length;
  new DataView(out.buffer).setUint32(off, headerBytes.length, true); off += 4;
  out.set(headerBytes, off); off += headerBytes.length;
  for (const b of blobs) { out.set(b, off); off += b.length; }
  return out;
}

export async function deserializeDocument(bytes) {
  const magic = new TextDecoder().decode(bytes.slice(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('Not a Paint.mac document.');
  let off = MAGIC.length;
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(off, true);
  off += 4;
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(off, off + headerLen)));
  off += headerLen;

  const doc = new PaintDocument(header.width, header.height);
  for (const meta of header.layers) {
    const slice = bytes.slice(off, off + meta.length);
    off += meta.length;
    const bitmap = await createImageBitmap(new Blob([slice], { type: 'image/png' }));
    const layer = new Layer(header.width, header.height, meta.name);
    layer.visible = meta.visible;
    layer.opacity = meta.opacity;
    layer.blendMode = meta.blendMode;
    layer.ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    doc.layers.push(layer);
  }
  if (!doc.layers.length) doc.layers.push(new Layer(header.width, header.height, 'Background'));
  doc.activeIndex = Math.min(header.activeIndex ?? 0, doc.layers.length - 1);
  doc.invalidateAll();
  return doc;
}

/* ---------- flat images ---------- */

export async function documentFromImageBytes(bytes, mime, name = 'Untitled') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime || '' }));
  const doc = new PaintDocument(bitmap.width, bitmap.height);
  const layer = new Layer(bitmap.width, bitmap.height, 'Background');
  layer.ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  doc.layers.push(layer);
  doc.fileName = name;
  doc.invalidateAll();
  return doc;
}

export function mimeForExtension(ext) {
  switch (ext.replace('.', '').toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    default: return '';
  }
}

/**
 * Flattens the document for export. JPEG has no alpha, so transparent areas are
 * composited over white rather than turning black.
 */
export async function exportBytes(doc, ext, quality = 0.92) {
  const mime = mimeForExtension(ext) || 'image/png';
  let canvas = doc.flatten();
  if (mime === 'image/jpeg' || mime === 'image/bmp') {
    const opaque = makeCanvas(canvas.width, canvas.height);
    const g = opaque.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(canvas, 0, 0);
    canvas = opaque;
  }
  return canvasToBytes(canvas, mime, quality);
}

/* ---------- clipboard ---------- */

export async function copyCanvasToClipboard(canvas) {
  const dataURL = canvas.toDataURL('image/png');
  await window.api.writeClipboardImage(dataURL);
}

export async function readClipboardCanvas() {
  const dataURL = await window.api.readClipboardImage();
  if (!dataURL) return null;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataURL;
  });
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
