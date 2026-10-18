import { defineBlock } from "../engine/block.ts";
import { si, significant } from "../engine/format.ts";
import { choice, number } from "../engine/params.ts";

export const rectifier = defineBlock({
  kind: "rectifier",
  label: "Rectifier",
  category: "Nonlinear",
  description: "A diode. Half-wave passes only the part above the forward drop; full-wave flips the negative half up as well. Being nonlinear, it creates new frequencies.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    mode: choice({
      label: "Mode",
      default: "half",
      options: [
        { value: "half", label: "half-wave" },
        { value: "full", label: "full-wave" },
      ],
    }),
    drop: number({ label: "Forward drop", unit: "V", default: 0, min: 0, max: 1, step: 0.01 }),
  },
  summary: (p) => (p.drop > 0 ? `${p.mode}, ${si(p.drop, "V")}` : `${p.mode}-wave`),
  create(p) {
    const full = p.mode === "full";
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = Math.max(0, (full ? Math.abs(x[i]) : x[i]) - p.drop);
      },
    };
  },
});

export const square = defineBlock({
  kind: "square",
  label: "Square law",
  category: "Nonlinear",
  description: "Squares the signal. The product of a signal with itself contains every difference frequency, so a square-law device can detect AM.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {},
  summary: () => "x²",
  create() {
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = x[i] * x[i];
      },
    };
  },
});

export const clipper = defineBlock({
  kind: "clipper",
  label: "Clipper",
  category: "Nonlinear",
  description: "Limits the signal to ± a level, either sharply or with a soft tanh curve. Clipping spreads energy into new frequencies, heard as distortion.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    mode: choice({
      label: "Curve",
      default: "soft",
      options: [
        { value: "soft", label: "soft" },
        { value: "hard", label: "hard" },
      ],
    }),
    level: number({ label: "Level", default: 1, min: 0.01, max: 10, step: 0.01 }),
  },
  summary: (p) => `${p.mode}, ±${significant(p.level)}`,
  create(p) {
    const { level } = p;
    const curve = p.mode === "soft" ? (v: number) => level * Math.tanh(v / level) : (v: number) => Math.max(-level, Math.min(level, v));
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) y[i] = curve(x[i]);
      },
    };
  },
});
