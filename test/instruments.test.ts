import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { blockType } from '../src/blocks/index.ts';
import type { Reading } from '../src/engine/block.ts';
import { Stream } from '../src/engine/simulator.ts';
import { control as controlPart, diagram } from '../src/model/build.ts';
import {
  diagramAt,
  everyBlock,
  FORMAT,
  readDocument,
  type LabDocument,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { flatten, resolveBindings } from '../src/model/flatten.ts';
import {
  controlState,
  faceItems,
  instrumentLeads,
  faceCards,
  layoutFace,
  reachingIn,
  readables,
  settables,
  symbolSources,
} from '../src/model/instruments.ts';
import { groupAt } from '../src/model/subsystems.ts';

const example = (title: string): LabDocument =>
  examples.find((e) => e.title === title)!.build();

const am = () => example('AM with an envelope detector');

const control = (doc: LabDocument, id: string) => {
  const block = doc.blocks.find((b) => b.id === id)!;
  const state = controlState(doc, resolveBindings(doc), [], block);
  assert.ok(!('problem' in state), JSON.stringify(state));
  return state;
};

describe('instruments', () => {
  test('stay out of the simulation', () => {
    const { circuit } = flatten(am());
    const kinds = new Set(circuit.blocks.map((b) => b.kind));
    for (const kind of ['plot', 'speaker', 'control', 'readout', 'note']) {
      assert.ok(!kinds.has(kind), kind);
    }

    assert.ok(!circuit.wires.some((w) => w.to.block === 'audioOut'));
  });

  test('controls set parameters, and subsystem settings through the block', () => {
    const doc = am();
    const mu = control(doc, 'muKnob');
    assert.equal(mu.label, 'mu');
    assert.equal(mu.value, 0.8);
    assert.equal(
      mu.set(doc, 1.2).parameters?.find((p) => p.name === 'mu')?.value,
      1.2,
    );

    const rc = control(doc, 'rcKnob');
    assert.equal(rc.label, 'Envelope detector › rc');
    const changed = rc.set(doc, 1e-4);
    assert.equal(
      diagramAt(changed, ['detector'])?.parameters?.[0]?.value,
      1e-4,
    );
  });

  test('controls of a block setting change the block, and say when it is bound', () => {
    const doc = example('FT8 over SSB');
    // The message is a setting inside the transmitter subsystem.
    const message = control(doc, 'message');
    assert.equal(message.label, 'FT8 transmitter › Message');
    assert.equal(message.value, 'CQ K1ABC FN42');
    const sent = message.set(doc, 'K1ABC W9XYZ -12');
    assert.equal(
      diagramAt(sent, ['ft8'])!.blocks.find((b) => b.id === 'message')!.params
        .message,
      'K1ABC W9XYZ -12',
    );

    const bound = controlState(doc, resolveBindings(doc), [], {
      id: 'x',
      kind: 'control',
      x: 0,
      y: 0,
      params: { target: 'receiver.noise' },
    });
    assert.ok(!('problem' in bound) && bound.binding === '-3 - snr');
    assert.ok(!('problem' in bound) && bound.bound === 7);
  });

  test('explain a control that sets nothing', () => {
    const doc = am();
    const state = controlState(doc, resolveBindings(doc), [], {
      id: 'x',
      kind: 'control',
      x: 0,
      y: 0,
      params: { target: 'nope' },
    });
    assert.deepEqual(state, { problem: 'No parameter is called "nope".' });
  });

  test('list what a control can set and a readout can show', () => {
    const doc = example('FT8 over SSB');
    const targets = settables(doc, []).map((s) => s.target);
    assert.ok(targets.includes('snr'));
    assert.ok(targets.includes('ft8/message.message'));
    assert.ok(!targets.some((t) => t.startsWith('rxWaterfall.')));

    const shown = readables(doc, []).map((r) => r.label);
    assert.ok(shown.includes('FT8 decoder › Message'));
    assert.ok(shown.includes('Symbol mapper › Tone'));
  });

  test('lead to the blocks they act on', () => {
    const doc = am();
    const of = (id: string) =>
      instrumentLeads(
        doc,
        doc.blocks.find((b) => b.id === id)!,
      );
    assert.deepEqual(of('carrierKnob').sort(), ['carrier', 'tuned']);
    assert.deepEqual(of('rcKnob'), ['detector']);
    assert.deepEqual(of('cnKnob'), ['receiver']);
  });

  test('fill the face without overlapping', () => {
    const doc = am();
    const items = faceItems(doc);
    const layout = layoutFace(items, undefined, 12, () => ({ w: 5, h: 3 }));
    const cells = new Set<string>();
    for (const spot of layout.values()) {
      assert.ok(spot.x + spot.w <= 12);

      for (let y = spot.y; y < spot.y + spot.h; y++) {
        for (let x = spot.x; x < spot.x + spot.w; x++) {
          assert.ok(!cells.has(`${x},${y}`), `${x},${y} is taken twice`);
          cells.add(`${x},${y}`);
        }
      }
    }

    // Saved spots stay where they are.
    const saved = layoutFace(items, doc.face, 20, () => ({ w: 5, h: 3 }));
    assert.deepEqual(saved.get('onAir'), doc.face!.onAir);
  });

  test('come from probes in documents saved before them', () => {
    const doc = readDocument({
      format: 'signal-lab/2',
      title: 'old',
      notes: '',
      duration: 0.01,
      blocks: [{ id: 'osc', kind: 'oscillator', x: 0, y: 0, params: {} }],
      wires: [],
      probes: [{ id: 'p1', at: { block: 'osc', port: 0 }, view: 'spectrum' }],
    });
    const plot = doc.blocks.find((b) => b.kind === 'plot');
    assert.equal(plot?.params.view, 'spectrum');
    assert.deepEqual(
      doc.wires.map((w) => [w.from.block, w.to.block]),
      [['osc', plot!.id]],
    );
  });
});

describe('FT8 readings', () => {
  test('follow the transmission symbol by symbol, and the decode comes as the slot ends', () => {
    const doc = example('FT8 over SSB');
    const s = new Stream(blockType);
    s.load(flatten(doc).circuit);

    // Every block's readings as they last stood.
    const latest = new Map<string, readonly Reading[]>();
    const at = (t: number, id: string) => {
      s.advance(t, (chunk) => {
        for (const [block, readings] of chunk.readings) {
          latest.set(block, readings);
        }
      });
      return (label: string) =>
        latest.get(id)?.find((r) => r.label === label)?.value;
    };

    // The transmission starts 0.5 s into the slot and each symbol lasts 0.16 s.
    assert.equal(at(0.4, 'ft8/mapper')('Symbol'), undefined);
    assert.equal(at(0.51, 'ft8/mapper')('Symbol'), '1 of 79');
    assert.equal(at(0.5 + 0.16 + 0.01, 'ft8/mapper')('Carries'), 'sync');
    assert.match(
      String(at(0.5 + 7 * 0.16 + 0.01, 'ft8/mapper')('Carries')),
      /^[01]{3}$/,
    );
    assert.equal(
      at(0.5 + 10 * 0.16 + 0.01, 'ft8/mapper')('Symbol'),
      '11 of 79',
    );
    // The message fills in from the left as its bits go out, and as they are heard.
    // The bits run a symbol ahead of the tones: by 3.2 s, ten symbols' worth.
    const message = at(3.2, 'ft8/message');
    assert.equal(message('Sent'), 'CQ ······ ····');
    // Bit 33 is in the second callsign, which packs to one 28-bit number.
    assert.equal(message('Bit'), '33 of 77');
    assert.equal(message('Field'), 'Call 2: K1ABC');
    assert.equal(message('Number'), '10214965');
    assert.equal(at(5.7, 'ft8/message')('Sent'), 'CQ K1ABC FN42');
    assert.equal(at(5.71, 'decoder')('Heard'), 'CQ K1ABC FN42');
    const decoded = at(15.01, 'decoder');
    assert.equal(decoded('Message'), 'CQ K1ABC FN42');
    assert.match(String(decoded('Tone errors')), /^\d+ of 79$/);
    // And again in the next slot.
    assert.equal(at(15.51, 'ft8/mapper')('Symbol'), '1 of 79');
  });
});

describe('instruments outside a subsystem', () => {
  const reaches = (doc: LabDocument, path: string[]) =>
    reachingIn(doc, path).map(
      ({ id, label, sets, block }) =>
        `${label} ${sets ? 'sets' : 'reads'} ${block} (${id})`,
    );

  test('show at the blocks they set or read, in this copy', () => {
    assert.deepEqual(reaches(example('FT8 over SSB'), ['ft8']), [
      'Message sets message (message)',
      'Sent reads message (sent)',
      'Symbol reads mapper (symbol)',
      'Tone reads mapper (tone)',
      'Carries reads mapper (carries)',
    ]);
    // Station B's controls set its parameters, which its blocks use. Station
    // A, built the same way, has none.
    const two = example('Two stations on the air');
    assert.deepEqual(reaches(two, ['stationB']), [
      'B carrier sets carrier (carrierB)',
      'B mu sets mu (muB)',
    ]);
    assert.deepEqual(reaches(two, ['stationA']), []);
    assert.deepEqual(reaches(am(), []), []);
  });

  test('a parameter of the same name inside hides the one outside', () => {
    const inner = (own: boolean) =>
      diagram(
        {
          in: { kind: 'terminal-in', x: 0, y: 0 },
          scale: {
            kind: 'gain',
            x: 100,
            y: 0,
            params: {},
            bindings: { gain: 'k' },
          },
          out: { kind: 'terminal-out', x: 200, y: 0 },
        },
        [
          ['in', 'scale'],
          ['scale', 'out'],
        ],
        undefined,
        own ? [{ name: 'k', value: 2, min: 0, max: 4 }] : [],
      );
    const doc: LabDocument = {
      format: FORMAT,
      title: 'test',
      notes: '',
      ...diagram(
        {
          hides: { kind: 'subsystem', x: 0, y: 0, inner: inner(true) },
          sees: { kind: 'subsystem', x: 0, y: 80, inner: inner(false) },
          knob: controlPart(0, 160, 'k', 'K'),
        },
        [],
        undefined,
        [{ name: 'k', value: 1, min: 0, max: 4 }],
      ),
    };
    assert.deepEqual(reaches(doc, ['sees']), ['K sets scale (knob)']);
    assert.deepEqual(reaches(doc, ['hides']), []);
  });
});

describe('Bits to tones', () => {
  const encoding = () => example('FT8: from a message to audio');
  // Every block running at 12 kHz, as the example does.
  const running = (doc: LabDocument) => ({
    status: new Map(
      everyBlock(doc).map(({ id }) => [
        id,
        { state: 'ok' as const, rates: [12000, 12000] },
      ]),
    ),
    bindings: resolveBindings(doc),
  });
  const view = (doc: LabDocument) =>
    faceItems(doc).find((item) => item.id === 'bitsToTones')!;

  test("watches the mapper's bits and tone, and the glide after it", () => {
    const doc = encoding();
    const sources = symbolSources(doc, view(doc), running(doc));
    assert.ok(!('problem' in sources), JSON.stringify(sources));
    assert.equal(sources.start, 0.5);
    assert.deepEqual(sources.tone, { block: 'mapper', port: 0 });
    assert.deepEqual(sources.bits, { block: 'ldpc', port: 0 });
    assert.deepEqual(sources.glide?.at, { block: 'smooth', port: 0 });
    // The Gaussian filter reaches 4 sigma, 509 samples at 12 kHz: 42.4 ms.
    assert.equal(sources.glide?.lag, 509 / 12000);
    assert.ok(Math.abs(sources.glide!.lag - 0.0424) < 1e-4);
  });

  test('a plot stacked under it joins it, lined up behind the filter', () => {
    const doc = encoding();
    const sources = symbolSources(doc, view(doc), running(doc));
    assert.ok(!('problem' in sources));
    assert.deepEqual(
      sources.stacked.map((row) => [row.item.id, row.at, row.lag]),
      [['basebandPlot', { block: 'slowKeyer', port: 0 }, 509 / 12000]],
    );
    // It has no card of its own on the face, but is still a face item.
    assert.ok(faceItems(doc).some((item) => item.id === 'basebandPlot'));
    assert.ok(!faceCards(doc).some((item) => item.id === 'basebandPlot'));
  });

  test('leads to its mapper, and follows it into a subsystem', () => {
    const doc = encoding();
    const block = doc.blocks.find((b) => b.id === 'bitsToTones')!;
    assert.deepEqual(instrumentLeads(doc, block), ['mapper']);
    const { doc: grouped, id } = groupAt(doc, [], new Set(['mapper']))!;
    const moved = grouped.blocks.find((b) => b.id === 'bitsToTones')!;
    assert.equal(moved.params.block, `${id}/mapper`);
    const sources = symbolSources(grouped, view(grouped), running(grouped));
    assert.ok(!('problem' in sources), JSON.stringify(sources));
    assert.equal(sources.mapper, `${id}/mapper`);
  });

  test('says what is missing', () => {
    const doc = encoding();
    const item = view(doc);
    const unset = { ...item, block: { ...item.block, params: {} } };
    assert.deepEqual(symbolSources(doc, unset, running(doc)), {
      problem: 'Choose the FT8 symbol mapper it shows.',
    });
    const wrong = {
      ...item,
      block: { ...item.block, params: { block: 'smooth' } },
    };
    assert.match(
      (symbolSources(doc, wrong, running(doc)) as { problem: string }).problem,
      /is not an FT8 symbol mapper/,
    );
  });
});
