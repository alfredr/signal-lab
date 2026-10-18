// A compact way to write diagrams in code, for the library and the examples. Layouts are by
// hand on the 8-unit grid: boxes are 144 x 56, circles 48 x 48, triangles 64 x 56, antennas
// 48 x 64 (port 56 down) and terminals 80 x 32 (port 16 down). Of the instruments, plots are
// 240 x 144, controls 176 x 72, readouts 176 x 64, speakers 64 x 64 and notes 240 x 96.

import {
  CONTROL,
  NOTE,
  PLOT,
  READOUT,
  SPEAKER,
  type PlotView,
} from '../blocks/instruments.ts';
import type { PortRef } from '../engine/circuit.ts';
import type { StoredParams } from '../engine/params.ts';
import {
  SUBSYSTEM,
  type Diagram,
  type LabBlock,
  type Parameter,
} from './document.ts';

export type Part = {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly name?: string;
  readonly params?: StoredParams;
  /** For a subsystem: what is inside. Implies kind "subsystem". */
  readonly inner?: Diagram;
  /** Settings bound to expressions, as in LabBlock. */
  readonly bindings?: { readonly [setting: string]: string };
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
  notes?: string,
  parameters?: readonly Parameter[],
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
    ...(notes ? { notes } : {}),
    ...(parameters?.length ? { parameters } : {}),
  };
}

/**
 * A parameter's name as inline code, for notes written with String.raw, where
 * a backtick can't be escaped.
 */
export const code = (name: string): string => `\`${name}\``;

// Instruments.

type PlotOptions = {
  readonly name?: string;
  /** Follow the playhead, showing this many seconds around it. */
  readonly follow?: number;
  readonly low?: number;
  readonly high?: number;
};

export const plot = (
  x: number,
  y: number,
  view: PlotView,
  { name, follow, low, high }: PlotOptions = {},
): Part => ({
  kind: PLOT,
  x,
  y,
  ...(name ? { name } : {}),
  params: {
    view,
    ...(follow ? { follow: true, span: follow } : {}),
    ...(low ? { low } : {}),
    ...(high ? { high } : {}),
  },
});

export const speaker = (x: number, y: number): Part => ({
  kind: SPEAKER,
  x,
  y,
});

/** A control for a parameter, or for `block.setting`. */
export const control = (
  x: number,
  y: number,
  target: string,
  name?: string,
): Part => ({
  kind: CONTROL,
  x,
  y,
  ...(name ? { name } : {}),
  params: { target },
});

export const readout = (
  x: number,
  y: number,
  block: string,
  reading: string,
): Part => ({ kind: READOUT, x, y, params: { block, reading } });

export const note = (
  x: number,
  y: number,
  text: string,
  face = false,
): Part => ({ kind: NOTE, x, y, params: { text, face } });
