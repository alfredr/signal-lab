// Antennas. Every transmit antenna radiates into one shared air, and every receive antenna picks
// up all of it: the model joins them through a hidden Air block, so there is no wire to draw.

import { defineBlock, type BlockType } from '../engine/block.ts';
import { amplitudeFromDecibels, decibels, si } from '../engine/format.ts';
import { number } from '../engine/params.ts';
import { seededNoise } from '../engine/random.ts';
import { noiseSigma } from './sources.ts';

const gainParam = (help: string) =>
  number({
    label: 'Gain',
    unit: 'dB',
    default: 0,
    min: -60,
    max: 40,
    step: 0.5,
    help,
  });

export const transmitAntenna = defineBlock({
  kind: 'antenna-tx',
  label: 'Transmit antenna',
  category: 'Radio',
  description:
    'Radiates its input. Every transmit antenna adds into the same air, which every receive antenna picks up, so there is no wire to draw.',
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'air', hidden: true }],
  shape: { kind: 'antenna' },
  params: { gain: gainParam('Of the signal as it reaches the air.') },
  summary: (p) => (p.gain ? decibels(p.gain) : ''),
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

export const receiveAntenna = defineBlock({
  kind: 'antenna-rx',
  label: 'Receive antenna',
  category: 'Radio',
  description: String.raw`Picks up everything on the air, plus band noise: the static of the atmosphere and of every other electrical thing nearby. Its level is the noise power in a reference bandwidth, as for the Noise block, so with the carrier's power you can read off $C/N$.`,
  inputs: [{ name: 'air', hidden: true }],
  outputs: [{ name: 'out' }],
  shape: { kind: 'antenna' },
  params: {
    gain: gainParam('Applied to what it picks up from the air.'),
    noise: number({
      label: 'Band noise',
      unit: 'dB',
      default: -30,
      min: -120,
      max: 20,
      step: 0.5,
      help: 'Power in the bandwidth below; -120 dB is effectively silent.',
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
  },
  summary: (p) => `noise ${decibels(p.noise)} in ${si(p.bandwidth, 'Hz')}`,
  create(p, context) {
    const gain = amplitudeFromDecibels(p.gain);
    const sigma = noiseSigma(p.noise, p.bandwidth, context.outputRates[0]);
    const normal = seededNoise(context.seed, p.seed);
    return {
      process([air], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = gain * air[i] + sigma * normal();
        }
      },
    };
  },
});

const airTypes = new Map<number, BlockType>();

/** The hidden block that sums `count` transmit antennas into the air. */
export function airType(count: number): BlockType {
  let type = airTypes.get(count);
  if (!type) {
    type = defineBlock({
      kind: `air:${count}`,
      label: 'Air',
      category: 'Radio',
      description:
        'Everything every transmit antenna radiates, added together.',
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
