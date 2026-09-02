// Renderer entry point: build the app, mount the chrome, wire the extras that
// don't belong to any single module (zoom control, drag-and-drop, resize).

import { App } from './app.js';
import { registerCommands } from './commands.js';
import { mountToolStrip } from './ui/toolStrip.js';
import { mountToolOptions } from './ui/toolOptions.js';
import { mountColorPanel } from './ui/colorPanel.js';
import { mountLayersPanel } from './ui/layersPanel.js';
import { mountHistoryPanel } from './ui/historyPanel.js';
import { ZOOM_STEPS } from './view.js';
import { installTooltips } from './ui/tooltip.js';
import * as io from './fileio.js';

document.body.dataset.platform = window.api.platform;

const app = new App();
window.paintApp = app; // handy from the devtools console

mountToolStrip(app, document.getElementById('toolstrip'));
mountToolOptions(app, document.getElementById('optionsbar'));
mountColorPanel(app, document.getElementById('color-body'));
mountLayersPanel(app, document.getElementById('layers-body'), document.getElementById('layer-props'));
mountHistoryPanel(app, document.getElementById('history-body'));
registerCommands(app);

// After the panels are built, so any remaining native titles get converted.
installTooltips();

/* ---------- zoom control ---------- */

const zoomSelect = document.getElementById('zoom-select');
for (const z of ZOOM_STEPS) {
  const o = document.createElement('option');
  o.value = String(z);
  o.textContent = `${Math.round(z * 100)}%`;
  zoomSelect.appendChild(o);
}
const customOption = document.createElement('option');
customOption.value = 'custom';
zoomSelect.appendChild(customOption);

zoomSelect.addEventListener('change', () => {
  const v = Number(zoomSelect.value);
  if (Number.isFinite(v)) {
    app.view.setZoom(v);
    app.view.centerDocument();
    app.view.render();
    app.emit('view-changed');
  }
});

app.on('view-changed', () => {
  const z = app.view.zoom;
  const match = ZOOM_STEPS.find((s) => Math.abs(s - z) < 1e-6);
  if (match) {
    zoomSelect.value = String(match);
  } else {
    customOption.textContent = `${Math.round(z * 100)}%`;
    zoomSelect.value = 'custom';
  }
});

/* ---------- drag and drop ---------- */

document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (file.name.toLowerCase().endsWith(`.${io.DOC_EXT}`)) {
      const doc = await io.deserializeDocument(bytes);
      app.setDocument(doc, { path: file.path || null, name: file.name });
    } else {
      const doc = await io.documentFromImageBytes(bytes, file.type, file.name);
      app.setDocument(doc, { name: file.name });
    }
  } catch (err) {
    app.setStatus(`Could not open ${file.name}: ${err.message}`);
  }
});

/* ---------- startup ---------- */

window.addEventListener('resize', () => {
  app.view.clampPan();
  app.view.render();
  app.rulers.draw();
});

app.view.fitToWindow();
app.updateStatus();
app.rulers.draw();
app.emit('view-changed');

// `npm start -- --selftest` runs the smoke suite against a scratch document.
if (new URLSearchParams(location.search).has('dirty')) app.doc.markDirty(true);

if (new URLSearchParams(location.search).has('perf')) import('./perfprobe.js').then(m => m.run(app));

const shotsDir = new URLSearchParams(location.search).get('shots');
if (shotsDir) {
  import('./screenshots.js').then((m) => m.run(app, shotsDir));
}

if (new URLSearchParams(location.search).has('selftest')) {
  import('./selftest.js')
    .then((m) => m.run(app))
    .catch((err) => {
      // Without this, a throw inside the suite just leaves the run hanging with
      // no output at all, which says far less than a red run.
      console.error(`SELFTEST CRASHED: ${err && err.stack ? err.stack : err}`);
      window.api.selfTestDone?.({
        passed: 0, total: 1,
        failures: [`suite crashed: ${err && err.message ? err.message : err}`]
      });
    });
}
