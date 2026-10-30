// g-goal-card — one goal: name, station progress and today's lanes by stage.
// data: { code, name, project, sub, done, total, strip[], now, mergedToday, tags[], tint }
// out: g-select { id }, g-tap { action, id }
import { GraphiteElement, define, emit, node, ringLength, svg, tintSwatch, tintText } from './base.js';
import { sweepRing } from '../motion.js';

const SIZE = 46;
const STROKE = 4;
const RADIUS = (SIZE - STROKE) / 2;

class GGoalCard extends GraphiteElement {
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
    this.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('keydown', this._onKey);
  }

  _onClick = (event) => {
    const tag = event.target.closest?.('.g-tag');
    if (tag && tag.dataset.action) {
      emit(this, 'g-tap', { action: tag.dataset.action, id: this._data?.code ?? null });
      return;
    }
    if (!event.target.closest?.('.g-goal')) return;
    emit(this, 'g-select', { id: this._data?.code ?? null });
  };

  _onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.closest?.('.g-goal')) return;
    event.preventDefault();
    emit(this, 'g-select', { id: this._data?.code ?? null });
  };

  paint(data) {
    const total = Number(data.total) || 0;
    const done = Number(data.done) || 0;

    const card = node('button', 'g-goal');
    card.type = 'button';
    if (data.code !== undefined && data.code !== null) card.dataset.goal = String(data.code);
    card.style.setProperty('--tint', tintSwatch(data.tint));

    const top = node('div', 'g-goal-top');
    const identity = node('div', 'g-goal-id');
    identity.append(node('div', 'g-nm', data.name));
    const meta = node('div', 'g-meta');
    const code = node('span', 'g-code', data.code ? String(data.code) : 'No goal');
    code.style.color = tintText(data.tint);
    meta.append(code);
    if (data.project) meta.append(node('span', 'g-project', data.project));
    identity.append(meta);
    top.append(identity);

    if (total > 0) {
      const ring = node('div', 'g-mini-ring');
      const chart = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': 'true', focusable: 'false' });
      chart.append(svg('circle', { class: 'g-ring-track', cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', 'stroke-width': STROKE }));
      const bar = svg('circle', {
        class: 'g-mini-bar',
        cx: SIZE / 2,
        cy: SIZE / 2,
        r: RADIUS,
        fill: 'none',
        'stroke-width': STROKE,
        'stroke-linecap': 'round',
        'stroke-dasharray': ringLength(RADIUS),
      });
      bar.style.strokeDashoffset = String(ringLength(RADIUS));
      chart.append(bar);
      ring.append(chart, node('span', 'g-mini-val num', `${done}/${total}`));
      top.append(ring);
    }

    card.append(top);
    if (data.sub) card.append(node('div', 'g-sub', data.sub));

    const strip = node('div', 'g-strip');
    strip.setAttribute('aria-label', 'Lanes today by stage');
    for (const step of Array.isArray(data.strip) ? data.strip : []) {
      const cell = node('i', step?.tone ? `g-${step.tone}` : '');
      cell.setAttribute('title', `${step?.label ?? ''}: ${step?.count ?? 0}`);
      strip.append(cell);
    }
    if (strip.childNodes.length) card.append(strip);

    const now = node('div', 'g-goal-now');
    if (data.now) {
      now.append(node('span', '', 'Now: '));
      now.append(node('b', '', data.now));
    }
    if (Number(data.mergedToday) > 0) {
      if (data.now) now.append(node('span', '', ' · '));
      now.append(node('span', 'num', `${data.mergedToday} merged today`));
    }
    if (now.childNodes.length) card.append(now);

    const tags = Array.isArray(data.tags) ? data.tags : [];
    if (tags.length) {
      const line = node('div', 'g-tags');
      for (const tag of tags) {
        const chip = node('span', `g-tag${tag?.tone ? ` g-${tag.tone}` : ''}`, tag?.text);
        line.append(chip);
      }
      card.append(line);
    }

    this.replaceChildren(card);
  }

  changed(previous, next) {
    const bar = this.querySelector('.g-mini-bar');
    if (!bar) return;
    const total = Number(next.total) || 0;
    if (!total) return;
    sweepRing(bar, (Number(next.done) || 0) / total, { radius: RADIUS });
  }
}

define('g-goal-card', GGoalCard);
export { GGoalCard };
