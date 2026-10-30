// g-kpi — one tile of the at-a-glance row.
// data: { label, aside, big, dec, lines[], mix[], bars, rings[], tone, cta }
// out: g-tap { action, id }
import { GraphiteElement, define, emit, icon, node } from './base.js';
import { countUp } from '../motion.js';

class GKpi extends GraphiteElement {
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
  }

  _onClick = (event) => {
    const cta = event.target.closest?.('.g-cta');
    if (!cta || !this.contains(cta)) return;
    const action = this._data?.cta?.action ?? null;
    emit(this, 'g-tap', { action, id: this._data?.cta?.id ?? null });
  };

  paint(data) {
    const root = node('div', 'g-kpi');
    if (data.tone) root.classList.add(`g-kpi--${data.tone}`);

    const head = node('h3', 'g-kpi-h');
    head.append(node('span', 'g-kpi-label', data.label));
    if (data.aside) head.append(node('span', 'g-kpi-aside', data.aside));
    root.append(head);

    const big = node('div', 'g-kpi-big num');
    big.dataset.dec = String(data.dec ?? 0);
    big.textContent = String(data.big ?? 0);
    root.append(big);

    for (const line of Array.isArray(data.lines) ? data.lines : []) {
      root.append(node('div', 'g-kpi-line', line));
    }

    if (Array.isArray(data.mix) && data.mix.length) {
      const mix = document.createElement('g-mix');
      mix.data = { parts: data.mix };
      root.append(mix);
    }

    if (data.bars && Array.isArray(data.bars.values)) {
      const bars = document.createElement('g-hourbars');
      bars.data = data.bars;
      root.append(bars);
    }

    if (Array.isArray(data.rings) && data.rings.length) {
      const rings = node('div', 'g-rings');
      for (const ring of data.rings) {
        const item = document.createElement('g-ring');
        item.data = ring;
        rings.append(item);
      }
      root.append(rings);
    }

    if (data.cta) {
      const cta = node('button', 'g-cta');
      cta.type = 'button';
      if (data.cta.action) cta.dataset.action = data.cta.action;
      cta.append(node('span', 'g-cta-label', data.cta.label || ''));
      cta.append(icon('arrow'));
      root.append(cta);
    }

    this.replaceChildren(root);
  }

  changed(previous, next) {
    const big = this.querySelector('.g-kpi-big');
    if (!big) return;
    const before = Number(previous?.big ?? 0);
    const after = Number(next.big ?? 0);
    if (previous === null) countUp(big, after, { decimals: Number(next.dec ?? 0) });
    else if (before !== after) countUp(big, after, { from: before, decimals: Number(next.dec ?? 0) });
  }
}

define('g-kpi', GKpi);
export { GKpi };
