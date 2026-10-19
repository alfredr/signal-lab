// Draws the palette's and the diagram's pictures of blocks, from drawings.ts,
// in the text color.

import { svg } from './dom.ts';
import { DRAWINGS } from './drawings.ts';

/** The drawing for a palette entry, or a plain block for one without. */
export function blockIcon(key: string): SVGSVGElement {
  const parts = DRAWINGS[key] ?? [{ box: [4, 6, 16, 12] }];
  return svg(
    'svg',
    { class: 'block-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    ...parts.map((part) =>
      typeof part === 'string'
        ? svg('path', { d: part })
        : 'circle' in part
          ? svg('circle', {
              cx: part.circle[0],
              cy: part.circle[1],
              r: part.circle[2],
            })
          : svg('rect', {
              x: part.box[0],
              y: part.box[1],
              width: part.box[2],
              height: part.box[3],
              rx: 1.5,
              ...(part.dashed ? { class: 'dashed' } : {}),
            }),
    ),
  );
}
