import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { blockType } from '../src/blocks/index.ts';
import { welch } from '../src/dsp/spectrum.ts';
import { power } from '../src/engine/signal.ts';
import { simulate } from '../src/engine/simulator.ts';
import { circuit, output, plain, run, stream } from './helpers.ts';

// 409.6 kHz with a 4096-point FFT puts every line below on an exact 100 Hz bin.
const RATE = 409_600;

const amTransmitter = (mu: number) =>
  circuit(
    0.1,
    [
      ['tone', 'oscillator', { frequency: 1000, rate: RATE }],
      ['mu', 'gain', { gain: mu }],
      ['dc', 'offset', { value: 1 }],
      ['carrier', 'oscillator', { frequency: 100_000, rate: RATE }],
      ['modulator', 'mixer'],
    ],
    [
      ['tone:0', 'mu:0'],
      ['mu:0', 'dc:0'],
      ['dc:0', 'modulator:0'],
      ['carrier:0', 'modulator:1'],
    ],
  );

describe('AM power split', () => {
  test('carrier holds A^2/2 and each sideband A^2 mu^2 / 8', () => {
    const result = run(amTransmitter(0.8));
    const am = output(result, 'modulator');
    const { binWidth, power: bins } = welch(am.data, am.rate, 4096);
    const at = (hz: number) => bins[Math.round(hz / binWidth)];
    assert.ok(Math.abs(at(100_000) - 0.5) < 1e-3, `carrier ${at(100_000)}`);
    assert.ok(
      Math.abs(at(99_000) - 0.08) < 1e-3,
      `lower sideband ${at(99_000)}`,
    );
    assert.ok(
      Math.abs(at(101_000) - 0.08) < 1e-3,
      `upper sideband ${at(101_000)}`,
    );
    // Total power 0.66, so the sidebands get 0.16 / 0.66 = 24.2%.
    assert.ok(Math.abs(power(am.data) - 0.66) < 1e-3);
  });
});

describe('sample rates', () => {
  test('inputs at different rates are an error on the block that meets them', () => {
    const result = run(
      circuit(
        0.01,
        [
          ['a', 'oscillator', { rate: 48000 }],
          ['b', 'oscillator', { rate: 96000 }],
          ['sum', 'adder'],
        ],
        [
          ['a:0', 'sum:0'],
          ['b:0', 'sum:1'],
        ],
      ),
    );
    const status = result.status.get('sum');
    assert.equal(status?.state, 'error');
    assert.match(status.state === 'error' ? status.message : '', /Resample/);
  });

  test("resampling changes a wire's rate and its sample count", () => {
    const result = run(
      circuit(
        0.5,
        [
          ['tone', 'oscillator', { rate: 48000 }],
          ['up', 'resample', { direction: 'up', factor: 8 }],
        ],
        [['tone:0', 'up:0']],
      ),
    );
    const up = output(result, 'up');
    assert.equal(up.rate, 384000);
    assert.equal(up.data.length, 192000);
  });

  test('an unconnected input reads silence; a block with no inputs connected is idle', () => {
    const result = run(
      circuit(
        0.01,
        [
          ['tone', 'oscillator', { rate: 8000 }],
          ['mix', 'mixer'],
          ['lonely', 'gain'],
        ],
        [['tone:0', 'mix:0']],
      ),
    );
    assert.equal(
      output(result, 'mix').data.every((v) => v === 0),
      true,
    );
    assert.equal(result.status.get('lonely')?.state, 'idle');
  });
});

describe('feedback loops', () => {
  test('an echo loop computes y[n] = x[n] + 0.5 y[n - 10]', () => {
    const result = run(
      circuit(
        0.05,
        [
          ['x', 'constant', { value: 1, rate: 1000 }],
          ['sum', 'adder'],
          ['echo', 'delay', { time: 0.01 }],
          ['half', 'gain', { gain: 0.5 }],
        ],
        [
          ['x:0', 'sum:0'],
          ['sum:0', 'echo:0'],
          ['echo:0', 'half:0'],
          ['half:0', 'sum:1'],
        ],
      ),
    );
    const y = output(result, 'sum').data;
    for (const [n, expected] of [
      [0, 1],
      [9, 1],
      [10, 1.5],
      [25, 1.75],
      [49, 1.9375],
    ] as const) {
      assert.equal(y[n], expected, `y[${n}]`);
    }
  });

  test('a one-sample delay steps the loop sample by sample: an accumulator', () => {
    const result = run(
      circuit(
        0.01,
        [
          ['x', 'constant', { value: 1, rate: 1000 }],
          ['sum', 'adder'],
          ['z', 'delay', { time: 0 }],
        ],
        [
          ['x:0', 'sum:0'],
          ['sum:0', 'z:0'],
          ['z:0', 'sum:1'],
        ],
      ),
    );
    assert.deepEqual(
      [...output(result, 'sum').data],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
  });

  test('a loop without a delay is an error on every block in it', () => {
    const result = run(
      circuit(
        0.01,
        [
          ['x', 'constant', { rate: 1000 }],
          ['sum', 'adder'],
          ['half', 'gain', { gain: 0.5 }],
        ],
        [
          ['x:0', 'sum:0'],
          ['sum:0', 'half:0'],
          ['half:0', 'sum:1'],
        ],
      ),
    );
    for (const id of ['sum', 'half']) {
      const status = result.status.get(id);
      assert.equal(status?.state, 'error');
      assert.match(status.state === 'error' ? status.message : '', /Delay/);
    }

    assert.equal(result.status.get('x')?.state, 'ok');
  });
});

describe('streaming', () => {
  /** An AM link with every kind of state: filters, resamplers and a loop. */
  const link = plain(
    [
      ['tone', 'oscillator', { frequency: 700, rate: 8000 }],
      ['up', 'resample', { direction: 'up', factor: 6 }],
      ['dc', 'offset', { value: 1 }],
      ['carrier', 'oscillator', { frequency: 12_000, rate: 48_000 }],
      ['am', 'mixer'],
      ['tuned', 'bandpass', { center: 12_000, bandwidth: 3000 }],
      ['diode', 'diode'],
      ['cap', 'capacitor', { rc: 0.0005 }],
      ['down', 'resample', { direction: 'down', factor: 6 }],
    ],
    [
      ['tone', 'up'],
      ['up', 'dc'],
      ['dc', 'am:0'],
      ['carrier', 'am:1'],
      ['am', 'tuned'],
      ['tuned', 'diode:0'],
      ['diode', 'cap'],
      ['cap', 'diode:1'],
      ['diode', 'down'],
    ],
  );

  test('gives the same samples however the run is cut into chunks', () => {
    const whole = output(simulate(blockType, link, 0.3), 'down').data;
    const s = stream();
    s.load(link);
    const parts: number[] = [];
    for (let t = 0.0137; t < 0.3; t += 0.0137) {
      s.advance(t, (chunk) =>
        parts.push(...chunk.signals.get('down:0')!.data),
      );
    }

    s.advance(0.3, (chunk) =>
      parts.push(...chunk.signals.get('down:0')!.data),
    );
    assert.equal(parts.length, whole.length);
    assert.ok(
      parts.every((v, i) => v === whole[i]),
      'chunked and whole runs differ',
    );
  });

  test('keeps going: time never wraps and sources carry on', () => {
    const s = stream();
    s.load(link);
    s.advance(100);
    assert.ok(Math.abs(s.time - 100) < 1e-6);
    let last: Float32Array | undefined;
    s.advance(100.01, (chunk) => (last = chunk.signals.get('tone:0')!.data));
    // The tone at 100 s is where a cosine from time 0 would be.
    const n = 8000 * 100.01 - 1;
    assert.ok(
      Math.abs(last!.at(-1)! - Math.cos((2 * Math.PI * 700 * n) / 8000)) <
        1e-3,
    );
  });

  test('a knob change carries on the blocks it does not touch, and retunes in place', () => {
    const s = stream();
    assert.equal(s.load(amTransmitter(0.8).circuit).rebuilt, 5);
    s.advance(0.01);
    assert.equal(s.load(amTransmitter(0.8).circuit).rebuilt, 0);
    // A gain keeps no state, so it is built afresh; everything else carries on.
    assert.equal(s.load(amTransmitter(0.5).circuit).rebuilt, 1);
    // An oscillator retunes in place, going on from the phase it had reached:
    // 1 kHz at 8 kHz is 10.5 cycles in by sample 84, so the next sample is -1
    // at any new frequency.
    const tuned = (frequency: number) =>
      plain([['osc', 'oscillator', { frequency, rate: 8000 }]], []);
    const o = stream();
    o.load(tuned(1000));
    o.advance(84 / 8000);
    assert.equal(o.load(tuned(1700)).rebuilt, 0);
    let next = 0;
    o.advance(
      85 / 8000,
      (chunk) => (next = chunk.signals.get('osc:0')!.data[0]!),
    );
    assert.ok(Math.abs(next + 1) < 1e-6, `${next}`);
  });

  test('reset goes back to time 0 with every block afresh', () => {
    const s = stream();
    s.load(link);
    s.advance(0.05);
    assert.equal(s.reset()?.rebuilt, 9);
    assert.equal(s.time, 0);
  });
});
