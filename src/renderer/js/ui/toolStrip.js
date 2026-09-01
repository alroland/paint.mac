import { TOOL_GROUPS } from '../tools/index.js';
import { iconSvg } from '../tools/base.js';
import { setTip } from './tooltip.js';

export function mountToolStrip(app, el) {
  el.innerHTML = '';
  const buttons = new Map();

  TOOL_GROUPS.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('div');
      sep.className = 'tool-sep';
      el.appendChild(sep);
    }
    for (const T of group) {
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.type = 'button';
      b.innerHTML = iconSvg(T.icon);
      setTip(b, { title: T.label, key: T.shortcut, desc: T.hint, place: 'right' });
      b.setAttribute('aria-label', T.shortcut ? `${T.label} (${T.shortcut})` : T.label);
      b.addEventListener('click', () => app.setTool(T.id));
      el.appendChild(b);
      buttons.set(T.id, b);
    }
  });

  const sync = () => {
    for (const [id, b] of buttons) b.classList.toggle('on', id === app.activeToolId);
  };
  app.on('tool-changed', sync);
  sync();
}
