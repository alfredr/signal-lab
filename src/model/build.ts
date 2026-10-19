// Helpers for defining library diagrams and examples. Coordinates use an
// 8-unit grid. Block dimensions are defined by the layout code and instrument
// shapes; these helpers preserve the supplied positions.

import {
  BUTTON,
  CONTROL,
  NOTE,
  PLOT,
  READOUT,
  SYMBOLS,
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
  /** Seconds of the latest signal it shows, if not what suits the view. */
  readonly span?: number;
  readonly low?: number;
  readonly high?: number;
  /** A Bits to tones view, by full id, to join as a row. */
  readonly stack?: string;
};

export const plot = (
  x: number,
  y: number,
  view: PlotView,
  { name, span, low, high, stack }: PlotOptions = {},
): Part => ({
  kind: PLOT,
  x,
  y,
  ...(name ? { name } : {}),
  params: {
    view,
    ...(span ? { span } : {}),
    ...(low ? { low } : {}),
    ...(high ? { high } : {}),
    ...(stack ? { stack } : {}),
  },
});

/** A Bits to tones view of the FT8 symbol mapper `mapper`. */
export const symbolView = (
  x: number,
  y: number,
  mapper: string,
  name?: string,
): Part => ({
  kind: SYMBOLS,
  x,
  y,
  ...(name ? { name } : {}),
  params: { block: mapper },
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
  style?: 'slider' | 'lcd',
): Part => ({
  kind: CONTROL,
  x,
  y,
  ...(name ? { name } : {}),
  params: { target, ...(style ? { style } : {}) },
});

export const readout = (
  x: number,
  y: number,
  block: string,
  reading: string,
  style?: 'lcd',
): Part => ({
  kind: READOUT,
  x,
  y,
  params: { block, reading, ...(style ? { style } : {}) },
});

export const button = (x: number, y: number, name: string): Part => ({
  kind: BUTTON,
  x,
  y,
  name,
  params: {},
});

export const note = (
  x: number,
  y: number,
  text: string,
  face = false,
): Part => ({ kind: NOTE, x, y, params: { text, face } });
