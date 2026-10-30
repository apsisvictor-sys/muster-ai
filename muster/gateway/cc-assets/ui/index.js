// graphite-ui — one import registers every element.
//
//   import 'graphite-ui/index.js';
//   import 'graphite-ui/tokens.css';
//   import 'graphite-ui/components.css';
//
// The import is safe in Node with no DOM: the element definitions are guarded, so a
// Next.js client component or a static page can import the same modules.
import './elements/g-nav.js';
import './elements/g-island.js';
import './elements/g-toast.js';
import './elements/g-kpi.js';
import './elements/g-ring.js';
import './elements/g-hourbars.js';
import './elements/g-mix.js';
import './elements/g-goal-card.js';
import './elements/g-board.js';
import './elements/g-lane-card.js';
import './elements/g-sheet.js';
import './elements/g-chips.js';
import './elements/g-line-chart.js';
import './elements/g-donut.js';
import './elements/g-hbars.js';
import './elements/g-feed.js';

export { GraphiteElement, HAS_DOM, define, emit, icon, tintSwatch, tintText } from './elements/base.js';
export {
  countUp,
  flip,
  formatNumber,
  growBars,
  maskIn,
  pageChange,
  reducedMotion,
  sweepRing,
  themeReveal,
  tween,
} from './motion.js';
