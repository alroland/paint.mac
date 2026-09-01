// Headless smoke test, run with `npm start -- --selftest`. Exercises the paths
// that are hard to eyeball: stroke + undo, selection masking, flood fill,
// transforms, filters and the .pmac round trip. Results go to the console,
// which the dev main process mirrors into the terminal.

import { PaintDocument, Layer } from './document.js';
import { magicWandMask } from './selection.js';
import { floodFill } from './paint.js';
import * as tf from './image/transform.js';
import * as adj from './image/adjustments.js';
import * as fx from './image/effects.js';
import { applyFilter } from './image/apply.js';
import * as io from './fileio.js';
import { COMBINE, featherMask } from './selection.js';
import { toolByShortcut } from './tools/index.js';
import { showTooltip, hideTooltip, configureTooltips } from './ui/tooltip.js';
import { formatKeys, rewriteKeys } from './platform.js';

const results = [];

const nextFrames = (n) => new Promise((resolve) => {
  const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  if (!cond) console.error(`SELFTEST FAIL — ${name} ${extra}`);
}

// One shared 1x1 readback surface, so probing pixels never turns a layer's
// GPU-backed context into a software one.
const probe = document.createElement('canvas');
probe.width = probe.height = 1;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });

function pixel(canvas, x, y) {
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
  return probeCtx.getImageData(0, 0, 1, 1).data;
}

const ev = (over = {}) => ({
  button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
  pointerType: 'mouse', pressure: 0.5, clientX: 0, clientY: 0, offsetX: 0, offsetY: 0, ...over
});

/**
 * Renders a document that exercises layers, blend modes, shapes, gradients,
 * text and a live selection, so a captured frame shows the real pipeline.
 */
function buildShowcase(app) {
  app.setDocument(PaintDocument.blank(900, 560, '#f5f2ea'), { name: 'Showcase' });
  const doc = app.doc;

  const bg = doc.layers[0];
  const grad = bg.ctx.createLinearGradient(0, 0, 900, 560);
  grad.addColorStop(0, '#fdf6e3');
  grad.addColorStop(1, '#d8e6f2');
  bg.ctx.fillStyle = grad;
  bg.ctx.fillRect(0, 0, 900, 560);
  bg.name = 'Background';
  bg.touch();

  const shapes = new Layer(900, 560, 'Shapes');
  const g = shapes.ctx;
  const radial = g.createRadialGradient(250, 220, 10, 250, 220, 170);
  radial.addColorStop(0, '#ff9d4d');
  radial.addColorStop(1, '#e2445c');
  g.fillStyle = radial;
  g.beginPath();
  g.arc(250, 220, 150, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = '#2f6fdb';
  g.beginPath();
  g.roundRect(430, 120, 300, 190, 22);
  g.fill();

  g.fillStyle = '#3ec98a';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (-Math.PI / 2) + (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 95 : 42;
    const x = 650 + Math.cos(a) * r;
    const y = 400 + Math.sin(a) * r;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  shapes.opacity = 0.9;
  shapes.blendMode = 'multiply';
  doc.addLayer(shapes);

  const text = new Layer(900, 560, 'Text');
  const t = text.ctx;
  t.font = '700 84px -apple-system, "SF Pro Text", Helvetica, sans-serif';
  t.fillStyle = '#1b2430';
  t.textBaseline = 'top';
  t.fillText('Paint.mac', 60, 420);
  t.font = '400 26px -apple-system, "SF Pro Text", Helvetica, sans-serif';
  t.fillStyle = '#5a6675';
  t.fillText('layers · selections · effects', 64, 512);
  doc.addLayer(text);

  const marquee = new Path2D();
  marquee.ellipse(560, 300, 210, 150, 0, 0, Math.PI * 2);
  app.selection.setFromPath(marquee);
  doc.emit('selection-changed');

  doc.setActive(1);
  doc.invalidateAll();
  app.setTool('select-ellipse');
}

export async function run(app) {
  app.setDocument(PaintDocument.blank(300, 200, '#ffffff'), { name: 'selftest' });
  const doc = app.doc;
  const layer = () => doc.activeLayer;

  /* --- brush stroke and undo --- */
  app.setTool('brush');
  app.setPrimaryColor({ r: 255, g: 0, b: 0, a: 1 });
  const brush = app.activeTool;
  brush.options.size = 20;
  brush.options.hardness = 100;
  brush.onDown({ x: 40, y: 40 }, ev());
  brush.onMove({ x: 120, y: 40 }, ev());
  brush.onUp({ x: 120, y: 40 }, ev({ buttons: 0 }));
  let px = pixel(layer().canvas, 80, 40);
  check('brush paints primary colour', px[0] > 200 && px[1] < 60, `got ${[...px]}`);
  check('brush recorded one history entry', app.history.entries.length === 1);

  app.undo();
  px = pixel(layer().canvas, 80, 40);
  check('undo restores pixels', px[0] > 240 && px[1] > 240, `got ${[...px]}`);
  app.redo();
  check('redo re-applies stroke', pixel(layer().canvas, 80, 40)[1] < 60);

  /* --- selection clipping --- */
  const sel = app.selection;
  const path = new Path2D();
  path.rect(200, 100, 50, 50);
  sel.setFromPath(path, COMBINE.REPLACE);
  check('selection bounds are exact', sel.bounds && sel.bounds.x === 200 && sel.bounds.y === 100 && sel.bounds.w === 50 && sel.bounds.h === 50,
    JSON.stringify(sel.bounds));

  app.setPrimaryColor({ r: 0, g: 0, b: 255, a: 1 });
  const b2 = app.activeTool;
  b2.onDown({ x: 150, y: 125 }, ev());
  b2.onMove({ x: 280, y: 125 }, ev());
  b2.onUp({ x: 280, y: 125 }, ev({ buttons: 0 }));
  const inside = pixel(layer().canvas, 220, 125);
  const outside = pixel(layer().canvas, 180, 125);
  check('paint lands inside the selection', inside[2] > 200, `got ${[...inside]}`);
  check('paint is clipped outside the selection', outside[2] > 240 && outside[0] > 240, `got ${[...outside]}`);

  sel.clear();

  /* --- magic wand --- */
  const flat = doc.flatten();
  const data = flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
  const wand = magicWandMask(data, doc.width, doc.height, 5, 180, 10, false);
  check('magic wand selects the white background', wand[180 * doc.width + 5] === 255);
  check('magic wand excludes the red stroke', wand[40 * doc.width + 80] === 0);

  /* --- flood fill --- */
  const fillLayer = layer();
  const filled = floodFill(app, fillLayer, 5, 190, { r: 0, g: 200, b: 0, a: 1 }, { tolerance: 10 });
  check('flood fill returns a dirty rect', !!filled);
  check('flood fill recolours the background', pixel(fillLayer.canvas, 5, 190)[1] > 150);

  /* --- layers --- */
  const before = doc.layers.length;
  app.addLayer('Test Layer');
  check('layer added', doc.layers.length === before + 1);
  check('new layer is active', doc.activeLayer.name === 'Test Layer');
  const merged = tf.mergeLayerDown(app);
  check('merge down succeeds', merged && doc.layers.length === before);

  /* --- adjustments --- */
  const beforeInvert = [...pixel(layer().canvas, 5, 190)];
  applyFilter(app, adj.invert, {}, 'Invert');
  const afterInvert = pixel(layer().canvas, 5, 190);
  check('invert flips channels', Math.abs(255 - beforeInvert[0] - afterInvert[0]) <= 1,
    `${beforeInvert} -> ${[...afterInvert]}`);
  app.undo();

  /* --- effects run without throwing --- */
  const w = 32, h = 32;
  const src = new Uint8ClampedArray(w * h * 4).fill(128);
  const dst = new Uint8ClampedArray(src.length);
  const effects = [
    ['gaussianBlur', { radius: 3 }], ['motionBlur', { angle: 30, distance: 8 }],
    ['zoomBlur', { amount: 20 }], ['pixelate', { size: 4 }], ['sharpen', { amount: 50 }],
    ['unsharpMask', { radius: 2, amount: 80, threshold: 0 }], ['edgeDetect', { amount: 100 }],
    ['emboss', { angle: 45 }], ['outline', { thickness: 2, intensity: 50 }],
    ['oilPainting', { radius: 2, levels: 10 }], ['glow', { radius: 4, brightness: 20, contrast: 10 }],
    ['vignette', { radius: 60, softness: 50, amount: 70 }], ['addNoise', { intensity: 30, colorSaturation: 40, coverage: 100 }],
    ['median', { radius: 2 }], ['reduceNoise', { radius: 2, strength: 40 }],
    ['bulge', { amount: 40 }], ['twist', { angle: 60, radiusPct: 80 }],
    ['tileReflection', { size: 16, curvature: 40 }], ['julia', { cRe: -0.4, cIm: 0.6, zoom: 1, iterations: 30, blend: 100 }]
  ];
  for (const [name, params] of effects) {
    try {
      fx[name](src, dst, w, h, params);
      check(`effect ${name} runs`, true);
    } catch (err) {
      check(`effect ${name} runs`, false, err.message);
    }
  }
  try {
    fx.clouds(src, dst, w, h, { scale: 20, roughness: 50, seed: 3, blend: 100 }, [0, 0, 0], [255, 255, 255]);
    check('effect clouds runs', true);
  } catch (err) {
    check('effect clouds runs', false, err.message);
  }

  /* --- transforms --- */
  const w0 = doc.width, h0 = doc.height;
  tf.rotateImage(app, 1);
  check('rotate 90 swaps dimensions', doc.width === h0 && doc.height === w0, `${doc.width}x${doc.height}`);
  app.undo();
  check('undo restores dimensions', doc.width === w0 && doc.height === h0, `${doc.width}x${doc.height}`);

  tf.resizeImage(app, 150, 100);
  check('resize changes dimensions', doc.width === 150 && doc.height === 100);
  check('resize resizes layer bitmaps', doc.layers.every((l) => l.width === 150 && l.height === 100));
  app.undo();
  check('undo restores size after resize', doc.width === w0 && doc.height === h0);

  const cropPath = new Path2D();
  cropPath.rect(10, 10, 80, 60);
  app.selection.setFromPath(cropPath, COMBINE.REPLACE);
  tf.cropToSelection(app);
  check('crop to selection resizes the document', doc.width === 80 && doc.height === 60, `${doc.width}x${doc.height}`);
  app.undo();
  app.selection.clear();

  tf.flipImage(app, true);
  check('flip horizontal keeps dimensions', doc.width === w0 && doc.height === h0);
  app.undo();

  /* --- shapes and text render something --- */
  app.setTool('shape-rect');
  const rectTool = app.activeTool;
  rectTool.options.style = 'fill';
  app.setPrimaryColor({ r: 20, g: 20, b: 20, a: 1 });
  app.setSecondaryColor({ r: 20, g: 20, b: 20, a: 1 });
  rectTool.onDown({ x: 20, y: 150 }, ev());
  rectTool.onMove({ x: 90, y: 190 }, ev());
  rectTool.onUp({ x: 90, y: 190 }, ev({ buttons: 0 }));
  const shapePx = pixel(layer().canvas, 55, 170);
  check('rectangle shape draws fill', shapePx[0] < 60 && shapePx[3] > 200, `got ${[...shapePx]}`);

  app.setTool('gradient');
  const grad = app.activeTool;
  grad.onDown({ x: 0, y: 0 }, ev());
  grad.onMove({ x: 299, y: 0 }, ev());
  grad.onUp({ x: 299, y: 0 }, ev({ buttons: 0 }));
  check('gradient commits without leaving an overlay', doc.overlay === null);

  /* --- .pmac round trip --- */
  doc.layers[0].name = 'RoundTrip';
  doc.layers[0].opacity = 0.5;
  doc.layers[0].blendMode = 'multiply';
  const bytes = await io.serializeDocument(doc);
  const reloaded = await io.deserializeDocument(bytes);
  check('round trip keeps dimensions', reloaded.width === doc.width && reloaded.height === doc.height);
  check('round trip keeps layer count', reloaded.layers.length === doc.layers.length);
  check('round trip keeps layer metadata',
    reloaded.layers[0].name === 'RoundTrip' && Math.abs(reloaded.layers[0].opacity - 0.5) < 1e-6 && reloaded.layers[0].blendMode === 'multiply');
  const a = pixel(doc.layers[0].canvas, 55, 170);
  const b = pixel(reloaded.layers[0].canvas, 55, 170);
  check('round trip preserves pixels', a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3],
    `${[...a]} vs ${[...b]}`);

  /* --- export --- */
  const png = await io.exportBytes(doc, 'png');
  check('PNG export produces bytes', png.length > 100 && png[0] === 0x89 && png[1] === 0x50);
  const jpg = await io.exportBytes(doc, 'jpg', 0.9);
  check('JPEG export produces bytes', jpg.length > 100 && jpg[0] === 0xff && jpg[1] === 0xd8);

  /* --- history navigation --- */
  const entries = app.history.entries.length;
  app.history.goTo(-1);
  check('history rewinds to the start', app.history.index === -1);
  app.history.goTo(entries - 1);
  check('history replays to the end', app.history.index === entries - 1);

  /* --- shape outline / fill colours and border styles --- */
  {
    const drag = (tool, x0, y0, x1, y1) => {
      tool.onDown({ x: x0, y: y0 }, ev());
      tool.onMove({ x: x1, y: y1 }, ev());
      tool.onUp({ x: x1, y: y1 }, ev({ buttons: 0 }));
    };

    app.setDocument(PaintDocument.blank(200, 200, null), { name: 'shape-colors' });
    app.setPrimaryColor({ r: 0, g: 0, b: 0, a: 1 });
    app.setSecondaryColor({ r: 255, g: 255, b: 255, a: 1 });
    app.setTool('shape-rect');
    const rect = app.activeTool;

    check('shape tools expose an outline colour', rect.schema.some((f) => f.key === 'strokeColor' && f.type === 'color'));
    check('shape tools expose a fill colour', rect.schema.some((f) => f.key === 'fillColor' && f.type === 'color'));
    check('shape tools expose a border style', rect.schema.some((f) => f.key === 'border' && f.type === 'select'));

    // Unpinned colours follow the palette.
    rect.options = { ...rect.options, style: 'fill', strokeColor: null, fillColor: null };
    drag(rect, 20, 20, 120, 120);
    let px = pixel(app.doc.activeLayer.canvas, 70, 70);
    check('unpinned fill follows the secondary colour', px[0] > 240 && px[1] > 240 && px[2] > 240, `got ${[...px]}`);
    app.undo();

    // Pinned fill colour wins over the palette.
    rect.options.fillColor = { r: 20, g: 190, b: 70, a: 1 };
    drag(rect, 20, 20, 120, 120);
    px = pixel(app.doc.activeLayer.canvas, 70, 70);
    check('pinned fill colour is used', px[0] < 60 && px[1] > 160 && px[2] < 110, `got ${[...px]}`);
    app.undo();

    // Pinned outline colour, independent of the fill.
    rect.options = { ...rect.options, style: 'outline', width: 10, strokeColor: { r: 210, g: 40, b: 30, a: 1 } };
    drag(rect, 30, 30, 150, 150);
    px = pixel(app.doc.activeLayer.canvas, 90, 30);
    check('pinned outline colour is used', px[0] > 170 && px[1] < 90 && px[2] < 80, `got ${[...px]}`);
    const middle = pixel(app.doc.activeLayer.canvas, 90, 90);
    check('outline style leaves the interior empty', middle[3] === 0, `alpha ${middle[3]}`);
    app.undo();

    // Right-drag swaps the two roles even when both are pinned.
    rect.options = { ...rect.options, style: 'fill', fillColor: { r: 20, g: 190, b: 70, a: 1 } };
    rect.onDown({ x: 20, y: 20 }, ev({ button: 2, buttons: 2 }));
    rect.onMove({ x: 120, y: 120 }, ev({ button: 2, buttons: 2 }));
    rect.onUp({ x: 120, y: 120 }, ev({ button: 2, buttons: 0 }));
    px = pixel(app.doc.activeLayer.canvas, 70, 70);
    check('right-drag swaps outline and fill colours', px[0] > 170 && px[1] < 90, `got ${[...px]}`);
    app.undo();

    // A dashed border must actually leave gaps along the edge.
    for (const border of ['dash', 'dot', 'dashdot']) {
      rect.options = { ...rect.options, style: 'outline', border, width: 6, strokeColor: { r: 0, g: 0, b: 0, a: 1 } };
      drag(rect, 20, 20, 180, 180);
      let opaque = 0, clear = 0;
      for (let x = 30; x < 170; x++) {
        const a = pixel(app.doc.activeLayer.canvas, x, 20)[3];
        if (a > 200) opaque++;
        else if (a < 20) clear++;
      }
      check(`border style "${border}" draws dashes`, opaque > 5 && clear > 5, `${opaque} on, ${clear} off`);
      app.undo();
    }

    rect.options = { ...rect.options, border: 'solid' };
    drag(rect, 20, 20, 180, 180);
    let solidGaps = 0;
    for (let x = 30; x < 170; x++) if (pixel(app.doc.activeLayer.canvas, x, 20)[3] < 20) solidGaps++;
    check('border style "solid" has no gaps', solidGaps === 0, `${solidGaps} gaps`);
    app.undo();

    // Line ends: the base class used to overwrite lineCap, so Flat did nothing.
    app.setTool('line');
    const line = app.activeTool;
    line.options = { ...line.options, width: 20, cap: 'butt', border: 'solid', strokeColor: { r: 0, g: 0, b: 0, a: 1 } };
    drag(line, 40, 100, 120, 100);
    const pastEndFlat = pixel(app.doc.activeLayer.canvas, 128, 100)[3];
    check('flat line ends stop at the endpoint', pastEndFlat === 0, `alpha ${pastEndFlat}`);
    app.undo();

    line.options.cap = 'round';
    drag(line, 40, 100, 120, 100);
    const pastEndRound = pixel(app.doc.activeLayer.canvas, 128, 100)[3];
    check('round line ends extend past the endpoint', pastEndRound > 200, `alpha ${pastEndRound}`);
    app.undo();

    // The options bar should actually render the new controls.
    app.setTool('shape-ellipse');
    const swatches = document.querySelectorAll('#optionsbar .color-opt');
    check('options bar renders colour swatches', swatches.length === 2, `${swatches.length} found`);
    check('unpinned swatches are marked as following the palette',
      [...swatches].every((b) => b.classList.contains('linked')));
    check('options bar renders the border style menu',
      [...document.querySelectorAll('#optionsbar select')].some((sel) => sel.options.length === 5));
  }

  /* --- paint bucket feathering --- */
  {
    // Two flat regions with a hard vertical seam at x = 100, so the edge
    // treatment of a fill is easy to measure along one scanline.
    const makeSplit = () => {
      app.setDocument(PaintDocument.blank(200, 100, null), { name: 'feather-fill' });
      const g = app.doc.activeLayer.ctx;
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 100, 100);
      g.fillStyle = '#000000'; g.fillRect(100, 0, 100, 100);
      app.doc.activeLayer.touch();
      app.doc.invalidateAll();
    };
    const greenAcrossSeam = () => {
      const vals = [];
      for (let x = 88; x <= 112; x++) vals.push(pixel(app.doc.activeLayer.canvas, x, 50)[1]);
      return vals;
    };
    const fillColor = { r: 0, g: 200, b: 0, a: 1 };

    app.setTool('bucket');
    const bucket = app.activeTool;
    check('paint bucket exposes a feather option',
      bucket.schema.some((f) => f.key === 'feather' && f.type === 'range'));

    makeSplit();
    floodFill(app, app.doc.activeLayer, 10, 50, fillColor, { tolerance: 10, feather: 0 });
    const hard = greenAcrossSeam();
    check('unfeathered fill has a hard edge', new Set(hard).size === 2, `${new Set(hard).size} levels`);

    makeSplit();
    floodFill(app, app.doc.activeLayer, 10, 50, fillColor, { tolerance: 10, feather: 8 });
    const soft = greenAcrossSeam();
    check('feathered fill ramps across the edge', new Set(soft).size > 5, `${new Set(soft).size} levels`);

    // Recover the fill's alpha from the composited pixels: green over white on
    // the left of the seam, green over black on the right.
    const alphaAt = (x) => {
      const g = pixel(app.doc.activeLayer.canvas, x, 50)[1];
      return x < 100 ? (255 - g) / 55 : g / 200;
    };
    check('feathered fill bleeds past the original edge', alphaAt(101) > 0.05,
      `alpha ${alphaAt(101).toFixed(2)}`);
    check('feathered fill is ~50% at the seam',
      Math.abs(alphaAt(99) - 0.5) < 0.25 || Math.abs(alphaAt(100) - 0.5) < 0.25,
      `${alphaAt(99).toFixed(2)} / ${alphaAt(100).toFixed(2)}`);

    // The band should be about as wide as the number on the slider — the whole
    // point of calibrating the blur radius.
    let band = 0;
    for (let x = 70; x <= 130; x++) {
      const a = alphaAt(x);
      if (a > 0.02 && a < 0.98) band++;
    }
    check('feather 8 softens roughly an 8px band', band >= 4 && band <= 20, `${band}px`);
    const core = pixel(app.doc.activeLayer.canvas, 20, 50);
    check('feathering leaves the interior fully filled',
      core[0] === 0 && core[1] === 200 && core[2] === 0, `got ${[...core]}`);
    check('feathering does not fade against the canvas edge',
      pixel(app.doc.activeLayer.canvas, 0, 50)[1] === 200,
      `g=${pixel(app.doc.activeLayer.canvas, 0, 50)[1]}`);

    // A feathered fill must still respect the selection it is drawn inside.
    makeSplit();
    const clip = new Path2D();
    clip.rect(0, 0, 60, 100);
    app.selection.setFromPath(clip, COMBINE.REPLACE);
    floodFill(app, app.doc.activeLayer, 10, 50, fillColor, { tolerance: 10, feather: 12 });
    check('feathered fill stays inside the selection',
      pixel(app.doc.activeLayer.canvas, 75, 50)[1] === 255,
      `g=${pixel(app.doc.activeLayer.canvas, 75, 50)[1]}`);
    app.selection.clear();

    // The blur runs on a crop of the hit mask, so cost tracks the fill, not the page.
    app.setDocument(PaintDocument.blank(1200, 800, null), { name: 'feather-perf' });
    const bg = app.doc.activeLayer.ctx;
    bg.fillStyle = '#ffffff'; bg.fillRect(0, 0, 600, 800);
    bg.fillStyle = '#101010'; bg.fillRect(600, 0, 600, 800);
    app.doc.activeLayer.touch();
    app.doc.invalidateAll();
    const t0 = performance.now();
    floodFill(app, app.doc.activeLayer, 10, 10, fillColor, { tolerance: 10, feather: 20 });
    const ms = performance.now() - t0;
    check('feathered fill stays fast on a large image', ms < 900, `${ms.toFixed(0)}ms`);
  }

  /* --- Escape deselects, but only when nothing is in progress --- */
  {
    const pressEscape = () => window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const selectBox = (x, y, w, h) => {
      const p = new Path2D();
      p.rect(x, y, w, h);
      app.selection.setFromPath(p, COMBINE.REPLACE);
      app.doc.emit('selection-changed');
    };

    app.setDocument(PaintDocument.blank(200, 200, '#ffffff'), { name: 'escape' });
    app.setTool('select-rect');

    selectBox(20, 20, 80, 80);
    check('selection is active before Escape', app.selection.active);
    pressEscape();
    check('Escape clears the selection', !app.selection.active);
    check('Escape records an undoable step',
      app.history.entries[app.history.index]?.label === 'Deselect',
      app.history.entries[app.history.index]?.label);

    app.undo();
    check('undo brings the selection back', app.selection.active);

    // Escape with nothing selected must not push a history entry.
    app.run('select.none');
    const depth = app.history.entries.length;
    pressEscape();
    pressEscape();
    check('Escape with no selection is a no-op', app.history.entries.length === depth,
      `${app.history.entries.length} vs ${depth}`);

    // Mid-drag, Escape belongs to the drag — the selection must survive.
    selectBox(20, 20, 80, 80);
    app.setTool('shape-rect');
    const esRect = app.activeTool;
    esRect.options.style = 'fill';
    esRect.onDown({ x: 30, y: 30 }, ev());
    esRect.onMove({ x: 90, y: 90 }, ev());
    check('shape tool reports itself busy mid-drag', esRect.busy);
    pressEscape();
    check('Escape cancels the shape drag', !esRect.dragging);
    check('cancelling a drag keeps the selection', app.selection.active);
    check('cancelled shape left no pixels', pixel(app.doc.activeLayer.canvas, 60, 60)[0] > 240,
      `got ${[...pixel(app.doc.activeLayer.canvas, 60, 60)]}`);

    // A second, quiet Escape then deselects.
    pressEscape();
    check('a second Escape deselects', !app.selection.active);

    // Same rule for a brush stroke in progress.
    selectBox(20, 20, 80, 80);
    app.setTool('brush');
    const esBrush = app.activeTool;
    esBrush.onDown({ x: 40, y: 40 }, ev());
    esBrush.onMove({ x: 60, y: 60 }, ev());
    check('brush reports itself busy mid-stroke', esBrush.busy);
    pressEscape();
    check('Escape aborts the stroke', !esBrush.drawing);
    check('aborting a stroke keeps the selection', app.selection.active);

    // Escape over a floating (moved) selection drops the pixels and deselects.
    app.setTool('move-pixels');
    app.liftFloating();
    app.moveFloating(60, 60);
    check('pixels are floating before Escape', !!app.floating);
    pressEscape();
    check('Escape commits the floating pixels', !app.floating);
    check('Escape then deselects', !app.selection.active);

    app.selection.clear();
  }

  /* --- picking outline/fill colours through the actual UI --- */
  {
    app.setTool('shape-rect');
    const rect = app.activeTool;
    rect.options.strokeColor = null;
    rect.options.fillColor = null;
    app.emit('tool-options-changed');
    await nextFrames(2);

    const pickViaSwatch = async (index, hex) => {
      const swatches = document.querySelectorAll('#optionsbar .color-opt');
      if (!swatches[index]) return { opened: false, title: 'no swatch' };
      swatches[index].click();
      await nextFrames(3);
      const modal = document.querySelector('.modal-backdrop');
      if (!modal) return { opened: false, title: 'no dialog' };
      const title = modal.querySelector('.modal-title')?.textContent || '';
      const hexInput = modal.querySelector('input[type=text]');
      hexInput.value = hex;
      hexInput.dispatchEvent(new Event('input', { bubbles: true }));
      modal.querySelector('.modal-foot .btn.primary').click();
      await nextFrames(3);
      return { opened: true, title };
    };

    const outline = await pickViaSwatch(0, '#123456');
    check('outline swatch opens the colour picker', outline.opened, outline.title);
    check('outline picker is labelled correctly', outline.title === 'Outline', outline.title);
    check('picking an outline colour pins it', 
      rect.options.strokeColor && rect.options.strokeColor.r === 0x12 && rect.options.strokeColor.g === 0x34,
      JSON.stringify(rect.options.strokeColor));

    // With Style on Outline the fill is never painted, so the swatch says so.
    rect.options.style = 'outline';
    app.emit('tool-options-changed');
    await nextFrames(2);
    let sw = document.querySelectorAll('#optionsbar .color-opt');
    check('fill swatch is dimmed when Style is Outline', sw[1].classList.contains('muted'));
    check('outline swatch is not dimmed when Style is Outline', !sw[0].classList.contains('muted'));

    // Flipping Style must re-sync the swatches without rebuilding the bar.
    const segButtons = document.querySelectorAll('#optionsbar .segmented button');
    segButtons[1].click();                                   // Interior
    check('outline swatch dims when Style is Interior', sw[0].classList.contains('muted'));
    check('fill swatch undims when Style is Interior', !sw[1].classList.contains('muted'));
    segButtons[0].click();                                   // back to Outline

    const fill = await pickViaSwatch(1, '#AABB22');
    check('fill swatch opens the colour picker', fill.opened, fill.title);
    check('fill picker is labelled correctly', fill.title === 'Fill', fill.title);
    check('picking a fill colour pins it',
      rect.options.fillColor && rect.options.fillColor.r === 0xAA && rect.options.fillColor.g === 0xBB,
      JSON.stringify(rect.options.fillColor));

    // Picking a fill colour while Style was Outline should honour the intent
    // rather than silently discarding it.
    check('picking a dimmed fill colour switches Style to Both', rect.options.style === 'both',
      `style is ${rect.options.style}`);

    // And the pinned fill must actually reach the canvas.
    rect.options.style = 'both';
    rect.onDown({ x: 20, y: 20 }, ev());
    rect.onMove({ x: 120, y: 120 }, ev());
    rect.onUp({ x: 120, y: 120 }, ev({ buttons: 0 }));
    const inside = pixel(app.doc.activeLayer.canvas, 70, 70);
    check('a fill colour picked through the UI paints', 
      Math.abs(inside[0] - 0xAA) < 6 && Math.abs(inside[1] - 0xBB) < 6, `got ${[...inside]}`);
    app.undo();
    rect.options.strokeColor = null;
    rect.options.fillColor = null;
  }

  /* --- flood fill is linear, not quadratic in span width --- */
  // The original per-pixel-seed fill re-scanned each row span once per pixel,
  // so a wand over a wide photo never returned. Wide spans are the trigger, so
  // this image is deliberately wide with large matching regions.
  {
    const W = 1600, H = 900;
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // Horizontal bands: every row is near-uniform, so matching spans run
        // the full 1600px width — the exact case the old fill choked on.
        const v = 90 + Math.floor(y / 3) % 9 + ((x * 7 + y * 13) % 3);
        buf[i] = buf[i + 1] = buf[i + 2] = v;
        buf[i + 3] = 255;
      }
    }
    const t = performance.now();
    const m = magicWandMask(buf, W, H, 5, 5, 12, false);
    const ms = performance.now() - t;
    let count = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) count++;
    check('wide-span flood fill completes quickly', ms < 500, `${ms.toFixed(0)}ms`);
    check('wide-span flood fill selects a large region', count > W * 20, `${count} px`);
  }

  /* --- span fill matches a brute-force reference --- */
  {
    const W = 61, H = 43;
    const buf = new Uint8ClampedArray(W * H * 4);
    // Deterministic pseudo-random blobs, so a failure is reproducible.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < W * H; i++) {
      const v = rnd() < 0.55 ? 255 : 0;
      buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = v;
      buf[i * 4 + 3] = 255;
    }
    for (const [sx, sy] of [[0, 0], [30, 21], [60, 42], [7, 19], [1, 42], [60, 0], [15, 30], [44, 8]]) {
      const got = magicWandMask(buf, W, H, sx, sy, 5, false);

      // Reference: plain breadth-first fill, four-connected.
      const want = new Uint8Array(W * H);
      const start = (sy * W + sx) * 4;
      const same = (i) => buf[i * 4] === buf[start] && buf[i * 4 + 3] === buf[start + 3];
      const queue = [sy * W + sx];
      want[sy * W + sx] = same(sy * W + sx) ? 255 : 0;
      if (want[sy * W + sx]) {
        while (queue.length) {
          const idx = queue.shift();
          const x = idx % W, y = (idx / W) | 0;
          for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (want[ni] || !same(ni)) continue;
            want[ni] = 255;
            queue.push(ni);
          }
        }
      }
      let diff = 0;
      for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) diff++;
      check(`span fill matches reference from (${sx},${sy})`, diff === 0, `${diff} differing pixels`);
    }
  }

  /* --- worst-case selection outlines stay cheap to render --- */
  // A magic wand over noisy pixels produces a boundary with a run per pixel.
  // Before the run-merging and bitmap fallback this pegged the render loop and
  // locked the app up, so budget both the build and the frame.
  app.setDocument(PaintDocument.blank(800, 600, '#ffffff'), { name: 'ants' });
  const noiseMask = new Uint8Array(800 * 600);
  for (let i = 0; i < noiseMask.length; i++) noiseMask[i] = Math.random() < 0.5 ? 255 : 0;
  app.selection.setFromMask(noiseMask, COMBINE.REPLACE);

  let t0 = performance.now();
  const noisyOutline = app.selection.outline();
  const buildMs = performance.now() - t0;
  check('noisy outline falls back to an edge bitmap', !!noisyOutline?.edge);
  check('noisy outline builds quickly', buildMs < 400, `${buildMs.toFixed(0)}ms`);

  t0 = performance.now();
  for (let i = 0; i < 5; i++) app.view._render();
  const frameMs = (performance.now() - t0) / 5;
  check('frames stay fast with a noisy selection', frameMs < 40, `${frameMs.toFixed(1)}ms/frame`);

  // A plain rectangle must still take the crisp animated path, and merging runs
  // should collapse it to a handful of segments.
  const rectPath = new Path2D();
  rectPath.rect(100, 100, 400, 300);
  app.selection.setFromPath(rectPath, COMBINE.REPLACE);
  const rectOutline = app.selection.outline();
  check('simple outline uses an animated path', !!rectOutline?.path);
  check('collinear edges merge into runs', rectOutline.runCount <= 8, `${rectOutline?.runCount} runs`);

  t0 = performance.now();
  for (let i = 0; i < 5; i++) app.view._render();
  check('frames stay fast with a rectangular selection', (performance.now() - t0) / 5 < 40);
  app.selection.clear();

  /* --- erase clears to transparent, fill paints the primary colour --- */
  app.setDocument(PaintDocument.blank(80, 80, '#ffffff'), { name: 'erase' });
  const eraseArea = new Path2D();
  eraseArea.rect(10, 10, 40, 40);
  app.selection.setFromPath(eraseArea, COMBINE.REPLACE);
  await app.run('edit.eraseSelection');
  check('erase selection leaves transparency', pixel(app.doc.activeLayer.canvas, 25, 25)[3] === 0,
    `alpha ${pixel(app.doc.activeLayer.canvas, 25, 25)[3]}`);
  check('erase leaves pixels outside the selection', pixel(app.doc.activeLayer.canvas, 70, 70)[3] === 255);
  // Undo should cost the selection rect on one layer, not a snapshot of the
  // whole document (which on a large multi-layer image runs to hundreds of MB).
  app.addLayer('Extra');
  app.doc.setActive(0);
  await app.run('edit.eraseSelection');
  const eraseBytes = app.history.entries[app.history.index].bytes;
  check('erase undo stores only the affected region',
    eraseBytes <= 40 * 40 * 8 * 1.5, `${eraseBytes} bytes`);

  app.setPrimaryColor({ r: 200, g: 30, b: 40, a: 1 });
  await app.run('edit.fillSelection');
  const fillPx = pixel(app.doc.activeLayer.canvas, 25, 25);
  check('fill selection uses the primary colour', fillPx[0] > 180 && fillPx[1] < 70 && fillPx[3] === 255,
    `got ${[...fillPx]}`);
  app.selection.clear();

  /* --- feathered selections are masked exactly once --- */
  // Shape and gradient tools mask their preview overlay; committing must not
  // mask again, which would square the coverage at soft edges.
  app.setDocument(PaintDocument.blank(120, 120, null), { name: 'feather' });
  const featherPath = new Path2D();
  featherPath.rect(20, 20, 80, 80);
  app.selection.setFromPath(featherPath, COMBINE.REPLACE);
  app.selection.setFromMask(
    featherMask(app.selection.mask, 120, 120, 6), COMBINE.REPLACE
  );
  app.setPrimaryColor({ r: 0, g: 0, b: 0, a: 1 });
  app.setSecondaryColor({ r: 0, g: 0, b: 0, a: 1 });
  app.setTool('shape-rect');
  const fr = app.activeTool;
  fr.options.style = 'fill';
  fr.onDown({ x: 0, y: 0 }, ev());
  fr.onMove({ x: 119, y: 119 }, ev());
  fr.onUp({ x: 119, y: 119 }, ev({ buttons: 0 }));

  let softest = { diff: 0, cov: 0, alpha: 0 };
  for (let y = 10; y < 110; y++) {
    const cov = app.selection.coverageAt(20, y);
    if (cov < 40 || cov > 215) continue;           // only genuinely soft pixels
    const alpha = pixel(app.doc.activeLayer.canvas, 20, y)[3];
    const diff = Math.abs(alpha - cov);
    if (diff > softest.diff) softest = { diff, cov, alpha };
  }
  check('feathered edges keep their coverage (masked once)', softest.diff <= 12,
    `coverage ${softest.cov} vs alpha ${softest.alpha}`);
  app.selection.clear();

  /* --- history entries survive a structural undo/redo cycle --- */
  // regionEdit / StrokeRecorder entries reference their layer by id, because
  // restoring a document state rebuilds the layer objects.
  app.setDocument(PaintDocument.blank(120, 120, '#ffffff'), { name: 'identity' });
  app.setPrimaryColor({ r: 0, g: 0, b: 0, a: 1 });
  app.setSecondaryColor({ r: 0, g: 0, b: 0, a: 1 });
  app.setTool('shape-rect');
  const rt = app.activeTool;
  rt.options.style = 'fill';
  rt.onDown({ x: 10, y: 10 }, ev());
  rt.onMove({ x: 40, y: 40 }, ev());
  rt.onUp({ x: 40, y: 40 }, ev({ buttons: 0 }));
  app.addLayer('Structural');            // pushes a whole-document snapshot
  app.history.goTo(-1);
  app.history.goTo(app.history.entries.length - 1);
  const idLayer = app.doc.layers[0];
  const shapeAfter = pixel(idLayer.canvas, 25, 25);
  check('region edit re-applies after a structural undo/redo', shapeAfter[0] < 60 && shapeAfter[3] > 200,
    `got ${[...shapeAfter]}`);
  const untouched = pixel(idLayer.canvas, 100, 100);
  check('region edit leaves pixels outside its rect alone', untouched[0] > 240 && untouched[3] > 200,
    `got ${[...untouched]}`);

  app.history.goTo(0);
  const stillThere = pixel(app.doc.layers[0].canvas, 25, 25);
  check('region edit survives partial rewind', stillThere[0] < 60, `got ${[...stillThere]}`);
  app.history.goTo(-1);
  const rewound = pixel(app.doc.layers[0].canvas, 25, 25);
  check('full rewind clears the shape', rewound[0] > 240, `got ${[...rewound]}`);

  /* --- key hints on Windows and Linux --- */
  // Can't run those platforms here, so exercise the rewrite directly: on
  // non-macOS the UI must say Ctrl, not show a ⌘ that binds to nothing.
  {
    const cases = [
      ['⌘Z', 'Ctrl+Z'],
      ['⇧⌘Z', 'Shift+Ctrl+Z'],
      ['⌥⌫', 'Alt+Backspace'],
      ['⌘-click or ⌥-click to set the clone source.', 'Ctrl-click or Alt-click to set the clone source.'],
      ['⎋ cancels · ⌘⏎ commits', 'Esc cancels · Ctrl+Enter commits'],
      ['⌘+ / ⌘−', 'Ctrl+Plus / Ctrl+Minus'],
      ['B', 'B']
    ];
    let bad = '';
    for (const [input, want] of cases) {
      const got = rewriteKeys(input);
      if (got !== want && !bad) bad = `"${input}" -> "${got}" (wanted "${want}")`;
    }
    check('key hints rewrite for Windows and Linux', !bad, bad);
    check('key hints are untouched on macOS', formatKeys('⌘Z') === '⌘Z');
  }

  /* --- about dialog --- */
  {
    app.run('help.about');                       // resolves only when closed
    await nextFrames(4);
    const modal = document.querySelector('.modal-backdrop');
    check('about dialog opens', !!modal);

    if (modal) {
      const text = modal.textContent;
      check('about credits the author', text.includes('Al Roland'), text.slice(0, 80));
      check('about shows the site', text.includes('www.alroland.com/paint.mac'));
      check('about shows a version', /Version \d/.test(text), text.slice(0, 120));

      const link = modal.querySelector('.about-link');
      check('about link points at the site',
        link?.dataset.external === 'https://www.alroland.com/paint.mac', link?.dataset.external);

      // Clicking must hand the URL to the OS, never navigate the app window.
      const before = location.href;
      link?.click();
      await nextFrames(2);
      check('about link does not navigate the app', location.href === before);

      // The icon has to be bundled and allowed by the CSP, not a broken image.
      const icon = modal.querySelector('.about-icon');
      check('about icon is bundled and loads',
        !!icon && icon.complete && icon.naturalWidth > 0,
        `complete=${icon?.complete} natural=${icon?.naturalWidth}`);

      check('about has a single Close button',
        modal.querySelectorAll('.modal-foot .btn').length === 1,
        `${modal.querySelectorAll('.modal-foot .btn').length} buttons`);

      modal.querySelector('.modal-foot .btn.primary')?.click();
      await nextFrames(2);
      check('about dialog closes', !document.querySelector('.modal-backdrop'));
    }
  }

  // The shortcuts sheet is informational too.
  {
    app.run('help.shortcuts');
    await nextFrames(4);
    const sc = document.querySelector('.modal-backdrop');
    check('shortcuts sheet has a single Close button',
      sc?.querySelectorAll('.modal-foot .btn').length === 1,
      `${sc?.querySelectorAll('.modal-foot .btn').length} buttons`);
    sc?.querySelector('.modal-foot .btn.primary')?.click();
    await nextFrames(2);
  }

  /* --- tooltips --- */
  {
    const strip = document.getElementById('toolstrip');
    const buttons = [...strip.querySelectorAll('.tool-btn')];
    check('every tool button has a tooltip', buttons.every((b) => b.dataset.tip), 
      `${buttons.filter((b) => !b.dataset.tip).length} missing`);
    check('every tool button has a description', buttons.every((b) => b.dataset.tipDesc),
      `${buttons.filter((b) => !b.dataset.tipDesc).length} missing`);

    // A native title alongside data-tip would produce a second, OS-drawn tooltip.
    check('no element carries both a native title and a tooltip',
      document.querySelectorAll('[data-tip][title]').length === 0);
    check('no native titles left anywhere',
      document.querySelectorAll('[title]').length === 0,
      `${document.querySelectorAll('[title]').length} left`);

    // Tooltip content must match the tool it is attached to, in palette order.
    const tools = [...app.tools.values()].map((t) => t.constructor);
    let contentOk = true;
    let firstBad = '';
    buttons.forEach((b, i) => {
      const T = tools[i];
      const keyOk = (b.dataset.tipKey || '') === (T.shortcut || '');
      if (b.dataset.tip !== T.label || b.dataset.tipDesc !== T.hint || !keyOk) {
        contentOk = false;
        if (!firstBad) firstBad = `${T.label}: tip="${b.dataset.tip}" key="${b.dataset.tipKey}"`;
      }
    });
    check('tooltip text matches each tool', contentOk, firstBad);

    // Shortcuts advertised in the tooltip must actually select that tool.
    let shortcutsOk = true;
    let badShortcut = '';
    for (const T of tools) {
      if (!T.shortcut) continue;
      const resolved = toolByShortcut(T.shortcut);
      if (resolved !== T) { shortcutsOk = false; badShortcut = `${T.shortcut} -> ${resolved?.label}`; }
    }
    check('advertised shortcuts select the right tool', shortcutsOk, badShortcut);

    const shortcuts = tools.map((T) => T.shortcut).filter(Boolean);
    check('no duplicate tool shortcuts', new Set(shortcuts).size === shortcuts.length,
      shortcuts.join(''));

    // Show each one and confirm it renders on screen, with real text and inside
    // the window — a tooltip that opens off-screen is worse than none.
    let shownOk = true, boundsOk = true, firstFail = '';
    for (const b of buttons) {
      showTooltip(b);
      const tip = document.getElementById('tooltip');
      const r = tip.getBoundingClientRect();
      if (tip.hidden || r.width < 20 || r.height < 10) {
        shownOk = false;
        if (!firstFail) firstFail = `${b.dataset.tip} not rendered`;
      }
      if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
        boundsOk = false;
        if (!firstFail) firstFail = `${b.dataset.tip} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      }
      if (tip.querySelector('.tip-title').textContent !== b.dataset.tip) {
        shownOk = false;
        if (!firstFail) firstFail = `${b.dataset.tip} rendered wrong title`;
      }
      hideTooltip();
    }
    check('every tool tooltip renders', shownOk, firstFail);
    check('every tool tooltip stays inside the window', boundsOk, firstFail);

    // The tool strip is against the left edge, so tips must open to the right.
    showTooltip(buttons[0]);
    const tipEl = document.getElementById('tooltip');
    check('tool tooltips open beside the strip, not over it',
      tipEl.getBoundingClientRect().left >= buttons[0].getBoundingClientRect().right,
      `tip left ${Math.round(tipEl.getBoundingClientRect().left)}`);
    hideTooltip();
    check('hideTooltip hides it', document.getElementById('tooltip').hidden);

    // Hover timing. Real OS focus/blur events aren't delivered when the test
    // window never becomes key, so the delegated handlers are driven with
    // synthetic events and the delays are shortened to keep this deterministic.
    const target = buttons[3];
    configureTooltips({ showDelay: 40, repeatWindow: 0 });

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    check('hover waits before showing', document.getElementById('tooltip')?.hidden !== false);

    // A window blur cancels any pending show — correct behaviour, but this test
    // window can lose key status at any moment, so give the timer a few tries.
    let hoverShown = false;
    for (let attempt = 0; attempt < 4 && !hoverShown; attempt++) {
      hideTooltip();
      target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 90));
      hoverShown = document.getElementById('tooltip').hidden === false;
    }
    check('hover shows the tooltip after the delay', hoverShown);
    check('hovered tooltip shows that tool',
      document.querySelector('#tooltip .tip-title').textContent === target.dataset.tip);

    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    check('leaving hides the tooltip', document.getElementById('tooltip').hidden);

    // Moving between descendants of the same anchor must not flicker it away.
    showTooltip(target);
    const icon = target.querySelector('svg') || target;
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: icon }));
    check('moving within a button keeps the tooltip up', document.getElementById('tooltip').hidden === false);
    hideTooltip();

    // Warm re-show: sliding along the strip should not re-wait the full delay.
    configureTooltips({ repeatWindow: 500 });
    hideTooltip();
    buttons[5].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    check('sliding to the next tool re-shows immediately',
      document.getElementById('tooltip').hidden === false);
    check('warm re-show swaps in the new tool',
      document.querySelector('#tooltip .tip-title').textContent === buttons[5].dataset.tip);
    hideTooltip();

    // Keyboard focus should not make the user wait out the hover delay.
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    check('focus shows the tooltip immediately', document.getElementById('tooltip').hidden === false);
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    check('blur hides the tooltip', document.getElementById('tooltip').hidden);

    // Interacting should dismiss it rather than leaving it floating over the canvas.
    showTooltip(target);
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check('clicking dismisses the tooltip', document.getElementById('tooltip').hidden);
    showTooltip(target);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'b' }));
    check('typing dismisses the tooltip', document.getElementById('tooltip').hidden);

    configureTooltips({ showDelay: 420, repeatWindow: 500 });

    // Panel buttons sit against the right edge and must flip to the left.
    const addLayerBtn = document.querySelector('[data-cmd="layer.add"]');
    check('panel buttons have tooltips', !!addLayerBtn?.dataset.tip);
    showTooltip(addLayerBtn);
    const pr = document.getElementById('tooltip').getBoundingClientRect();
    check('right-edge tooltips flip inward', pr.right <= window.innerWidth, `right ${Math.round(pr.right)}`);
    hideTooltip();
  }

  /* --- UI chrome is laid out and populated --- */
  const toolButtons = document.querySelectorAll('#toolstrip .tool-btn');
  check('tool strip renders every tool', toolButtons.length === app.tools.size, `${toolButtons.length} of ${app.tools.size}`);
  check('options bar has controls', document.querySelectorAll('#optionsbar .opt').length > 1);
  check('layers panel lists layers', document.querySelectorAll('#layers-body .layer-row').length === app.doc.layers.length);
  check('history panel lists entries', document.querySelectorAll('#history-body .hist-row').length === app.history.entries.length + 1);
  check('colour palette rendered', document.querySelectorAll('#color-body .palette div').length === 28);

  const viewCanvas = document.getElementById('view');
  check('view canvas has a backing store', viewCanvas.width > 100 && viewCanvas.height > 100, `${viewCanvas.width}x${viewCanvas.height}`);
  for (const id of ['toolstrip', 'optionsbar', 'sidebar', 'viewport', 'statusbar']) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    check(`#${id} is visible`, r.width > 0 && r.height > 0, `${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const vp = document.getElementById('viewport').getBoundingClientRect();
  check('viewport fills the middle column', vp.width > 400 && vp.height > 300, `${Math.round(vp.width)}x${Math.round(vp.height)}`);
  check('no horizontal overflow', document.documentElement.scrollWidth <= window.innerWidth + 1);

  // Draw one frame synchronously so the capture below shows real content.
  app.view._render();

  const capturePath = new URLSearchParams(location.search).get('capture');
  if (capturePath) {
    buildShowcase(app);
    app.view.fitToWindow();
    try {
      // capturePage() returns the last frame the compositor presented, so wait
      // for a few real paints before asking for it.
      await nextFrames(4);
      // Show a tooltip in the captured frame so it can be checked by eye. It
      // goes up last, because a window blur dismisses it.
      app.setPrimaryColor({ r: 200, g: 60, b: 50, a: 1 });
      app.setSecondaryColor({ r: 60, g: 120, b: 220, a: 1 });
      app.setTool('shape-round-rect');
      app.activeTool.options.style = 'outline';
      app.emit('tool-options-changed');
      await nextFrames(12);
      await window.api.capturePage(capturePath);
      console.error(`SELFTEST CAPTURE written to ${capturePath}`);
    } catch (err) {
      console.error(`SELFTEST CAPTURE failed: ${err.message}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.error(`SELFTEST SUMMARY — ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.error('SELFTEST FAILURES: ' + failed.map((f) => f.name).join(' | '));
  else console.error('SELFTEST ALL PASSED');

  if (new URLSearchParams(location.search).has('exit')) {
    window.api.selfTestDone({ passed: results.length - failed.length, total: results.length });
  }
  return failed.length === 0;
}
