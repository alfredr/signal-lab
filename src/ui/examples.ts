// Starter diagrams. Each is laid out by hand on the 8-unit grid; see geometry.ts for block sizes
// (boxes are 144 x 56, circles 48 x 48, triangles 64 x 56).

import type { PortRef } from "../engine/circuit.ts";
import type { StoredParams } from "../engine/params.ts";
import { FORMAT, type LabDocument, type ProbeView } from "./doc.ts";

interface Part {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly name?: string;
  readonly params?: StoredParams;
}

/** A wire as ["block:port", "block:port"]; the port defaults to 0. */
type Link = readonly [from: string, to: string];

function ref(text: string): PortRef {
  const [block, port] = text.split(":");
  return { block: block!, port: Number(port ?? 0) };
}

function example(
  title: string,
  notes: string,
  duration: number,
  parts: Readonly<Record<string, Part>>,
  links: readonly Link[],
  probes: readonly (readonly [at: string, view: ProbeView])[],
): LabDocument {
  return {
    format: FORMAT,
    title,
    notes,
    duration,
    blocks: Object.entries(parts).map(([id, { name, params = {}, ...part }]) => ({ id, ...part, params, ...(name ? { name } : {}) })),
    wires: links.map(([from, to], i) => ({ id: `w${i + 1}`, from: ref(from), to: ref(to) })),
    probes: probes.map(([at, view], i) => ({ id: `p${i + 1}`, at: ref(at), view })),
  };
}

const RF = 384_000;

const am = (): LabDocument =>
  example(
    "AM with an envelope detector",
    `The voice, raised by a constant so it never goes negative, sets the amplitude of a 100 kHz carrier. The receiver's tuned circuit picks the station out of the noise, the envelope detector follows its peaks, and two filters clean up what is left.

The audio runs at 48 kHz and only the radio stages at 384 kHz; the Resample blocks move between the two.

Try pushing μ past 1 to hear overmodulation, or changing the detector's RC. Raise the antenna noise toward the carrier's -3 dB and listen to the detector give up. Zoom into the channel's spectrum to find the carrier and its two sidebands.`,
    1.2,
    {
      voice: { kind: "voice", x: 0, y: 80, params: { vowel: "ah", pitch: 120, bandwidth: 4500, rate: 48000 } },
      mu: { kind: "gain", x: 184, y: 80, name: "μ", params: { gain: 0.8 } },
      dc: { kind: "offset", x: 296, y: 80, params: { value: 1 } },
      up: { kind: "resample", x: 480, y: 80, params: { direction: "up", factor: 8 } },
      modulator: { kind: "mixer", x: 664, y: 84, name: "Modulator" },
      carrier: { kind: "oscillator", x: 592, y: 176, name: "Carrier", params: { frequency: 100_000, rate: RF } },
      channel: { kind: "adder", x: 760, y: 84, name: "Channel" },
      noise: { kind: "noise", x: 592, y: -40, name: "Antenna noise", params: { level: -30, bandwidth: 9000, rate: RF } },
      tuned: { kind: "bandpass", x: 96, y: 320, name: "Tuned circuit", params: { center: 100_000, bandwidth: 13_500, sections: 1 } },
      detector: { kind: "envelope", x: 280, y: 320, params: { rc: 20e-6 } },
      audio: { kind: "lowpass", x: 464, y: 320, name: "Audio filter", params: { cutoff: 4500, order: "4" } },
      down: { kind: "resample", x: 648, y: 320, params: { direction: "down", factor: 8 } },
      dcBlock: { kind: "highpass", x: 832, y: 320, name: "DC block", params: { cutoff: 50, order: "2" } },
    },
    [
      ["voice", "mu"],
      ["mu", "dc"],
      ["dc", "up"],
      ["up", "modulator:0"],
      ["carrier", "modulator:1"],
      ["modulator", "channel:0"],
      ["noise", "channel:2"],
      ["channel", "tuned"],
      ["tuned", "detector"],
      ["detector", "audio"],
      ["audio", "down"],
      ["down", "dcBlock"],
    ],
    [
      ["voice", "time"],
      ["channel", "spectrum"],
      ["dcBlock", "time"],
    ],
  );

const dsb = (): LabDocument =>
  example(
    "DSB-SC and the product detector",
    `Drop the carrier and send only the sidebands. The receiver has to supply its own carrier: it multiplies by a local oscillator and low-pass filters the product.

The output scales with the cosine of the phase difference between the two oscillators. Turn the receiver LO's phase to 90° and the voice vanishes; past 90° it returns upside down. Detune the LO by a few hertz and the voice beats in and out.`,
    1.2,
    {
      voice: { kind: "voice", x: 0, y: 80, params: { rate: 48000 } },
      up: { kind: "resample", x: 184, y: 80, params: { direction: "up", factor: 8 } },
      modulator: { kind: "mixer", x: 368, y: 84, name: "Modulator" },
      carrier: { kind: "oscillator", x: 296, y: 176, name: "Carrier", params: { frequency: 100_000, rate: RF } },
      channel: { kind: "adder", x: 464, y: 84, name: "Channel" },
      noise: { kind: "noise", x: 296, y: -40, name: "Antenna noise", params: { level: -40, bandwidth: 9000, rate: RF } },
      detector: { kind: "mixer", x: 576, y: 84, name: "Detector" },
      lo: { kind: "oscillator", x: 504, y: 176, name: "Receiver LO", params: { frequency: 100_000, phase: 0, rate: RF } },
      audio: { kind: "lowpass", x: 672, y: 80, name: "Audio filter", params: { cutoff: 4500, order: "4" } },
      down: { kind: "resample", x: 856, y: 80, params: { direction: "down", factor: 8 } },
    },
    [
      ["voice", "up"],
      ["up", "modulator:0"],
      ["carrier", "modulator:1"],
      ["modulator", "channel:0"],
      ["noise", "channel:2"],
      ["channel", "detector:0"],
      ["lo", "detector:1"],
      ["detector", "audio"],
      ["audio", "down"],
    ],
    [
      ["voice", "time"],
      ["modulator", "spectrum"],
      ["down", "time"],
    ],
  );

const ssb = (): LabDocument =>
  example(
    "SSB by the phasing method",
    `The phase splitter makes two copies of the voice 90° apart. Each multiplies a carrier, and the carriers are 90° apart too, so when the products are combined one sideband cancels. Subtracting keeps the upper sideband; switch the adder's bottom input to add for the lower.

In the receiver, move the BFO 50 Hz off 100 kHz. Every component shifts by the same 50 Hz, which breaks the voice's harmonic ratios: it sounds wrong in a way a pitch change never does.

The splitter holds 90° only above a few hundred hertz, so the voice's lowest harmonics leak into the unwanted sideband. Zoom into the spectrum just below 100 kHz to see it.`,
    1.2,
    {
      voice: { kind: "voice", x: 0, y: 80, params: { rate: 48000 } },
      split: { kind: "hilbert", x: 184, y: 76, params: { taps: "511" } },
      upI: { kind: "resample", x: 400, y: 68, params: { direction: "up", factor: 8 } },
      upQ: { kind: "resample", x: 400, y: 220, params: { direction: "up", factor: 8 } },
      mixI: { kind: "mixer", x: 584, y: 72 },
      mixQ: { kind: "mixer", x: 584, y: 224 },
      cos: { kind: "oscillator", x: 528, y: 128, name: "cos", params: { frequency: 100_000, rate: RF } },
      sin: { kind: "oscillator", x: 528, y: 296, name: "sin", params: { frequency: 100_000, phase: -90, rate: RF } },
      sideband: { kind: "adder", x: 680, y: 72, name: "SSB", params: { b: "-" } },
      channel: { kind: "adder", x: 776, y: 72, name: "Channel" },
      noise: { kind: "noise", x: 640, y: -56, name: "Antenna noise", params: { level: -40, bandwidth: 2500, rate: RF } },
      detector: { kind: "mixer", x: 896, y: 72, name: "Detector" },
      bfo: { kind: "oscillator", x: 832, y: 144, name: "BFO", params: { frequency: 100_000, rate: RF } },
      audio: { kind: "lowpass", x: 992, y: 68, name: "Audio filter", params: { cutoff: 4500, order: "4" } },
      down: { kind: "resample", x: 1176, y: 68, params: { direction: "down", factor: 8 } },
    },
    [
      ["voice", "split"],
      ["split:0", "upI"],
      ["split:1", "upQ"],
      ["upI", "mixI:0"],
      ["cos", "mixI:1"],
      ["upQ", "mixQ:0"],
      ["sin", "mixQ:1"],
      ["mixI", "sideband:0"],
      ["mixQ", "sideband:1"],
      ["sideband", "channel:0"],
      ["noise", "channel:2"],
      ["channel", "detector:0"],
      ["bfo", "detector:1"],
      ["detector", "audio"],
      ["audio", "down"],
    ],
    [
      ["sideband", "spectrum"],
      ["down", "time"],
    ],
  );

const echo = (): LabDocument =>
  example(
    "Echo: a feedback loop",
    `The adder's output, delayed and turned down, comes back into it. The Delay is what makes the loop computable: inside a loop the simulator steps every block together, one delay's worth of samples at a time, so each block only ever reads values that already exist.

Raise the feedback above 1 and the echoes grow instead of dying away. Shorten the delay to a few milliseconds and the echoes merge into a comb filter; look at the spectrum.`,
    3,
    {
      voice: { kind: "voice", x: 0, y: 80, params: { vowel: "oo", pitch: 180, rate: 48000 } },
      sum: { kind: "adder", x: 184, y: 84, name: "Sum" },
      delay: { kind: "delay", x: 280, y: 80, params: { time: 0.3 } },
      feedback: { kind: "gain", x: 464, y: 80, name: "Feedback", params: { gain: 0.5 } },
    },
    [
      ["voice", "sum:0"],
      ["sum", "delay"],
      ["delay", "feedback"],
      ["feedback", "sum:1"],
    ],
    [["sum", "time"]],
  );

const sweep = (): LabDocument =>
  example(
    "Filter shapes from a sweep",
    `The sweep glides from 20 Hz to 20 kHz over the window, so time stands in for frequency: the outline of each filter's output traces its frequency response on a log scale.

Change the low-pass order and watch the skirt steepen. Add band-pass sections and the top flattens while the sides fall away faster.`,
    4,
    {
      sweep: { kind: "sweep", x: 0, y: 80, params: { from: 20, to: 20000, spacing: "log", rate: 48000 } },
      lowpass: { kind: "lowpass", x: 184, y: 80, params: { cutoff: 1000, order: "4" } },
      bandpass: { kind: "bandpass", x: 184, y: 176, params: { center: 3000, bandwidth: 500, sections: 2 } },
    },
    [
      ["sweep", "lowpass"],
      ["sweep", "bandpass"],
    ],
    [
      ["lowpass", "time"],
      ["bandpass", "time"],
    ],
  );

export const examples: readonly { readonly title: string; readonly build: () => LabDocument }[] = [
  { title: "AM with an envelope detector", build: am },
  { title: "DSB-SC and the product detector", build: dsb },
  { title: "SSB by the phasing method", build: ssb },
  { title: "Echo: a feedback loop", build: echo },
  { title: "Filter shapes from a sweep", build: sweep },
];
