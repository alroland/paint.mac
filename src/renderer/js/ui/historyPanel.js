import { setTip } from './tooltip.js';

export function mountHistoryPanel(app, el) {
  const render = () => {
    const h = app.history;
    el.innerHTML = '';

    const base = document.createElement('div');
    base.className = 'hist-row' + (h.index === -1 ? ' on' : '');
    base.textContent = 'Open / New Image';
    setTip(base, { title: 'Open / New Image', desc: 'The document as it was before any edits.', place: 'left' });
    base.addEventListener('click', () => h.goTo(-1));
    el.appendChild(base);

    h.entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'hist-row' + (i === h.index ? ' on' : '') + (i > h.index ? ' future' : '');
      row.textContent = entry.label;
      // Long labels are ellipsized in this narrow panel, so the tip shows them in full.
      setTip(row, {
        title: entry.label,
        desc: i === h.index ? 'Current state.' : i > h.index ? 'Click to redo up to here.' : 'Click to undo back to here.',
        place: 'left'
      });
      row.addEventListener('click', () => {
        h.goTo(i);
        app.view.render();
      });
      el.appendChild(row);
    });

    const current = el.querySelector('.hist-row.on');
    current?.scrollIntoView({ block: 'nearest' });
  };

  app.history.on('changed', render);
  app.on('document-changed', render);
  render();
}
