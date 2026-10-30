// g-lane-card — one lane on the board.
// data: { id, title, chip, when, rounds, now, waits, model, attention, tint, goalCode }
// out: g-select { id }
import { GraphiteElement, define, emit, node, tintSwatch, tintText } from './base.js';

class GLaneCard extends GraphiteElement {
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
    if (!event.target.closest?.('.g-card')) return;
    this._select();
  };

  _onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.closest?.('.g-card')) return;
    event.preventDefault();
    this._select();
  };

  _select() {
    emit(this, 'g-select', { id: this._data?.id ?? null });
  }

  paint(data) {
    const card = node('button', 'g-card');
    card.type = 'button';
    if (data.id !== undefined && data.id !== null) card.dataset.id = String(data.id);
    card.style.setProperty('--tint', tintSwatch(data.tint));

    const top = node('div', 'g-r1');
    if (data.goalCode) {
      const goal = node('span', 'g-gc', data.goalCode);
      goal.style.color = tintText(data.tint);
      top.append(goal);
    }
    if (data.chip) top.append(node('span', 'g-kind', data.chip));
    if (data.when) top.append(node('span', 'g-when num', data.when));
    if (Number(data.rounds) > 0) {
      const rounds = node('span', 'g-rounds');
      rounds.setAttribute('title', `${data.rounds} fix round${Number(data.rounds) > 1 ? 's' : ''}`);
      for (let index = 0; index < Number(data.rounds); index += 1) rounds.append(node('i'));
      top.append(rounds);
    }
    if (top.childNodes.length) card.append(top);

    card.append(node('div', 'g-tt', data.title));

    if (data.now) {
      const line = node('div', 'g-nowl');
      const dot = node('i');
      dot.setAttribute('aria-hidden', 'true');
      line.append(dot, node('span', 'g-nowl-t', data.now));
      card.append(line);
    }
    if (data.waits) card.append(node('div', 'g-waits', data.waits));
    if (data.attention) card.append(node('div', 'g-attn', data.attention));
    if (data.model) {
      const row = node('div', 'g-r3');
      row.append(node('span', 'g-model', data.model));
      card.append(row);
    }

    this.replaceChildren(card);
  }
}

define('g-lane-card', GLaneCard);
export { GLaneCard };
