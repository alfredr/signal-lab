import { synthesizeVowel } from '../dsp/vowel.ts';
import { defineBlock } from '../engine/block.ts';
import { decibels, si, significant } from '../engine/format.ts';
import { choice, number } from '../engine/params.ts';
import { seededNoise } from '../engine/random.ts';

const RATES = [
  8000, 12000, 16000, 24000, 48000, 96000, 192000, 384000, 768000, 1536000,
];

/** Every source picks its own sample rate; blocks downstream inherit it. */
function rate(fallback = 48000) {
  return number({
    label: 'Sample rate',
    unit: 'Hz',
    default: fallback,
    min: 1000,
    max: 2_000_000,
    presets: RATES,
  });
}

/**
 * Standard deviation of white noise with `level` dB of power in `bandwidth`
 * Hz, at `rate`.
 */
export function noiseSigma(
  level: number,
  bandwidth: number,
  rate: number,
): number {
  // Power P in bandwidth B is a density of P / B per Hz; white noise of variance sigma^2
  // spreads that density from 0 to rate / 2.
  return Math.sqrt((10 ** (level / 10) * (rate / 2)) / bandwidth);
}

export const oscillator = defineBlock({
  kind: 'oscillator',
  label: 'Oscillator',
  category: 'Sources',
  description: String.raw`A cosine wave, $A\cos(2\pi f t + \varphi)$. Use it for a carrier, a local oscillator or a test tone.`,
  inputs: [],
  outputs: [{ name: 'out' }],
  shape: { kind: 'circle', symbol: '~' },
  params: {
    frequency: number({
      label: 'Frequency',
      unit: 'Hz',
      default: 1000,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    amplitude: number({
      label: 'Amplitude',
      default: 1,
      min: 0,
      max: 10,
      step: 0.01,
    }),
    phase: number({
      label: 'Phase',
      unit: 'deg',
      default: 0,
      min: -180,
      max: 180,
      step: 1,
    }),
    rate: rate(),
  },
  summary: (p) => si(p.frequency, 'Hz'),
  rates: (_, p) => [p.rate],
  create(p, context) {
    const step = (2 * Math.PI * p.frequency) / context.outputRates[0];
    const phase = (p.phase * Math.PI) / 180;
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = p.amplitude * Math.cos(step * i + phase);
        }
      },
    };
  },
});

export const voice = defineBlock({
  kind: 'voice',
  label: 'Voice',
  category: 'Sources',
  description: String.raw`A sung vowel, two syllables every 1.2 s. It is scaled so its most negative peak is $-1$, so in AM a modulation index $\mu = 1$ just reaches zero.`,
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    vowel: choice({
      label: 'Vowel',
      default: 'ah',
      options: [
        { value: 'ah', label: 'ah' },
        { value: 'ee', label: 'ee' },
        { value: 'oo', label: 'oo' },
      ],
    }),
    pitch: number({
      label: 'Pitch',
      unit: 'Hz',
      default: 120,
      min: 60,
      max: 400,
      step: 1,
      scale: 'log',
    }),
    bandwidth: number({
      label: 'Bandwidth',
      unit: 'Hz',
      default: 4500,
      min: 500,
      max: 20000,
      scale: 'log',
      help: 'Harmonics above this are left out.',
    }),
    rate: rate(),
  },
  summary: (p) => `"${p.vowel}" ${si(p.pitch, 'Hz')}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    const take = synthesizeVowel(
      p.vowel,
      p.pitch,
      p.bandwidth,
      context.outputRates[0],
    );
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = take[i % take.length];
        }
      },
    };
  },
});

export const noise = defineBlock({
  kind: 'noise',
  label: 'Noise',
  category: 'Sources',
  description: String.raw`White Gaussian noise. Its level is the power $N_0 B$ it has in a reference bandwidth $B$, the way receivers quote SNR, so a setting means the same thing at any sample rate.`,
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    level: number({
      label: 'Power',
      unit: 'dB',
      default: -30,
      min: -120,
      max: 20,
      step: 0.5,
      help: String.raw`In the bandwidth below, relative to 1. A sine of amplitude 1 has power $\tfrac12$, or $-3$ dB.`,
    }),
    bandwidth: number({
      label: 'Measured in',
      unit: 'Hz',
      default: 2500,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    seed: number({ label: 'Seed', default: 1, min: 1, max: 999, step: 1 }),
    rate: rate(),
  },
  summary: (p) => `${decibels(p.level)} in ${si(p.bandwidth, 'Hz')}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    const sigma = noiseSigma(p.level, p.bandwidth, context.outputRates[0]);
    const normal = seededNoise(context.seed, p.seed);
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = sigma * normal();
        }
      },
    };
  },
});

export const constant = defineBlock({
  kind: 'constant',
  label: 'DC',
  category: 'Sources',
  description: String.raw`A constant level. Added to a message, it is the 1 in $1 + \mu\, m(t)$.`,
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    value: number({
      label: 'Value',
      default: 1,
      min: -10,
      max: 10,
      step: 0.01,
    }),
    rate: rate(),
  },
  summary: (p) => significant(p.value),
  rates: (_, p) => [p.rate],
  create(p) {
    return {
      process(_, [out], start, end) {
        out.fill(p.value, start, end);
      },
    };
  },
});

export const sweep = defineBlock({
  kind: 'sweep',
  label: 'Sweep',
  category: 'Sources',
  description:
    "A tone gliding from one frequency to another over the whole window. Feed it to a filter and the outline of the output traces the filter's frequency response.",
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    from: number({
      label: 'From',
      unit: 'Hz',
      default: 20,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    to: number({
      label: 'To',
      unit: 'Hz',
      default: 20000,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    spacing: choice({
      label: 'Spacing',
      default: 'log',
      options: [
        { value: 'log', label: 'log' },
        { value: 'linear', label: 'linear' },
      ],
    }),
    amplitude: number({
      label: 'Amplitude',
      default: 1,
      min: 0,
      max: 10,
      step: 0.01,
    }),
    rate: rate(),
  },
  summary: (p) => `${si(p.from, 'Hz')} to ${si(p.to, 'Hz')}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    const rate = context.outputRates[0];
    const span = context.duration;
    const ratio = p.to / p.from;
    // Phase is the integral of the instantaneous frequency.
    const phaseAt =
      p.spacing === 'linear' || Math.abs(ratio - 1) < 1e-9
        ? (t: number) =>
            2 * Math.PI * (p.from * t + ((p.to - p.from) * t * t) / (2 * span))
        : (t: number) =>
            ((2 * Math.PI * p.from * span) / Math.log(ratio)) *
            (ratio ** (t / span) - 1);
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = p.amplitude * Math.cos(phaseAt(i / rate));
        }
      },
    };
  },
});
