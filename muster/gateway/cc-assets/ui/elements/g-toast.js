// g-toast — a short confirmation, announced as a status region.
// data: { title, sub, tone, undo }   settings: timeout
// out: g-undo
import { GraphiteElement, define, emit, icon, node } from './base.js';

class GToast extends GraphiteElement {
  static settings = ['timeout'];

  connectedCallback() {
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
    this.setAttribute('aria-atomic', 'true');
    super.connectedCallback();
    this.addEventListener('click', this._onClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick);
    clearTimeout(this._timer);
  }

  _onClick = (event) => {
    const undo = event.target.closest?.('.g-undo');
    if (!undo || !this.contains(undo)) return;
    emit(this, 'g-undo', {});
    this.hide();
  };

  /** Show one message, and hide it again after the timeout attribute's milliseconds. */
  show(detail) {
    this.data = detail || {};
    this.setAttribute('open', '');
    const timeout = Number(this.getAttribute('timeout') || 0);
    clearTimeout(this._timer);
    if (timeout > 0) this._timer = setTimeout(() => this.hide(), timeout);
  }

  /** Hide the toast without losing its last message. */
  hide() {
    clearTimeout(this._timer);
    this.removeAttribute('open');
    const root = this.querySelector('.g-toast');
    if (root) root.classList.remove('g-toast--show');
  }

  paint(data) {
    const root = node('div', 'g-toast');
    if (this.hasAttribute('open')) root.classList.add('g-toast--show');
    if (data.tone) root.classList.add(`g-tone-${data.tone}`);

    const dot = node('span', 'g-toast-dot');
    dot.append(icon('check'));
    const body = node('div', 'g-toast-body');
    body.append(node('b', '', data.title));
    if (data.sub) body.append(node('span', '', data.sub));
    root.append(dot, body);

    if (data.undo) {
      const undo = node('button', 'g-undo');
      undo.type = 'button';
      undo.append(node('span', '', typeof data.undo === 'string' ? data.undo : data.undo.label || 'Undo'));
      root.append(undo);
    }

    this.replaceChildren(root);
  }

  changed() {
    const root = this.querySelector('.g-toast');
    if (root && this.hasAttribute('open')) root.classList.add('g-toast--show');
  }
}

define('g-toast', GToast);
export { GToast };
