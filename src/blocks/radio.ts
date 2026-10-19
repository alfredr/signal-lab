// Antennas. An antenna radiates whatever is wired into it and hears everything the other
// antennas radiate, plus band noise: there is one shared air and no wire to draw. The engine
// runs each antenna as two halves, one that radiates and one that hears, joined through hidden
// Air blocks the model adds, so an antenna that does both never looks like a feedback loop.

import { BlockError, defineBlock, type BlockType } from '../engine/block.ts';
import { amplitudeFromDecibels, decibels, si } from '../engine/format.ts';
import { number } from '../engine/params.ts';
import { seededNoise } from '../engine/random.ts';
import { noiseSigma } from './sources.ts';

export const ANTENNA = 'antenna';
/** The halves of an antenna, as the engine runs them. */
export const RADIATE = 'antenna-tx';
export const HEAR = 'antenna-rx';

const params = {
  gain: number({
    label: 'Gain',
    unit: 'dB',
    default: 0,
    min: -60,
    max: 40,
    step: 0.5,
    help: 'Of what it radiates and of what it picks up: an antenna works the same both ways.',
  }),
  noise: number({
    label: 'Band noise',
    unit: 'dB',
    default: -30,
    min: -120,
    max: 20,
    step: 0.5,
    help: 'What it hears besides the other antennas, as power in the bandwidth below; -120 dB is effectively silent.',
  }),
  bandwidth: number({
    label: 'Measured in',
    unit: 'Hz',
    default: 9000,
    min: 1,
    max: 1_000_000,
    scale: 'log',
  }),
  seed: number({ label: 'Seed', default: 1, min: 1, max: 999, step: 1 }),
};

export const antenna = defineBlock({
  kind: ANTENNA,
  label: 'Antenna',
  category: 'Radio',
  description: String.raw`Puts on the air whatever is wired into its input, and its output hears everything the other antennas put there, plus band noise: the static of the atmosphere and of every other electrical thing nearby. There is one shared air, so there is no wire to draw between stations. The noise level is the power in a reference bandwidth, as for the Noise block, so with the carrier's power you can read off $C/N$.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  shape: { kind: 'antenna' },
  params,
  summary: (p) => `noise ${decibels(p.noise)} in ${si(p.bandwidth, 'Hz')}`,
  create() {
    throw new BlockError('An antenna runs as its two halves.');
  },
});

/** The half of an antenna that radiates. */
export const radiate = defineBlock({
  kind: RADIATE,
  label: 'Antenna',
  category: 'Radio',
  description: 'What an antenna radiates.',
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'air', hidden: true }],
  params,
  create(p) {
    const gain = amplitudeFromDecibels(p.gain);
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = gain * x[i];
        }
      },
    };
  },
});

/** The half of an antenna that hears. */
export const hear = defineBlock({
  kind: HEAR,
  label: 'Antenna',
  category: 'Radio',
  description: 'What an antenna hears.',
  inputs: [{ name: 'air', hidden: true }],
  outputs: [{ name: 'out' }],
  params,
  create(p, context) {
    const rate = context.outputRates[0];
    let gain = amplitudeFromDecibels(p.gain);
    let sigma = noiseSigma(p.noise, p.bandwidth, rate);
    const normal = seededNoise(context.seed, p.seed);
    return {
      process([air], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = gain * air[i] + sigma * normal();
        }
      },
      update(next) {
        if (next.seed !== p.seed) {
          return false;
        }

        gain = amplitudeFromDecibels(next.gain);
        sigma = noiseSigma(next.noise, next.bandwidth, rate);
        return true;
      },
    };
  },
});

const airTypes = new Map<number, BlockType>();

/** The hidden block that sums what `count` antennas radiate. */
export function airType(count: number): BlockType {
  let type = airTypes.get(count);
  if (!type) {
    type = defineBlock({
      kind: `air:${count}`,
      label: 'Air',
      category: 'Radio',
      description: 'Everything some antennas radiate, added together.',
      inputs: Array.from({ length: count }, (_, i) => ({
        name: `tx${i + 1}`,
      })),
      outputs: [{ name: 'out' }],
      params: {},
      create() {
        return {
          process(inputs, [y], start, end) {
            y.fill(0, start, end);

            for (const x of inputs) {
              for (let i = start; i < end; i++) {
                y[i] += x[i];
              }
            }
          },
        };
      },
    });
    airTypes.set(count, type);
  }

  return type;
}
