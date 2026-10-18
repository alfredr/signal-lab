import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INPUT_TERMINAL, OUTPUT_TERMINAL } from "../src/blocks/terminals.ts";
import { diagram } from "../src/model/build.ts";
import { duplicate, FORMAT, removeBlocks, updateDiagramAt, type LabDocument } from "../src/model/document.ts";
import { examples } from "../src/model/examples.ts";
import { template } from "../src/model/library.ts";
import { groupAt, ungroupAt } from "../src/model/subsystems.ts";
import { simulateDocument } from "./helpers.ts";

const simulate = simulateDocument;

function doc(parts: Parameters<typeof diagram>[0], links: Parameters<typeof diagram>[1], duration = 0.01): LabDocument {
  return { format: FORMAT, title: "test", notes: "", duration, probes: [], ...diagram(parts, links) };
}

const doubler = diagram(
  {
    in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
    twice: { kind: "gain", x: 100, y: 0, params: { gain: 2 } },
    out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
  },
  [
    ["in", "twice"],
    ["twice", "out"],
  ],
);

describe("subsystems", () => {
  test("a subsystem's output carries what its inside computes", () => {
    const { signals } = simulate(
      doc(
        {
          tone: { kind: "oscillator", x: 0, y: 0, params: { rate: 8000 } },
          sub: { kind: "subsystem", x: 100, y: 0, inner: doubler },
        },
        [["tone", "sub"]],
      ),
    );
    const tone = signals.get("tone:0")!.data;
    const out = signals.get("sub:0")!.data;
    assert.ok(out.every((v, i) => v === 2 * tone[i]));
    // Blocks inside are probe-able by path.
    assert.deepEqual(signals.get("sub/twice:0")!.data, out);
  });

  test("the library envelope detector is the peak detector max(x, decay * held)", () => {
    const rate = 384_000;
    const { signals } = simulate(
      doc(
        {
          tone: { kind: "oscillator", x: 0, y: 0, params: { frequency: 100_000, rate } },
          detector: { kind: "subsystem", x: 100, y: 0, inner: template("envelope-detector")!.build() },
        },
        [["tone", "detector"]],
      ),
    );
    const x = signals.get("tone:0")!.data;
    const y = signals.get("detector:0")!.data;
    const decay = Math.exp(-1 / (rate * 20e-6));
    let held = 0;
    for (let i = 0; i < x.length; i++) {
      held = Math.fround(Math.max(x[i], Math.fround(decay * held)));
      assert.equal(y[i], held, `sample ${i}`);
    }
  });

  test("an error inside shows on the subsystem block", () => {
    const inner = diagram(
      {
        in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
        other: { kind: "oscillator", x: 0, y: 99, params: { rate: 96000 } },
        sum: { kind: "adder", x: 100, y: 0 },
        out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
      },
      [
        ["in", "sum:0"],
        ["other", "sum:1"],
        ["sum", "out"],
      ],
    );
    const { status } = simulate(
      doc(
        {
          tone: { kind: "oscillator", x: 0, y: 0, params: { rate: 48000 } },
          sub: { kind: "subsystem", x: 100, y: 0, name: "Mixer stage", inner },
        },
        [["tone", "sub"]],
      ),
    );
    const sub = status.get("sub");
    assert.equal(sub?.state, "error");
    assert.match(sub.state === "error" ? sub.message : "", /^Inside, Adder: .*Resample/);
  });

  test("removing an input terminal renumbers the subsystem's ports and drops its wire", () => {
    const twoIn = diagram(
      {
        a: { kind: INPUT_TERMINAL, x: 0, y: 0 },
        b: { kind: INPUT_TERMINAL, x: 0, y: 50 },
        sum: { kind: "adder", x: 100, y: 0 },
        out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
      },
      [
        ["a", "sum:0"],
        ["b", "sum:1"],
        ["sum", "out"],
      ],
    );
    const before = doc(
      {
        x: { kind: "constant", x: 0, y: 0, params: { rate: 1000 } },
        y: { kind: "constant", x: 0, y: 60, params: { rate: 1000 } },
        sub: { kind: "subsystem", x: 100, y: 0, inner: twoIn },
      },
      [
        ["x", "sub:0"],
        ["y", "sub:1"],
      ],
    );
    const after = updateDiagramAt(before, ["sub"], (d) => removeBlocks(d, new Set(["a"])));
    assert.deepEqual(
      after.wires.map((w) => [w.from.block, w.to.port]),
      [["y", 0]],
    );
  });
});

describe("antennas", () => {
  test("a receive antenna hears every transmitter, plus its own noise", () => {
    const { signals } = simulate(
      doc(
        {
          a: { kind: "oscillator", x: 0, y: 0, params: { frequency: 1000, rate: 48000 } },
          b: { kind: "oscillator", x: 0, y: 60, params: { frequency: 3000, rate: 48000 } },
          ta: { kind: "antenna-tx", x: 100, y: 0 },
          tb: { kind: "antenna-tx", x: 100, y: 60, params: { gain: -6 } },
          rx: { kind: "antenna-rx", x: 0, y: 200, params: { noise: -120 } },
        },
        [
          ["a", "ta"],
          ["b", "tb"],
        ],
      ),
    );
    const a = signals.get("a:0")!.data;
    const b = signals.get("b:0")!.data;
    const rx = signals.get("rx:0")!.data;
    let worst = 0;
    const half = 10 ** (-6 / 20);
    for (let i = 0; i < rx.length; i++) worst = Math.max(worst, Math.abs(rx[i] - (a[i] + half * b[i])));
    assert.ok(worst < 1e-4, `worst ${worst}`);
  });

  test("with no transmitter the receive antenna says so", () => {
    const { status } = simulate(doc({ rx: { kind: "antenna-rx", x: 0, y: 0 } }, []));
    const rx = status.get("rx");
    assert.equal(rx?.state, "idle");
    assert.match(rx.state === "idle" ? rx.reason : "", /Transmit antenna/);
  });
});

describe("grouping", () => {
  test("grouping and ungrouping leave every signal unchanged and keep probes", () => {
    const original = examples[0]!.build();
    const baseline = simulate(original).signals.get("dcBlock:0")!.data;

    const grouped = groupAt({ ...original, probes: [...original.probes, { id: "p9", at: { block: "dc", port: 0 }, view: "time" }] }, [], new Set(["dc", "up", "modulator", "carrier"]));
    assert.ok(grouped);
    const groupedRun = simulate(grouped.doc);
    assert.deepEqual(groupedRun.signals.get("dcBlock:0")!.data, baseline);
    const moved = grouped.doc.probes.find((p) => p.id === "p9")!;
    assert.equal(moved.at.block, `${grouped.id}/dc`);
    assert.ok(groupedRun.signals.get(`${moved.at.block}:0`));

    const ungrouped = ungroupAt(grouped.doc, [], grouped.id);
    assert.deepEqual(simulate(ungrouped).signals.get("dcBlock:0")!.data, baseline);
    assert.equal(ungrouped.probes.find((p) => p.id === "p9")!.at.block, "dc");
  });
});

describe("duplicating", () => {
  test("copies blocks with fresh ids and keeps only the wires among them", () => {
    const original = examples[0]!.build();
    const [copy, ids] = duplicate(original, new Set(["tuned", "detector", "audio"]));
    assert.equal(ids.length, 3);
    assert.ok(ids.every((id) => !original.blocks.some((b) => b.id === id)));
    const copied = copy.wires.filter((w) => ids.includes(w.from.block) || ids.includes(w.to.block));
    // tuned -> detector -> audio inside the copy; nothing to or from the originals.
    assert.equal(copied.length, 2);
    assert.ok(copied.every((w) => ids.includes(w.from.block) && ids.includes(w.to.block)));
    // The copied envelope detector shares its inside, and still simulates.
    const { status } = simulate({ ...copy, wires: [...copy.wires, { id: "wx", from: { block: "receiver", port: 0 }, to: { block: ids[0]!, port: 0 } }] });
    assert.equal(status.get(ids[2]!)?.state, "ok");
  });
});

describe("examples", () => {
  for (const example of examples) {
    test(`"${example.title}" runs with every block working`, () => {
      const { status } = simulate(example.build());
      const problems = [...status].filter(([, s]) => s.state !== "ok").map(([id, s]) => `${id}: ${JSON.stringify(s)}`);
      assert.deepEqual(problems, []);
    });
  }
});
