// elements/base.js — the shared shape every graphite-ui element is built on.
//
// Light DOM, no shadow root, no template strings with data in them: every text from
// data goes through textContent. Importing this module in Node without a DOM must not
// throw, so the base class is a plain class there and customElements is guarded.

export const HAS_DOM = typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined';

const Root = HAS_DOM ? HTMLElement : class {};

/** Register a custom element once, and never when there is no DOM. */
export function define(name, ctor) {
  if (!HAS_DOM) return;
  if (customElements.get(name)) return;
  customElements.define(name, ctor);
}

/** Create an element with a class and optional text. */
export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

/** Replace an element's text, never its markup. */
export function setText(element, value) {
  if (!element) return;
  element.textContent = value === undefined || value === null ? '' : String(value);
}

/** Dispatch one of the library's CustomEvents. */
export function emit(host, type, detail = {}) {
  if (typeof CustomEvent !== 'function') return;
  host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** An SVG node in the SVG namespace. */
export function svg(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

const ICONS = {
  bolt: 'M11 2 5 12h5l-1 8 7-11h-5z',
  eye: 'M2 11s3.6-5 9-5 9 5 9 5-3.6 5-9 5-9-5-9-5z',
  merge: 'M6 3v6a4 4 0 0 0 4 4h8M14 9l4 4-4 4',
  check: 'M4 11l5 5 10-11',
  arrow: 'M4 11h14M12 5l6 6-6 6',
  back: 'M18 11H5M11 5l-6 6 6 6',
  close: 'M6 6l12 12M18 6 6 18',
  play: 'M7 4l11 7-11 7z',
};

/** A stroked icon. The name is a library constant, never data. */
export function icon(name, className = 'g-i') {
  const shape = svg('svg', {
    class: className,
    viewBox: '0 0 22 22',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  shape.append(svg('path', { d: ICONS[name] ?? ICONS.check }));
  if (name === 'eye') shape.append(svg('circle', { cx: 11, cy: 11, r: 2.6 }));
  return shape;
}

/** The swatch colour for a tint key, and the readable text variant of it. */
export const tintSwatch = (tint) => (tint ? `var(--tint-${tint})` : 'var(--ink-4)');
export const tintText = (tint) => (tint ? `var(--tint-${tint}-text)` : 'var(--ink)');

/** A ring's dash geometry for a circle of this radius. */
export const ringLength = (radius) => 2 * Math.PI * radius;

const same = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * The element contract: data in through `data`, simple settings through attributes,
 * CustomEvents out. `paint(data, previous)` builds the light DOM; `changed(previous, next, hadFocus)`
 * runs after it and is where an element animates.
 */
export class GraphiteElement extends Root {
  constructor() {
    super();
    this._data = null;
  }

  static get observedAttributes() {
    return Array.isArray(this.settings) ? this.settings.slice() : [];
  }

  get data() {
    return this._data;
  }

  set data(value) {
    const next = value === undefined ? null : value;
    if (same(this._data, next)) return;
    const previous = this._data;
    this._data = next;
    if (HAS_DOM && this.isConnected) this.render(previous);
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (this._mirror) return;
    if (!HAS_DOM || !this.isConnected) return;
    this.render(this._data);
    if (typeof this.settingChanged === 'function') this.settingChanged(name, newValue);
  }

  connectedCallback() {
    this.render(null);
  }

  render(previous) {
    const focusWasInside =
      typeof document !== 'undefined' && document.activeElement && this.contains(document.activeElement);
    this.paint(this._data || {}, previous === undefined ? null : previous);
    if (typeof this.changed === 'function') this.changed(previous || null, this._data || {}, focusWasInside);
  }

  /** Subclasses build their light DOM here. */
  paint() {}
}
