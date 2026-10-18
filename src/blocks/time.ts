import { defineBlock, RateError, type DelayProcessor } from "../engine/block.ts";
import { si } from "../engine/format.ts";
import { choice, number } from "../engine/params.ts";
import { Fir, hilbertTaps, SampleDelay } from "../dsp/fir.ts";
import { downsample, upsample } from "../dsp/resample.ts";

export const delay = defineBlock({
  kind: "delay",
  label: "Delay",
  category: "Time and rate",
  description: "Holds the signal back by a fixed time (at least one sample). Every feedback loop needs one: it is what makes the loop's next output depend only on the past.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    time: number({ label: "Delay", unit: "s", default: 0.25, min: 0, max: 5, scale: "linear", step: 0.0001 }),
  },
  summary: (p) => si(p.time, "s"),
  create(p, context): DelayProcessor {
    const latency = Math.max(1, Math.round(p.time * context.outputRates[0]));
    // ring[k] holds the output due at the next time t with t % latency === k.
    const ring = new Float32Array(latency);
    let position = 0;
    return {
      latency,
      pull([out]) {
        for (let i = 0; i < out.length; i++) out[i] = ring[(position + i) % latency];
      },
      push([input]) {
        for (let i = 0; i < input.length; i++) ring[(position + i) % latency] = input[i];
        position = (position + input.length) % latency;
      },
      process([input], [out]) {
        for (let i = 0; i < out.length; i++) {
          out[i] = ring[position];
          ring[position] = input[i];
          position = (position + 1) % latency;
        }
      },
    };
  },
});

export const hilbert = defineBlock({
  kind: "hilbert",
  label: "Phase splitter",
  category: "Time and rate",
  description:
    "Splits a signal into two copies 90° apart at every frequency (a Hilbert transformer). I is the input delayed to match; Q lags it by 90°. Feeding I and Q to two mixers builds the phasing SSB transmitter.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "I" }, { name: "Q" }],
  params: {
    taps: choice({
      label: "Length",
      default: "255",
      help: "Longer filters hold 90° down to lower frequencies, at the cost of more delay.",
      options: [
        { value: "63", label: "63" },
        { value: "127", label: "127" },
        { value: "255", label: "255" },
        { value: "511", label: "511" },
        { value: "1023", label: "1023" },
      ],
    }),
  },
  summary: () => "90°",
  create(p) {
    const length = Number(p.taps);
    const quadrature = new Fir(hilbertTaps(length));
    const inPhase = new SampleDelay((length - 1) / 2);
    return {
      process([x], [i, q]) {
        inPhase.process(x, i);
        quadrature.process(x, q);
      },
    };
  },
});

export const resample = defineBlock({
  kind: "resample",
  label: "Resample",
  category: "Time and rate",
  description:
    "Changes the sample rate by a whole-number factor, filtering to prevent aliasing or imaging. Run audio at an audio rate and only the RF stages at a high one.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    direction: choice({
      label: "Direction",
      default: "up",
      options: [
        { value: "up", label: "up" },
        { value: "down", label: "down" },
      ],
    }),
    factor: number({ label: "Factor", unit: "x", default: 8, min: 2, max: 32, step: 1 }),
  },
  summary: (p) => (p.direction === "up" ? `↑ ×${p.factor}` : `↓ ÷${p.factor}`),
  rates([rate], p) {
    if (rate === undefined) throw new RateError("Resample has no input.");
    return [p.direction === "up" ? rate * p.factor : rate / p.factor];
  },
  create(p) {
    return {
      process([x], [y]) {
        if (p.direction === "up") upsample(x, p.factor, y);
        else downsample(x, p.factor, y);
      },
    };
  },
});
