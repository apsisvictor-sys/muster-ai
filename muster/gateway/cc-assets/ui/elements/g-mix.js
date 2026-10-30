// g-mix — the share of working lanes per model, as a bar and a legend.
// data: { parts: [{ label, count }] }
import { GraphiteElement, define, node } from './base.js';
import { growBars } from '../motion.js';

class GMix extends GraphiteElement {
  paint(data) {
    const parts = Array.isArray(data.parts) ? data.parts : [];
    const total = parts.reduce((sum, part) => sum + (Number(part?.count) || 0), 0);

    const root = node('div', 'g-mix-wrap');
    const mix = node('div', 'g-mix');
    mix.setAttribute('role', 'img');
    mix.setAttribute('aria-label', parts.map((part) => `${part?.label}: ${part?.count ?? 0}`).join(', '));

    const legend = node('div', 'g-legend');

    parts.forEach((part, index) => {
      const count = Number(part?.count) || 0;
      const share = total > 0 ? (count / total) * 100 : 0;
      const bar = node('i', index ? 'g-mix-2' : 'g-mix-1');
      bar.dataset.grow = 'x';
      bar.style.flex = String(Math.max(share, 0.01));
      mix.append(bar);

      const item = node('span', 'g-legend-item');
      const dot = node('i', index ? 'g-legend-2' : 'g-legend-1');
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, node('span', '', `${part?.label ?? ''} · ${count}`));
      legend.append(item);
    });

    root.append(mix, legend);
    this.replaceChildren(root);
  }

  changed() {
    const mix = this.querySelector('.g-mix');
    if (mix) growBars(mix);
  }
}

define('g-mix', GMix);
export { GMix };
