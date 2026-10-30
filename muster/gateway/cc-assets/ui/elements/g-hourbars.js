// g-hourbars — one bar per hour, the current hour in ink, the rest hatched.
// data: { values: number[], now, label }
import { GraphiteElement, define } from './base.js';
import { growBars } from '../motion.js';

class GHourbars extends GraphiteElement {
  paint(data) {
    const values = Array.isArray(data.values) ? data.values : [];
    const max = Math.max(1, ...values.map((value) => Number(value) || 0));
    const now = Number.isInteger(data.now) ? data.now : null;

    const root = document.createElement('div');
    root.className = 'g-hourbars';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', data.label || 'Lanes per hour');

    values.forEach((value, hour) => {
      const count = Number(value) || 0;
      const bar = document.createElement('i');
      bar.dataset.grow = 'y';
      if (hour === now) bar.classList.add('g-now');
      bar.style.height = `${Math.max(4, (count / max) * 100)}%`;
      bar.title = `${String(hour).padStart(2, '0')}:00 · ${count}`;
      root.append(bar);
    });

    this.replaceChildren(root);
  }

  changed() {
    const root = this.querySelector('.g-hourbars');
    if (root) growBars(root);
  }
}

define('g-hourbars', GHourbars);
export { GHourbars };
