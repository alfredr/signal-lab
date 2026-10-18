import type { BlockType, Category } from '../engine/block.ts';
import { capacitor } from './detectors.ts';
import { bandpass, highpass, lowpass } from './filters.ts';
import { adder, gain, mixer, offset } from './math.ts';
import { clipper, diode, rectifier, square } from './nonlinear.ts';
import { airType, receiveAntenna, transmitAntenna } from './radio.ts';
import { constant, noise, oscillator, sweep, voice } from './sources.ts';
import { inputTerminal, outputTerminal } from './terminals.ts';
import { delay, hilbert, resample } from './time.ts';

/** Every block type a diagram can contain, in palette order. */
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
  diode,
  square,
  clipper,
  lowpass,
  highpass,
  bandpass,
  capacitor,
  transmitAntenna,
  receiveAntenna,
  delay,
  hilbert,
  resample,
  inputTerminal,
  outputTerminal,
];

export const categories: readonly Category[] = [
  'Sources',
  'Radio',
  'Math',
  'Nonlinear',
  'Filters',
  'Detectors',
  'Time and rate',
  'Subsystems',
];

const byKind = new Map(blockTypes.map((type) => [type.kind, type]));

/**
 * A block type by kind, including the internal Air blocks the model adds for
 * antennas.
 */
export function blockType(kind: string): BlockType | undefined {
  if (kind.startsWith('air:')) {
    return airType(Number(kind.slice(4)));
  }

  return byKind.get(kind);
}
