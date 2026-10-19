import { bandpassSection, Biquads, butterworth } from '../dsp/biquad.ts';
import { Fir } from '../dsp/fir.ts';
import { defineBlock } from '../engine/block.ts';
import { si, significant } from '../engine/format.ts';
import { choice, number } from '../engine/params.ts';

const order = choice({
  label: 'Order',
  default: '4',
  help: String.raw`Order 1 is a single RC stage. Higher orders are Butterworth and fall $6n$ dB per octave for order $n$.`,
  options: [
    { value: '1', label: '1' },
    { value: '2', label: '2' },
    { value: '4', label: '4' },
    { value: '6', label: '6' },
    { value: '8', label: '8' },
  ],
});

export const lowpass = defineBlock({
  kind: 'lowpass',
  label: 'Low-pass',
  category: 'Filters',
  description: String.raw`Passes frequencies below the cutoff $f_c$, where the gain is down 3 dB, to $1/\sqrt{2}$.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    cutoff: number({
      label: 'Cutoff',
      unit: 'Hz',
      default: 4500,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    order,
  },
  summary: (p) => `< ${si(p.cutoff, 'Hz')}`,
  create(p, context) {
    const design = (q: typeof p) =>
      butterworth(
        'lowpass',
        Number(q.order),
        q.cutoff,
        context.outputRates[0],
      );
    const filter = new Biquads(design(p));
    return {
      process: ([x], [y], start, end) => filter.process(x, y, start, end),
      update: (next) => filter.retune(design(next)),
    };
  },
});

export const highpass = defineBlock({
  kind: 'highpass',
  label: 'High-pass',
  category: 'Filters',
  description:
    'Passes frequencies above the cutoff. A low cutoff makes a DC block, removing the steady level a detector leaves behind.',
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    cutoff: number({
      label: 'Cutoff',
      unit: 'Hz',
      default: 50,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    order: { ...order, default: '2' },
  },
  summary: (p) => `> ${si(p.cutoff, 'Hz')}`,
  create(p, context) {
    const design = (q: typeof p) =>
      butterworth(
        'highpass',
        Number(q.order),
        q.cutoff,
        context.outputRates[0],
      );
    const filter = new Biquads(design(p));
    return {
      process: ([x], [y], start, end) => filter.process(x, y, start, end),
      update: (next) => filter.retune(design(next)),
    };
  },
});

export const bandpass = defineBlock({
  kind: 'bandpass',
  label: 'Band-pass',
  category: 'Filters',
  description: String.raw`Tuned circuits. One section is a single LC resonator, tuned to $f_0 = 1 / (2\pi\sqrt{LC})$; more sections in cascade give steeper skirts for the same $-3$ dB bandwidth, like an IF strip.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    center: number({
      label: 'Center',
      unit: 'Hz',
      default: 100_000,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    bandwidth: number({
      label: 'Bandwidth',
      unit: 'Hz',
      default: 10_000,
      min: 1,
      max: 1_000_000,
      scale: 'log',
    }),
    sections: number({
      label: 'Sections',
      default: 1,
      min: 1,
      max: 6,
      step: 1,
    }),
  },
  summary: (p) => `${si(p.center, 'Hz')} ±${si(p.bandwidth / 2, 'Hz')}`,
  create(p, context) {
    const design = (q: typeof p) => {
      // n identical resonators narrow the -3 dB width by sqrt(2^(1/n) - 1); widen each to match.
      const each = q.bandwidth / Math.sqrt(2 ** (1 / q.sections) - 1);
      const section = bandpassSection(q.center, each, context.outputRates[0]);
      return Array.from({ length: q.sections }, () => section);
    };

    const filter = new Biquads(design(p));
    return {
      process: ([x], [y], start, end) => filter.process(x, y, start, end),
      update: (next) => filter.retune(design(next)),
    };
  },
});

/**
 * How many samples a Gaussian filter reaches each way: out to four standard
 * deviations, which leaves less than 1e-4 behind. It is also its delay.
 */
function gaussianHalf(time: number, bt: number, rate: number): number {
  const sigma = (Math.sqrt(Math.LN2) / (2 * Math.PI * bt)) * time * rate;
  return Math.max(1, Math.round(4 * sigma));
}

export const gaussian = defineBlock({
  kind: 'gaussian',
  label: 'Gaussian filter',
  category: 'Filters',
  description: String.raw`Smooths its input with a Gaussian bell, so a step becomes a glide with no overshoot. In GFSK, which FT8 uses, it rounds each step of the frequency, so the signal throws less energy onto its neighbours. Its width is set against a symbol time $T$ by the bandwidth-time product $BT$: the bell's standard deviation is $\sigma = \frac{\sqrt{\ln 2}}{2\pi \cdot BT}\, T$, so FT8's $BT = 2$ smooths each step over about a quarter of a symbol. It reaches four standard deviations each way, so it delays the signal by $4\sigma$: 42.4 ms for FT8.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    time: number({
      label: 'Symbol time',
      unit: 's',
      default: 0.16,
      min: 1e-5,
      max: 10,
      scale: 'log',
    }),
    bt: number({
      label: 'BT',
      default: 2,
      min: 0.1,
      max: 10,
      step: 0.1,
      help: 'Bandwidth times symbol time: smaller is smoother.',
    }),
  },
  summary: (p) => `BT ${significant(p.bt)}`,
  lag: (p, rate) => gaussianHalf(p.time, p.bt, rate) / rate,
  create(p, context) {
    const rate = context.outputRates[0];
    const sigma = (Math.sqrt(Math.LN2) / (2 * Math.PI * p.bt)) * p.time * rate;
    const half = gaussianHalf(p.time, p.bt, rate);
    const taps = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      taps[k] = Math.exp(-((k - half) ** 2) / (2 * sigma * sigma));
      sum += taps[k];
    }

    for (let k = 0; k < taps.length; k++) {
      taps[k] /= sum;
    }

    const filter = new Fir(taps);
    return {
      process: ([x], [y], start, end) => filter.process(x, y, start, end),
    };
  },
});
