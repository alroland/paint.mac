// Modal dialogs. One generic builder covers everything; effect dialogs layer a
// live EffectSession preview on top of it.

import { EffectSession } from '../image/apply.js';
import { clamp } from '../util.js';
import { formatKeys } from '../platform.js';

const root = () => document.getElementById('modal-root');

/**
 * Generic modal.
 * fields: [{ type, key, label, ... }]  — see buildField below.
 * Pass hideCancel for a one-button informational dialog.
 * Resolves with the values object, or null when cancelled.
 */
export function showDialog({ title, fields = [], okLabel = 'OK', cancelLabel = 'Cancel', hideCancel = false, onChange, onOpen, extraFoot, width }) {
  return new Promise((resolve) => {
    const values = {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    if (width) modal.style.width = `${width}px`;
    modal.innerHTML = `<div class="modal-title">${escapeHtml(title)}</div>`;

    const body = document.createElement('div');
    body.className = 'modal-body';
    modal.appendChild(body);

    const syncers = new Map();
    const api = { values, setValue, refresh: () => onChange?.(values, api), close: (v) => finish(v) };

    for (const f of fields) {
      if (f.key !== undefined) values[f.key] = f.value;
      body.appendChild(buildField(f, values, (key) => onChange?.(values, api, key), syncers));
    }

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    if (extraFoot) foot.appendChild(extraFoot(api));
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    foot.appendChild(spacer);

    // Informational dialogs have nothing to cancel, so they get one button.
    const ok = button(okLabel, 'btn primary', () => finish({ ...values }));
    if (!hideCancel) foot.appendChild(button(cancelLabel, 'btn', () => finish(null)));
    foot.appendChild(ok);
    modal.appendChild(foot);
    backdrop.appendChild(modal);
    root().appendChild(backdrop);

    /**
     * Updates one field's value and its widgets. Deliberately does NOT re-fire
     * onChange, so a handler that links two fields (width <-> height) can't
     * bounce back and forth.
     */
    function setValue(key, v) {
      values[key] = v;
      syncers.get(key)?.(v);
    }

    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); finish({ ...values }); }
    };
    backdrop.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });

    function finish(v) {
      backdrop.remove();
      resolve(v);
    }

    requestAnimationFrame(() => {
      const first = body.querySelector('input,select,textarea');
      (first || ok).focus();
      if (first?.select) first.select();
      onOpen?.(api, body);
    });
  });
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function buildField(f, values, changed, syncers) {
  if (f.type === 'custom') return f.render(values, changed);

  const row = document.createElement('div');
  row.className = 'field';

  if (f.type === 'note') {
    row.className = 'hint';
    row.textContent = formatKeys(f.text);
    return row;
  }
  if (f.type === 'separator') {
    const hr = document.createElement('div');
    hr.style.cssText = 'height:1px;background:var(--line-soft);margin:2px 0';
    return hr;
  }

  const label = document.createElement('label');
  label.textContent = f.label ?? '';
  row.appendChild(label);

  let input;
  switch (f.type) {
    case 'range': {
      input = document.createElement('input');
      input.type = 'range';
      input.min = f.min; input.max = f.max; input.step = f.step ?? 1;
      input.value = f.value;
      const val = document.createElement('span');
      val.className = 'val';
      const fmt = () => { val.textContent = `${round(values[f.key], f.step)}${f.unit || ''}`; };
      fmt();
      input.addEventListener('input', () => { values[f.key] = Number(input.value); fmt(); changed(f.key); });
      syncers?.set(f.key, (v) => { input.value = v; fmt(); });
      row.append(input, val);
      break;
    }
    case 'number': {
      input = document.createElement('input');
      input.type = 'number';
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      input.step = f.step ?? 1;
      input.value = f.value;
      input.addEventListener('input', () => {
        const n = Number(input.value);
        values[f.key] = Number.isFinite(n) ? n : f.value;
        changed(f.key);
      });
      syncers?.set(f.key, (v) => { input.value = v; });
      row.appendChild(input);
      if (f.unit) { const u = document.createElement('span'); u.className = 'hint'; u.textContent = f.unit; row.appendChild(u); }
      break;
    }
    case 'text': {
      input = document.createElement('input');
      input.type = 'text';
      input.value = f.value ?? '';
      input.style.width = f.wide ? '220px' : '';
      input.addEventListener('input', () => { values[f.key] = input.value; changed(f.key); });
      syncers?.set(f.key, (v) => { input.value = v; });
      row.appendChild(input);
      break;
    }
    case 'select': {
      input = document.createElement('select');
      for (const [v, l] of f.items) {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        if (String(v) === String(f.value)) o.selected = true;
        input.appendChild(o);
      }
      input.addEventListener('change', () => {
        const raw = input.value;
        values[f.key] = f.numeric ? Number(raw) : raw;
        changed(f.key);
      });
      syncers?.set(f.key, (v) => { input.value = v; });
      row.appendChild(input);
      break;
    }
    case 'toggle': {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!f.value;
      input.addEventListener('change', () => { values[f.key] = input.checked; changed(f.key); });
      syncers?.set(f.key, (v) => { input.checked = !!v; });
      row.appendChild(input);
      break;
    }
    default:
      return row;
  }
  if (input) input.dataset.key = f.key;
  return row;
}

function round(v, step) {
  if (typeof v !== 'number') return v;
  const decimals = step && step < 1 ? String(step).split('.')[1].length : 0;
  return v.toFixed(decimals);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Effect dialog with live on-canvas preview. `filter` is a
 * (src, dst, w, h, params) function; `fields` describe its parameters.
 */
export async function showEffectDialog(app, { title, fields, filter, mapParams }) {
  const session = new EffectSession(app, title);
  if (!session.ok) {
    app.setStatus('Nothing to apply the effect to.');
    return false;
  }
  const run = (values) => session.preview(filter, mapParams ? mapParams(values) : values);

  const extraFoot = (api) => {
    const b = button('Reset', 'btn', () => {
      for (const f of fields) if (f.key !== undefined) api.setValue(f.key, f.value);
      run(api.values);
    });
    return b;
  };

  const result = await showDialog({
    title,
    fields,
    okLabel: 'Apply',
    extraFoot,
    onChange: (values) => run(values),
    onOpen: (api) => run(api.values)
  });

  if (result) {
    session.commit();
    app.lastEffect = { title, fields, filter, mapParams };
    return true;
  }
  session.cancel();
  return false;
}

/** Modal that shows a canvas the caller draws into (histograms, curves). */
export function canvasField(width, height, draw, onPointer) {
  return {
    type: 'custom',
    render() {
      const wrap = document.createElement('div');
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      c.className = 'curve-canvas';
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
      wrap.appendChild(c);
      const ctx = c.getContext('2d');
      const redraw = () => draw(ctx, c);
      redraw();
      if (onPointer) {
        const handle = (e) => {
          const r = c.getBoundingClientRect();
          onPointer(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), e, redraw);
        };
        c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); handle(e); });
        c.addEventListener('pointermove', (e) => { if (e.buttons) handle(e); });
      }
      wrap._redraw = redraw;
      return wrap;
    }
  };
}
