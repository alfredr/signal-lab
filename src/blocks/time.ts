import { Fir, hilbertTaps, SampleDelay } from '../dsp/fir.ts';
import { downsample, upsample } from '../dsp/resample.ts';
import {
  defineBlock,
  RateError,
  type DelayProcessor,
} from '../engine/block.ts';
import { si } from '../engine/format.ts';
import { choice, number } from '../engine/params.ts';

export const delay = defineBlock({
  kind: 'delay',
  label: 'Delay',
  category: 'Time and rate',
  description: String.raw`Holds the signal back by $\tau$, at least one sample. Every feedback loop needs a delay: it is what makes the loop's next output depend only on the past.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    time: number({
      label: 'Delay',
      unit: 's',
      default: 0.25,
      min: 0,
      max: 5,
      scale: 'linear',
      step: 0.0001,
    }),
  },
  summary: (p) => si(p.time, 's'),
  create(p, context): DelayProcessor {
    const latency = Math.max(1, Math.round(p.time * context.outputRates[0]));
    return {
      latency,
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = i >= latency ? x[i - latency] : 0;
        }
      },
    };
  },
});

export const hilbert = defineBlock({
  kind: 'hilbert',
  label: 'Phase splitter',
  category: 'Time and rate',
  description: String.raw`Splits a signal into two copies $90^\circ$ apart at every frequency (a Hilbert transformer). I is the input delayed to match; Q lags it by $90^\circ$. Two mixers fed with I and Q make the phasing SSB transmitter.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'I' }, { name: 'Q' }],
  params: {
    taps: choice({
      label: 'Length',
      default: '255',
      help: String.raw`Longer filters hold $90^\circ$ down to lower frequencies, at the cost of more delay.`,
      options: [
        { value: '63', label: '63' },
        { value: '127', label: '127' },
        { value: '255', label: '255' },
        { value: '511', label: '511' },
        { value: '1023', label: '1023' },
      ],
    }),
  },
  summary: () => '90°',
  create(p) {
    const length = Number(p.taps);
    const quadrature = new Fir(hilbertTaps(length));
    const inPhase = new SampleDelay((length - 1) / 2);
    return {
      process([x], [i, q], start, end) {
        inPhase.process(x, i, start, end);
        quadrature.process(x, q, start, end);
      },
    };
  },
});

export const resample = defineBlock({
  kind: 'resample',
  label: 'Resample',
  category: 'Time and rate',
  description:
    'Changes the sample rate by a whole-number factor, filtering out aliases or images. Keep audio at an audio rate and run only the RF stages fast.',
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    direction: choice({
      label: 'Direction',
      default: 'up',
      options: [
        { value: 'up', label: 'up' },
        { value: 'down', label: 'down' },
      ],
    }),
    factor: number({
      label: 'Factor',
      unit: 'x',
      default: 8,
      min: 2,
      max: 32,
      step: 1,
    }),
  },
  summary: (p) => (p.direction === 'up' ? `↑ ×${p.factor}` : `↓ ÷${p.factor}`),
  rates([rate], p) {
    if (rate === undefined) {
      throw new RateError('Resample has no input.');
    }

    return [p.direction === 'up' ? rate * p.factor : rate / p.factor];
  },
  create(p) {
    // Never in a loop, so this is a single call over the whole window.
    return {
      process([x], [y]) {
        if (p.direction === 'up') {
          upsample(x, p.factor, y);
        } else {
          downsample(x, p.factor, y);
        }
      },
    };
  },
});
