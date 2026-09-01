// Menu / shortcut command dispatch. Every user-visible operation funnels
// through here so the menu bar, keyboard and buttons can't drift apart.

import { PaintDocument, Layer, BLEND_MODES } from './document.js';
import { captureDocState, docStateEdit, selectionEdit, regionEdit, metaEdit } from './history.js';
import { extractSelection, eraseSelection } from './tools/select.js';
import { paintOp } from './paint.js';
import { makeCanvas, normalizeRect } from './util.js';
import { toCss } from './color.js';
import * as adj from './image/adjustments.js';
import * as fx from './image/effects.js';
import * as tf from './image/transform.js';
import { applyFilter, EffectSession } from './image/apply.js';
import { showDialog, showEffectDialog, canvasField } from './ui/dialogs.js';
import * as io from './fileio.js';
import { formatKeys } from './platform.js';

export function registerCommands(app) {
  const doc = () => app.doc;
  const sel = () => app.selection;

  const commands = {
    /* ---------------- File ---------------- */

    'file.new': async () => {
      if (!(await confirmDiscard(app))) return;
      const v = await showDialog({
        title: 'New Image',
        fields: [
          { type: 'number', key: 'width', label: 'Width', value: 1200, min: 1, max: 20000, unit: 'px' },
          { type: 'number', key: 'height', label: 'Height', value: 800, min: 1, max: 20000, unit: 'px' },
          { type: 'select', key: 'background', label: 'Background', value: 'white', items: [['white', 'White'], ['transparent', 'Transparent'], ['secondary', 'Secondary colour']] }
        ],
        okLabel: 'Create'
      });
      if (!v) return;
      const fill = v.background === 'white' ? '#ffffff'
        : v.background === 'secondary' ? toCss(app.secondaryColor)
        : null;
      app.setDocument(PaintDocument.blank(Math.round(v.width), Math.round(v.height), fill), { name: 'Untitled' });
    },

    'file.open': async () => {
      if (!(await confirmDiscard(app))) return;
      const path = await window.api.openDialog();
      if (path) await openPath(app, path);
    },

    'file.openPath': async ({ path }) => {
      if (!(await confirmDiscard(app))) return;
      await openPath(app, path);
    },

    'file.save': async () => saveDocument(app, false),
    'file.saveAs': async () => saveDocument(app, true),

    'file.export': async () => {
      const base = (doc().fileName || 'Untitled').replace(/\.[^.]+$/, '');
      const path = await window.api.saveDialog({
        defaultPath: `${base}.png`,
        filters: [
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
          { name: 'WebP', extensions: ['webp'] }
        ]
      });
      if (!path) return;
      const ext = path.split('.').pop().toLowerCase();
      let quality = 0.92;
      if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp') {
        const v = await showDialog({
          title: 'Export Quality',
          fields: [{ type: 'range', key: 'quality', label: 'Quality', value: 92, min: 1, max: 100, step: 1, unit: '%' }],
          okLabel: 'Export'
        });
        if (!v) return;
        quality = v.quality / 100;
      }
      const bytes = await io.exportBytes(doc(), ext, quality);
      await window.api.writeFile(path, bytes);
      app.setStatus(`Exported to ${path.split('/').pop()}`);
    },

    /* ---------------- Edit ---------------- */

    'edit.undo': () => app.undo(),
    'edit.redo': () => app.redo(),

    'edit.copy': async () => {
      const ext = extractSelection(doc(), sel(), doc().activeLayer);
      if (!ext) return app.setStatus('Nothing to copy.');
      await io.copyCanvasToClipboard(ext.canvas);
      app.setStatus('Copied.');
    },

    'edit.copyMerged': async () => {
      app.commitFloating();
      const flat = doc().flatten();
      const layerLike = { canvas: flat, ctx: flat.getContext('2d'), touch() {} };
      const ext = extractSelection(doc(), sel(), layerLike);
      if (!ext) return app.setStatus('Nothing to copy.');
      await io.copyCanvasToClipboard(ext.canvas);
      app.setStatus('Copied merged.');
    },

    'edit.cut': async () => {
      const layer = doc().activeLayer;
      const ext = extractSelection(doc(), sel(), layer);
      if (!ext) return app.setStatus('Nothing to cut.');
      await io.copyCanvasToClipboard(ext.canvas);
      eraseRegion(app, layer, 'Cut');
      app.view.render();
    },

    'edit.paste': async () => {
      const canvas = await io.readClipboardCanvas();
      if (!canvas) return app.setStatus('The clipboard has no image.');
      app.commitFloating();
      const layer = doc().activeLayer;
      // Paste lands at the top-left of the selection, or of the canvas.
      const at = sel().bounds || { x: 0, y: 0 };
      const r = normalizeRect({ x: at.x, y: at.y, w: canvas.width, h: canvas.height }, doc().width, doc().height);
      if (!r) return app.setStatus('The pasted image lands outside the canvas.');
      const before = makeCanvas(r.w, r.h);
      before.getContext('2d').drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      layer.ctx.drawImage(canvas, at.x, at.y);
      layer.touch();
      doc().invalidate(r);
      app.pushHistory(regionEdit(doc(), layer, r, before, 'Paste'));
      app.setTool('move-pixels');
      app.view.render();
    },

    'edit.pasteLayer': async () => {
      const canvas = await io.readClipboardCanvas();
      if (!canvas) return app.setStatus('The clipboard has no image.');
      app.commitFloating();
      const before = captureDocState(doc(), sel());
      const layer = new Layer(doc().width, doc().height, 'Pasted Layer');
      layer.ctx.drawImage(canvas, 0, 0);
      doc().addLayer(layer);
      app.pushHistory(docStateEdit(doc(), sel(), before, 'Paste Into New Layer'));
      app.view.render();
    },

    'edit.eraseSelection': () => {
      const layer = doc().activeLayer;
      if (!layer) return;
      eraseRegion(app, layer, 'Erase Selection');
      app.view.render();
    },

    'edit.fillSelection': () => {
      const layer = doc().activeLayer;
      if (!layer) return;
      const r = normalizeRect(sel().clipRect(), doc().width, doc().height);
      if (!r) return;
      const before = makeCanvas(r.w, r.h);
      before.getContext('2d').drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const css = toCss({ ...app.primaryColor, a: 1 });
      paintOp(app, layer, r, (ctx) => {
        ctx.fillStyle = css;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }, { alpha: app.primaryColor.a });
      app.pushHistory(regionEdit(doc(), layer, r, before, 'Fill Selection'));
      app.view.render();
    },

    'select.all': () => {
      const before = sel().snapshot();
      sel().selectAll();
      app.pushHistory(selectionEdit(doc(), sel(), before, 'Select All'));
      doc().emit('selection-changed');
    },

    'select.none': () => {
      app.commitFloating();
      if (!sel().active) return;
      const before = sel().snapshot();
      sel().clear();
      app.pushHistory(selectionEdit(doc(), sel(), before, 'Deselect'));
      doc().emit('selection-changed');
    },

    'select.invert': () => {
      app.commitFloating();
      const before = sel().snapshot();
      sel().invert();
      app.pushHistory(selectionEdit(doc(), sel(), before, 'Invert Selection'));
      doc().emit('selection-changed');
    },

    /* ---------------- Image ---------------- */

    'image.crop': () => {
      app.commitFloating();
      if (!tf.cropToSelection(app)) app.setStatus('Make a selection first.');
      else app.view.fitToWindow();
    },

    'image.trim': () => {
      app.commitFloating();
      if (!tf.trimTransparent(app)) app.setStatus('Nothing to trim.');
      else app.view.fitToWindow();
    },

    'image.resize': async () => {
      app.commitFloating();
      const w0 = doc().width, h0 = doc().height;
      const v = await showDialog({
        title: 'Resize Image',
        fields: [
          { type: 'select', key: 'unit', label: 'Resize by', value: 'pixels', items: [['pixels', 'Absolute size'], ['percent', 'Percentage']] },
          { type: 'number', key: 'width', label: 'Width', value: w0, min: 1, max: 20000, unit: 'px' },
          { type: 'number', key: 'height', label: 'Height', value: h0, min: 1, max: 20000, unit: 'px' },
          { type: 'number', key: 'percent', label: 'Percentage', value: 100, min: 1, max: 2000, unit: '%' },
          { type: 'toggle', key: 'ratio', label: 'Maintain aspect ratio', value: true },
          { type: 'toggle', key: 'smooth', label: 'Smooth resampling', value: true }
        ],
        okLabel: 'Resize',
        onChange: (values, api, key) => {
          if (!values.ratio) return;
          // setValue does not re-fire onChange, so linking the two fields
          // cannot ping-pong.
          if (key === 'width') api.setValue('height', Math.max(1, Math.round(values.width * h0 / w0)));
          else if (key === 'height') api.setValue('width', Math.max(1, Math.round(values.height * w0 / h0)));
        }
      });
      if (!v) return;
      const w = v.unit === 'percent' ? Math.round((w0 * v.percent) / 100) : Math.round(v.width);
      const h = v.unit === 'percent' ? Math.round((h0 * v.percent) / 100) : Math.round(v.height);
      if (tf.resizeImage(app, w, h, { smooth: v.smooth })) app.view.fitToWindow();
    },

    'image.canvasSize': async () => {
      app.commitFloating();
      const v = await showDialog({
        title: 'Canvas Size',
        fields: [
          { type: 'number', key: 'width', label: 'Width', value: doc().width, min: 1, max: 20000, unit: 'px' },
          { type: 'number', key: 'height', label: 'Height', value: doc().height, min: 1, max: 20000, unit: 'px' },
          { type: 'select', key: 'anchor', label: 'Anchor', value: 'center', items: [
            ['top-left', 'Top left'], ['top', 'Top'], ['top-right', 'Top right'],
            ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'],
            ['bottom-left', 'Bottom left'], ['bottom', 'Bottom'], ['bottom-right', 'Bottom right']
          ] }
        ],
        okLabel: 'Resize'
      });
      if (!v) return;
      tf.resizeCanvas(app, v.width, v.height, v.anchor);
      app.view.fitToWindow();
    },

    'image.flipH': () => { app.commitFloating(); tf.flipImage(app, true); },
    'image.flipV': () => { app.commitFloating(); tf.flipImage(app, false); },
    'image.rotateCW': () => { app.commitFloating(); tf.rotateImage(app, 1); app.view.fitToWindow(); },
    'image.rotateCCW': () => { app.commitFloating(); tf.rotateImage(app, 3); app.view.fitToWindow(); },
    'image.rotate180': () => { app.commitFloating(); tf.rotateImage(app, 2); },

    'image.rotateArbitrary': async () => {
      app.commitFloating();
      const v = await showDialog({
        title: 'Arbitrary Rotate',
        fields: [
          { type: 'range', key: 'angle', label: 'Angle', value: 0, min: -180, max: 180, step: 1, unit: '°' },
          { type: 'toggle', key: 'expand', label: 'Expand canvas to fit', value: true },
          { type: 'toggle', key: 'smooth', label: 'Smooth resampling', value: true }
        ],
        okLabel: 'Rotate'
      });
      if (!v || v.angle === 0) return;
      tf.rotateImageArbitrary(app, v.angle, { expand: v.expand, smooth: v.smooth });
      app.view.fitToWindow();
    },

    'image.flatten': () => { app.commitFloating(); tf.flattenImage(app); },

    /* ---------------- Layers ---------------- */

    'layer.add': () => { app.commitFloating(); app.addLayer(); },

    'layer.duplicate': () => {
      app.commitFloating();
      const before = captureDocState(doc(), sel());
      const src = doc().activeLayer;
      if (!src) return;
      doc().addLayer(src.clone());
      app.pushHistory(docStateEdit(doc(), sel(), before, 'Duplicate Layer'));
    },

    'layer.delete': () => {
      app.commitFloating();
      if (doc().layers.length <= 1) return app.setStatus('An image needs at least one layer.');
      const before = captureDocState(doc(), sel());
      doc().removeLayerAt(doc().activeIndex);
      app.pushHistory(docStateEdit(doc(), sel(), before, 'Delete Layer'));
    },

    'layer.mergeDown': () => {
      app.commitFloating();
      if (!tf.mergeLayerDown(app)) app.setStatus('The bottom layer has nothing to merge into.');
    },

    'layer.moveUp': () => moveActiveLayer(app, 1),
    'layer.moveDown': () => moveActiveLayer(app, -1),

    'layer.import': async () => {
      const path = await window.api.openDialog();
      if (!path) return;
      const file = await window.api.readFile(path);
      const bytes = new Uint8Array(file.data);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: io.mimeForExtension(file.ext) }));
      app.commitFloating();
      const before = captureDocState(doc(), sel());
      const layer = new Layer(doc().width, doc().height, file.name.replace(/\.[^.]+$/, ''));
      layer.ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      doc().addLayer(layer);
      app.pushHistory(docStateEdit(doc(), sel(), before, 'Import Layer'));
    },

    'layer.properties': async () => {
      const layer = doc().activeLayer;
      if (!layer) return;
      const beforeMeta = { name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode };
      const v = await showDialog({
        title: 'Layer Properties',
        fields: [
          { type: 'text', key: 'name', label: 'Name', value: layer.name, wide: true },
          { type: 'toggle', key: 'visible', label: 'Visible', value: layer.visible },
          { type: 'range', key: 'opacity', label: 'Opacity', value: Math.round(layer.opacity * 100), min: 0, max: 100, step: 1, unit: '%' },
          { type: 'select', key: 'blendMode', label: 'Blend mode', value: layer.blendMode, items: BLEND_MODES }
        ],
        onChange: (values) => {
          layer.name = values.name;
          layer.visible = values.visible;
          layer.opacity = values.opacity / 100;
          layer.blendMode = values.blendMode;
          doc().invalidateAll();
          doc().emit('layers-changed');
          app.view.render();
        }
      });
      if (!v) {
        Object.assign(layer, beforeMeta);
        doc().invalidateAll();
        doc().emit('layers-changed');
        app.view.render();
        return;
      }
      app.pushHistory(metaEdit(doc(), layer, beforeMeta, 'Layer Properties'));
    },

    'layer.flipH': () => { app.commitFloating(); tf.flipLayer(app, true); },
    'layer.flipV': () => { app.commitFloating(); tf.flipLayer(app, false); },

    'layer.rotateZoom': async () => {
      app.commitFloating();
      const layer = doc().activeLayer;
      if (!layer) return;
      const original = makeCanvas(layer.width, layer.height);
      original.getContext('2d').drawImage(layer.canvas, 0, 0);

      const preview = (v) => {
        const g = layer.ctx;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, layer.width, layer.height);
        g.translate(layer.width / 2 + v.panX, layer.height / 2 + v.panY);
        g.rotate((v.angle * Math.PI) / 180);
        g.scale(v.zoom / 100, v.zoom / 100);
        g.drawImage(original, -layer.width / 2, -layer.height / 2);
        g.restore();
        layer.touch();
        doc().invalidateAll();
        app.view.render();
      };

      const v = await showDialog({
        title: 'Rotate / Zoom Layer',
        fields: [
          { type: 'range', key: 'angle', label: 'Angle', value: 0, min: -180, max: 180, step: 1, unit: '°' },
          { type: 'range', key: 'zoom', label: 'Zoom', value: 100, min: 5, max: 500, step: 1, unit: '%' },
          { type: 'range', key: 'panX', label: 'Pan X', value: 0, min: -1000, max: 1000, step: 1, unit: 'px' },
          { type: 'range', key: 'panY', label: 'Pan Y', value: 0, min: -1000, max: 1000, step: 1, unit: 'px' }
        ],
        okLabel: 'Apply',
        onChange: preview
      });

      // Restore the original, then re-apply through the undoable path.
      const g = layer.ctx;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, layer.width, layer.height);
      g.drawImage(original, 0, 0);
      g.restore();
      layer.touch();
      doc().invalidateAll();
      if (v) tf.rotateZoomLayer(app, { angle: v.angle, zoom: v.zoom / 100, panX: v.panX, panY: v.panY });
      app.view.render();
    },

    /* ---------------- Adjustments ---------------- */

    'adjust.invert': () => applyFilter(app, adj.invert, {}, 'Invert Colours'),
    'adjust.blackAndWhite': () => applyFilter(app, adj.blackAndWhite, {}, 'Black and White'),
    'adjust.sepia': () => applyFilter(app, adj.sepia, {}, 'Sepia'),
    'adjust.autoLevel': () => applyFilter(app, adj.autoLevel, {}, 'Auto Level'),

    'adjust.brightnessContrast': () => showEffectDialog(app, {
      title: 'Brightness / Contrast',
      filter: adj.brightnessContrast,
      fields: [
        { type: 'range', key: 'brightness', label: 'Brightness', value: 0, min: -100, max: 100, step: 1 },
        { type: 'range', key: 'contrast', label: 'Contrast', value: 0, min: -100, max: 100, step: 1 }
      ]
    }),

    'adjust.hueSaturation': () => showEffectDialog(app, {
      title: 'Hue / Saturation',
      filter: adj.hueSaturation,
      fields: [
        { type: 'range', key: 'hue', label: 'Hue', value: 0, min: -180, max: 180, step: 1, unit: '°' },
        { type: 'range', key: 'saturation', label: 'Saturation', value: 100, min: 0, max: 200, step: 1, unit: '%' },
        { type: 'range', key: 'lightness', label: 'Lightness', value: 0, min: -100, max: 100, step: 1 }
      ]
    }),

    'adjust.posterize': () => showEffectDialog(app, {
      title: 'Posterize',
      filter: adj.posterize,
      fields: [{ type: 'range', key: 'levels', label: 'Levels', value: 6, min: 2, max: 64, step: 1 }]
    }),

    'adjust.temperature': () => showEffectDialog(app, {
      title: 'Colour Temperature',
      filter: adj.temperature,
      fields: [
        { type: 'range', key: 'temp', label: 'Temperature', value: 0, min: -100, max: 100, step: 1 },
        { type: 'range', key: 'tint', label: 'Tint', value: 0, min: -100, max: 100, step: 1 }
      ]
    }),

    'adjust.levels': () => {
      const session = new EffectSession(app, 'Levels');
      if (!session.ok) return;
      const bins = adj.histogram(session.srcData.data);
      const peak = Math.max(1, ...bins);
      return runSessionDialog(app, session, adj.levels, {
        title: 'Levels',
        fields: [
          canvasField(300, 90, (ctx) => {
            ctx.fillStyle = '#1b1b1b';
            ctx.fillRect(0, 0, 300, 90);
            ctx.fillStyle = '#7aa8ff';
            for (let i = 0; i < 256; i++) {
              const hgt = (bins[i] / peak) * 88;
              ctx.fillRect((i / 256) * 300, 90 - hgt, 300 / 256 + 0.5, hgt);
            }
          }),
          { type: 'range', key: 'inLow', label: 'Input black', value: 0, min: 0, max: 255, step: 1 },
          { type: 'range', key: 'inHigh', label: 'Input white', value: 255, min: 0, max: 255, step: 1 },
          { type: 'range', key: 'gamma', label: 'Gamma', value: 1, min: 0.1, max: 3, step: 0.01 },
          { type: 'range', key: 'outLow', label: 'Output black', value: 0, min: 0, max: 255, step: 1 },
          { type: 'range', key: 'outHigh', label: 'Output white', value: 255, min: 0, max: 255, step: 1 }
        ]
      });
    },

    'adjust.curves': () => {
      const session = new EffectSession(app, 'Curves');
      if (!session.ok) return;
      const points = [[0, 0], [64, 64], [128, 128], [192, 192], [255, 255]];
      let dragIndex = -1;

      const curve = canvasField(260, 260, (ctx) => {
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(0, 0, 260, 260);
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const p = (i / 4) * 260;
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 260); ctx.moveTo(0, p); ctx.lineTo(260, p); ctx.stroke();
        }
        const lut = adj.buildCurveLut(points);
        ctx.strokeStyle = '#7aa8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
          const x = (i / 255) * 260;
          const y = 260 - (lut[i] / 255) * 260;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const [px, py] of points) {
          ctx.beginPath();
          ctx.arc((px / 255) * 260, 260 - (py / 255) * 260, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }, (nx, ny, e, redraw) => {
        const x = nx * 255, y = (1 - ny) * 255;
        if (e.type === 'pointerdown') {
          dragIndex = points.reduce((best, p, i) =>
            Math.abs(p[0] - x) < Math.abs(points[best][0] - x) ? i : best, 0);
        }
        if (dragIndex > 0 && dragIndex < points.length - 1) points[dragIndex][0] = Math.round(x);
        points[dragIndex][1] = Math.round(Math.max(0, Math.min(255, y)));
        points.sort((a, b) => a[0] - b[0]);
        redraw();
        session.preview(adj.curves, { points, channel: 'rgb' });
      });

      return runSessionDialog(app, session, adj.curves, {
        title: 'Curves',
        fields: [curve, { type: 'note', text: 'Drag the control points to reshape the tone curve.' }],
        staticParams: () => ({ points, channel: 'rgb' })
      });
    },

    /* ---------------- Effects ---------------- */

    'effect.gaussianBlur': () => showEffectDialog(app, {
      title: 'Gaussian Blur', filter: fx.gaussianBlur,
      fields: [{ type: 'range', key: 'radius', label: 'Radius', value: 5, min: 0, max: 100, step: 1, unit: 'px' }]
    }),

    'effect.motionBlur': () => showEffectDialog(app, {
      title: 'Motion Blur', filter: fx.motionBlur,
      fields: [
        { type: 'range', key: 'angle', label: 'Angle', value: 25, min: -180, max: 180, step: 1, unit: '°' },
        { type: 'range', key: 'distance', label: 'Distance', value: 20, min: 1, max: 200, step: 1, unit: 'px' },
        { type: 'toggle', key: 'centered', label: 'Centred', value: true }
      ]
    }),

    'effect.zoomBlur': () => showEffectDialog(app, {
      title: 'Zoom Blur', filter: fx.zoomBlur,
      fields: [{ type: 'range', key: 'amount', label: 'Amount', value: 20, min: 0, max: 100, step: 1 }]
    }),

    'effect.pixelate': () => showEffectDialog(app, {
      title: 'Pixelate', filter: fx.pixelate,
      fields: [{ type: 'range', key: 'size', label: 'Cell size', value: 8, min: 2, max: 100, step: 1, unit: 'px' }]
    }),

    'effect.sharpen': () => showEffectDialog(app, {
      title: 'Sharpen', filter: fx.sharpen,
      fields: [{ type: 'range', key: 'amount', label: 'Amount', value: 50, min: 0, max: 300, step: 1, unit: '%' }]
    }),

    'effect.unsharp': () => showEffectDialog(app, {
      title: 'Unsharp Mask', filter: fx.unsharpMask,
      fields: [
        { type: 'range', key: 'radius', label: 'Radius', value: 4, min: 1, max: 50, step: 1, unit: 'px' },
        { type: 'range', key: 'amount', label: 'Amount', value: 80, min: 0, max: 300, step: 1, unit: '%' },
        { type: 'range', key: 'threshold', label: 'Threshold', value: 0, min: 0, max: 100, step: 1 }
      ]
    }),

    'effect.glow': () => showEffectDialog(app, {
      title: 'Glow', filter: fx.glow,
      fields: [
        { type: 'range', key: 'radius', label: 'Radius', value: 8, min: 1, max: 60, step: 1, unit: 'px' },
        { type: 'range', key: 'brightness', label: 'Brightness', value: 20, min: -100, max: 100, step: 1 },
        { type: 'range', key: 'contrast', label: 'Contrast', value: 10, min: -100, max: 100, step: 1 }
      ]
    }),

    'effect.vignette': () => showEffectDialog(app, {
      title: 'Vignette', filter: fx.vignette,
      fields: [
        { type: 'range', key: 'radius', label: 'Radius', value: 60, min: 0, max: 100, step: 1, unit: '%' },
        { type: 'range', key: 'softness', label: 'Softness', value: 50, min: 1, max: 100, step: 1, unit: '%' },
        { type: 'range', key: 'amount', label: 'Amount', value: 70, min: 0, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.edgeDetect': () => showEffectDialog(app, {
      title: 'Edge Detect', filter: fx.edgeDetect,
      fields: [{ type: 'range', key: 'amount', label: 'Amount', value: 100, min: 10, max: 400, step: 5, unit: '%' }]
    }),

    'effect.emboss': () => showEffectDialog(app, {
      title: 'Emboss', filter: fx.emboss,
      fields: [{ type: 'range', key: 'angle', label: 'Angle', value: 45, min: -180, max: 180, step: 1, unit: '°' }]
    }),

    'effect.outline': () => showEffectDialog(app, {
      title: 'Outline', filter: fx.outline,
      fields: [
        { type: 'range', key: 'thickness', label: 'Thickness', value: 2, min: 1, max: 10, step: 1, unit: 'px' },
        { type: 'range', key: 'intensity', label: 'Intensity', value: 50, min: 0, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.oil': () => showEffectDialog(app, {
      title: 'Oil Painting', filter: fx.oilPainting,
      fields: [
        { type: 'range', key: 'radius', label: 'Brush size', value: 3, min: 1, max: 8, step: 1 },
        { type: 'range', key: 'levels', label: 'Coarseness', value: 20, min: 2, max: 64, step: 1 }
      ]
    }),

    'effect.addNoise': () => showEffectDialog(app, {
      title: 'Add Noise', filter: fx.addNoise,
      fields: [
        { type: 'range', key: 'intensity', label: 'Intensity', value: 30, min: 0, max: 100, step: 1 },
        { type: 'range', key: 'colorSaturation', label: 'Colour', value: 40, min: 0, max: 100, step: 1 },
        { type: 'range', key: 'coverage', label: 'Coverage', value: 100, min: 1, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.median': () => showEffectDialog(app, {
      title: 'Median', filter: fx.median,
      fields: [{ type: 'range', key: 'radius', label: 'Radius', value: 2, min: 1, max: 8, step: 1, unit: 'px' }]
    }),

    'effect.reduceNoise': () => showEffectDialog(app, {
      title: 'Reduce Noise', filter: fx.reduceNoise,
      fields: [
        { type: 'range', key: 'radius', label: 'Radius', value: 3, min: 1, max: 8, step: 1, unit: 'px' },
        { type: 'range', key: 'strength', label: 'Strength', value: 40, min: 1, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.bulge': () => showEffectDialog(app, {
      title: 'Bulge', filter: fx.bulge,
      fields: [{ type: 'range', key: 'amount', label: 'Amount', value: 45, min: -100, max: 100, step: 1 }]
    }),

    'effect.twist': () => showEffectDialog(app, {
      title: 'Twist', filter: fx.twist,
      fields: [
        { type: 'range', key: 'angle', label: 'Angle', value: 60, min: -720, max: 720, step: 5, unit: '°' },
        { type: 'range', key: 'radiusPct', label: 'Radius', value: 80, min: 5, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.tile': () => showEffectDialog(app, {
      title: 'Tile Reflection', filter: fx.tileReflection,
      fields: [
        { type: 'range', key: 'size', label: 'Tile size', value: 64, min: 8, max: 300, step: 1, unit: 'px' },
        { type: 'range', key: 'curvature', label: 'Curvature', value: 40, min: -100, max: 100, step: 1 }
      ]
    }),

    'effect.clouds': () => {
      const a = app.primaryColor, b = app.secondaryColor;
      const filter = (src, dst, w, h, p) => fx.clouds(src, dst, w, h, p, [a.r, a.g, a.b], [b.r, b.g, b.b]);
      return showEffectDialog(app, {
        title: 'Clouds', filter,
        fields: [
          { type: 'range', key: 'scale', label: 'Scale', value: 120, min: 4, max: 600, step: 2 },
          { type: 'range', key: 'roughness', label: 'Roughness', value: 50, min: 0, max: 100, step: 1, unit: '%' },
          { type: 'range', key: 'blend', label: 'Blend', value: 100, min: 0, max: 100, step: 1, unit: '%' },
          { type: 'number', key: 'seed', label: 'Seed', value: 1, min: 1, max: 99999 },
          { type: 'note', text: 'Rendered between the primary and secondary colours.' }
        ]
      });
    },

    'effect.julia': () => showEffectDialog(app, {
      title: 'Julia Fractal', filter: fx.julia,
      fields: [
        { type: 'range', key: 'cRe', label: 'Real', value: -0.4, min: -2, max: 2, step: 0.01 },
        { type: 'range', key: 'cIm', label: 'Imaginary', value: 0.6, min: -2, max: 2, step: 0.01 },
        { type: 'range', key: 'zoom', label: 'Zoom', value: 1, min: 0.2, max: 8, step: 0.1, unit: '×' },
        { type: 'range', key: 'iterations', label: 'Detail', value: 80, min: 8, max: 400, step: 4 },
        { type: 'range', key: 'blend', label: 'Blend', value: 100, min: 0, max: 100, step: 1, unit: '%' }
      ]
    }),

    'effect.repeat': () => {
      if (!app.lastEffect) return app.setStatus('No effect to repeat yet.');
      return showEffectDialog(app, app.lastEffect);
    },

    /* ---------------- View ---------------- */

    'view.zoomIn': () => app.view.zoomIn(),
    'view.zoomOut': () => app.view.zoomOut(),
    'view.zoom100': () => { app.view.setZoom(1); app.view.centerDocument(); app.view.render(); app.emit('view-changed'); },
    'view.fit': () => app.view.fitToWindow(),
    'view.grid': ({ value }) => { app.view.showGrid = value; app.view.render(); },
    'view.pixelGrid': ({ value }) => { app.view.showPixelGrid = value; app.view.render(); },
    'view.rulers': ({ value }) => {
      app.view.showRulers = value;
      document.getElementById('workarea').classList.toggle('no-rulers', !value);
      app.view.render();
      app.rulers.draw();
    },

    /* ---------------- Help ---------------- */

    'help.shortcuts': () => showShortcuts(),
    'help.website': () => window.api.openExternal(SITE_URL),
    'help.about': async () => {
      const version = await window.api.getVersion().catch(() => '');
      return showDialog({
        title: 'About Paint.mac',
        fields: [aboutPanel(version)],
        okLabel: 'Close',
        hideCancel: true
      });
    }
  };

  app.run = async (id, payload = {}) => {
    const fn = commands[id];
    if (!fn) { console.warn('Unknown command', id); return; }
    try {
      await fn(payload);
    } catch (err) {
      console.error(`Command ${id} failed`, err);
      app.setStatus(`${id} failed: ${err.message}`);
    }
  };

  window.api.onMenuCommand((payload) => app.run(payload.id, payload));

  // Buttons in the chrome carry a data-cmd attribute rather than their own handlers.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) app.run(btn.dataset.cmd);
  });

  window.api.onRequestClose(async () => {
    // Dev-only: simulates a wedged renderer, so the watchdog can be tested.
    if (new URLSearchParams(location.search).has('ignoreClose')) return;
    window.api.ackClose();   // tell main we are alive, before any prompt
    if (await confirmDiscard(app, true)) window.api.confirmClose();
    else window.api.cancelClose();
  });

  return commands;
}

/* ---------------- helpers ---------------- */

const AUTHOR = 'Al Roland';
const SITE = 'www.alroland.com/paint.mac';
const SITE_URL = 'https://www.alroland.com/paint.mac';

/** Contents of Help -> About. Built with DOM calls, never innerHTML. */
function aboutPanel(version) {
  return {
    type: 'custom',
    render() {
      const wrap = document.createElement('div');
      wrap.className = 'about';

      const icon = document.createElement('img');
      icon.className = 'about-icon';
      icon.src = 'assets/icon.png';
      icon.alt = '';
      icon.width = 96;
      icon.height = 96;

      const body = document.createElement('div');
      body.className = 'about-body';

      const line = (cls, text) => {
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = text;
        return el;
      };

      body.append(
        line('about-name', 'Paint.mac'),
        line('about-sub', 'A Paint.NET-style raster image editor for macOS.'),
        line('about-meta', version ? `Version ${version}` : ''),
        line('about-meta', 'Layers · selections · magic wand · adjustments · effects'),
        line('about-by', `By ${AUTHOR}`)
      );

      const link = document.createElement('a');
      link.className = 'about-link';
      link.href = SITE_URL;
      link.textContent = SITE;
      link.dataset.external = SITE_URL;
      link.addEventListener('click', (e) => {
        // Never navigate the app window; hand the URL to the OS instead.
        e.preventDefault();
        window.api.openExternal(SITE_URL);
      });
      body.appendChild(link);

      wrap.append(icon, body);
      return wrap;
    }
  };
}

/** Clears the selection from one layer, recording only the affected rect. */
function eraseRegion(app, layer, label) {
  const r = normalizeRect(app.selection.clipRect(), app.doc.width, app.doc.height);
  if (!r) return;
  const before = makeCanvas(r.w, r.h);
  before.getContext('2d').drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  eraseSelection(app.doc, app.selection, layer);
  app.pushHistory(regionEdit(app.doc, layer, r, before, label));
}

function moveActiveLayer(app, dir) {
  app.commitFloating();
  const doc = app.doc;
  const to = doc.activeIndex + dir;
  if (to < 0 || to >= doc.layers.length) return;
  const before = captureDocState(doc, app.selection);
  doc.moveLayer(doc.activeIndex, to);
  app.pushHistory(docStateEdit(doc, app.selection, before, dir > 0 ? 'Move Layer Up' : 'Move Layer Down'));
}

async function openPath(app, path) {
  const file = await window.api.readFile(path);
  const bytes = new Uint8Array(file.data);
  if (file.ext === `.${io.DOC_EXT}`) {
    const doc = await io.deserializeDocument(bytes);
    doc.fileName = file.name;
    app.setDocument(doc, { path, name: file.name });
  } else {
    const doc = await io.documentFromImageBytes(bytes, io.mimeForExtension(file.ext), file.name);
    app.setDocument(doc, { path: null, name: file.name });
    app.setStatus('Opened a flat image — use Save As to store it as a layered .pmac document.');
  }
}

async function saveDocument(app, forceDialog) {
  let path = app.doc.filePath;
  if (forceDialog || !path || !path.endsWith(`.${io.DOC_EXT}`)) {
    const base = (app.doc.fileName || 'Untitled').replace(/\.[^.]+$/, '');
    path = await window.api.saveDialog({
      defaultPath: `${base}.${io.DOC_EXT}`,
      filters: [{ name: 'Paint.mac Document', extensions: [io.DOC_EXT] }]
    });
    if (!path) return false;
  }
  const bytes = await io.serializeDocument(app.doc);
  await window.api.writeFile(path, bytes);
  app.doc.filePath = path;
  app.doc.fileName = path.split('/').pop();
  app.history.markSaved();
  app.doc.markDirty(false);
  app.updateTitle();
  window.api.setRepresentedFile(path);
  app.setStatus(`Saved ${app.doc.fileName}`);
  return true;
}

async function confirmDiscard(app, closing = false) {
  if (!app.doc.dirty) return true;
  // Dev-only: lets the shutdown test stand in for the user picking "Don't Save".
  if (new URLSearchParams(location.search).has('discard')) return true;
  const choice = await window.api.messageBox({
    type: 'warning',
    message: `Do you want to save the changes to “${app.doc.fileName}”?`,
    detail: 'Your changes will be lost if you don’t save them.',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2
  });
  if (choice === 2) return false;
  if (choice === 0) return saveDocument(app, false);
  return true;
}

/**
 * Runs a dialog against a pre-built EffectSession. Used by Levels and Curves,
 * which need the source histogram before the dialog opens.
 */
async function runSessionDialog(app, session, filter, { title, fields, staticParams }) {
  const run = (values) => session.preview(filter, staticParams ? staticParams() : values);
  const result = await showDialog({
    title,
    fields,
    okLabel: 'Apply',
    onChange: (values) => run(values),
    onOpen: (api) => run(api.values)
  });
  if (result) { session.commit(); return true; }
  session.cancel();
  return false;
}

function showShortcuts() {
  const rows = [
    ['h', 'Tools'],
    ['S / D / L / W', 'Rectangle · Ellipse · Lasso · Magic wand select'],
    ['M / N', 'Move selected pixels · Move selection outline'],
    ['P / B / E', 'Pencil · Paintbrush · Eraser'],
    ['F / G / K', 'Paint bucket · Gradient · Colour picker'],
    ['C / R / T', 'Clone stamp · Recolour · Text'],
    ['O / U / I / Y', 'Line · Rectangle · Ellipse · Polygon'],
    ['H / Z', 'Pan · Zoom'],
    ['h', 'Editing'],
    ['⌘Z / ⇧⌘Z', 'Undo · Redo'],
    ['⌘X / ⌘C / ⌘V', 'Cut · Copy · Paste'],
    ['⇧⌘C / ⇧⌘V', 'Copy merged · Paste into new layer'],
    ['⌫', 'Erase selection to transparent'],
    ['⌥⌫', 'Fill selection with the primary colour'],
    ['⌘A / ⌘D / ⌘I', 'Select all · Deselect · Invert selection'],
    ['⎋', 'Cancel the current drag, or deselect when nothing is in progress'],
    ['X', 'Swap primary and secondary colours'],
    ['[ / ]', 'Decrease · increase brush size'],
    ['h', 'View'],
    ['⌘+ / ⌘−', 'Zoom in · out'],
    ['⌘0 / ⌘B', 'Actual size · Fit to window'],
    ['Space + drag', 'Pan the canvas'],
    ['⌘-scroll / pinch', 'Zoom at the pointer'],
    ['h', 'Image'],
    ['⇧⌘X', 'Crop to selection'],
    ['⌘R / ⇧⌘R', 'Resize image · Canvas size'],
    ['⌘] / ⌘[', 'Rotate 90° clockwise · counter-clockwise'],
    ['⇧⌘F / ⌘M', 'Flatten · Merge layer down']
  ];
  const grid = {
    type: 'custom',
    render() {
      const d = document.createElement('div');
      d.className = 'shortcut-grid';
      for (const [k, v] of rows) {
        if (k === 'h') {
          const head = document.createElement('div');
          head.className = 'h';
          head.textContent = v;
          d.appendChild(head);
          continue;
        }
        const key = document.createElement('div');
        key.className = 'k';
        key.textContent = formatKeys(k);
        const desc = document.createElement('div');
        desc.textContent = v;
        d.append(key, desc);
      }
      return d;
    }
  };
  return showDialog({ title: 'Keyboard Shortcuts', fields: [grid], okLabel: 'Close', hideCancel: true });
}
