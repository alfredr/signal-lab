// A compact way to write diagrams in code, for the library and the examples. Layouts are by
// hand on the 8-unit grid: boxes are 144 x 56, circles 48 x 48, triangles 64 x 56, antennas
// 48 x 64 (port 56 down) and terminals 80 x 32 (port 16 down).

import type { PortRef } from '../engine/circuit.ts';
import type { StoredParams } from '../engine/params.ts';
import { SUBSYSTEM, type Diagram, type LabBlock } from './document.ts';

export type Part = {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly name?: string;
  readonly params?: StoredParams;
  /** For a subsystem: what is inside. Implies kind "subsystem". */
  readonly inner?: Diagram;
};

/** A wire as ["block:port", "block:port"]; the port defaults to 0. */
export type Link = readonly [from: string, to: string];

export function ref(text: string): PortRef {
  const [block, port] = text.split(':');
  return { block: block!, port: Number(port ?? 0) };
}

export function diagram(
  parts: Readonly<Record<string, Part>>,
  links: readonly Link[],
): Diagram {
  const blocks = Object.entries(parts).map(
    ([id, { name, params = {}, inner, ...part }]): LabBlock => ({
      id,
      ...part,
      ...(inner ? { kind: SUBSYSTEM, inner } : {}),
      params,
      ...(name ? { name } : {}),
    }),
  );
  return {
    blocks,
    wires: links.map(([from, to], i) => ({
      id: `w${i + 1}`,
      from: ref(from),
      to: ref(to),
    })),
  };
}
