import { defineBlock } from "../engine/block.ts";
import { si } from "../engine/format.ts";
import { number } from "../engine/params.ts";

export const envelope = defineBlock({
  kind: "envelope",
  label: "Envelope detector",
  category: "Detectors",
  description:
    "A diode charging a capacitor that discharges through a resistor. The capacitor jumps up to each carrier peak and sags between them. Too short an RC leaves carrier ripple; too long and it can't follow the envelope down.",
  inputs: [{ name: "in" }],
  outputs: [{ name: "out" }],
  params: {
    rc: number({ label: "RC", unit: "s", default: 20e-6, min: 1e-7, max: 0.1, scale: "log", help: "Discharge time constant." }),
  },
  summary: (p) => `RC ${si(p.rc, "s")}`,
  create(p, context) {
    const decay = Math.exp(-1 / (context.outputRates[0] * p.rc));
    let held = 0;
    return {
      process([x], [y]) {
        for (let i = 0; i < y.length; i++) {
          held = Math.max(held * decay, x[i]);
          y[i] = held;
        }
      },
    };
  },
});
