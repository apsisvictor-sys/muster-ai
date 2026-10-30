// g-chips — the three small counters beside a page title.
// data: { chips: [{ label, value, icon }] }
import { GraphiteElement, define, icon, node } from './base.js';
import { countUp } from '../motion.js';

class GChips extends GraphiteElement {
  paint(data) {
    const root = node('div', 'g-chips');
    for (const chip of Array.isArray(data.chips) ? data.chips : []) {
      const item = node('div', 'g-chip');
      const badge = node('span', 'g-chip-ic');
      badge.append(icon(chip?.icon || 'check'));
      const body = node('div', 'g-chip-body');
      const value = node('b', 'g-chip-v num', chip?.value ?? 0);
      body.append(value, node('small', 'g-chip-l', chip?.label));
      item.append(badge, body);
      root.append(item);
    }
    this.replaceChildren(root);
  }

  changed(previous, next) {
    const values = [...this.querySelectorAll('.g-chip-v')];
    const chips = Array.isArray(next.chips) ? next.chips : [];
    values.forEach((element, index) => {
      const before = previous?.chips?.[index]?.value;
      const after = Number(chips[index]?.value ?? 0);
      if (previous === null) countUp(element, after);
      else if (Number(before ?? 0) !== after) countUp(element, after, { from: Number(before ?? 0) });
    });
  }
}

define('g-chips', GChips);
export { GChips };
