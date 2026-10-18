// Where blocks and their ports sit on the diagram, and how wires route between them.

import type { BlockType, PortSpec } from "../engine/block.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export interface PortPlace extends Point {
  readonly side: Side;
}

export interface BlockLayout {
  readonly width: number;
  readonly height: number;
  /** Port positions relative to the block's top-left corner. */
  readonly inputs: readonly PortPlace[];
  readonly outputs: readonly PortPlace[];
}

/** Blocks snap to this grid. */
export const GRID = 8;
/** Spacing between ports along a side. */
const PITCH = 24;
/** How far a wire runs straight out of a port before it turns. */
const STUB = 16;

export const snap = (value: number): number => Math.round(value / GRID) * GRID;

/** Positions for `count` ports spread around `middle`. */
const spread = (count: number, middle: number): number[] =>
  Array.from({ length: count }, (_, i) => middle + (i - (count - 1) / 2) * PITCH);

export function layoutBlock(type: BlockType): BlockLayout {
  const shape = type.shape?.kind ?? "box";
  const sideOf = (port: PortSpec) => port.side ?? "left";
  const left = type.inputs.filter((port) => sideOf(port) === "left");

  let width: number;
  let height: number;
  if (shape === "circle") [width, height] = [48, 48];
  else if (shape === "triangle") [width, height] = [64, 56];
  else {
    width = 144;
    height = Math.max(56, Math.max(left.length, type.outputs.length) * PITCH + 16);
  }

  const leftY = spread(left.length, height / 2);
  const topX = spread(type.inputs.filter((port) => sideOf(port) === "top").length, width / 2);
  const bottomX = spread(type.inputs.filter((port) => sideOf(port) === "bottom").length, width / 2);
  const inputs = type.inputs.map((port): PortPlace => {
    switch (sideOf(port)) {
      case "top":
        return { x: topX.shift()!, y: 0, side: "top" };
      case "bottom":
        return { x: bottomX.shift()!, y: height, side: "bottom" };
      default:
        return { x: 0, y: leftY.shift()!, side: "left" };
    }
  });
  const outputs = spread(type.outputs.length, height / 2).map((y): PortPlace => ({ x: width, y, side: "right" }));
  return { width, height, inputs, outputs };
}

/** Corner points for a wire from an output (always facing right) to an input on any side. */
export function route(from: Point, to: PortPlace): Point[] {
  const exit = { x: from.x + STUB, y: from.y };
  if (to.side === "left") {
    const entry = { x: to.x - STUB, y: to.y };
    if (entry.x >= exit.x) {
      const middle = snap((from.x + to.x) / 2);
      return [from, { x: middle, y: from.y }, { x: middle, y: to.y }, to];
    }
    // Backwards: cross over in the gap just above or below the target's row, or go under both.
    const y = to.y - from.y > 100 ? to.y - 48 : from.y - to.y > 100 ? to.y + 48 : Math.max(from.y, to.y) + 48;
    return [from, exit, { x: exit.x, y }, { x: entry.x, y }, entry, to];
  }
  const below = to.side === "bottom";
  const entry = { x: to.x, y: to.y + (below ? STUB : -STUB) };
  if (to.x >= exit.x && (below ? from.y >= entry.y : from.y <= entry.y)) return [from, { x: to.x, y: from.y }, to];
  return [from, exit, { x: exit.x, y: entry.y }, entry, to];
}

/** SVG path through the points with rounded corners. */
export function roundedPath(points: readonly Point[], radius = 6): string {
  const p = points.filter((point, i) => i === 0 || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
  if (p.length < 2) return "";
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const toward = (q: Point, length: number) => {
      const distance = Math.hypot(q.x - b.x, q.y - b.y) || 1;
      return { x: b.x + ((q.x - b.x) / distance) * length, y: b.y + ((q.y - b.y) / distance) * length };
    };
    const start = toward(a, r);
    const end = toward(c, r);
    d += ` L${start.x},${start.y} Q${b.x},${b.y} ${end.x},${end.y}`;
  }
  const last = p[p.length - 1];
  return `${d} L${last.x},${last.y}`;
}
