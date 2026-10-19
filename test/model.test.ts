import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dictionary } from 'cmu-pronouncing-dictionary';

import { setDictionary } from '../src/blocks/pronouncing.ts';
import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../src/blocks/terminals.ts';
import { diagram } from '../src/model/build.ts';
import {
  diagramAt,
  duplicate,
  FORMAT,
  type LabDocument,
  readDocument,
  removeBlocks,
  updateDiagramAt,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { template } from '../src/model/library.ts';
import { groupAt, ungroupAt, wiredOutside } from '../src/model/subsystems.ts';
import { simulateDocument } from './helpers.ts';

const simulate = (d: LabDocument) => simulateDocument(d, 0.01);

// The worker fetches this for documents that speak; the tests load it here.
setDictionary(new Map(Object.entries(dictionary)));

function doc(
  parts: Parameters<typeof diagram>[0],
  links: Parameters<typeof diagram>[1],
): LabDocument {
  return {
    format: FORMAT,
    title: 'test',
    notes: '',
    ...diagram(parts, links),
  };
}

const doubler = diagram(
  {
    in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
    twice: { kind: 'gain', x: 100, y: 0, params: { gain: 2 } },
    out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
  },
  [
    ['in', 'twice'],
    ['twice', 'out'],
  ],
);

describe('subsystems', () => {
  test("a subsystem's output carries what its inside computes", () => {
    const { signals } = simulate(
      doc(
        {
          tone: { kind: 'oscillator', x: 0, y: 0, params: { rate: 8000 } },
          sub: { kind: 'subsystem', x: 100, y: 0, inner: doubler },
        },
        [['tone', 'sub']],
      ),
    );
    const tone = signals.get('tone:0')!.data;
    const out = signals.get('sub:0')!.data;
    assert.ok(out.every((v, i) => v === 2 * tone[i]));
    // Blocks inside are probe-able by path.
    assert.deepEqual(signals.get('sub/twice:0')!.data, out);
  });

  test('the library envelope detector is the peak detector max(x, decay * held)', () => {
    const rate = 384_000;
    const { signals } = simulate(
      doc(
        {
          tone: {
            kind: 'oscillator',
            x: 0,
            y: 0,
            params: { frequency: 100_000, rate },
          },
          detector: {
            kind: 'subsystem',
            x: 100,
            y: 0,
            inner: template('envelope-detector')!.build(),
          },
        },
        [['tone', 'detector']],
      ),
    );
    const x = signals.get('tone:0')!.data;
    const y = signals.get('detector:0')!.data;
    const decay = Math.exp(-1 / (rate * 20e-6));
    let held = 0;
    for (let i = 0; i < x.length; i++) {
      held = Math.fround(Math.max(x[i], Math.fround(decay * held)));
      assert.equal(y[i], held, `sample ${i}`);
    }
  });

  test('an error inside shows on the subsystem block', () => {
    const inner = diagram(
      {
        in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
        other: { kind: 'oscillator', x: 0, y: 99, params: { rate: 96000 } },
        sum: { kind: 'adder', x: 100, y: 0 },
        out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
      },
      [
        ['in', 'sum:0'],
        ['other', 'sum:1'],
        ['sum', 'out'],
      ],
    );
    const { status } = simulate(
      doc(
        {
          tone: { kind: 'oscillator', x: 0, y: 0, params: { rate: 48000 } },
          sub: { kind: 'subsystem', x: 100, y: 0, name: 'Mixer stage', inner },
        },
        [['tone', 'sub']],
      ),
    );
    const sub = status.get('sub');
    assert.equal(sub?.state, 'error');
    assert.match(
      sub.state === 'error' ? sub.message : '',
      /^Inside, Adder: .*Resample/,
    );
  });

  test("removing an input terminal renumbers the subsystem's ports and drops its wire", () => {
    const twoIn = diagram(
      {
        a: { kind: INPUT_TERMINAL, x: 0, y: 0 },
        b: { kind: INPUT_TERMINAL, x: 0, y: 50 },
        sum: { kind: 'adder', x: 100, y: 0 },
        out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
      },
      [
        ['a', 'sum:0'],
        ['b', 'sum:1'],
        ['sum', 'out'],
      ],
    );
    const before = doc(
      {
        x: { kind: 'constant', x: 0, y: 0, params: { rate: 1000 } },
        y: { kind: 'constant', x: 0, y: 60, params: { rate: 1000 } },
        sub: { kind: 'subsystem', x: 100, y: 0, inner: twoIn },
      },
      [
        ['x', 'sub:0'],
        ['y', 'sub:1'],
      ],
    );
    const after = updateDiagramAt(before, ['sub'], (d) =>
      removeBlocks(d, new Set(['a'])),
    );
    assert.deepEqual(
      after.wires.map((w) => [w.from.block, w.to.port]),
      [['y', 0]],
    );
  });
});

describe('wired outside', () => {
  // A stage holding the doubler, so the doubler's terminals lead out through
  // the stage's.
  const stage = diagram(
    {
      in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
      inner: { kind: 'subsystem', x: 100, y: 0, inner: doubler },
      out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
    },
    [
      ['in', 'inner'],
      ['inner', 'out'],
    ],
  );
  const twoCopies = doc(
    {
      tone: {
        kind: 'oscillator',
        x: 0,
        y: 0,
        name: 'Tone',
        params: { rate: 8000 },
      },
      dc: { kind: 'constant', x: 0, y: 80, params: { rate: 8000 } },
      first: { kind: 'subsystem', x: 100, y: 0, inner: stage },
      second: { kind: 'subsystem', x: 100, y: 80, inner: stage },
      sum: { kind: 'adder', x: 200, y: 0 },
      quiet: { kind: 'gain', x: 200, y: 80 },
    },
    [
      ['tone', 'first'],
      ['dc', 'second'],
      ['first', 'sum:0'],
      ['first', 'quiet'],
      ['second', 'sum:1'],
    ],
  );
  const ends = (d: LabDocument, path: string[], terminal: string) =>
    wiredOutside(
      d,
      path,
      diagramAt(d, path)!.blocks.find((b) => b.id === terminal)!,
    ).map(({ id, label }) => `${id}: ${label}`);

  test('each copy of a subsystem is wired on its own', () => {
    assert.deepEqual(ends(twoCopies, ['first'], 'in'), ['tone: Tone']);
    assert.deepEqual(ends(twoCopies, ['second'], 'in'), ['dc: DC']);
    // An output can go several places; a port is named where there are several.
    assert.deepEqual(ends(twoCopies, ['first'], 'out'), [
      'sum: Adder › a',
      'quiet: Gain',
    ]);
  });

  test('from deeper in, the trail leads on out through the terminals around it', () => {
    assert.deepEqual(ends(twoCopies, ['second', 'inner'], 'in'), ['dc: DC']);
    assert.deepEqual(ends(twoCopies, ['second', 'inner'], 'out'), [
      'sum: Adder › b',
    ]);
  });

  test('a terminal with nothing on it outside has nothing to show', () => {
    const loose = updateDiagramAt(twoCopies, [], (d) => ({
      ...d,
      wires: d.wires.filter((w) => w.from.block !== 'dc'),
    }));
    assert.deepEqual(ends(loose, ['second', 'inner'], 'in'), []);
    assert.deepEqual(ends(loose, ['first'], 'in'), ['tone: Tone']);
  });
});

describe('antennas', () => {
  test('an antenna hears every other antenna, plus its own noise', () => {
    const { signals } = simulate(
      doc(
        {
          a: {
            kind: 'oscillator',
            x: 0,
            y: 0,
            params: { frequency: 1000, rate: 48000 },
          },
          b: {
            kind: 'oscillator',
            x: 0,
            y: 60,
            params: { frequency: 3000, rate: 48000 },
          },
          ta: { kind: 'antenna', x: 100, y: 0 },
          tb: { kind: 'antenna', x: 100, y: 60, params: { gain: -6 } },
          rx: { kind: 'antenna', x: 0, y: 200, params: { noise: -120 } },
          meter: { kind: 'meter', x: 200, y: 200 },
        },
        [
          ['a', 'ta'],
          ['b', 'tb'],
          ['rx', 'meter'],
        ],
      ),
    );
    const a = signals.get('a:0')!.data;
    const b = signals.get('b:0')!.data;
    const rx = signals.get('rx:0')!.data;
    let worst = 0;
    const half = 10 ** (-6 / 20);
    for (let i = 0; i < rx.length; i++) {
      worst = Math.max(worst, Math.abs(rx[i] - (a[i] + half * b[i])));
    }

    assert.ok(worst < 1e-4, `worst ${worst}`);
  });

  test('transmit and receive antennas saved before become Antennas', () => {
    const doc = readDocument({
      format: FORMAT,
      title: 'old',
      notes: '',
      blocks: [
        {
          id: 'osc',
          kind: 'oscillator',
          x: 0,
          y: 0,
          params: { rate: 48000 },
        },
        { id: 'tx', kind: 'antenna-tx', x: 100, y: 0, params: {} },
        { id: 'rx', kind: 'antenna-rx', x: 0, y: 100, params: {} },
        { id: 'm', kind: 'meter', x: 100, y: 100, params: {} },
      ],
      wires: [
        {
          id: 'w1',
          from: { block: 'osc', port: 0 },
          to: { block: 'tx', port: 0 },
        },
        {
          id: 'w2',
          from: { block: 'rx', port: 0 },
          to: { block: 'm', port: 0 },
        },
      ],
    });
    assert.deepEqual(
      doc.blocks.map((b) => b.kind),
      ['oscillator', 'antenna', 'antenna', 'meter'],
    );
    assert.equal(simulate(doc).status.get('rx')?.state, 'ok');
  });

  test('with nothing else on the air an antenna says so', () => {
    const { status } = simulate(
      doc(
        {
          rx: { kind: 'antenna', x: 0, y: 0 },
          meter: { kind: 'meter', x: 100, y: 0 },
        },
        [['rx', 'meter']],
      ),
    );
    const rx = status.get('rx');
    assert.equal(rx?.state, 'idle');
    assert.match(rx.state === 'idle' ? rx.reason : '', /another antenna/);
  });

  test('an antenna that both sends and hears hears only the others', () => {
    const { signals, status } = simulate(
      doc(
        {
          a: {
            kind: 'oscillator',
            x: 0,
            y: 0,
            params: { frequency: 1000, rate: 48000 },
          },
          b: {
            kind: 'oscillator',
            x: 0,
            y: 60,
            params: { frequency: 3000, rate: 48000 },
          },
          one: { kind: 'antenna', x: 100, y: 0, params: { noise: -120 } },
          two: { kind: 'antenna', x: 100, y: 60, params: { noise: -120 } },
          meterOne: { kind: 'meter', x: 200, y: 0 },
          meterTwo: { kind: 'meter', x: 200, y: 60 },
        },
        [
          ['a', 'one'],
          ['b', 'two'],
          ['one', 'meterOne'],
          ['two', 'meterTwo'],
        ],
      ),
    );
    assert.equal(status.get('one')?.state, 'ok');
    const one = signals.get('one:0')!.data;
    const b = signals.get('b:0')!.data;
    let worst = 0;
    for (let i = 0; i < one.length; i++) {
      worst = Math.max(worst, Math.abs(one[i] - b[i]));
    }

    assert.ok(worst < 1e-4, `worst ${worst}`);
  });
});

describe('grouping', () => {
  test('grouping and ungrouping leave every signal unchanged, and instruments follow', () => {
    const original = examples[0]!.build();
    const baseline = simulate(original).signals.get('dcBlock:0')!.data;
    const grouped = groupAt(
      original,
      [],
      new Set(['detector', 'audio', 'down', 'dcBlock', 'audioOut']),
    );
    assert.ok(grouped);
    const { id } = grouped;
    assert.deepEqual(
      simulate(grouped.doc).signals.get(`${id}/dcBlock:0`)!.data,
      baseline,
    );
    // The plot's face spot goes inside with it, and the knob left outside
    // still finds the capacitor.
    assert.deepEqual(
      grouped.doc.face?.[`${id}/audioOut`],
      original.face?.audioOut,
    );
    const knob = (doc: LabDocument) =>
      doc.blocks.find((b) => b.id === 'rcKnob')!.params.target;
    assert.equal(knob(grouped.doc), `${id}/detector.rc`);

    const ungrouped = ungroupAt(grouped.doc, [], id);
    assert.deepEqual(
      simulate(ungrouped).signals.get('dcBlock:0')!.data,
      baseline,
    );
    assert.equal(knob(ungrouped), 'detector.rc');
    assert.deepEqual(ungrouped.face?.audioOut, original.face?.audioOut);
  });
});

describe('duplicating', () => {
  test('copies blocks with fresh ids and keeps only the wires among them', () => {
    const original = examples[0]!.build();
    const [copy, ids] = duplicate(
      original,
      new Set(['tuned', 'detector', 'audio']),
    );
    assert.equal(ids.length, 3);
    assert.ok(ids.every((id) => !original.blocks.some((b) => b.id === id)));
    const copied = copy.wires.filter(
      (w) => ids.includes(w.from.block) || ids.includes(w.to.block),
    );
    // tuned -> detector -> audio inside the copy; nothing to or from the originals.
    assert.equal(copied.length, 2);
    assert.ok(
      copied.every(
        (w) => ids.includes(w.from.block) && ids.includes(w.to.block),
      ),
    );
    // The copied envelope detector shares its inside, and still simulates.
    const { status } = simulate({
      ...copy,
      wires: [
        ...copy.wires,
        {
          id: 'wx',
          from: { block: 'receiver', port: 0 },
          to: { block: ids[0]!, port: 0 },
        },
      ],
    });
    assert.equal(status.get(ids[2]!)?.state, 'ok');
  });
});

describe('examples', () => {
  for (const example of examples) {
    test(`"${example.title}" runs with every block working`, () => {
      const { status } = simulate(example.build());
      const problems = [...status]
        .filter(([, s]) => s.state !== 'ok')
        .map(([id, s]) => `${id}: ${JSON.stringify(s)}`);
      assert.deepEqual(problems, []);
    });
  }
});
