import { defineBlock } from "../engine/block.ts";
import { decibels, si, significant } from "../engine/format.ts";
import { choice, number } from "../engine/params.ts";
import { gaussian, mulberry32 } from "../engine/random.ts";
import { synthesizeVowel } from "../dsp/vowel.ts";

const RATES = [8000, 12000, 16000, 24000, 48000, 96000, 192000, 384000, 768000, 1536000];

/** Every source picks its own sample rate; blocks downstream inherit it. */
function rate(fallback = 48000) {
  return number({ label: "Sample rate", unit: "Hz", default: fallback, min: 1000, max: 2_000_000, presets: RATES });
}

export const oscillator = defineBlock({
  kind: "oscillator",
  label: "Oscillator",
  category: "Sources",
  description: "A cosine wave, amplitude · cos(2πft + phase). Use it for a carrier, a local oscillator or a test tone.",
  inputs: [],
  outputs: [{ name: "out" }],
  shape: { kind: "circle", symbol: "~" },
  params: {
    frequency: number({ label: "Frequency", unit: "Hz", default: 1000, min: 1, max: 1_000_000, scale: "log" }),
    amplitude: number({ label: "Amplitude", default: 1, min: 0, max: 10, step: 0.01 }),
    phase: number({ label: "Phase", unit: "deg", default: 0, min: -180, max: 180, step: 1 }),
    rate: rate(),
  },
  summary: (p) => si(p.frequency, "Hz"),
  rates: (_, p) => [p.rate],
  create(p, context) {
    const step = (2 * Math.PI * p.frequency) / context.outputRates[0];
    const start = (p.phase * Math.PI) / 180;
    let n = 0;
    return {
      process(_, [out]) {
        for (let i = 0; i < out.length; i++, n++) out[i] = p.amplitude * Math.cos(step * n + start);
      },
    };
  },
});

export const voice = defineBlock({
  kind: "voice",
  label: "Voice",
  category: "Sources",
  description: "A sung vowel, two syllables every 1.2 s. Its most negative peak is -1, so a modulation index of 1 just reaches zero in AM.",
  inputs: [],
  outputs: [{ name: "out" }],
  params: {
    vowel: choice({
      label: "Vowel",
      default: "ah",
      options: [
        { value: "ah", label: "ah" },
        { value: "ee", label: "ee" },
        { value: "oo", label: "oo" },
      ],
    }),
    pitch: number({ label: "Pitch", unit: "Hz", default: 120, min: 60, max: 400, step: 1, scale: "log" }),
    bandwidth: number({ label: "Bandwidth", unit: "Hz", default: 4500, min: 500, max: 20000, scale: "log", help: "Harmonics above this are left out." }),
    rate: rate(),
  },
  summary: (p) => `"${p.vowel}" ${si(p.pitch, "Hz")}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    const take = synthesizeVowel(p.vowel, p.pitch, p.bandwidth, context.outputRates[0]);
    let n = 0;
    return {
      process(_, [out]) {
        for (let i = 0; i < out.length; i++, n++) out[i] = take[n % take.length];
      },
    };
  },
});

export const noise = defineBlock({
  kind: "noise",
  label: "Noise",
  category: "Sources",
  description:
    "White Gaussian noise. Its level is the noise power inside a reference bandwidth, the way receivers quote SNR, so a setting means the same thing at any sample rate.",
  inputs: [],
  outputs: [{ name: "out" }],
  params: {
    level: number({ label: "Power", unit: "dB", default: -30, min: -120, max: 20, step: 0.5, help: "In the bandwidth below, relative to 1 (a sine of amplitude 1 has power 0.5, or -3 dB)." }),
    bandwidth: number({ label: "Measured in", unit: "Hz", default: 2500, min: 1, max: 1_000_000, scale: "log" }),
    seed: number({ label: "Seed", default: 1, min: 1, max: 999, step: 1 }),
    rate: rate(),
  },
  summary: (p) => `${decibels(p.level)} in ${si(p.bandwidth, "Hz")}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    // Power P in bandwidth B is a density of P / B per Hz, and white noise of variance
    // sigma^2 spreads that density over 0 to rate / 2.
    const sigma = Math.sqrt((10 ** (p.level / 10) * (context.outputRates[0] / 2)) / p.bandwidth);
    const normal = gaussian(mulberry32(context.seed ^ Math.imul(p.seed, 0x9e3779b1)));
    return {
      process(_, [out]) {
        for (let i = 0; i < out.length; i++) out[i] = sigma * normal();
      },
    };
  },
});

export const constant = defineBlock({
  kind: "constant",
  label: "DC",
  category: "Sources",
  description: "A constant level. Added to a message, it is the carrier term in 1 + μm(t).",
  inputs: [],
  outputs: [{ name: "out" }],
  params: {
    value: number({ label: "Value", default: 1, min: -10, max: 10, step: 0.01 }),
    rate: rate(),
  },
  summary: (p) => significant(p.value),
  rates: (_, p) => [p.rate],
  create(p) {
    return {
      process(_, [out]) {
        out.fill(p.value);
      },
    };
  },
});

export const sweep = defineBlock({
  kind: "sweep",
  label: "Sweep",
  category: "Sources",
  description: "A tone gliding from one frequency to another over the whole window. Feed it to a filter and look at the spectrum to see the filter's shape.",
  inputs: [],
  outputs: [{ name: "out" }],
  params: {
    from: number({ label: "From", unit: "Hz", default: 20, min: 1, max: 1_000_000, scale: "log" }),
    to: number({ label: "To", unit: "Hz", default: 20000, min: 1, max: 1_000_000, scale: "log" }),
    spacing: choice({
      label: "Spacing",
      default: "log",
      options: [
        { value: "log", label: "log" },
        { value: "linear", label: "linear" },
      ],
    }),
    amplitude: number({ label: "Amplitude", default: 1, min: 0, max: 10, step: 0.01 }),
    rate: rate(),
  },
  summary: (p) => `${si(p.from, "Hz")} to ${si(p.to, "Hz")}`,
  rates: (_, p) => [p.rate],
  create(p, context) {
    const rate = context.outputRates[0];
    const span = context.duration;
    const ratio = p.to / p.from;
    // Phase is the integral of the instantaneous frequency.
    const phaseAt =
      p.spacing === "linear" || Math.abs(ratio - 1) < 1e-9
        ? (t: number) => 2 * Math.PI * (p.from * t + ((p.to - p.from) * t * t) / (2 * span))
        : (t: number) => ((2 * Math.PI * p.from * span) / Math.log(ratio)) * (ratio ** (t / span) - 1);
    let n = 0;
    return {
      process(_, [out]) {
        for (let i = 0; i < out.length; i++, n++) out[i] = p.amplitude * Math.cos(phaseAt(n / rate));
      },
    };
  },
});
