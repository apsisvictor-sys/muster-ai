// g-sheet — the side sheet: facts, timeline, feed. Focus is trapped while it is open.
// data: { title, sub, tags[], facts[], timeline[], feed[], note, actions[] }
// methods: open(), close()   out: g-tap { action, id }
import { GraphiteElement, define, emit, icon, node } from './base.js';

let nextId = 0;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

class GSheet extends GraphiteElement {
  static settings = [];

  constructor() {
    super();
    this._titleId = `g-sheet-title-${(nextId += 1)}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this._release();
  }

  get isOpen() {
    return this.hasAttribute('open');
  }

  _focusables() {
    return [...this.querySelectorAll(FOCUSABLE)].filter((item) => !item.hasAttribute('disabled'));
  }

  _onClick = (event) => {
    const close = event.target.closest?.('.g-sheet-close');
    if (close && this.contains(close)) {
      this.close();
      return;
    }
    const action = event.target.closest?.('[data-action]');
    if (action && this.contains(action)) {
      const name = action.dataset.action;
      emit(this, 'g-tap', { action: name, id: action.dataset.id ?? null });
      if (name !== 'close') this.close({ silent: true });
    }
  };

  _onKey = (event) => {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this._focusables();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const last = items.length - 1;
    let next;
    if (event.shiftKey) next = index <= 0 ? last : index - 1;
    else next = index === last || index < 0 ? 0 : index + 1;
    event.preventDefault();
    items[next].focus();
  };

  /** Show the sheet, trap focus inside it and remember where focus came from. */
  open() {
    if (this.isOpen) return;
    this._returnTo = document.activeElement;
    this.setAttribute('open', '');
    const backdrop = this.querySelector('.g-sheet-backdrop');
    if (backdrop) backdrop.hidden = false;
    document.addEventListener('keydown', this._onKey, true);
    const first = this.querySelector('.g-sheet-close') || this._focusables()[0];
    first?.focus();
  }

  /** Hide the sheet, restore focus and, unless silent, report the close. */
  close(options = {}) {
    if (!this.isOpen) return;
    this.removeAttribute('open');
    this._release();
    const backdrop = this.querySelector('.g-sheet-backdrop');
    if (backdrop) backdrop.hidden = true;
    if (!options.silent) emit(this, 'g-tap', { action: 'close', id: null });
    const back = this._returnTo;
    this._returnTo = null;
    if (back && typeof back.focus === 'function' && back.isConnected !== false) back.focus();
  }

  _release() {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this._onKey, true);
  }

  paint(data) {
    const backdrop = node('div', 'g-sheet-backdrop');
    backdrop.hidden = !this.isOpen;

    const panel = node('div', 'g-sheet-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', this._titleId);

    const head = node('div', 'g-sheet-h');
    const identity = node('div', 'g-sheet-id');
    const title = node('h2', 'g-sheet-title', data.title);
    title.id = this._titleId;
    identity.append(title);
    if (data.sub) identity.append(node('p', 'g-note', data.sub));

    const tags = node('div', 'g-tags');
    for (const tag of Array.isArray(data.tags) ? data.tags : []) {
      tags.append(node('span', `g-tag${tag?.tone ? ` g-${tag.tone}` : ''}`, tag?.text));
    }
    if (tags.childNodes.length) identity.append(tags);

    const close = node('button', 'g-sheet-close');
    close.type = 'button';
    close.append(icon('close'));
    const closeLabel = node('span', 'g-sr', 'Close');
    close.append(closeLabel);
    head.append(identity, close);
    panel.append(head);

    const facts = Array.isArray(data.facts) ? data.facts : [];
    if (facts.length) {
      const grid = node('div', 'g-facts');
      for (const fact of facts) {
        const cell = node('div', 'g-fact');
        cell.append(node('small', '', fact?.label), node('b', '', fact?.value ?? '–'));
        grid.append(cell);
      }
      panel.append(grid);
    }

    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    if (timeline.length) {
      panel.append(node('h3', 'g-sheet-h3', 'Timeline'));
      const list = node('ul', 'g-tl');
      for (const step of timeline) {
        const item = node('li', step?.tone === 'warn' ? 'g-tl-warn' : 'g-tl-on');
        item.append(node('time', 'g-tl-t num', step?.at));
        item.append(node('span', 'g-tl-s', step?.text));
        list.append(item);
      }
      panel.append(list);
    }

    const feed = Array.isArray(data.feed) ? data.feed : [];
    if (feed.length) {
      panel.append(node('h3', 'g-sheet-h3', 'Live session'));
      const lines = node('div', 'g-feed');
      feed.forEach((line, index) => {
        const paragraph = node('p', '', line);
        if (index === feed.length - 1) {
          const cursor = node('span', 'g-cur');
          cursor.setAttribute('aria-hidden', 'true');
          paragraph.append(cursor);
        }
        lines.append(paragraph);
      });
      panel.append(lines);
    }

    if (data.note) panel.append(node('p', 'g-note', data.note));

    const actions = Array.isArray(data.actions) ? data.actions : [];
    if (actions.length) {
      const row = node('div', 'g-sheet-actions');
      for (const action of actions) {
        const button = node('button', 'g-pillbtn', action?.label);
        button.type = 'button';
        button.dataset.action = String(action?.action ?? '');
        row.append(button);
      }
      panel.append(row);
    }

    backdrop.append(panel);
    this.replaceChildren(backdrop);
  }
}

define('g-sheet', GSheet);
export { GSheet };
