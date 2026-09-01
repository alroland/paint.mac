// Text tool. Typing happens in a real <textarea> floating over the canvas so
// caret handling, selection and IME all behave natively; on commit the text is
// re-rendered into the layer with the canvas text API.

import { Tool, ICONS } from './base.js';
import { paintOp } from '../paint.js';
import { regionEdit } from '../history.js';
import { toCss } from '../color.js';
import { makeCanvas, normalizeRect } from '../util.js';

const FONTS = [
  ['-apple-system, "SF Pro Text", Helvetica, sans-serif', 'System'],
  ['Helvetica Neue, Helvetica, sans-serif', 'Helvetica Neue'],
  ['Georgia, serif', 'Georgia'],
  ['"Times New Roman", Times, serif', 'Times'],
  ['Menlo, ui-monospace, monospace', 'Menlo'],
  ['Avenir Next, Avenir, sans-serif', 'Avenir Next'],
  ['Impact, Haettenschweiler, sans-serif', 'Impact'],
  ['"Comic Sans MS", cursive', 'Comic Sans']
];

export class TextTool extends Tool {
  static id = 'text';
  static hint = 'Click and type on the canvas. ⌘⏎ commits, ⎋ cancels.';
  static label = 'Text';
  static shortcut = 'T';
  static icon = ICONS.text;
  static cursor = 'text';

  constructor(app) {
    super(app);
    this.options = {
      font: FONTS[0][0], size: 48, bold: false, italic: false,
      align: 'left', antialias: true, lineHeight: 120
    };
    this.editor = null;
    this._unsub = null;
  }

  get schema() {
    return [
      { type: 'select', key: 'font', label: 'Font', items: FONTS, wide: true },
      { type: 'range', key: 'size', label: 'Size', min: 6, max: 400, step: 1, unit: 'px', number: true },
      { type: 'toggle', key: 'bold', label: 'Bold' },
      { type: 'toggle', key: 'italic', label: 'Italic' },
      { type: 'segmented', key: 'align', label: 'Align', items: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] },
      { type: 'range', key: 'lineHeight', label: 'Line height', min: 70, max: 250, step: 5, unit: '%' },
      { type: 'note', text: '⎋ cancels · ⌘⏎ commits · click elsewhere to commit.' }
    ];
  }

  /** An open text box counts as in-progress work. */
  get busy() { return !!this.editor; }

  activate() {
    super.activate();
    this._unsub = this.app.on('view-changed', () => this.reposition());
  }

  deactivate() {
    this.commit();
    this._unsub?.();
    this._unsub = null;
    super.deactivate();
  }

  onDown(pt) {
    this.app.commitFloating();
    if (this.editor) {
      this.commit();
      return;
    }
    if (!this.layer) return;
    this.openEditor(pt);
  }

  /** Re-applies option changes (font, size, colour) to a live editor. */
  refresh() { if (this.editor) this.styleEditor(); }

  openEditor(pt) {
    const ta = document.createElement('textarea');
    ta.className = 'text-edit';
    ta.spellcheck = false;
    ta.rows = 1;
    this.origin = { x: pt.x, y: pt.y };
    this.app.overlayHost.appendChild(ta);
    this.editor = ta;
    this.styleEditor();

    ta.addEventListener('input', () => this.autoSize());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { this.discard(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { this.commit(); }
    });
    ta.addEventListener('blur', () => { if (this.editor === ta) this.commit(); });
    requestAnimationFrame(() => ta.focus());
  }

  styleEditor() {
    const ta = this.editor;
    if (!ta) return;
    const view = this.app.view;
    const z = view.zoom;
    const s = view.toScreen(this.origin.x, this.origin.y);
    const px = this.options.size * z;
    ta.style.left = `${s.x}px`;
    ta.style.top = `${s.y}px`;
    ta.style.font = `${this.options.italic ? 'italic ' : ''}${this.options.bold ? '700 ' : '400 '}${px}px/${this.options.lineHeight}% ${this.options.font}`;
    ta.style.color = toCss(this.app.primaryColor);
    ta.style.textAlign = this.options.align;
    ta.style.transformOrigin = '0 0';
    this.autoSize();
  }

  autoSize() {
    const ta = this.editor;
    if (!ta) return;
    const z = this.app.view.zoom;
    const lines = ta.value.split('\n');
    const longest = lines.reduce((a, b) => (a.length >= b.length ? a : b), '');
    // Measure with the same font we will render with, then pad for the caret.
    const m = measure(longest, this.fontSpec(this.options.size));
    ta.style.width = `${Math.max(24, m.width * z + this.options.size * z * 0.6)}px`;
    ta.style.height = `${Math.max(1, lines.length) * this.options.size * (this.options.lineHeight / 100) * z + 4}px`;
  }

  reposition() { this.styleEditor(); }

  fontSpec(size) {
    return `${this.options.italic ? 'italic ' : ''}${this.options.bold ? '700 ' : '400 '}${size}px ${this.options.font}`;
  }

  discard() {
    const ta = this.editor;
    this.editor = null;
    ta?.remove();
    this.app.view.render();
  }

  commit() {
    const ta = this.editor;
    if (!ta) return;
    const text = ta.value;
    this.editor = null;
    ta.remove();
    if (!text.trim() || !this.layer) { this.app.view.render(); return; }

    const size = this.options.size;
    const lh = size * (this.options.lineHeight / 100);
    const lines = text.split('\n');
    const spec = this.fontSpec(size);
    let maxW = 0;
    for (const l of lines) maxW = Math.max(maxW, measure(l, spec).width);

    // Bounds are padded generously: descenders and italic overhang both spill
    // past the naive text metrics.
    const pad = size;
    const left = this.options.align === 'center' ? this.origin.x - maxW / 2
      : this.options.align === 'right' ? this.origin.x - maxW
      : this.origin.x;
    const box = normalizeRect({
      x: left - pad, y: this.origin.y - pad,
      w: maxW + pad * 2, h: lines.length * lh + pad * 2
    }, this.doc.width, this.doc.height);
    if (!box) { this.app.view.render(); return; }

    const before = makeCanvas(box.w, box.h);
    before.getContext('2d').drawImage(this.layer.canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

    const color = toCss(this.app.primaryColor);
    const align = this.options.align;
    const originX = this.origin.x, originY = this.origin.y;
    paintOp(this.app, this.layer, box, (ctx) => {
      ctx.font = spec;
      ctx.fillStyle = color;
      ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
      ctx.textBaseline = 'top';
      lines.forEach((line, i) => ctx.fillText(line, originX, originY + i * lh));
    }, { alpha: this.app.primaryColor.a });

    this.app.pushHistory(regionEdit(this.doc, this.layer, box, before, 'Text'));
    this.app.view.render();
  }

  cancel() { this.discard(); }
}

let measureCtx = null;
function measure(text, font) {
  if (!measureCtx) measureCtx = makeCanvas(4, 4).getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text || ' ');
}

export const TEXT_TOOLS = [TextTool];
