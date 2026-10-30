// motion.js — the library's motion primitives.
//
// Two rules hold for every function here: motion runs only when data changes (the
// elements call these from their own change handler, never from a timer), and each
// one is a no-op under prefers-reduced-motion. Under reduced motion the final value
// still lands, so nothing depends on an animation to become correct.

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the reader asked for reduced motion. */
export function reducedMotion() {
  const query = globalThis.matchMedia;
  if (typeof query !== 'function') return false;
  try {
    return Boolean(query(REDUCED_QUERY).matches);
  } catch {
    return false;
  }
}

const clock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

const frame = (callback) => {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === 'function') raf(callback);
  else callback(clock());
};

/** Format a number the way every counter in the library shows it. */
export function formatNumber(value, decimals = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return decimals > 0 ? number.toFixed(decimals) : Math.round(number).toLocaleString('en-US');
}

/** Count a node's text from its current value to `to`. */
export function countUp(node, to, options = {}) {
  if (!node) return;
  const decimals = Number(options.decimals ?? node.dataset?.dec ?? 0) || 0;
  const target = Number(to);
  if (!Number.isFinite(target)) return;
  if (reducedMotion()) {
    node.textContent = formatNumber(target, decimals);
    return;
  }
  const from = Number.isFinite(Number(options.from))
    ? Number(options.from)
    : target > 40
      ? Math.round(target * 0.62)
      : 0;
  const duration = Number(options.duration ?? 850);
  const started = clock();
  const step = (time) => {
    const progress = Math.min(1, (time - started) / Math.max(1, duration));
    const eased = 1 - 2 ** (-10 * progress);
    node.textContent = formatNumber(from + (target - from) * (progress === 1 ? 1 : eased), decimals);
    if (progress < 1) frame(step);
  };
  frame(step);
}

/** Count a node from the value it already shows to `to`. */
export function tween(node, to, options = {}) {
  if (!node) return;
  const from = Number.parseFloat(String(node.textContent ?? '').replace(/,/g, '')) || 0;
  const target = Number(to);
  if (!Number.isFinite(target)) return;
  if (from === target) {
    node.textContent = formatNumber(target, Number(options.decimals ?? node.dataset?.dec ?? 0) || 0);
    return;
  }
  countUp(node, target, { ...options, from, duration: options.duration ?? 420 });
}

/** Sweep an SVG circle from its current offset to `value` (0 to 1). */
export function sweepRing(circle, value, options = {}) {
  if (!circle) return;
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const radius = Number(options.radius ?? circle.getAttribute?.('r') ?? 33);
  const length = 2 * Math.PI * radius;
  const offset = length * (1 - ratio);
  const apply = () => {
    circle.setAttribute?.('stroke-dasharray', String(length));
    circle.setAttribute?.('stroke-dashoffset', String(offset));
    if (circle.style) circle.style.strokeDashoffset = String(offset);
  };
  if (reducedMotion()) {
    apply();
    return;
  }
  apply();
  if (typeof circle.animate !== 'function') return;
  circle.animate([{ strokeDashoffset: String(length) }, { strokeDashoffset: String(offset) }], {
    duration: Number(options.duration ?? 1150),
    easing: options.easing ?? 'cubic-bezier(0.65, 0, 0.35, 1)',
    fill: 'none',
  });
}

/** Grow every `[data-grow]` bar under `root` from zero. */
export function growBars(root, options = {}) {
  if (!root || reducedMotion()) return;
  const bars = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll('[data-grow]')] : [];
  bars.forEach((bar, index) => {
    if (typeof bar.animate !== 'function') return;
    const axis = bar.dataset?.grow === 'x' ? 'scaleX(0)' : 'scaleY(0)';
    bar.animate([{ transform: axis }, { transform: 'none' }], {
      duration: Number(options.duration ?? 520),
      delay: index * Number(options.stagger ?? 28),
      easing: options.easing ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'backwards',
    });
  });
}

/** Animate `element` from a rectangle it held before a re-render. */
export function flip(element, fromRect, options = {}) {
  if (!element || !fromRect || reducedMotion()) return;
  if (typeof element.getBoundingClientRect !== 'function' || typeof element.animate !== 'function') return;
  const to = element.getBoundingClientRect();
  const dx = (fromRect.left ?? 0) - (to.left ?? 0);
  const dy = (fromRect.top ?? 0) - (to.top ?? 0);
  if (!dx && !dy) return;
  element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
    duration: Number(options.duration ?? 460),
    easing: options.easing ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
  });
}

/** Raise a heading out of its own mask. */
export function maskIn(element, options = {}) {
  if (!element || reducedMotion() || typeof element.animate !== 'function') return;
  const parts = typeof element.querySelectorAll === 'function' ? [...element.querySelectorAll('span')] : [];
  const targets = parts.length ? parts : [element];
  for (const part of targets) {
    if (typeof part.animate !== 'function') continue;
    part.animate([{ transform: 'translateY(105%)' }, { transform: 'none' }], {
      duration: Number(options.duration ?? 500),
      easing: options.easing ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'both',
    });
  }
}

/** Reveal a theme change from the point that was tapped. */
export function themeReveal(target, origin, apply) {
  const run = typeof apply === 'function' ? apply : () => {};
  if (typeof document === 'undefined' || reducedMotion()) {
    run();
    return;
  }
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(run);
    return;
  }
  run();
  const root = document.documentElement;
  if (!root || typeof root.animate !== 'function') return;
  const x = Number(origin?.x ?? 0);
  const y = Number(origin?.y ?? 0);
  const width = globalThis.innerWidth ?? 0;
  const height = globalThis.innerHeight ?? 0;
  const reach = Math.hypot(Math.max(x, width - x) || 1, Math.max(y, height - y) || 1);
  root.animate(
    [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${reach}px at ${x}px ${y}px)` }],
    { duration: 460, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

/** Run a view change, through the browser's view transition when it has one. */
export function pageChange(target, render) {
  const run = typeof render === 'function' ? render : () => {};
  if (reducedMotion() || typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    run();
    return;
  }
  document.startViewTransition(run);
}
