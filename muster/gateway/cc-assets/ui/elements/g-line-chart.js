// g-line-chart — lanes finished per hour, with a hover/touch guide.
// data: { title, points: number[], unit, labels?[] }
import { GraphiteElement, define, node, svg } from './base.js';
import { maskIn } from '../motion.js';

let nextId = 0;

const WIDTH = 1000;
const HEIGHT = 220;
const PAD = 26;

class GLineChart extends GraphiteElement {
  constructor() {
    super();
    this._gradientId = `g-chart-grad-${(nextId += 1)}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointermove', this._onMove);
    this.addEventListener('pointerdown', this._onMove);
    this.addEventListener('pointerleave', this._onLeave);
  }

  disconnectedCallback() {
    this.removeEventListener('pointermove', this._onMove);
    this.removeEventListener('pointerdown', this._onMove);
    this.removeEventListener('pointerleave', this._onLeave);
  }

  _points() {
    return Array.isArray(this._data?.points) ? this._data.points.map((value) => Number(value) || 0) : [];
  }

  _onMove = (event) => {
    const chart = this.querySelector('.g-chart-svg');
    const guide = this.querySelector('.g-guide');
    const tip = this.querySelector('.g-tip');
    const points = this._points();
    if (!chart || !guide || !tip || points.length < 2) return;
    const box = chart.getBoundingClientRect();
    if (!box.width) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const index = Math.round(fraction * (points.length - 1));
    const x = PAD + (index * (WIDTH - PAD * 2)) / (points.length - 1);
    const max = Math.max(1, ...points);
    const y = HEIGHT - 24 - (points[index] / max) * (HEIGHT - 50);
    guide.setAttribute('x1', String(x));
    guide.setAttribute('x2', String(x));
    guide.style.opacity = '1';
    tip.style.opacity = '1';
    tip.style.left = `${(x / WIDTH) * box.width}px`;
    tip.style.top = `${(y / HEIGHT) * box.height}px`;
    const unit = this._data?.unit ?? '';
    tip.replaceChildren(
      node('b', '', `${String(index).padStart(2, '0')}:00`),
      node('span', '', `${points[index]} ${unit}`),
    );
  };

  _onLeave = () => {
    const guide = this.querySelector('.g-guide');
    const tip = this.querySelector('.g-tip');
    if (guide) guide.style.opacity = '0';
    if (tip) tip.style.opacity = '0';
  };

  paint(data) {
    const points = Array.isArray(data.points) ? data.points.map((value) => Number(value) || 0) : [];
    const max = Math.max(1, ...points);
    const step = points.length > 1 ? (WIDTH - PAD * 2) / (points.length - 1) : 0;
    const x = (index) => PAD + index * step;
    const y = (value) => HEIGHT - 24 - (value / max) * (HEIGHT - 50);

    const root = node('figure', 'g-chart');
    const chart = svg('svg', {
      class: 'g-chart-svg',
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      preserveAspectRatio: 'none',
      role: 'img',
    });
    chart.setAttribute('aria-label', data.title || 'Lanes per hour');

    const defs = svg('defs');
    const gradient = svg('linearGradient', { id: this._gradientId, x1: '0', y1: '0', x2: '0', y2: '1' });
    gradient.append(svg('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '0.22' }));
    gradient.append(svg('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' }));
    defs.append(gradient);
    chart.append(defs);

    for (const fraction of [0, 0.5, 1]) {
      chart.append(
        svg('line', {
          class: 'g-gl',
          x1: PAD,
          x2: WIDTH - PAD,
          y1: y(max * fraction),
          y2: y(max * fraction),
          'vector-effect': 'non-scaling-stroke',
        }),
      );
    }

    const line = points.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const area = points.length
      ? `${line} L${x(points.length - 1).toFixed(1)},${HEIGHT - 24} L${x(0).toFixed(1)},${HEIGHT - 24} Z`
      : '';

    const plot = svg('g', { class: 'g-chart-plot' });
    if (area) plot.append(svg('path', { class: 'g-ar', d: area, fill: `url(#${this._gradientId})` }));
    if (line) plot.append(svg('path', { class: 'g-ln', d: line, 'vector-effect': 'non-scaling-stroke' }));
    chart.append(plot);

    const guide = svg('line', {
      class: 'g-guide',
      x1: 0,
      x2: 0,
      y1: 10,
      y2: HEIGHT - 24,
      'vector-effect': 'non-scaling-stroke',
    });
    guide.style.opacity = '0';
    chart.append(guide);

    root.append(chart);
    root.append(node('span', 'g-ylab num', `${max}`));

    const axis = node('div', 'g-axis');
    axis.setAttribute('aria-hidden', 'true');
    for (const label of Array.isArray(data.labels) ? data.labels : []) {
      axis.append(node('span', 'num', label));
    }
    if (axis.childNodes.length) root.append(axis);

    const tip = node('div', 'g-tip');
    tip.setAttribute('aria-hidden', 'true');
    root.append(tip);

    this.replaceChildren(root);
  }

  changed() {
    const plot = this.querySelector('.g-chart-plot');
    if (plot) maskIn(plot);
  }
}

define('g-line-chart', GLineChart);
export { GLineChart };
