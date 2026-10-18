// Where blocks and their ports sit on the diagram, and how wires route between them.

import type { BlockType, PortSpec } from '../engine/block.ts';

export type Point = {
  readonly x: number;
  readonly y: number;
};

type Side = 'left' | 'right' | 'top' | 'bottom';

export type PortPlace = Point & {
  readonly side: Side;
};

export type BlockLayout = {
  readonly width: number;
  readonly height: number;
  /**
   * Port positions relative to the block's top-left corner, by port index.
   * Hidden ports, which the app wires itself, have no position.
   */
  readonly inputs: readonly (PortPlace | undefined)[];
  readonly outputs: readonly (PortPlace | undefined)[];
};

/** Blocks snap to this grid. */
const GRID = 8;
/** Spacing between ports along a side. */
const PITCH = 24;
/** How far a wire runs straight out of a port before it turns. */
const STUB = 16;

export const snap = (value: number): number => Math.round(value / GRID) * GRID;

/** Positions for `count` ports spread around `middle`. */
const spread = (count: number, middle: number): number[] =>
  Array.from(
    { length: count },
    (_, i) => middle + (i - (count - 1) / 2) * PITCH,
  );

const layouts = new WeakMap<BlockType, BlockLayout>();

export function layoutOf(type: BlockType): BlockLayout {
  let layout = layouts.get(type);
  if (!layout) {
    layouts.set(type, (layout = layoutBlock(type)));
  }

  return layout;
}

function layoutBlock(type: BlockType): BlockLayout {
  const shape = type.shape ?? { kind: 'box' };
  const sideOf = (port: PortSpec) => port.side ?? 'left';
  const visibleInputs = type.inputs.filter((port) => !port.hidden);
  const visibleOutputs = type.outputs.filter((port) => !port.hidden);
  const left = visibleInputs.filter((port) => sideOf(port) === 'left');

  let width: number;
  let height: number;
  let portY: number | undefined;
  switch (shape.kind) {
    case 'circle':
      [width, height] = [48, 48];
      break;
    case 'triangle':
      [width, height] = [64, 56];
      break;
    case 'antenna':
      // The mast's foot, where the wire meets it, is near the bottom.
      [width, height, portY] = [48, 64, 56];
      break;
    case 'terminal':
      [width, height] = [80, 32];
      break;
    case 'instrument':
      [width, height] = [shape.width, shape.height];
      break;
    default:
      width = 144;
      height = Math.max(
        56,
        Math.max(left.length, visibleOutputs.length) * PITCH + 16,
      );
  }

  const middle = portY ?? height / 2;
  const leftY = spread(left.length, middle);
  const topX = spread(
    visibleInputs.filter((port) => sideOf(port) === 'top').length,
    width / 2,
  );
  const bottomX = spread(
    visibleInputs.filter((port) => sideOf(port) === 'bottom').length,
    width / 2,
  );
  const inputs = type.inputs.map((port): PortPlace | undefined => {
    if (port.hidden) {
      return undefined;
    }

    switch (sideOf(port)) {
      case 'top':
        return { x: topX.shift()!, y: 0, side: 'top' };
      case 'bottom':
        return { x: bottomX.shift()!, y: height, side: 'bottom' };
      default:
        return { x: 0, y: leftY.shift()!, side: 'left' };
    }
  });
  const rightY = spread(visibleOutputs.length, middle);
  const outputs = type.outputs.map((port): PortPlace | undefined =>
    port.hidden ? undefined : { x: width, y: rightY.shift()!, side: 'right' },
  );
  return { width, height, inputs, outputs };
}

/**
 * Corner points for a wire from an output (always facing right) to an input on
 * any side.
 */
export function route(from: Point, to: PortPlace): Point[] {
  const exit = { x: from.x + STUB, y: from.y };
  if (to.side === 'left') {
    const entry = { x: to.x - STUB, y: to.y };
    if (entry.x >= exit.x) {
      const middle = snap((from.x + to.x) / 2);
      return [from, { x: middle, y: from.y }, { x: middle, y: to.y }, to];
    }

    // Backwards: cross over in the gap just above or below the target's row, or go under both.
    const y =
      to.y - from.y > 100
        ? to.y - 48
        : from.y - to.y > 100
          ? to.y + 48
          : Math.max(from.y, to.y) + 48;
    return [from, exit, { x: exit.x, y }, { x: entry.x, y }, entry, to];
  }

  const below = to.side === 'bottom';
  const entry = { x: to.x, y: to.y + (below ? STUB : -STUB) };
  if (to.x >= exit.x && (below ? from.y >= entry.y : from.y <= entry.y)) {
    return [from, { x: to.x, y: from.y }, to];
  }

  return [from, exit, { x: exit.x, y: entry.y }, entry, to];
}

/** SVG path through the points with rounded corners. */
export function roundedPath(points: readonly Point[], radius = 6): string {
  const p = points.filter(
    (point, i) =>
      i === 0 || point.x !== points[i - 1].x || point.y !== points[i - 1].y,
  );
  if (p.length < 2) {
    return '';
  }

  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const r = Math.min(
      radius,
      Math.hypot(b.x - a.x, b.y - a.y) / 2,
      Math.hypot(c.x - b.x, c.y - b.y) / 2,
    );
    const toward = (q: Point, length: number) => {
      const distance = Math.hypot(q.x - b.x, q.y - b.y) || 1;
      return {
        x: b.x + ((q.x - b.x) / distance) * length,
        y: b.y + ((q.y - b.y) / distance) * length,
      };
    };

    const start = toward(a, r);
    const end = toward(c, r);
    d += ` L${start.x},${start.y} Q${b.x},${b.y} ${end.x},${end.y}`;
  }

  const last = p[p.length - 1];
  return `${d} L${last.x},${last.y}`;
}
