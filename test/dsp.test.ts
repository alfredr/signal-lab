import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Biquads, butterworth, magnitude } from "../src/dsp/biquad.ts";
import { Fir, hilbertTaps } from "../src/dsp/fir.ts";
import { downsample, resamplerDelay, upsample } from "../src/dsp/resample.ts";
import { welch } from "../src/dsp/spectrum.ts";
import { power } from "../src/engine/signal.ts";
import { circuit, decibels, output, simulator } from "./helpers.ts";

const tone = (frequency: number, rate: number, length: number, phase = 0) =>
  Float32Array.from({ length }, (_, n) => Math.cos((2 * Math.PI * frequency * n) / rate + phase));

describe("Butterworth filters", () => {
  test("are 3 dB down at the cutoff and fall 6 dB per octave per order", () => {
    const sections = butterworth("lowpass", 4, 1000, 48000);
    assert.ok(Math.abs(magnitude(sections, 1000, 48000) - Math.SQRT1_2) < 1e-3);
    // An order-n Butterworth has gain 1 / sqrt(1 + r^2n), where the bilinear transform makes r
    // the ratio of tan(pi f / rate) rather than of the frequencies themselves.
    const r = Math.tan((Math.PI * 4000) / 48000) / Math.tan((Math.PI * 1000) / 48000);
    assert.ok(Math.abs(magnitude(sections, 4000, 48000) - 1 / Math.sqrt(1 + r ** 8)) < 1e-6);
  });

  test("passes a tone at the cutoff at 0.707 of its amplitude once settled", () => {
    const x = tone(1000, 48000, 48000);
    const y = new Float32Array(x.length);
    new Biquads(butterworth("lowpass", 2, 1000, 48000)).process(x, y);
    const ratio = Math.sqrt(power(y.subarray(24000)) / power(x.subarray(24000)));
    assert.ok(Math.abs(ratio - Math.SQRT1_2) < 0.01, `ratio ${ratio}`);
  });
});

describe("resampling", () => {
  test("up by 8 then down by 8 returns the tone, delayed by the two filters", () => {
    const x = tone(1000, 48000, 24000);
    const up = new Float32Array(x.length * 8);
    upsample(x, 8, up);
    const back = new Float32Array(x.length);
    downsample(up, 8, back);
    const delay = (2 * resamplerDelay(8)) / 8;
    const expected = tone(1000, 48000, x.length, (-2 * Math.PI * 1000 * delay) / 48000);
    let worst = 0;
    for (let n = 4000; n < x.length; n++) worst = Math.max(worst, Math.abs(back[n] - expected[n]));
    assert.ok(worst < 0.01, `worst error ${worst}`);
  });

  test("upsampling leaves no images of the tone", () => {
    const up = new Float32Array(8 * 16384);
    upsample(tone(1500, 48000, 16384), 8, up);
    const { binWidth, power: bins } = welch(up, 384000, 8192);
    const level = (hz: number) => decibels(bins[Math.round(hz / binWidth)]);
    assert.ok(Math.abs(level(1500) - decibels(0.5)) < 0.1);
    // The first image would sit at 48 kHz - 1.5 kHz.
    assert.ok(level(46500) < -75, `image at ${level(46500)} dB`);
  });
});

describe("Hilbert transformer", () => {
  test("turns a cosine into a sine after its delay", () => {
    const length = 255;
    const x = tone(1000, 48000, 9600);
    const q = new Float32Array(x.length);
    new Fir(hilbertTaps(length)).process(x, q);
    const delay = (length - 1) / 2;
    let worst = 0;
    for (let n = length; n < x.length; n++) {
      worst = Math.max(worst, Math.abs(q[n] - Math.sin((2 * Math.PI * 1000 * (n - delay)) / 48000)));
    }
    assert.ok(worst < 0.01, `worst error ${worst}`);
  });
});

describe("spectrum", () => {
  test("a sine reads its power, A^2 / 2, at its peak", () => {
    const x = tone(1000, 64000, 64000).map((v) => 2 * v);
    const { binWidth, power: bins } = welch(x, 64000, 4096);
    assert.ok(Math.abs(bins[Math.round(1000 / binWidth)] - 2) < 1e-6);
  });
});

describe("noise source", () => {
  test("its power in the reference bandwidth is the level set", () => {
    // -20 dB in 2.5 kHz is a density of 4e-6 per Hz; over 24 kHz that is 0.096.
    const result = simulator().run(circuit(4, [["n", "noise", { level: -20, bandwidth: 2500, rate: 48000 }]], []));
    const measured = power(output(result, "n").data);
    assert.ok(Math.abs(measured / 0.096 - 1) < 0.02, `power ${measured}`);
  });
});
