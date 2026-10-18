import type { BlockType, Category } from '../engine/block.ts';
import { capacitor } from './detectors.ts';
import { bandpass, highpass, lowpass } from './filters.ts';
import { ft8Decoder, ft8Transmitter } from './ft8.ts';
import { control, note, plot, readout, speaker } from './instruments.ts';
import { adder, gain, mixer, offset } from './math.ts';
import { meter, snrMeter } from './meters.ts';
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
  meter,
  snrMeter,
  ft8Transmitter,
  ft8Decoder,
  transmitAntenna,
  receiveAntenna,
  delay,
  hilbert,
  resample,
  inputTerminal,
  outputTerminal,
  plot,
  speaker,
  control,
  readout,
  note,
];

export const categories: readonly Category[] = [
  'Sources',
  'Radio',
  'Math',
  'Nonlinear',
  'Filters',
  'Detectors',
  'Meters',
  'Digital modes',
  'Time and rate',
  'Subsystems',
  'Instruments',
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
