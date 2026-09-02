import { PaintDocument } from './document.js';
import { COMBINE } from './selection.js';

const T = (label, fn) => {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.error(`PERF ${label}: ${ms.toFixed(1)}ms`);
  return ms;
};

export async function run(app) {
  const W = 3000, H = 2000;
  app.setDocument(PaintDocument.blank(W, H, '#ffffff'), { name: 'perf' });
  app.view.fitToWindow();

  const p = new Path2D();
  p.rect(400, 300, 1200, 900);
  app.selection.setFromPath(p, COMBINE.REPLACE);
  app.doc.emit('selection-changed');

  console.error(`PERF === selection outline drag, ${W}x${H} ===`);
  T('20 x translate(1,1) [one drag gesture]', () => {
    for (let i = 0; i < 20; i++) app.selection.translate(1, 1);
  });
  T('20 x translate + outline rebuild', () => {
    for (let i = 0; i < 20; i++) { app.selection.translate(1, 1); app.selection.outline(); }
  });
  T('20 renders with the selection active', () => {
    for (let i = 0; i < 20; i++) app.view._render();
  });

  console.error('PERF === move selected pixels ===');
  app.setTool('move-pixels');
  T('liftFloating', () => app.liftFloating());
  T('20 x moveFloating [one drag gesture]', () => {
    for (let i = 0; i < 20; i++) app.moveFloating(400 + i, 300 + i);
  });
  T('commitFloating', () => app.commitFloating());

  console.error('PERF === brush stroke ===');
  app.setTool('brush');
  app.activeTool.options.size = 60;
  app.selection.clear();
  const e = { button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, pointerType: 'mouse', pressure: 0.5 };
  T('60-segment stroke', () => {
    app.activeTool.onDown({ x: 100, y: 100 }, e);
    for (let i = 1; i <= 60; i++) app.activeTool.onMove({ x: 100 + i * 20, y: 100 + i * 10 }, e);
    app.activeTool.onUp({ x: 1300, y: 700 }, e);
  });
  console.error('PERF DONE');
}
