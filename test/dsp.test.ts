import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Biquads, butterworth, magnitude } from '../src/dsp/biquad.ts';
import { Fir, hilbertTaps } from '../src/dsp/fir.ts';
import {
  downsample,
  Downsampler,
  Interpolator,
  resamplerDelay,
  upsample,
  Upsampler,
} from '../src/dsp/resample.ts';
import { welch } from '../src/dsp/spectrum.ts';
import { power } from '../src/engine/signal.ts';
import { circuit, decibels, output, run } from './helpers.ts';

const tone = (frequency: number, rate: number, length: number, phase = 0) =>
  Float32Array.from({ length }, (_, n) =>
    Math.cos((2 * Math.PI * frequency * n) / rate + phase),
  );

describe('Butterworth filters', () => {
  test('are 3 dB down at the cutoff and fall 6 dB per octave per order', () => {
    const sections = butterworth('lowpass', 4, 1000, 48000);
    assert.ok(
      Math.abs(magnitude(sections, 1000, 48000) - Math.SQRT1_2) < 1e-3,
    );
    // An order-n Butterworth has gain 1 / sqrt(1 + r^2n), where the bilinear transform makes r
    // the ratio of tan(pi f / rate) rather than of the frequencies themselves.
    const r =
      Math.tan((Math.PI * 4000) / 48000) / Math.tan((Math.PI * 1000) / 48000);
    assert.ok(
      Math.abs(magnitude(sections, 4000, 48000) - 1 / Math.sqrt(1 + r ** 8)) <
        1e-6,
    );
  });

  test('passes a tone at the cutoff at 0.707 of its amplitude once settled', () => {
    const x = tone(1000, 48000, 48000);
    const y = new Float32Array(x.length);
    new Biquads(butterworth('lowpass', 2, 1000, 48000)).process(x, y);
    const ratio = Math.sqrt(
      power(y.subarray(24000)) / power(x.subarray(24000)),
    );
    assert.ok(Math.abs(ratio - Math.SQRT1_2) < 0.01, `ratio ${ratio}`);
  });
});

describe('resampling', () => {
  test('up by 8 then down by 8 returns the tone, delayed by the two filters', () => {
    const x = tone(1000, 48000, 24000);
    const up = new Float32Array(x.length * 8);
    upsample(x, 8, up);
    const back = new Float32Array(x.length);
    downsample(up, 8, back);
    const delay = (resamplerDelay(8, 'up') + resamplerDelay(8, 'down')) / 8;
    const expected = tone(
      1000,
      48000,
      x.length,
      (-2 * Math.PI * 1000 * delay) / 48000,
    );
    let worst = 0;
    for (let n = 4000; n < x.length; n++) {
      worst = Math.max(worst, Math.abs(back[n] - expected[n]));
    }

    assert.ok(worst < 0.01, `worst error ${worst}`);
  });

  test('works a chunk at a time, the same as all at once', () => {
    const x = tone(1000, 48000, 4800);
    const whole = new Float32Array(x.length * 3);
    upsample(x, 3, whole);
    const up = new Upsampler(3);
    const parts: number[] = [];
    for (let at = 0; at < x.length; at += 701) {
      const chunk = x.subarray(at, Math.min(x.length, at + 701));
      const out = new Float32Array(chunk.length * 3);
      up.process(chunk, out);
      parts.push(...out);
    }

    assert.ok(parts.every((v, i) => v === whole[i]));

    const down = new Downsampler(3);
    const back = new Float32Array(whole.length / 3);
    downsample(whole, 3, back);
    const pieces: number[] = [];
    for (let at = 0; at < whole.length; at += 2103) {
      const chunk = whole.subarray(at, Math.min(whole.length, at + 2103));
      const out = new Float32Array(chunk.length / 3);
      down.process(chunk, out);
      pieces.push(...out);
    }

    assert.ok(pieces.every((v, i) => v === back[i]));
  });

  test('upsampling leaves no images of the tone', () => {
    const up = new Float32Array(8 * 16384);
    upsample(tone(1500, 48000, 16384), 8, up);
    const { binWidth, power: bins } = welch(up, 384000, 8192);
    const level = (hz: number) => decibels(bins[Math.round(hz / binWidth)]);
    assert.ok(Math.abs(level(1500) - decibels(0.5)) < 0.1);
    // The first image would sit at 48 kHz - 1.5 kHz.
    assert.ok(level(46500) < -75, `image at ${level(46500)} dB`);
  });
});

describe('Hilbert transformer', () => {
  test('turns a cosine into a sine after its delay', () => {
    const length = 255;
    const x = tone(1000, 48000, 9600);
    const q = new Float32Array(x.length);
    new Fir(hilbertTaps(length)).process(x, q);
    const delay = (length - 1) / 2;
    let worst = 0;
    for (let n = length; n < x.length; n++) {
      worst = Math.max(
        worst,
        Math.abs(q[n] - Math.sin((2 * Math.PI * 1000 * (n - delay)) / 48000)),
      );
    }

    assert.ok(worst < 0.01, `worst error ${worst}`);
  });
});

describe('spectrum', () => {
  test('a sine reads its power, A^2 / 2, at its peak', () => {
    const x = tone(1000, 64000, 64000).map((v) => 2 * v);
    const { binWidth, power: bins } = welch(x, 64000, 4096);
    assert.ok(Math.abs(bins[Math.round(1000 / binWidth)] - 2) < 1e-6);
  });
});

describe('noise source', () => {
  test('its power in the reference bandwidth is the level set', () => {
    // -20 dB in 2.5 kHz is a density of 4e-6 per Hz; over 24 kHz that is 0.096.
    const result = run(
      circuit(
        4,
        [['n', 'noise', { level: -20, bandwidth: 2500, rate: 48000 }]],
        [],
      ),
    );
    const measured = power(output(result, 'n').data);
    assert.ok(Math.abs(measured / 0.096 - 1) < 0.02, `power ${measured}`);
  });
});

describe('reading a signal at another rate', () => {
  /**
   * A tone read out at `out` Hz, as the speaker does, and its level at `at`
   * Hz.
   */
  const readOut = (
    frequency: number,
    rate: number,
    out: number,
    at: number,
  ): number => {
    const reader = new Interpolator();
    const ratio = rate / out;
    const reach = reader.reach(ratio);
    const n = 4800;
    const samples = Float32Array.from(
      { length: Math.ceil(n * ratio) + 2 * reach + 2 },
      (_, i) => Math.sin((2 * Math.PI * frequency * (i - reach)) / rate),
    );
    let re = 0;
    let im = 0;
    for (let k = 0; k < n; k++) {
      const v = reader.at(samples, reach + k * ratio, ratio);
      re += v * Math.cos((2 * Math.PI * at * k) / out);
      im += v * Math.sin((2 * Math.PI * at * k) / out);
    }

    return (2 * Math.hypot(re, im)) / n;
  };

  test('passes what fits below half the new rate', () => {
    assert.ok(Math.abs(readOut(1000, 48000, 48000, 1000) - 1) < 0.01);
    assert.ok(Math.abs(readOut(10_000, 384_000, 48000, 10_000) - 1) < 0.01);
    assert.ok(Math.abs(readOut(1000, 12000, 48000, 1000) - 1) < 0.01);
  });

  test("doesn't fold what is above it back down", () => {
    // 100 kHz read at 48 kHz would land on 4 kHz.
    const alias = readOut(100_000, 384_000, 48000, 4000);
    assert.ok(alias < 1e-3, `alias at ${alias}`);
    // Read 8 samples apart, as at 8× speed, 4 kHz would fold to 2 kHz.
    assert.ok(readOut(4000, 48000, 6000, 2000) < 1e-3);
  });
});
