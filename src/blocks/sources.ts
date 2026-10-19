import { resampleTo } from '../dsp/resample.ts';
import { synthesizeVowel } from '../dsp/vowel.ts';
import {
  BlockError,
  defineBlock,
  type Processor,
  type Reading,
} from '../engine/block.ts';
import { decibels, MINUS, si, significant } from '../engine/format.ts';
import { boolean, choice, number, text } from '../engine/params.ts';
import { seededNoise } from '../engine/random.ts';
import { sampleCount } from '../engine/signal.ts';
import { clipFor } from './clips.ts';

const RATES = [
  8000, 12000, 16000, 24000, 48000, 96000, 192000, 384000, 768000, 1536000,
];

/** Every source picks its own sample rate; blocks downstream inherit it. */
export function rate(fallback = 48000) {
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
    const rate = context.outputRates[0];
    let settings = p;
    // Phase in cycles at sample `from`, where the frequency last changed, so
    // turning the knob glides on from where the wave is.
    let from = sampleCount(context.time, rate);
    let cycles = ((p.frequency * from) / rate) % 1;
    let n = from;
    return {
      process(_, [out], start, end) {
        const { amplitude, frequency } = settings;
        const offset = cycles + settings.phase / 360;
        for (let i = start; i < end; i++, n++) {
          out[i] =
            amplitude *
            Math.cos(2 * Math.PI * (offset + (frequency * (n - from)) / rate));
        }
      },
      update(next) {
        cycles = (cycles + (settings.frequency * (n - from)) / rate) % 1;
        from = n;
        settings = next;
        return true;
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
    let n = sampleCount(context.time, context.outputRates[0]);
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++, n++) {
          out[i] = take[n % take.length];
        }
      },
    };
  },
});

/** The Recording block's kind: it plays recordings the page keeps. */
export const RECORDING = 'recording';

export const recording = defineBlock({
  kind: RECORDING,
  label: 'Recording',
  category: 'Sources',
  description: String.raw`Plays a recording: an audio file, or something recorded from the microphone, loaded in the inspector. It plays once each time its **trigger** input rises through 0.5 (wire a Button to it) or Play is pressed in the inspector, or over and over if it loops. It is scaled so its loudest peak is 1.`,
  inputs: [{ name: 'trigger', side: 'bottom', optional: true }],
  outputs: [{ name: 'out' }],
  reports: ['Playing'],
  params: {
    clip: text({ label: 'Recording', default: '', maxLength: 80 }),
    loop: boolean({ label: 'Loop', default: false }),
    rate: rate(),
  },
  summary: (p) => (p.loop ? 'loops' : 'on trigger'),
  rates: (_, p) => [p.rate],
  create(p, context) {
    if (!p.clip) {
      throw new BlockError(
        'No recording yet: load a file or record one in the inspector.',
      );
    }

    const clip = clipFor(p.clip);
    if (!clip) {
      throw new BlockError(
        "This recording isn't in this browser. Load it again, or open the file the diagram was saved in.",
      );
    }

    const rate = context.outputRates[0];
    return playback(
      resampleTo(clip.data, clip.rate, rate),
      rate,
      p.loop,
      context.time,
    );
  },
});

/**
 * How a Recording or Speech block plays its take: over and over if it loops,
 * aligned with the stream's time, or else once from the start each time its
 * trigger input rises through 0.5 or it is pressed. `describe` adds readings
 * for where it is in the take.
 */
export function playback(
  take: Float32Array,
  rate: number,
  loop: boolean,
  time: number,
  describe: (at: number) => readonly Reading[] = () => [],
): Processor {
  // Where in the take it is; at the end, it has stopped.
  let at = loop ? sampleCount(time, rate) % take.length : take.length;
  let pressed = false;
  // The trigger's last value, to see it rise.
  let last = 0;
  return {
    process([trigger], [out], start, end) {
      // Where the trigger rose, in this chunk's output samples. Only the
      // trigger samples under [start, end) count: in a feedback loop the rest
      // are not worked out yet.
      const starts: number[] = pressed ? [start] : [];
      pressed = false;
      const scale = trigger.length / out.length;

      for (
        let j = Math.floor(start * scale);
        j < Math.floor(end * scale);
        j++
      ) {
        if (last < 0.5 && trigger[j] >= 0.5) {
          starts.push(Math.max(start, Math.floor(j / scale)));
        }

        last = trigger[j];
      }

      let k = 0;
      for (let i = start; i < end; i++) {
        while (k < starts.length && starts[k] <= i) {
          at = 0;
          k++;
        }

        if (at < take.length) {
          out[i] = take[at++];

          if (loop && at === take.length) {
            at = 0;
          }
        } else {
          out[i] = 0;
        }
      }
    },
    press() {
      pressed = true;
    },
    readings: (): Reading[] => [
      ...describe(at),
      {
        label: 'Playing',
        value:
          at < take.length
            ? `${(at / rate).toFixed(1)} of ${(take.length / rate).toFixed(1)} s`
            : 'stopped',
      },
    ],
  };
}

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
    const rate = context.outputRates[0];
    let sigma = noiseSigma(p.level, p.bandwidth, rate);
    const normal = seededNoise(context.seed, p.seed);
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = sigma * normal();
        }
      },
      update(next) {
        if (next.seed !== p.seed) {
          return false;
        }

        sigma = noiseSigma(next.level, next.bandwidth, rate);
        return true;
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
    let { value } = p;
    return {
      process(_, [out], start, end) {
        out.fill(value, start, end);
      },
      update(next) {
        value = next.value;
        return true;
      },
    };
  },
});

export const sweep = defineBlock({
  kind: 'sweep',
  label: 'Sweep',
  category: 'Sources',
  description:
    "A tone gliding from one frequency to another, then starting over. Feed it to a filter and the outline of the output traces the filter's frequency response.",
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
    period: number({
      label: 'Sweep time',
      unit: 's',
      default: 1,
      min: 0.01,
      max: 60,
      scale: 'log',
      help: 'How long one glide takes before it starts over.',
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
    const span = p.period;
    const length = Math.max(1, Math.round(span * rate));
    const ratio = p.to / p.from;
    // Phase is the integral of the instantaneous frequency.
    const phaseAt =
      p.spacing === 'linear' || Math.abs(ratio - 1) < 1e-9
        ? (t: number) =>
            2 * Math.PI * (p.from * t + ((p.to - p.from) * t * t) / (2 * span))
        : (t: number) =>
            ((2 * Math.PI * p.from * span) / Math.log(ratio)) *
            (ratio ** (t / span) - 1);
    let n = sampleCount(context.time, rate);
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++, n++) {
          out[i] = p.amplitude * Math.cos(phaseAt((n % length) / rate));
        }
      },
    };
  },
});

export const vco = defineBlock({
  kind: 'vco',
  label: 'VCO',
  category: 'Sources',
  description: String.raw`A voltage-controlled oscillator: a sine whose frequency follows its input, $f = f_0 + k\,x(t)$, and whose phase adds that up, $\varphi(t) = 2\pi \int f\,dt$, so it never jumps. With a message as its input it is an FM transmitter; with FT8's smoothed tones and $k = 6.25$ Hz it makes FT8's audio. **phase** is how far it has run ahead of its rest frequency, $\int k\,x\,dt$, in cycles.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }, { name: 'phase' }],
  params: {
    rest: number({
      label: 'Rest frequency',
      unit: 'Hz',
      default: 1000,
      min: 0,
      max: 1_000_000,
      help: 'Its frequency with no input.',
    }),
    sensitivity: number({
      label: 'Sensitivity',
      unit: 'Hz',
      default: 1,
      min: -100_000,
      max: 100_000,
      help: 'How far the frequency moves for each unit of input.',
    }),
    amplitude: number({
      label: 'Amplitude',
      default: 1,
      min: 0,
      max: 10,
      step: 0.01,
    }),
  },
  summary: (p) =>
    `${si(p.rest, 'Hz')} ${p.sensitivity < 0 ? MINUS : '+'} ${si(Math.abs(p.sensitivity), 'Hz')}/unit`,
  create(p, context) {
    const rate = context.inputRates[0];
    let settings = p;
    // The phase in cycles: in all, kept below 1, and from the input alone.
    let cycles = 0;
    let ahead = 0;
    return {
      process([x], [out, phase], start, end) {
        const { rest, sensitivity, amplitude } = settings;
        for (let i = start; i < end; i++) {
          out[i] = amplitude * Math.sin(2 * Math.PI * cycles);
          phase[i] = ahead;
          const step = (sensitivity * x[i]) / rate;
          cycles += rest / rate + step;
          cycles -= Math.floor(cycles);
          ahead += step;
        }
      },
      update(next) {
        settings = next;
        return true;
      },
    };
  },
});
