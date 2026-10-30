// g-feed — a lane's live session text, one paragraph per line.
// data: { lines: string[], current }
import { GraphiteElement, define, node } from './base.js';

class GFeed extends GraphiteElement {
  paint(data) {
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const root = node('div', 'g-feed');
    root.setAttribute('role', 'log');
    root.setAttribute('aria-label', 'Live session');

    lines.forEach((line, index) => {
      const paragraph = node('p', '', line);
      if (data.current && index === lines.length - 1) {
        const cursor = node('span', 'g-cur');
        cursor.setAttribute('aria-hidden', 'true');
        paragraph.append(cursor);
      }
      root.append(paragraph);
    });

    this.replaceChildren(root);
  }
}

define('g-feed', GFeed);
export { GFeed };
