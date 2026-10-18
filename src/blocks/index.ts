import type { BlockType, Category } from "../engine/block.ts";
import { envelope } from "./detectors.ts";
import { bandpass, highpass, lowpass } from "./filters.ts";
import { adder, gain, mixer, offset } from "./math.ts";
import { clipper, rectifier, square } from "./nonlinear.ts";
import { constant, noise, oscillator, sweep, voice } from "./sources.ts";
import { delay, hilbert, resample } from "./time.ts";

/** Every block type, in palette order. */
export const blockTypes: readonly BlockType[] = [
  oscillator,
  voice,
  noise,
  constant,
  sweep,
  gain,
  offset,
  adder,
  mixer,
  rectifier,
  square,
  clipper,
  lowpass,
  highpass,
  bandpass,
  envelope,
  delay,
  hilbert,
  resample,
];

export const categories: readonly Category[] = ["Sources", "Math", "Nonlinear", "Filters", "Detectors", "Time and rate"];

const byKind = new Map(blockTypes.map((type) => [type.kind, type]));

export function blockType(kind: string): BlockType | undefined {
  return byKind.get(kind);
}
