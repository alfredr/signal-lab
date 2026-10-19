import { defineBlock } from '../engine/block.ts';
import { si } from '../engine/format.ts';
import { number } from '../engine/params.ts';

export const capacitor = defineBlock({
  kind: 'capacitor',
  label: 'Capacitor',
  category: 'Detectors',
  description: String.raw`A capacitor discharging through a resistor: it holds the voltage it is given, which then decays as $e^{-t/RC}$. It answers one sample later, so it can close a feedback loop; fed back to a diode's cathode it makes a peak detector.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    rc: number({
      label: 'RC',
      unit: 's',
      default: 20e-6,
      min: 1e-7,
      max: 0.1,
      scale: 'log',
      help: 'Discharge time constant.',
    }),
  },
  summary: (p) => `RC ${si(p.rc, 's')}`,
  create(p, context) {
    const rate = context.outputRates[0];
    let decay = Math.exp(-1 / (rate * p.rc));
    // The input just before this chunk.
    let held = 0;
    return {
      latency: 1,
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = decay * (i > 0 ? x[i - 1] : held);
        }
      },
      keep([x]: readonly Float32Array[], length: number) {
        if (length > 0) {
          held = x[length - 1];
        }
      },
      update(next) {
        decay = Math.exp(-1 / (rate * next.rc));
        return true;
      },
    };
  },
});
