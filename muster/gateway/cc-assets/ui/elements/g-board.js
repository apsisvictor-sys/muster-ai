// g-board — the stage columns of lanes. Column keys arrive as data and the library
// never names one: the head dot takes its colour from the column's accent token.
// data: { columns: [{ key, label, empty, cards[], more, accent }], phoneStart }
// out: g-tap { action, id }, and g-select passed up from a lane card
import { GraphiteElement, define, emit, node } from './base.js';
import { flip } from '../motion.js';

class GBoard extends GraphiteElement {
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
  }

  _onClick = (event) => {
    const more = event.target.closest?.('.g-more');
    if (more && this.contains(more)) {
      emit(this, 'g-tap', { action: 'more', id: more.dataset.more ?? null });
    }
  };

  paint(data) {
    const before = new Map();
    for (const card of this.querySelectorAll('.g-card')) {
      if (card.dataset.id !== undefined) before.set(card.dataset.id, card.getBoundingClientRect());
    }

    const board = node('div', 'g-board');
    board.setAttribute('role', 'list');
    if (data.phoneStart) board.dataset.phoneStart = String(data.phoneStart);

    for (const column of Array.isArray(data.columns) ? data.columns : []) {
      const key = column?.key === undefined || column?.key === null ? '' : String(column.key);
      const col = node('div', 'g-col');
      col.dataset.key = key;
      col.setAttribute('role', 'listitem');
      if (column?.accent) col.dataset.accent = String(column.accent);
      if (data.phoneStart && key === String(data.phoneStart)) col.dataset.phoneStart = 'true';

      const head = node('div', 'g-col-h');
      const dot = node('i', 'g-col-dot');
      dot.setAttribute('aria-hidden', 'true');
      head.append(dot, node('span', 'g-col-label', column?.label), node('span', 'g-col-n num', (column?.cards || []).length));
      col.append(head);

      const cards = node('div', 'g-cards');
      for (const card of Array.isArray(column?.cards) ? column.cards : []) {
        const lane = document.createElement('g-lane-card');
        lane.data = card;
        cards.append(lane);
      }
      if (!cards.childNodes.length) cards.append(node('div', 'g-empty', column?.empty ?? 'Nothing here now'));
      col.append(cards);

      if (Number(column?.more) > 0) {
        const more = node('button', 'g-more', `+ ${column.more} more`);
        more.type = 'button';
        more.dataset.more = key;
        col.append(more);
      }

      board.append(col);
    }

    this.replaceChildren(board);

    for (const card of this.querySelectorAll('.g-card')) {
      const rect = before.get(card.dataset.id);
      if (rect) flip(card, rect);
    }
  }
}

define('g-board', GBoard);
export { GBoard };
