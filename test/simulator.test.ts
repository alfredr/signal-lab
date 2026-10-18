import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { welch } from "../src/dsp/spectrum.ts";
import { power } from "../src/engine/signal.ts";
import { circuit, output, simulator } from "./helpers.ts";

// 409.6 kHz with a 4096-point FFT puts every line below on an exact 100 Hz bin.
const RATE = 409_600;

const amTransmitter = (mu: number) =>
  circuit(
    0.1,
    [
      ["tone", "oscillator", { frequency: 1000, rate: RATE }],
      ["mu", "gain", { gain: mu }],
      ["dc", "offset", { value: 1 }],
      ["carrier", "oscillator", { frequency: 100_000, rate: RATE }],
      ["modulator", "mixer"],
    ],
    [
      ["tone:0", "mu:0"],
      ["mu:0", "dc:0"],
      ["dc:0", "modulator:0"],
      ["carrier:0", "modulator:1"],
    ],
  );

describe("AM power split", () => {
  test("carrier holds A^2/2 and each sideband A^2 mu^2 / 8", () => {
    const result = simulator().run(amTransmitter(0.8));
    const am = output(result, "modulator");
    const { binWidth, power: bins } = welch(am.data, am.rate, 4096);
    const at = (hz: number) => bins[Math.round(hz / binWidth)];
    assert.ok(Math.abs(at(100_000) - 0.5) < 1e-3, `carrier ${at(100_000)}`);
    assert.ok(Math.abs(at(99_000) - 0.08) < 1e-3, `lower sideband ${at(99_000)}`);
    assert.ok(Math.abs(at(101_000) - 0.08) < 1e-3, `upper sideband ${at(101_000)}`);
    // Total power 0.66, so the sidebands get 0.16 / 0.66 = 24.2%.
    assert.ok(Math.abs(power(am.data) - 0.66) < 1e-3);
  });
});

describe("sample rates", () => {
  test("inputs at different rates are an error on the block that meets them", () => {
    const result = simulator().run(
      circuit(
        0.01,
        [
          ["a", "oscillator", { rate: 48000 }],
          ["b", "oscillator", { rate: 96000 }],
          ["sum", "adder"],
        ],
        [
          ["a:0", "sum:0"],
          ["b:0", "sum:1"],
        ],
      ),
    );
    const status = result.status.get("sum");
    assert.equal(status?.state, "error");
    assert.match(status.state === "error" ? status.message : "", /Resample/);
  });

  test("resampling changes a wire's rate and its sample count", () => {
    const result = simulator().run(
      circuit(
        0.5,
        [
          ["tone", "oscillator", { rate: 48000 }],
          ["up", "resample", { direction: "up", factor: 8 }],
        ],
        [["tone:0", "up:0"]],
      ),
    );
    const up = output(result, "up");
    assert.equal(up.rate, 384000);
    assert.equal(up.data.length, 192000);
  });

  test("an unconnected input reads silence; a block with no inputs connected is idle", () => {
    const result = simulator().run(
      circuit(
        0.01,
        [
          ["tone", "oscillator", { rate: 8000 }],
          ["mix", "mixer"],
          ["lonely", "gain"],
        ],
        [["tone:0", "mix:0"]],
      ),
    );
    assert.equal(output(result, "mix").data.every((v) => v === 0), true);
    assert.equal(result.status.get("lonely")?.state, "idle");
  });
});

describe("feedback loops", () => {
  test("an echo loop computes y[n] = x[n] + 0.5 y[n - 10]", () => {
    const result = simulator().run(
      circuit(
        0.05,
        [
          ["x", "constant", { value: 1, rate: 1000 }],
          ["sum", "adder"],
          ["echo", "delay", { time: 0.01 }],
          ["half", "gain", { gain: 0.5 }],
        ],
        [
          ["x:0", "sum:0"],
          ["sum:0", "echo:0"],
          ["echo:0", "half:0"],
          ["half:0", "sum:1"],
        ],
      ),
    );
    const y = output(result, "sum").data;
    for (const [n, expected] of [[0, 1], [9, 1], [10, 1.5], [25, 1.75], [49, 1.9375]] as const) {
      assert.equal(y[n], expected, `y[${n}]`);
    }
  });

  test("a one-sample delay steps the loop sample by sample: an accumulator", () => {
    const result = simulator().run(
      circuit(
        0.01,
        [
          ["x", "constant", { value: 1, rate: 1000 }],
          ["sum", "adder"],
          ["z", "delay", { time: 0 }],
        ],
        [
          ["x:0", "sum:0"],
          ["sum:0", "z:0"],
          ["z:0", "sum:1"],
        ],
      ),
    );
    assert.deepEqual([...output(result, "sum").data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a loop without a delay is an error on every block in it", () => {
    const result = simulator().run(
      circuit(
        0.01,
        [
          ["x", "constant", { rate: 1000 }],
          ["sum", "adder"],
          ["half", "gain", { gain: 0.5 }],
        ],
        [
          ["x:0", "sum:0"],
          ["sum:0", "half:0"],
          ["half:0", "sum:1"],
        ],
      ),
    );
    for (const id of ["sum", "half"]) {
      const status = result.status.get(id);
      assert.equal(status?.state, "error");
      assert.match(status.state === "error" ? status.message : "", /Delay/);
    }
    assert.equal(result.status.get("x")?.state, "ok");
  });
});

describe("caching", () => {
  test("a second run reuses everything, and a knob recomputes only what is downstream of it", () => {
    const sim = simulator();
    assert.equal(sim.run(amTransmitter(0.8)).recomputed, 5);
    assert.equal(sim.run(amTransmitter(0.8)).recomputed, 0);
    // mu, dc and the modulator depend on the gain; the two oscillators don't.
    assert.equal(sim.run(amTransmitter(0.5)).recomputed, 3);
  });
});
