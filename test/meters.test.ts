import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SimulationResult } from '../src/engine/simulator.ts';
import { circuit, run } from './helpers.ts';

const reading = (result: SimulationResult, block: string, label: string) => {
  const value = result.readings
    .get(block)
    ?.find((r) => r.label === label)?.value;
  assert.equal(typeof value, 'number', `${block} ${label}`);
  return value as number;
};

describe('meters', () => {
  test('a meter reads a unit sine as -3 dB, RMS 0.707, peak 1', () => {
    const result = run(
      circuit(
        1,
        [
          ['tone', 'oscillator', { frequency: 1000, rate: 48000 }],
          ['meter', 'meter', { window: 1 }],
        ],
        [['tone', 'meter']],
      ),
    );
    assert.ok(Math.abs(reading(result, 'meter', 'Power') + 3.0103) < 0.01);
    assert.ok(Math.abs(reading(result, 'meter', 'RMS') - Math.SQRT1_2) < 1e-3);
    assert.ok(Math.abs(reading(result, 'meter', 'Peak') - 1) < 1e-6);
  });

  test('an SNR meter finds the delay and measures the noise added', () => {
    // A sweep (a tone that doesn't repeat within a window, so its delay is
    // unambiguous) of power 0.5, plus noise of 0.01 power over the whole band:
    // 17 dB.
    const result = run(
      circuit(
        4,
        [
          ['tone', 'sweep', { from: 200, to: 3000, period: 4, rate: 12000 }],
          ['late', 'delay', { time: 0.005 }],
          ['noise', 'noise', { level: -20, bandwidth: 6000, rate: 12000 }],
          ['sum', 'adder'],
          ['snr', 'snr-meter', { window: 1, maxDelay: 0.02 }],
        ],
        [
          ['tone', 'late'],
          ['late', 'sum:0'],
          ['noise', 'sum:1'],
          ['sum', 'snr:0'],
          ['tone', 'snr:1'],
        ],
      ),
    );
    assert.ok(Math.abs(reading(result, 'snr', 'SNR') - 16.99) < 0.2);
    assert.ok(Math.abs(reading(result, 'snr', 'Delay') - 0.005) < 1e-9);
  });

  test('a delay of a fraction of a sample does not cap the SNR', () => {
    // Up by 3 and down by 3: clean, but shifted by a non-integer number of samples.
    const result = run(
      circuit(
        1.5,
        [
          ['tone', 'oscillator', { frequency: 1500, rate: 12000 }],
          ['up', 'resample', { direction: 'up', factor: 3 }],
          ['down', 'resample', { direction: 'down', factor: 3 }],
          ['snr', 'snr-meter', { window: 0.5 }],
        ],
        [
          ['tone', 'up'],
          ['up', 'down'],
          ['down', 'snr:0'],
          ['tone', 'snr:1'],
        ],
      ),
    );
    assert.ok(
      reading(result, 'snr', 'SNR') > 40,
      `${reading(result, 'snr', 'SNR')}`,
    );
  });
});
