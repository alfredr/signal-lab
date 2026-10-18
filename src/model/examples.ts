// Starter documents. Layout conventions are in build.ts.

import type { StoredParams } from "../engine/params.ts";
import { diagram, ref, type Link, type Part } from "./build.ts";
import { FORMAT, type Diagram, type LabDocument, type ProbeView } from "./document.ts";
import { template } from "./library.ts";

const RF = 384_000;

function document(
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
    ...diagram(parts, links),
    probes: probes.map(([at, view], i) => ({ id: `p${i + 1}`, at: ref(at), view })),
  };
}

const library = (key: string): Diagram => template(key)!.build();

/** An AM broadcast transmitter, ending at its antenna. */
function station(vowel: string, pitch: number, carrier: number): Diagram {
  return diagram(
    {
      voice: { kind: "voice", x: 0, y: 80, params: { vowel, pitch, bandwidth: 4500, rate: 48000 } },
      mu: { kind: "gain", x: 184, y: 80, name: "μ", params: { gain: 0.8 } },
      dc: { kind: "offset", x: 296, y: 80, params: { value: 1 } },
      up: { kind: "resample", x: 480, y: 80, params: { direction: "up", factor: 8 } },
      modulator: { kind: "mixer", x: 664, y: 84, name: "Modulator" },
      carrier: { kind: "oscillator", x: 592, y: 176, name: "Carrier", params: { frequency: carrier, rate: RF } },
      antenna: { kind: "antenna-tx", x: 760, y: 52 },
    },
    [
      ["voice", "mu"],
      ["mu", "dc"],
      ["dc", "up"],
      ["up", "modulator:0"],
      ["carrier", "modulator:1"],
      ["modulator", "antenna"],
    ],
  );
}

type Chain = {
  readonly parts: Readonly<Record<string, Part>>;
  readonly links: readonly Link[];
};

/**
 * An AM receiver with its output port at height `y`: antenna, tuned circuit, envelope
 * detector, audio filter, back down to 48 kHz and a DC block.
 */
function amReceiver(y: number, tuned: StoredParams, noise: number): Chain {
  return {
    parts: {
      receiver: { kind: "antenna-rx", x: 40, y: y - 28, params: { noise, bandwidth: 9000 } },
      tuned: { kind: "bandpass", x: 136, y, name: "Tuned circuit", params: tuned },
      detector: { kind: "subsystem", x: 320, y, name: "Envelope detector", inner: library("envelope-detector") },
      audio: { kind: "lowpass", x: 504, y, name: "Audio filter", params: { cutoff: 4500, order: "4" } },
      down: { kind: "resample", x: 688, y, params: { direction: "down", factor: 8 } },
      dcBlock: { kind: "highpass", x: 872, y, name: "DC block", params: { cutoff: 50, order: "2" } },
    },
    links: [
      ["receiver", "tuned"],
      ["tuned", "detector"],
      ["detector", "audio"],
      ["audio", "down"],
      ["down", "dcBlock"],
    ],
  };
}

/**
 * A receiver that multiplies by its own oscillator `lo` (named `name`) and low-pass filters
 * the product, then returns to 48 kHz: for DSB-SC and SSB.
 */
function productReceiver(y: number, lo: string, name: string, noise: StoredParams): Chain {
  return {
    parts: {
      receiver: { kind: "antenna-rx", x: 40, y: y - 28, params: noise },
      detector: { kind: "mixer", x: 136, y: y + 4, name: "Detector" },
      [lo]: { kind: "oscillator", x: 80, y: y + 80, name, params: { frequency: 100_000, phase: 0, rate: RF } },
      audio: { kind: "lowpass", x: 232, y, name: "Audio filter", params: { cutoff: 4500, order: "4" } },
      down: { kind: "resample", x: 416, y, params: { direction: "down", factor: 8 } },
    },
    links: [
      ["receiver", "detector:0"],
      [lo, "detector:1"],
      ["detector", "audio"],
      ["audio", "down"],
    ],
  };
}

const am = (): LabDocument => {
  const transmitter = station("ah", 120, 100_000);
  const receiver = amReceiver(300, { center: 100_000, bandwidth: 13_500, sections: 1 }, -30);
  return document(
    "AM with an envelope detector",
    String.raw`The voice, raised by a constant so it never goes negative, sets the amplitude of a 100 kHz carrier: $x(t) = [1 + \mu\, m(t)] \cos 2\pi f_c t$. The receive antenna picks it up along with band noise, the tuned circuit selects the station, and the envelope detector follows the carrier's peaks.

The audio runs at 48 kHz and only the radio stages at 384 kHz; the Resample blocks move between the two.

The envelope detector is a subsystem: double-click it to see the diode, and the capacitor feeding back to the diode's cathode. With $RC$ too short the output keeps carrier ripple; too long and it can't follow the envelope down.

Try pushing $\mu$ past 1 to hear overmodulation, or raising the antenna's band noise toward the carrier's $-3$ dB. Zoom into the antenna's spectrum to find the carrier and its two sidebands.`,
    1.2,
    { ...Object.fromEntries(transmitter.blocks.map(({ id, ...part }) => [id, part])), ...receiver.parts },
    [...transmitter.wires.map((w): Link => [`${w.from.block}:${w.from.port}`, `${w.to.block}:${w.to.port}`]), ...receiver.links],
    [
      ["voice", "time"],
      ["receiver", "spectrum"],
      ["dcBlock", "time"],
    ],
  );
};

const twoStations = (): LabDocument => {
  const receiver = amReceiver(268, { center: 90_000, bandwidth: 9000, sections: 3 }, -40);
  return document(
    "Two stations on the air",
    String.raw`Two AM stations share the air: Station A sings "ah" on 90 kHz and Station B "oo" on 110 kHz. Each is a subsystem; open one to see the transmitter inside.

The receiver's tuned circuit decides which station you hear. Move its center to 110 kHz to switch. Widen it, or drop it to one section, and the other station bleeds through: a single tuned circuit's skirts fall off slowly, which is why receivers moved to a fixed, sharp IF filter.`,
    1.2,
    {
      stationA: { kind: "subsystem", x: 0, y: 0, name: "Station A, 90 kHz", inner: station("ah", 120, 90_000) },
      stationB: { kind: "subsystem", x: 0, y: 88, name: "Station B, 110 kHz", inner: station("oo", 180, 110_000) },
      ...receiver.parts,
    },
    receiver.links,
    [
      ["receiver", "spectrum"],
      ["tuned", "spectrum"],
      ["dcBlock", "time"],
    ],
  );
};

const dsb = (): LabDocument => {
  const receiver = productReceiver(300, "lo", "Receiver LO", { noise: -40, bandwidth: 9000 });
  return document(
    "DSB-SC and the product detector",
    String.raw`Drop the carrier and send only the sidebands, $m(t) \cos 2\pi f_c t$. The receiver has to supply its own carrier: it multiplies by a local oscillator and low-pass filters the product.

The output scales with $\cos\varphi$, where $\varphi$ is the phase difference between the two oscillators. Turn the receiver LO's phase to $90^\circ$ and the voice vanishes; past $90^\circ$ it returns upside down. Detune the LO by a few hertz and the voice beats in and out.`,
    1.2,
    {
      voice: { kind: "voice", x: 0, y: 80, params: { rate: 48000 } },
      up: { kind: "resample", x: 184, y: 80, params: { direction: "up", factor: 8 } },
      modulator: { kind: "mixer", x: 368, y: 84, name: "Modulator" },
      carrier: { kind: "oscillator", x: 296, y: 176, name: "Carrier", params: { frequency: 100_000, rate: RF } },
      transmitter: { kind: "antenna-tx", x: 464, y: 52 },
      ...receiver.parts,
    },
    [
      ["voice", "up"],
      ["up", "modulator:0"],
      ["carrier", "modulator:1"],
      ["modulator", "transmitter"],
      ...receiver.links,
    ],
    [
      ["voice", "time"],
      ["modulator", "spectrum"],
      ["down", "time"],
    ],
  );
};

const ssb = (): LabDocument => {
  const receiver = productReceiver(440, "bfo", "BFO", { noise: -40, bandwidth: 2500 });
  return document(
    "SSB by the phasing method",
    String.raw`The phase splitter makes two copies of the voice $90^\circ$ apart. Each multiplies a carrier, and the carriers are $90^\circ$ apart too, so when the products are combined one sideband cancels: $m\cos\omega_c t - \hat m \sin\omega_c t$ keeps only the upper. Switch the SSB adder's bottom input to add for the lower.

In the receiver, move the BFO 50 Hz off 100 kHz. Every component shifts by the same 50 Hz, which breaks the voice's harmonic ratios: it sounds wrong in a way a pitch change never does.

The splitter holds $90^\circ$ only above a few hundred hertz, so the voice's lowest harmonics leak into the unwanted sideband. Zoom into the spectrum just below 100 kHz to see it.`,
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
      transmitter: { kind: "antenna-tx", x: 776, y: 40 },
      ...receiver.parts,
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
      ["sideband", "transmitter"],
      ...receiver.links,
    ],
    [
      ["sideband", "spectrum"],
      ["down", "time"],
    ],
  );
};

const echo = (): LabDocument =>
  document(
    "Echo: a feedback loop",
    String.raw`The sum's output, delayed and turned down, comes back into it: $y[n] = x[n] + g\, y[n - D]$. The Delay is what makes the loop computable. Inside a loop the simulator steps every block together, one delay's worth of samples at a time, so each block only ever reads values that already exist.

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
  document(
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
  { title: "Two stations on the air", build: twoStations },
  { title: "DSB-SC and the product detector", build: dsb },
  { title: "SSB by the phasing method", build: ssb },
  { title: "Echo: a feedback loop", build: echo },
  { title: "Filter shapes from a sweep", build: sweep },
];
