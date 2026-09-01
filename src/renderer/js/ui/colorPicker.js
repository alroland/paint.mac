// Full colour picker dialog: saturation/value square, hue strip, alpha strip,
// plus synchronised hex and numeric fields.

import { showDialog } from './dialogs.js';
import { hsvToRgb, rgbToHsv, toHex, fromHex, toCss } from '../color.js';
import { clamp } from '../util.js';

export async function pickColor(initial, title = 'Choose Colour') {
  let { h, s, v } = rgbToHsv(initial.r, initial.g, initial.b);
  let a = initial.a ?? 1;

  const current = () => ({ ...hsvToRgb(h, s, v), a });

  let refresh = () => {};

  const field = {
    type: 'custom',
    render() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:12px;align-items:flex-start';

      const sv = document.createElement('canvas');
      sv.width = 240; sv.height = 190;
      sv.style.cssText = 'width:240px;height:190px;border-radius:6px;border:1px solid var(--line);cursor:crosshair';

      const strips = document.createElement('div');
      strips.style.cssText = 'display:flex;gap:8px';
      const hue = document.createElement('canvas');
      hue.width = 18; hue.height = 190;
      hue.style.cssText = 'width:18px;height:190px;border-radius:4px;border:1px solid var(--line);cursor:crosshair';
      const alpha = document.createElement('canvas');
      alpha.width = 18; alpha.height = 190;
      alpha.style.cssText = 'width:18px;height:190px;border-radius:4px;border:1px solid var(--line);cursor:crosshair';
      strips.append(hue, alpha);

      const side = document.createElement('div');
      side.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:130px';
      const preview = document.createElement('div');
      preview.style.cssText = 'height:36px;border-radius:5px;border:1px solid var(--line)';
      const hexInput = document.createElement('input');
      hexInput.type = 'text';
      hexInput.style.cssText = 'width:100%;background:var(--bg-3);border:1px solid var(--line);color:var(--text);border-radius:4px;height:22px;padding:0 5px;font-family:var(--mono);text-transform:uppercase';

      const numbers = document.createElement('div');
      numbers.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:4px 6px;align-items:center';
      const inputs = {};
      for (const key of ['R', 'G', 'B', 'A']) {
        const lab = document.createElement('span');
        lab.textContent = key;
        lab.style.color = 'var(--text-dim)';
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = 0; inp.max = key === 'A' ? 100 : 255;
        inp.style.cssText = 'width:100%;background:var(--bg-3);border:1px solid var(--line);color:var(--text);border-radius:4px;height:20px;padding:0 4px';
        inp.addEventListener('input', () => {
          const c = current();
          const n = clamp(Number(inp.value) || 0, 0, key === 'A' ? 100 : 255);
          if (key === 'A') a = n / 100;
          else {
            const next = { ...c, [key.toLowerCase()]: n };
            ({ h, s, v } = rgbToHsv(next.r, next.g, next.b));
          }
          refresh(true);
        });
        inputs[key] = inp;
        numbers.append(lab, inp);
      }

      hexInput.addEventListener('input', () => {
        const parsed = fromHex(hexInput.value, a);
        if (!parsed) return;
        ({ h, s, v } = rgbToHsv(parsed.r, parsed.g, parsed.b));
        refresh(true);
      });

      side.append(preview, hexInput, numbers);
      wrap.append(sv, strips, side);

      const svCtx = sv.getContext('2d');
      const hueCtx = hue.getContext('2d');
      const alphaCtx = alpha.getContext('2d');

      // Hue strip is static; drawn once.
      const hg = hueCtx.createLinearGradient(0, 0, 0, hue.height);
      for (let i = 0; i <= 6; i++) {
        const c = hsvToRgb(i * 60, 1, 1);
        hg.addColorStop(i / 6, `rgb(${c.r},${c.g},${c.b})`);
      }

      refresh = (skipFields) => {
        const c = current();

        svCtx.fillStyle = toCss({ ...hsvToRgb(h, 1, 1), a: 1 });
        svCtx.fillRect(0, 0, sv.width, sv.height);
        const white = svCtx.createLinearGradient(0, 0, sv.width, 0);
        white.addColorStop(0, 'rgba(255,255,255,1)');
        white.addColorStop(1, 'rgba(255,255,255,0)');
        svCtx.fillStyle = white;
        svCtx.fillRect(0, 0, sv.width, sv.height);
        const black = svCtx.createLinearGradient(0, 0, 0, sv.height);
        black.addColorStop(0, 'rgba(0,0,0,0)');
        black.addColorStop(1, 'rgba(0,0,0,1)');
        svCtx.fillStyle = black;
        svCtx.fillRect(0, 0, sv.width, sv.height);
        const cx = s * sv.width, cy = (1 - v) * sv.height;
        svCtx.strokeStyle = v > 0.55 && s < 0.55 ? '#000' : '#fff';
        svCtx.lineWidth = 1.5;
        svCtx.beginPath();
        svCtx.arc(cx, cy, 6, 0, Math.PI * 2);
        svCtx.stroke();

        hueCtx.fillStyle = hg;
        hueCtx.fillRect(0, 0, hue.width, hue.height);
        hueCtx.strokeStyle = '#fff';
        hueCtx.lineWidth = 2;
        const hy = (h / 360) * hue.height;
        hueCtx.beginPath();
        hueCtx.moveTo(0, hy); hueCtx.lineTo(hue.width, hy);
        hueCtx.stroke();

        alphaCtx.fillStyle = '#fff';
        alphaCtx.fillRect(0, 0, alpha.width, alpha.height);
        alphaCtx.fillStyle = '#bbb';
        for (let y = 0; y < alpha.height; y += 6) {
          for (let x = 0; x < alpha.width; x += 6) {
            if (((x / 6) + (y / 6)) % 2 === 0) alphaCtx.fillRect(x, y, 6, 6);
          }
        }
        const ag = alphaCtx.createLinearGradient(0, 0, 0, alpha.height);
        ag.addColorStop(0, `rgba(${c.r},${c.g},${c.b},1)`);
        ag.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
        alphaCtx.fillStyle = ag;
        alphaCtx.fillRect(0, 0, alpha.width, alpha.height);
        alphaCtx.strokeStyle = '#fff';
        alphaCtx.lineWidth = 2;
        const ay = (1 - a) * alpha.height;
        alphaCtx.beginPath();
        alphaCtx.moveTo(0, ay); alphaCtx.lineTo(alpha.width, ay);
        alphaCtx.stroke();

        preview.style.background = toCss(c);
        if (!skipFields) hexInput.value = toHex(c);
        inputs.R.value = c.r;
        inputs.G.value = c.g;
        inputs.B.value = c.b;
        inputs.A.value = Math.round(a * 100);
        result.color = c;
      };

      drag(sv, (px, py) => { s = px; v = 1 - py; refresh(); });
      drag(hue, (_px, py) => { h = py * 360; refresh(); });
      drag(alpha, (_px, py) => { a = 1 - py; refresh(); });

      refresh();
      return wrap;
    }
  };

  const result = { color: current() };
  const out = await showDialog({ title, fields: [field], okLabel: 'Choose' });
  return out ? result.color : null;
}

function drag(canvas, cb) {
  const handle = (e) => {
    const r = canvas.getBoundingClientRect();
    cb(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); handle(e); });
  canvas.addEventListener('pointermove', (e) => { if (e.buttons) handle(e); });
}
