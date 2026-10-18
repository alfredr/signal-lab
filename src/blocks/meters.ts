// Blocks that measure rather than produce signals. They have no outputs; what
// they find comes back as readings, shown on the block, in the inspector and on
// the panel.

import { bestLag, fitReference } from '../dsp/correlate.ts';
import { defineBlock, type Reading } from '../engine/block.ts';
import { si, toDecibels } from '../engine/format.ts';
import { number } from '../engine/params.ts';

/** Where measuring starts, so filters can settle first. */
const from = number({
  label: 'Measure from',
  unit: 's',
  default: 0.05,
  min: 0,
  max: 30,
  step: 0.001,
  help: 'Skips the start, while filters settle.',
});

export const meter = defineBlock({
  kind: 'meter',
  label: 'Meter',
  category: 'Meters',
  description: String.raw`Measures a signal: its power $\overline{x^2}$ in dB, RMS, peak and mean (the DC level).`,
  inputs: [{ name: 'in' }],
  outputs: [],
  params: { from },
  summary: (p) => `from ${si(p.from, 's')}`,
  create(p, context) {
    const first = Math.round(p.from * context.inputRates[0]);
    let sum = 0;
    let squares = 0;
    let peak = 0;
    let count = 0;
    return {
      process([x], _, start, end) {
        for (let i = Math.max(start, first); i < end; i++) {
          sum += x[i];
          squares += x[i] * x[i];
          peak = Math.max(peak, Math.abs(x[i]));
          count++;
        }
      },
      readings(): Reading[] {
        const power = count ? squares / count : 0;
        return [
          { label: 'Power', value: toDecibels(power, -200), unit: 'dB' },
          { label: 'RMS', value: Math.sqrt(power) },
          { label: 'Peak', value: peak },
          { label: 'Mean', value: count ? sum / count : 0 },
        ];
      },
    };
  },
});

export const snrMeter = defineBlock({
  kind: 'snr-meter',
  label: 'SNR meter',
  category: 'Meters',
  description: String.raw`Compares a received signal with a clean reference. It finds the delay between them, fits the reference's gain, and reports how much of the received power the reference explains against what is left: $\mathrm{SNR} = 10 \log_{10} \frac{P_\text{signal}}{P_\text{error}}$.`,
  inputs: [{ name: 'received' }, { name: 'reference', side: 'bottom' }],
  outputs: [],
  params: {
    from,
    maxDelay: number({
      label: 'Longest delay',
      unit: 's',
      default: 0.01,
      min: 0,
      max: 1,
      step: 0.0001,
      help: 'How far apart the two may be in time, either way.',
    }),
  },
  summary: (p) => `delay ≤ ${si(p.maxDelay, 's')}`,
  create(p, context) {
    const rate = context.inputRates[0];
    let received: Float32Array | undefined;
    let reference: Float32Array | undefined;
    return {
      // Never in a loop (it has no outputs), so this sees the whole window.
      process([x, r]) {
        received = x;
        reference = r;
      },
      readings(): Reading[] {
        if (!received || !reference) {
          return [];
        }

        const first = Math.round(p.from * rate);
        const lag = bestLag(
          received,
          reference,
          first,
          Math.round(p.maxDelay * rate),
        );
        const fit = fitReference(received, reference, first, lag);
        return [
          {
            label: 'SNR',
            value: toDecibels(fit.signal / Math.max(fit.error, 1e-30), -200),
            unit: 'dB',
          },
          { label: 'Delay', value: lag / rate, unit: 's' },
          { label: 'Gain', value: fit.gain, unit: 'x' },
        ];
      },
    };
  },
});
