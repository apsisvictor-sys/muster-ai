// g-donut — lanes by model as a ring with a legend.
// data: { segments: [{ label, value }], centre: { big, small } }
import { GraphiteElement, define, node, ringLength, svg } from './base.js';
import { maskIn } from '../motion.js';

const SIZE = 170;
const RADIUS = 70;
const STROKE = 20;

class GDonut extends GraphiteElement {
  paint(data) {
    const segments = Array.isArray(data.segments) ? data.segments.filter((part) => Number(part?.value) > 0) : [];
    const total = segments.reduce((sum, part) => sum + (Number(part.value) || 0), 0);
    const length = ringLength(RADIUS);

    const root = node('div', 'g-donut');
    const centre = node('div', 'g-donut-cen');
    const chart = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': 'true', focusable: 'false' });

    let offset = 0;
    segments.forEach((part, index) => {
      const value = Number(part.value) || 0;
      const span = total > 0 ? (value / total) * length : 0;
      const arc = svg('circle', {
        class: `g-seg g-seg-${(index % 5) + 1}`,
        cx: SIZE / 2,
        cy: SIZE / 2,
        r: RADIUS,
        fill: 'none',
        'stroke-width': STROKE,
        'stroke-dasharray': `${span} ${length}`,
        'stroke-dashoffset': String(-offset),
      });
      offset += span;
      chart.append(arc);
    });

    const big = node('b', 'num', data.centre?.big ?? total);
    centre.append(chart, node('span', 'g-donut-mid', ''));
    const middle = centre.querySelector('.g-donut-mid');
    middle.append(big);
    if (data.centre?.small) middle.append(node('small', '', data.centre.small));

    const legend = node('ul', 'g-dleg');
    for (const part of segments) {
      const item = node('li');
      const dot = node('i', 'g-dleg-dot');
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, node('span', 'g-dleg-l', part.label), node('span', 'g-dleg-v num', part.value));
      legend.append(item);
    }

    root.append(centre, legend);
    this.replaceChildren(root);
  }

  changed() {
    const centre = this.querySelector('.g-donut-cen');
    if (centre) maskIn(centre);
  }
}

define('g-donut', GDonut);
export { GDonut };
