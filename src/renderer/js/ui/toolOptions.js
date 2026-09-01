// Renders the per-tool options bar from each tool's `schema` getter.

import { toCss, toHex } from '../color.js';
import { pickColor } from './colorPicker.js';
import { setTip } from './tooltip.js';
import { formatKeys } from '../platform.js';

export function mountToolOptions(app, el) {
  let disposers = [];
  let syncers = [];
  const syncAll = () => { for (const fn of syncers) fn(); };

  const render = () => {
    for (const off of disposers) off();
    disposers = [];
    syncers = [];
    el.innerHTML = '';
    const tool = app.activeTool;
    if (!tool) return;

    const name = document.createElement('div');
    name.className = 'opt';
    name.innerHTML = `<strong style="color:var(--text)">${tool.constructor.label}</strong>`;
    el.appendChild(name);

    const schema = tool.schema || [];
    for (const item of schema) {
      el.appendChild(separator());
      el.appendChild(control(app, tool, item, { disposers, syncers, syncAll }));
    }
  };

  app.on('tool-changed', render);
  app.on('tool-options-changed', render);
  render();
}

const STYLE_NAMES = { outline: 'Outline', fill: 'Interior', both: 'Both' };
const styleName = (v) => STYLE_NAMES[v] || v;

function separator() {
  const d = document.createElement('div');
  d.className = 'opt-sep';
  return d;
}

function control(app, tool, item, ctx = { disposers: [], syncers: [], syncAll() {} }) {
  const wrap = document.createElement('div');
  wrap.className = 'opt';

  const notify = () => {
    tool.refresh?.();
    ctx.syncAll();
    app.emit('tool-option-set', { tool: tool.constructor.id, key: item.key });
    app.view.render();
  };

  switch (item.type) {
    case 'range': {
      const label = document.createElement('label');
      label.textContent = item.label;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = item.min; range.max = item.max; range.step = item.step ?? 1;
      range.value = tool.options[item.key];

      const val = document.createElement(item.number ? 'input' : 'span');
      if (item.number) {
        val.type = 'number';
        val.min = item.min; val.max = item.max; val.step = item.step ?? 1;
        val.value = tool.options[item.key];
        val.addEventListener('input', () => {
          const n = Number(val.value);
          if (!Number.isFinite(n)) return;
          tool.options[item.key] = n;
          range.value = n;
          notify();
        });
      } else {
        val.className = 'val';
        val.textContent = `${tool.options[item.key]}${item.unit || ''}`;
      }

      range.addEventListener('input', () => {
        const n = Number(range.value);
        tool.options[item.key] = n;
        if (item.number) val.value = n; else val.textContent = `${n}${item.unit || ''}`;
        notify();
      });
      wrap.append(label, range, val);
      break;
    }
    case 'segmented': {
      const label = document.createElement('label');
      label.textContent = item.label;
      const seg = document.createElement('div');
      seg.className = 'segmented';
      for (const [v, l] of item.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = l;
        b.classList.toggle('on', tool.options[item.key] === v);
        b.addEventListener('click', () => {
          tool.options[item.key] = v;
          for (const other of seg.children) other.classList.remove('on');
          b.classList.add('on');
          notify();
        });
        seg.appendChild(b);
      }
      wrap.append(label, seg);
      break;
    }
    case 'select': {
      const label = document.createElement('label');
      label.textContent = item.label;
      const sel = document.createElement('select');
      if (item.wide) sel.style.maxWidth = '150px';
      for (const [v, l] of item.items) {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        if (tool.options[item.key] === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { tool.options[item.key] = sel.value; notify(); });
      wrap.append(label, sel);
      break;
    }
    case 'toggle': {
      const label = document.createElement('label');
      label.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!tool.options[item.key];
      cb.addEventListener('change', () => { tool.options[item.key] = cb.checked; notify(); });
      label.append(cb, document.createTextNode(item.label));
      wrap.appendChild(label);
      break;
    }
    case 'color': {
      const label = document.createElement('label');
      label.textContent = item.label;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-opt';
      const swatch = document.createElement('i');
      btn.appendChild(swatch);

      // A null value means "follow the palette", so the control keeps tracking
      // the primary/secondary swatches until the user pins a specific colour.
      const fallback = () => (item.fallback === 'secondary' ? app.secondaryColor : app.primaryColor);

      // Whether the current Style actually paints this role. An outline-only
      // shape ignores its fill colour, which otherwise looks like a broken control.
      const inUse = () => {
        const style = tool.options.style;
        if (!style || !item.role) return true;
        return item.role === 'fill' ? style !== 'outline' : style !== 'fill';
      };

      const sync = () => {
        const pinned = tool.options[item.key];
        const active = inUse();
        swatch.style.background = toCss(pinned || fallback());
        btn.classList.toggle('linked', !pinned);
        btn.classList.toggle('muted', !active);
        const source = item.fallback || 'primary';
        setTip(btn, {
          title: item.label,
          desc: !active
            ? `Style is set to ${styleName(tool.options.style)}, so this colour isn't painted. Pick one and the style switches to Both.`
            : pinned
              ? `Pinned to ${toHex(pinned)}. Click to change, right-click to follow the ${source} colour again.`
              : `Following the ${source} colour. Click to pin a specific colour.`,
          place: 'bottom'
        });
      };

      btn.addEventListener('click', async () => {
        const wasUnused = !inUse();
        const picked = await pickColor(tool.options[item.key] || fallback(), item.label);
        if (!picked) return;
        tool.options[item.key] = picked;
        if (wasUnused) {
          // Honour the obvious intent rather than silently ignoring the choice.
          tool.options.style = 'both';
          app.setStatus(`Style switched to Both so the ${item.label.toLowerCase()} colour is used.`);
          app.emit('tool-options-changed');
          return;
        }
        notify();
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        tool.options[item.key] = null;
        notify();
      });

      // Track palette changes while this control is unpinned.
      ctx.disposers.push(app.on('color-changed', sync));
      ctx.syncers.push(sync);
      sync();
      wrap.append(label, btn);
      break;
    }
    case 'note': {
      wrap.style.color = 'var(--text-faint)';
      wrap.textContent = formatKeys(item.text);
      break;
    }
  }
  return wrap;
}
