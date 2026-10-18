import { defineBlock } from "../engine/block.ts";
import { MINUS, significant } from "../engine/format.ts";
import { choice, number } from "../engine/params.ts";

export const gain = defineBlock({
  kind: "gain",
  label: "Gain",
  category: "Math",
  description: "Multiplies the signal by a constant. As the modulation index μ it sets how deeply the message swings the carrier.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  shape: { kind: "triangle" },
  params: {
    gain: number({ label: "Gain", unit: "x", default: 1, min: -10, max: 10, step: 0.01 }),
  },
  summary: (p) => `×${significant(p.gain)}`,
  create(p) {
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = p.gain * x[i];
      },
    };
  },
});

export const offset = defineBlock({
  kind: "offset",
  label: "Offset",
  category: "Math",
  description: "Adds a constant: the 1 in 1 + μm(t), which keeps an AM envelope from going negative.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    value: number({ label: "Add", default: 1, min: -10, max: 10, step: 0.01 }),
  },
  summary: (p) => (p.value < 0 ? `${MINUS} ${significant(-p.value)}` : `+ ${significant(p.value)}`),
  create(p) {
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = x[i] + p.value;
      },
    };
  },
});

const signOption = (label: string) =>
  choice({
    label,
    default: "+",
    options: [
      { value: "+", label: "add" },
      { value: "-", label: "subtract" },
    ],
  });

export const adder = defineBlock({
  kind: "adder",
  label: "Adder",
  category: "Math",
  description: "Sums its inputs. Unconnected inputs count as zero; the top and bottom inputs can subtract instead.",
  inputs: [{ name: "a" }, { name: "b", side: "bottom" }, { name: "c", side: "top" }],
  outputs: [{ name: "out" }],
  shape: { kind: "circle", symbol: "+" },
  params: {
    b: signOption("Bottom input"),
    c: signOption("Top input"),
  },
  create(p) {
    const sb = p.b === "-" ? -1 : 1;
    const sc = p.c === "-" ? -1 : 1;
    return {
      process([a, b, c], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = a[i] + sb * b[i] + sc * c[i];
      },
    };
  },
});

export const mixer = defineBlock({
  kind: "mixer",
  label: "Mixer",
  category: "Math",
  description: "Multiplies its two inputs. Multiplying by a cosine shifts a spectrum up and down by that frequency: the move behind modulation, product detection and every superhet.",
  inputs: [{ name: "a" }, { name: "b", side: "bottom" }],
  outputs: [{ name: "out" }],
  shape: { kind: "circle", symbol: "×" },
  params: {},
  create() {
    return {
      process([a, b], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = a[i] * b[i];
      },
    };
  },
});
