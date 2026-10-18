import { defineBlock } from "../engine/block.ts";
import { si } from "../engine/format.ts";
import { choice, number } from "../engine/params.ts";
import { bandpassSection, Biquads, butterworth } from "../dsp/biquad.ts";

const order = choice({
  label: "Order",
  default: "4",
  help: String.raw`Order 1 is a single RC stage. Higher orders are Butterworth and fall $6n$ dB per octave for order $n$.`,
  options: [
    { value: "1", label: "1" },
    { value: "2", label: "2" },
    { value: "4", label: "4" },
    { value: "6", label: "6" },
    { value: "8", label: "8" },
  ],
});

export const lowpass = defineBlock({
  kind: "lowpass",
  label: "Low-pass",
  category: "Filters",
  description: String.raw`Passes frequencies below the cutoff $f_c$, where the gain is down 3 dB, to $1/\sqrt{2}$.`,
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    cutoff: number({ label: "Cutoff", unit: "Hz", default: 4500, min: 1, max: 1_000_000, scale: "log" }),
    order,
  },
  summary: (p) => `< ${si(p.cutoff, "Hz")}`,
  create(p, context) {
    const filter = new Biquads(butterworth("lowpass", Number(p.order), p.cutoff, context.outputRates[0]));
    return { process: ([x], [y], start, end) => filter.process(x, y, start, end) };
  },
});

export const highpass = defineBlock({
  kind: "highpass",
  label: "High-pass",
  category: "Filters",
  description: "Passes frequencies above the cutoff. A low cutoff makes a DC block, removing the steady level a detector leaves behind.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    cutoff: number({ label: "Cutoff", unit: "Hz", default: 50, min: 1, max: 1_000_000, scale: "log" }),
    order: { ...order, default: "2" },
  },
  summary: (p) => `> ${si(p.cutoff, "Hz")}`,
  create(p, context) {
    const filter = new Biquads(butterworth("highpass", Number(p.order), p.cutoff, context.outputRates[0]));
    return { process: ([x], [y], start, end) => filter.process(x, y, start, end) };
  },
});

export const bandpass = defineBlock({
  kind: "bandpass",
  label: "Band-pass",
  category: "Filters",
  description: String.raw`Tuned circuits. One section is a single LC resonator, tuned to $f_0 = 1 / (2\pi\sqrt{LC})$; more sections in cascade give steeper skirts for the same $-3$ dB bandwidth, like an IF strip.`,
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    center: number({ label: "Center", unit: "Hz", default: 100_000, min: 1, max: 1_000_000, scale: "log" }),
    bandwidth: number({ label: "Bandwidth", unit: "Hz", default: 10_000, min: 1, max: 1_000_000, scale: "log" }),
    sections: number({ label: "Sections", default: 1, min: 1, max: 6, step: 1 }),
  },
  summary: (p) => `${si(p.center, "Hz")} ±${si(p.bandwidth / 2, "Hz")}`,
  create(p, context) {
    // n identical resonators narrow the -3 dB width by sqrt(2^(1/n) - 1); widen each to match.
    const each = p.bandwidth / Math.sqrt(2 ** (1 / p.sections) - 1);
    const section = bandpassSection(p.center, each, context.outputRates[0]);
    const filter = new Biquads(Array.from({ length: p.sections }, () => section));
    return { process: ([x], [y], start, end) => filter.process(x, y, start, end) };
  },
});
