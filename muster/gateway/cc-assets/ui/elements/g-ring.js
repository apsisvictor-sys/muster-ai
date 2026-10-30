// g-ring — one usage ring, with an optional inner ring for the second window.
// data: { label, used, sub, inner }
import { GraphiteElement, define, node, ringLength, svg } from './base.js';
import { sweepRing } from '../motion.js';

const SIZE = 68;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const INNER_SIZE = 48;
const INNER_STROKE = 5;
const INNER_RADIUS = (INNER_SIZE - INNER_STROKE) / 2;

const arc = (radius, stroke, className) => {
  const length = ringLength(radius);
  const circle = svg('circle', {
    class: className,
    cx: SIZE / 2,
    cy: SIZE / 2,
    r: radius,
    fill: 'none',
    'stroke-width': stroke,
    'stroke-linecap': 'round',
    'stroke-dasharray': length,
  });
  circle.style.strokeDashoffset = String(length);
  return circle;
};

class GRing extends GraphiteElement {
  paint(data) {
    const used = Math.max(0, Math.min(100, Number(data.used) || 0));
    const root = node('div', 'g-ring');

    const wrap = node('div', 'g-ring-wrap');
    const chart = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': 'true', focusable: 'false' });
    chart.append(arc(RADIUS, STROKE, 'g-ring-track'));
    const bar = arc(RADIUS, STROKE, `g-ring-bar${used >= 100 ? ' g-ring-full' : ''}`);
    chart.append(bar);

    if (data.inner !== undefined && data.inner !== null) {
      const group = svg('g', { transform: `translate(${(SIZE - INNER_SIZE) / 2} ${(SIZE - INNER_SIZE) / 2})` });
      group.append(arc(INNER_RADIUS, INNER_STROKE, 'g-ring-track'));
      group.append(arc(INNER_RADIUS, INNER_STROKE, 'g-ring-bar g-ring-inner'));
      chart.append(group);
    }

    wrap.append(chart, node('span', 'g-ring-val num', data.used === undefined || data.used === null ? '–' : `${used}%`));
    root.append(wrap, node('b', 'g-ring-label', data.label));
    if (data.sub) root.append(node('small', 'g-ring-sub', data.sub));
    this.replaceChildren(root);
  }

  changed(previous, next) {
    const bars = this.querySelectorAll('.g-ring-bar');
    if (!bars.length) return;
    const used = Math.max(0, Math.min(100, Number(next.used) || 0)) / 100;
    sweepRing(bars[0], used, { radius: RADIUS });
    if (bars[1]) sweepRing(bars[1], Math.max(0, Math.min(1, Number(next.inner) || 0)), { radius: INNER_RADIUS });
  }
}

define('g-ring', GRing);
export { GRing };
