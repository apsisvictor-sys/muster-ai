// g-hbars — horizontal bars: fix rounds per model, lanes per goal.
// data: { rows: [{ label, value, max, display, tint }] }
import { GraphiteElement, define, node, tintSwatch } from './base.js';
import { growBars } from '../motion.js';

class GHBars extends GraphiteElement {
  paint(data) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const root = node('ul', 'g-hbars');

    for (const row of rows) {
      const max = Number(row?.max) || Math.max(1, ...rows.map((item) => Number(item?.value) || 0));
      const value = Number(row?.value) || 0;
      const item = node('li');

      const label = node('span', 'g-hbars-l');
      if (row?.tint) {
        const dot = node('i', 'g-hbars-dot');
        dot.style.background = tintSwatch(row.tint);
        dot.setAttribute('aria-hidden', 'true');
        label.append(dot);
      }
      label.append(node('span', 'g-hbars-t', row?.label));
      item.append(label);

      const track = node('div', 'g-b');
      const bar = node('i');
      bar.dataset.grow = 'x';
      bar.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
      if (row?.tint) bar.style.background = tintSwatch(row.tint);
      track.append(bar);
      item.append(track, node('span', 'g-hbars-v num', row?.display ?? value));
      root.append(item);
    }

    this.replaceChildren(root);
  }

  changed() {
    const root = this.querySelector('.g-hbars');
    if (root) growBars(root);
  }
}

define('g-hbars', GHBars);
export { GHBars };
