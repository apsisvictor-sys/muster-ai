// g-nav — the pill of view tabs with a sliding indicator.
// data: { items: [{ id, label, count? }] }   settings: value, label
// out: g-select { id }
import { GraphiteElement, HAS_DOM, define, emit, node } from './base.js';

class GNav extends GraphiteElement {
  static settings = ['value', 'label'];

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
    this.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    this.removeEventListener('keydown', this._onKey);
  }

  get value() {
    return this.getAttribute('value');
  }

  set value(id) {
    this.choose(id);
  }

  get items() {
    return [...this.querySelectorAll('[role="tab"]')];
  }

  _onClick = (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !this.contains(tab)) return;
    this.choose(tab.dataset.id, { focus: true });
  };

  _onKey = (event) => {
    const ids = this.items.map((tab) => tab.dataset.id);
    if (!ids.length) return;
    const current = Math.max(0, ids.indexOf(this.getAttribute('value')));
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % ids.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + ids.length) % ids.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = ids.length - 1;
    if (next === null) return;
    event.preventDefault();
    this.choose(ids[next], { focus: true });
  };

  /** Select a view. Emits g-select once, keeps one tab stop and repaints at once. */
  choose(id, options = {}) {
    if (id === undefined || id === null) return;
    if (this.getAttribute('value') !== id) {
      this._mirror = true;
      this.setAttribute('value', id);
      this._mirror = false;
      if (HAS_DOM && this.isConnected) this.render(this._data);
    }
    const tab = this.items.find((item) => item.dataset.id === id);
    if (options.focus && tab) tab.focus();
    emit(this, 'g-select', { id: String(id) });
  }

  paint(data) {
    const value = this.getAttribute('value');
    const nav = node('div', 'g-nav');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', this.getAttribute('label') || 'Views');

    for (const item of Array.isArray(data.items) ? data.items : []) {
      const id = String(item?.id ?? '');
      const selected = value !== null && id === value;
      const tab = node('button', 'g-nav-tab');
      tab.type = 'button';
      tab.dataset.id = id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) tab.setAttribute('aria-current', 'page');
      tab.append(node('span', 'g-nav-label', item?.label));
      if (item?.count !== undefined && item?.count !== null) {
        tab.append(node('span', 'g-nav-n num', item.count));
      }
      nav.append(tab);
    }

    const indicator = node('i', 'g-nav-ind');
    indicator.setAttribute('aria-hidden', 'true');
    nav.append(indicator);
    this.replaceChildren(nav);
  }

  changed(previous, next, hadFocus) {
    const indicator = this.querySelector('.g-nav-ind');
    const active = this.items.find((tab) => tab.getAttribute('aria-selected') === 'true');
    if (indicator && active && active.offsetWidth) {
      indicator.style.left = `${active.offsetLeft}px`;
      indicator.style.width = `${active.offsetWidth}px`;
    }
    if (hadFocus && active) active.focus();
  }
}

define('g-nav', GNav);
export { GNav };
