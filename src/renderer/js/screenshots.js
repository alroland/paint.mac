// Generates the README screenshots. Run with `npm run screenshots`.
//
// The artwork is drawn from code so the shots can be regenerated after a UI
// change instead of going stale the moment anything moves.

import { PaintDocument, Layer } from './document.js';
import { COMBINE } from './selection.js';
import { showTooltip, hideTooltip } from './ui/tooltip.js';

const nextFrames = (n) => new Promise((resolve) => {
  const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

const W = 1400, H = 900;

function addLayer(doc, name, draw, { opacity = 1, blendMode = 'source-over' } = {}) {
  const layer = new Layer(W, H, name);
  draw(layer.ctx);
  layer.opacity = opacity;
  layer.blendMode = blendMode;
  layer.touch();
  doc.layers.push(layer);
  return layer;
}

/** A dawn landscape, built the way a user would: one element per layer. */
function buildArtwork(app) {
  const doc = new PaintDocument(W, H);
  const horizon = H * 0.62;

  addLayer(doc, 'Sky', (g) => {
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#111c44');
    sky.addColorStop(0.45, '#4b3a78');
    sky.addColorStop(0.78, '#d1607a');
    sky.addColorStop(1, '#ffb469');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, horizon);
    // A scatter of stars, thinning out toward the horizon.
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * W;
      const y = Math.random() * horizon * 0.62;
      const a = (1 - y / (horizon * 0.62)) * 0.85;
      g.globalAlpha = a * (0.35 + Math.random() * 0.65);
      g.beginPath();
      g.arc(x, y, Math.random() * 1.5 + 0.4, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  });

  addLayer(doc, 'Sun', (g) => {
    const cx = W * 0.70, cy = horizon - 196;
    const glow = g.createRadialGradient(cx, cy, 8, cx, cy, 260);
    glow.addColorStop(0, 'rgba(255,226,150,.95)');
    glow.addColorStop(0.25, 'rgba(255,170,110,.45)');
    glow.addColorStop(1, 'rgba(255,140,90,0)');
    g.fillStyle = glow;
    g.fillRect(cx - 300, cy - 300, 600, 600);
    g.fillStyle = '#ffe6ad';
    g.beginPath();
    g.arc(cx, cy, 52, 0, Math.PI * 2);
    g.fill();
  }, { blendMode: 'screen' });

  const ridge = (g, color, base, peaks, jitter) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, horizon);
    let x = 0;
    let up = true;
    while (x < W) {
      const step = 90 + Math.random() * jitter;
      x += step;
      const y = base - (up ? peaks * (0.55 + Math.random() * 0.45) : peaks * 0.18 * Math.random());
      g.lineTo(Math.min(x, W), y);
      up = !up;
    }
    g.lineTo(W, horizon);
    g.closePath();
    g.fill();
  };

  addLayer(doc, 'Far Hills', (g) => ridge(g, '#5b4a8c', horizon, 150, 120), { opacity: 0.85 });
  addLayer(doc, 'Near Hills', (g) => ridge(g, '#2a2150', horizon + 4, 210, 160));

  addLayer(doc, 'Water', (g) => {
    const water = g.createLinearGradient(0, horizon, 0, H);
    water.addColorStop(0, '#c8617e');
    water.addColorStop(0.35, '#4a3670');
    water.addColorStop(1, '#161033');
    g.fillStyle = water;
    g.fillRect(0, horizon, W, H - horizon);

    // Sun glitter: short horizontal strokes lining up under the sun.
    g.globalAlpha = 0.55;
    g.strokeStyle = '#ffd9a1';
    g.lineCap = 'round';
    for (let y = horizon + 6; y < H; y += 9) {
      const spread = 26 + (y - horizon) * 1.5;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const cx = W * 0.70 + (Math.random() - 0.5) * spread * 2;
        const len = 8 + Math.random() * spread * 0.5;
        g.globalAlpha = 0.5 * (1 - (y - horizon) / (H - horizon)) + 0.06;
        g.lineWidth = 1 + Math.random() * 2;
        g.beginPath();
        g.moveTo(cx - len / 2, y);
        g.lineTo(cx + len / 2, y);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  });

  addLayer(doc, 'Trees', (g) => {
    g.fillStyle = '#0d0a1f';
    const tree = (x, h, w) => {
      g.beginPath();
      g.moveTo(x, horizon + 6);
      g.lineTo(x - w, horizon + 6);
      for (let i = 0; i < 5; i++) {
        const t = i / 5;
        g.lineTo(x - w * (1 - t) * 0.9, horizon + 6 - h * t);
        g.lineTo(x - w * (1 - t) * 0.45, horizon + 6 - h * (t + 0.06));
      }
      g.lineTo(x, horizon + 6 - h);
      for (let i = 5; i > 0; i--) {
        const t = i / 5;
        g.lineTo(x + w * (1 - t) * 0.45, horizon + 6 - h * (t + 0.06));
        g.lineTo(x + w * (1 - t) * 0.9, horizon + 6 - h * t);
      }
      g.lineTo(x + w, horizon + 6);
      g.closePath();
      g.fill();
    };
    for (const [x, h, w] of [[70, 180, 34], [140, 130, 26], [1210, 210, 38], [1300, 150, 28], [1360, 110, 22]]) {
      tree(x, h, w);
    }
    g.fillRect(0, horizon + 2, W, 6);
  });

  addLayer(doc, 'Title', (g) => {
    g.font = '300 42px Georgia, serif';
    g.fillStyle = 'rgba(255,240,225,.92)';
    g.textBaseline = 'top';
    g.fillText('dawn study', 62, 62);
    g.font = '300 17px -apple-system, sans-serif';
    g.fillStyle = 'rgba(255,240,225,.55)';
    g.fillText('seven layers · paint.mac', 64, 116);
  });

  doc.activeIndex = doc.layers.length - 3;   // "Water", a believable working layer
  doc.invalidateAll();
  app.setDocument(doc, { name: 'dawn-study.pmac' });
  app.doc.markDirty(false);
  app.setPrimaryColor({ r: 255, g: 214, b: 160, a: 1 });
  app.setSecondaryColor({ r: 26, g: 20, b: 54, a: 1 });
}

async function shoot(dir, name) {
  await nextFrames(8);
  await window.api.capturePage(`${dir}/${name}.png`);
  console.error(`SHOT ${name}`);
}

export async function run(app, dir) {
  buildArtwork(app);
  app.view.fitToWindow();

  // 1 — the editor at rest.
  app.setTool('brush');
  app.activeTool.options.size = 42;
  app.emit('tool-options-changed');
  await shoot(dir, '01-editor');

  // 2 — a magic wand selection with marching ants, plus a tooltip.
  app.setTool('magic-wand');
  app.activeTool.options.tolerance = 26;
  app.emit('tool-options-changed');
  app.doc.setActive(0);
  const wandBtn = document.querySelectorAll('#toolstrip .tool-btn')[3];
  app.activeTool.onDown({ x: 250, y: 120 }, {
    button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false,
    ctrlKey: false, pointerType: 'mouse', pressure: 0.5
  });
  await nextFrames(4);
  if (wandBtn) showTooltip(wandBtn);
  await shoot(dir, '02-selection');

  // 3 — an effect previewing live on the canvas. Runs on the sky, which fills
  // enough of the frame for the preview to actually read.
  hideTooltip();
  app.selection.clear();
  app.doc.emit('selection-changed');
  app.doc.setActive(0);
  app.run('effect.glow');
  await nextFrames(10);
  await shoot(dir, '03-effects');
  document.querySelector('.modal-backdrop .modal-foot .btn')?.click();   // Cancel
  await nextFrames(4);

  // 4 — Curves, with its histogram.
  app.doc.setActive(0);
  app.run('adjust.curves');
  await nextFrames(10);
  await shoot(dir, '04-adjustments');
  document.querySelector('.modal-backdrop .modal-foot .btn')?.click();
  await nextFrames(4);

  // 5 — layers with blend modes, and the shape tool's colour/border options.
  hideTooltip();
  app.setTool('shape-round-rect');
  app.activeTool.options.style = 'both';
  app.emit('tool-options-changed');
  app.doc.setActive(1);          // "Sun", which uses the Screen blend mode
  await shoot(dir, '05-layers');

  console.error('SHOTS DONE');
}
