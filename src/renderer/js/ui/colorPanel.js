import { toCss, toHex, fromHex, DEFAULT_PALETTE } from '../color.js';
import { pickColor } from './colorPicker.js';
import { setTip } from './tooltip.js';
import { clamp } from '../util.js';

export function mountColorPanel(app, el) {
  el.innerHTML = `
    <div class="color-top">
    <div class="swatch-stack">
      <div class="swatch secondary" id="sw-secondary" data-tip="Secondary Colour" data-tip-desc="Used by right-click drags and as the gradient end colour. Double-click to edit." data-tip-place="left"><i></i></div>
      <div class="swatch primary on" id="sw-primary" data-tip="Primary Colour" data-tip-desc="Used by every drawing tool. Double-click to edit." data-tip-place="left"><i></i></div>
      <button class="swap-btn" id="sw-swap" data-tip="Swap Colours" data-tip-key="X" data-tip-place="left">⇄</button>
    </div>
    <div class="color-fields">
      <div class="hex-row"><input id="hex-input" maxlength="9" spellcheck="false" /></div>
      <div class="alpha-row"><span style="color:var(--text-dim)">A</span><input type="range" id="alpha-input" min="0" max="100" step="1" /><span class="val" id="alpha-val"></span></div>
    </div>
    </div>`;

  const palette = document.createElement('div');
  palette.className = 'palette';
  el.appendChild(palette);

  const primary = el.querySelector('#sw-primary');
  const secondary = el.querySelector('#sw-secondary');
  const hexInput = el.querySelector('#hex-input');
  const alphaInput = el.querySelector('#alpha-input');
  const alphaVal = el.querySelector('#alpha-val');

  for (const hex of DEFAULT_PALETTE) {
    const d = document.createElement('div');
    d.style.background = hex;
    setTip(d, { title: hex.toUpperCase(), desc: 'Click sets the primary colour, right-click the secondary.' });
    d.addEventListener('click', () => app.setPrimaryColor({ ...fromHex(hex), a: app.primaryColor.a }));
    d.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      app.setSecondaryColor({ ...fromHex(hex), a: app.secondaryColor.a });
    });
    palette.appendChild(d);
  }

  const openPicker = async (which) => {
    const start = which === 'primary' ? app.primaryColor : app.secondaryColor;
    const picked = await pickColor(start, which === 'primary' ? 'Primary Colour' : 'Secondary Colour');
    if (!picked) return;
    which === 'primary' ? app.setPrimaryColor(picked) : app.setSecondaryColor(picked);
  };

  primary.addEventListener('click', () => { app.activeSwatch = 'primary'; sync(); });
  primary.addEventListener('dblclick', () => openPicker('primary'));
  secondary.addEventListener('click', () => { app.activeSwatch = 'secondary'; sync(); });
  secondary.addEventListener('dblclick', () => openPicker('secondary'));
  el.querySelector('#sw-swap').addEventListener('click', () => app.swapColors());

  hexInput.addEventListener('change', () => {
    const c = fromHex(hexInput.value, active().a);
    if (c) setActive(c); else sync();
  });
  alphaInput.addEventListener('input', () => {
    const a = clamp(Number(alphaInput.value) / 100, 0, 1);
    setActive({ ...active(), a });
  });

  function active() { return app.activeSwatch === 'secondary' ? app.secondaryColor : app.primaryColor; }
  function setActive(c) {
    app.activeSwatch === 'secondary' ? app.setSecondaryColor(c) : app.setPrimaryColor(c);
  }

  function sync() {
    primary.querySelector('i').style.background = toCss(app.primaryColor);
    secondary.querySelector('i').style.background = toCss(app.secondaryColor);
    primary.classList.toggle('on', app.activeSwatch !== 'secondary');
    secondary.classList.toggle('on', app.activeSwatch === 'secondary');
    const c = active();
    if (document.activeElement !== hexInput) hexInput.value = toHex(c);
    alphaInput.value = Math.round(c.a * 100);
    alphaVal.textContent = `${Math.round(c.a * 100)}%`;
  }

  app.on('color-changed', sync);
  sync();
}
