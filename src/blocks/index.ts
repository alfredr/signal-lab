import type { BlockType, Category } from '../engine/block.ts';
import { capacitor } from './detectors.ts';
import { bandpass, gaussian, highpass, lowpass } from './filters.ts';
import {
  crcBlock,
  ft8Decoder,
  ft8Mapper,
  ft8Message,
  ft8Transmitter,
  ldpcBlock,
} from './ft8.ts';
import {
  button,
  control,
  note,
  plot,
  readout,
  speaker,
  symbols,
} from './instruments.ts';
import { adder, gain, mixer, offset } from './math.ts';
import { meter, snrMeter } from './meters.ts';
import { clipper, diode, rectifier, square } from './nonlinear.ts';
import { airType, antenna, hear, radiate } from './radio.ts';
import {
  constant,
  noise,
  oscillator,
  recording,
  sweep,
  vco,
  voice,
} from './sources.ts';
import { speech } from './speech.ts';
import { inputTerminal, outputTerminal } from './terminals.ts';
import { delay, hilbert, resample } from './time.ts';

/** Every block type a diagram can contain, in palette order. */
export const blockTypes: readonly BlockType[] = [
  oscillator,
  voice,
  recording,
  speech,
  noise,
  constant,
  sweep,
  vco,
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
  gaussian,
  capacitor,
  meter,
  snrMeter,
  ft8Message,
  crcBlock,
  ldpcBlock,
  ft8Mapper,
  ft8Decoder,
  antenna,
  delay,
  hilbert,
  resample,
  inputTerminal,
  outputTerminal,
  plot,
  speaker,
  control,
  readout,
  symbols,
  button,
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

const byKind = new Map(
  [...blockTypes, radiate, hear, ft8Transmitter].map((type) => [
    type.kind,
    type,
  ]),
);

/**
 * A block type by kind, including the halves antennas run as and the Air
 * blocks the model adds between them, and the one-block FT8 transmitter of
 * documents saved before the subsystem replaced it.
 */
export function blockType(kind: string): BlockType | undefined {
  if (kind.startsWith('air:')) {
    return airType(Number(kind.slice(4)));
  }

  return byKind.get(kind);
}
