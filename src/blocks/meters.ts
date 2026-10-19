// Measurement blocks with no signal outputs. Results are reported as readings
// for the diagram, inspector, and panel.

import { bestLag, fitReference } from '../dsp/correlate.ts';
import { defineBlock, type Reading } from '../engine/block.ts';
import { si, toDecibels } from '../engine/format.ts';
import { number } from '../engine/params.ts';

/** How much of the latest signal a meter measures. */
const recent = number({
  label: 'Over the last',
  unit: 's',
  default: 1,
  min: 0.01,
  max: 60,
  scale: 'log',
});

/** Sums over one chunk, for a meter's sliding window. */
type Part = {
  readonly count: number;
  readonly sum: number;
  readonly squares: number;
  readonly peak: number;
};

export const meter = defineBlock({
  kind: 'meter',
  label: 'Meter',
  category: 'Meters',
  description: String.raw`Measures the latest stretch of a signal: its power $\overline{x^2}$ in dB, RMS, peak and mean (the DC level).`,
  inputs: [{ name: 'in' }],
  outputs: [],
  params: { window: recent },
  reports: ['Power', 'RMS', 'Peak', 'Mean'],
  summary: (p) => `last ${si(p.window, 's')}`,
  create(p, context) {
    const wanted = Math.max(1, Math.round(p.window * context.inputRates[0]));
    const parts: Part[] = [];
    let count = 0;
    return {
      // It has no outputs, so it is never in a loop and gets whole chunks.
      process([x], _, start, end) {
        let sum = 0;
        let squares = 0;
        let peak = 0;
        for (let i = start; i < end; i++) {
          sum += x[i];
          squares += x[i] * x[i];
          peak = Math.max(peak, Math.abs(x[i]));
        }

        parts.push({ count: end - start, sum, squares, peak });
        count += end - start;

        while (parts.length > 1 && count - parts[0].count >= wanted) {
          count -= parts.shift()!.count;
        }
      },
      readings(): Reading[] {
        if (!count) {
          return [];
        }

        let sum = 0;
        let squares = 0;
        let peak = 0;
        for (const part of parts) {
          sum += part.sum;
          squares += part.squares;
          peak = Math.max(peak, part.peak);
        }

        const power = squares / count;
        return [
          { label: 'Power', value: toDecibels(power, -200), unit: 'dB' },
          { label: 'RMS', value: Math.sqrt(power) },
          { label: 'Peak', value: peak },
          { label: 'Mean', value: sum / count },
        ];
      },
    };
  },
});

export const snrMeter = defineBlock({
  kind: 'snr-meter',
  label: 'SNR meter',
  category: 'Meters',
  description: String.raw`Compares a received signal with a clean reference, a stretch at a time. It finds the delay between them, fits the reference's gain, and reports how much of the received power the reference explains against what is left: $\mathrm{SNR} = 10 \log_{10} \frac{P_\text{signal}}{P_\text{error}}$.`,
  inputs: [{ name: 'received' }, { name: 'reference', side: 'bottom' }],
  outputs: [],
  reports: ['SNR', 'Delay', 'Gain'],
  params: {
    window: {
      ...recent,
      help: 'It measures again each time this much more has arrived.',
    },
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
    const maxLag = Math.round(p.maxDelay * rate);
    // A window of each, plus room for the delay either way.
    const length = Math.max(1, Math.round(p.window * rate)) + 2 * maxLag;
    const received = new Float32Array(length);
    const reference = new Float32Array(length);
    let filled = 0;
    let readings: Reading[] = [];
    return {
      process([x, r], _, start, end) {
        for (let i = start; i < end; i++) {
          received[filled] = x[i];
          reference[filled] = r[i];
          filled++;

          if (filled === length) {
            const lag = bestLag(received, reference, maxLag, maxLag);
            const fit = fitReference(received, reference, maxLag, lag);
            readings = [
              {
                label: 'SNR',
                value: toDecibels(
                  fit.signal / Math.max(fit.error, 1e-30),
                  -200,
                ),
                unit: 'dB',
              },
              { label: 'Delay', value: lag / rate, unit: 's' },
              { label: 'Gain', value: fit.gain, unit: 'x' },
            ];
            // Keep the end, so the next stretch can reach back across the delay.
            received.copyWithin(0, length - 2 * maxLag);
            reference.copyWithin(0, length - 2 * maxLag);
            filled = 2 * maxLag;
          }
        }
      },
      readings: () => readings,
    };
  },
});
