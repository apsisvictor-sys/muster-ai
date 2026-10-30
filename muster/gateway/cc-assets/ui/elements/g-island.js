// g-island — the live island: a change line, the team and the PC state behind a pill.
// data: { idle, last, line, recent[], team[], pc }   settings: offline, open
// out: g-tap { action, id }
import { GraphiteElement, define, emit, icon, node, setText } from './base.js';

let nextId = 0;

class GIsland extends GraphiteElement {
  static settings = ['offline'];

  constructor() {
    super();
    this._panelId = `g-island-pop-${(nextId += 1)}`;
  }

  connectedCallback() {
    // The live region is created once and never rebuilt: a fresh node each render would
    // drop the announcement a screen reader is still reading.
    if (!this.querySelector('.g-sr')) {
      const announce = node('p', 'g-sr');
      announce.setAttribute('aria-live', 'polite');
      announce.setAttribute('aria-atomic', 'true');
      this.append(announce);
    }
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
    this.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('keydown', this._onKey);
  }

  get isOpen() {
    return this.hasAttribute('open');
  }

  _onClick = (event) => {
    const target = event.target;
    if (target.closest?.('.g-island-pc')) {
      emit(this, 'g-tap', { action: 'pc', id: null });
      return;
    }
    if (target.closest?.('.g-island-b')) this.toggle(!this.isOpen);
  };

  _onKey = (event) => {
    if (event.key === 'Escape' && this.isOpen) {
      this.toggle(false);
      this.querySelector('.g-island-b')?.focus();
    }
  };

  /** Open or close the popup in place, so focus and aria state survive. */
  toggle(open) {
    const button = this.querySelector('.g-island-b');
    const pop = this.querySelector('.g-island-pop');
    if (!button || !pop) return;
    const next = open === undefined ? !this.isOpen : Boolean(open);
    if (next) this.setAttribute('open', '');
    else this.removeAttribute('open');
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    pop.hidden = !next;
    pop.classList.toggle('open', next);
    if (next) emit(this, 'g-tap', { action: 'toggle', id: null });
  }

  paint(data) {
    const offline = this.hasAttribute('offline');
    const root = node('div', 'g-island');
    if (offline) root.classList.add('g-island--offline');

    const button = node('button', 'g-island-b');
    button.type = 'button';
    button.setAttribute('aria-expanded', this.isOpen ? 'true' : 'false');
    button.setAttribute('aria-controls', this._panelId);

    const live = node('span', 'g-live');
    live.setAttribute('aria-hidden', 'true');
    button.append(live);
    button.append(node('span', 'g-island-line', data.line ?? data.idle ?? ''));
    if (data.last) {
      const separator = node('span', 'g-island-sep');
      separator.setAttribute('aria-hidden', 'true');
      button.append(separator, node('span', 'g-island-last num', data.last));
    }

    const pop = node('div', 'g-island-pop');
    pop.id = this._panelId;
    pop.hidden = !this.isOpen;
    if (this.isOpen) pop.classList.add('open');

    const recent = Array.isArray(data.recent) ? data.recent : [];
    if (recent.length) {
      const list = node('ul', 'g-tl');
      list.setAttribute('aria-label', 'Latest events');
      for (const line of recent) {
        const item = node('li', 'g-tl-on');
        item.append(node('span', 'g-tl-s', line));
        list.append(item);
      }
      pop.append(list);
    }

    const team = Array.isArray(data.team) ? data.team : [];
    if (team.length) {
      const list = node('ul', 'g-team');
      for (const member of team) {
        const item = node('li', 'g-team-row');
        const head = node('div', 'g-team-head');
        head.append(node('b', '', member?.name), node('span', 'g-team-state', member?.state));
        item.append(head);
        if (member?.model) item.append(node('span', 'g-model', member.model));
        if (member?.line) item.append(node('p', 'g-team-line', member.line));
        list.append(item);
      }
      pop.append(list);
    }

    if (data.pc) {
      const pc = node('button', `g-island-pc g-tone-${data.pc.tone || 'ok'}`);
      pc.type = 'button';
      pc.append(icon('bolt'));
      pc.append(node('span', '', data.pc.text));
      pop.append(pc);
    }

    root.append(button, pop);

    const announce = this.querySelector('.g-sr');
    for (const child of [...this.children]) {
      if (child !== announce) child.remove();
    }
    this.prepend(root);
    if (announce) this.append(announce);
  }

  changed(previous, next) {
    const announce = this.querySelector('[aria-live]');
    const line = next.line ?? '';
    const before = previous?.line ?? '';
    if (announce && line && line !== before) setText(announce, line);
  }
}

define('g-island', GIsland);
export { GIsland };
