// Layers panel. Displayed top-of-stack first, which is the opposite of the
// document's array order, so every index is flipped on the way in and out.

import { BLEND_MODES } from '../document.js';
import { setTip } from './tooltip.js';
import { metaEdit, captureDocState, docStateEdit } from '../history.js';

export function mountLayersPanel(app, listEl, propsEl) {
  let dragFrom = null;

  propsEl.innerHTML = `
    <div class="row"><label>Blend</label><select id="layer-blend"></select></div>
    <div class="row"><label>Opacity</label><input type="range" id="layer-opacity" min="0" max="100" step="1" /><span class="val" id="layer-opacity-val"></span></div>`;

  const blendSel = propsEl.querySelector('#layer-blend');
  const opacity = propsEl.querySelector('#layer-opacity');
  const opacityVal = propsEl.querySelector('#layer-opacity-val');

  for (const [v, l] of BLEND_MODES) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    blendSel.appendChild(o);
  }

  blendSel.addEventListener('change', () => {
    const layer = app.doc.activeLayer;
    if (!layer) return;
    const before = snapshotMeta(layer);
    layer.blendMode = blendSel.value;
    app.doc.invalidateAll();
    app.pushHistory(metaEdit(app.doc, layer, before, 'Change Blend Mode'));
    app.view.render();
  });

  // Dragging the slider is one continuous gesture; record a single undo step
  // from the value the drag started at.
  let opacityBefore = null;
  opacity.addEventListener('pointerdown', () => {
    const layer = app.doc.activeLayer;
    opacityBefore = layer ? snapshotMeta(layer) : null;
  });
  opacity.addEventListener('input', () => {
    const layer = app.doc.activeLayer;
    if (!layer) return;
    layer.opacity = Number(opacity.value) / 100;
    opacityVal.textContent = `${opacity.value}%`;
    app.doc.invalidateAll();
    app.view.render();
    renderList();
  });
  opacity.addEventListener('change', () => {
    const layer = app.doc.activeLayer;
    if (!layer || !opacityBefore) return;
    if (opacityBefore.opacity !== layer.opacity) {
      app.pushHistory(metaEdit(app.doc, layer, opacityBefore, 'Change Opacity'));
    }
    opacityBefore = null;
  });

  function snapshotMeta(l) {
    return { name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode };
  }

  function renderList() {
    const doc = app.doc;
    listEl.innerHTML = '';
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const row = document.createElement('div');
      row.className = 'layer-row' + (i === doc.activeIndex ? ' on' : '');
      row.draggable = true;
      row.dataset.index = i;

      const vis = document.createElement('div');
      vis.className = 'layer-vis';
      vis.textContent = layer.visible ? '👁' : '—';
      setTip(vis, {
        title: layer.visible ? 'Hide layer' : 'Show layer',
        desc: layer.visible ? 'Hidden layers are skipped when compositing and exporting.' : 'Show this layer again.'
      });
      vis.addEventListener('click', (e) => {
        e.stopPropagation();
        const before = snapshotMeta(layer);
        layer.visible = !layer.visible;
        doc.invalidateAll();
        app.pushHistory(metaEdit(doc, layer, before, layer.visible ? 'Show Layer' : 'Hide Layer'));
        app.view.render();
        renderList();
      });

      const thumb = document.createElement('canvas');
      thumb.className = 'layer-thumb';
      thumb.width = 76; thumb.height = 60;
      thumb.getContext('2d').drawImage(layer.thumbnail(76, 60), 0, 0);

      const meta = document.createElement('div');
      meta.className = 'layer-meta';
      const name = document.createElement('div');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(layer, name);
      });
      const sub = document.createElement('div');
      sub.className = 'layer-sub';
      const blendLabel = BLEND_MODES.find(([v]) => v === layer.blendMode)?.[1] || 'Normal';
      sub.textContent = `${Math.round(layer.opacity * 100)}%  ·  ${blendLabel}`;
      meta.append(name, sub);

      row.append(vis, thumb, meta);
      row.addEventListener('click', () => { doc.setActive(i); });

      row.addEventListener('dragstart', (e) => {
        dragFrom = i;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragover'); });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        if (dragFrom === null || dragFrom === i) return;
        const before = captureDocState(doc, app.selection);
        doc.moveLayer(dragFrom, i);
        app.pushHistory(docStateEdit(doc, app.selection, before, 'Reorder Layers'));
        dragFrom = null;
        app.view.render();
      });

      listEl.appendChild(row);
    }
    syncProps();
  }

  function startRename(layer, nameEl) {
    const input = document.createElement('input');
    input.value = layer.name;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    const finish = (save) => {
      if (save && input.value.trim() && input.value !== layer.name) {
        const before = snapshotMeta(layer);
        layer.name = input.value.trim();
        app.pushHistory(metaEdit(app.doc, layer, before, 'Rename Layer'));
      }
      renderList();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function syncProps() {
    const layer = app.doc.activeLayer;
    if (!layer) return;
    blendSel.value = layer.blendMode;
    opacity.value = Math.round(layer.opacity * 100);
    opacityVal.textContent = `${Math.round(layer.opacity * 100)}%`;
  }

  const rerender = () => renderList();
  app.on('document-changed', () => { bind(); rerender(); });

  function bind() {
    app.doc.on('layers-changed', rerender);
    app.doc.on('active-changed', rerender);
    app.doc.on('pixels-changed', scheduleThumbs);
  }

  // Thumbnails are comparatively expensive; refresh them on a lazy timer
  // rather than on every dab.
  let thumbTimer = null;
  function scheduleThumbs() {
    if (thumbTimer) return;
    thumbTimer = setTimeout(() => { thumbTimer = null; renderList(); }, 400);
  }

  bind();
  renderList();
}
