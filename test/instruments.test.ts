import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readingAt } from '../src/engine/block.ts';
import {
  diagramAt,
  readDocument,
  type LabDocument,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { flatten, resolveBindings } from '../src/model/flatten.ts';
import {
  controlState,
  faceItems,
  instrumentLeads,
  layoutFace,
  readables,
  settables,
} from '../src/model/instruments.ts';
import { simulateDocument } from './helpers.ts';

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
    const message = control(doc, 'message');
    assert.equal(message.label, 'FT8 transmitter › Message');
    assert.equal(message.value, 'CQ K1ABC FN42');
    const sent = message.set(doc, 'K1ABC W9XYZ -12');
    assert.equal(
      sent.blocks.find((b) => b.id === 'ft8')!.params.message,
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
    assert.ok(targets.includes('ft8.message'));
    assert.ok(!targets.some((t) => t.startsWith('rxWaterfall.')));

    const run = simulateDocument(doc);
    const shown = readables(doc, [], run.readings).map((r) => r.label);
    assert.ok(shown.includes('FT8 decoder › Message'));
    assert.ok(shown.includes('FT8 transmitter › Tone'));
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

describe('FT8 tracks', () => {
  test('follow the transmission symbol by symbol', () => {
    const doc = example('FT8 over SSB');
    const { readings } = simulateDocument(doc);
    const sent = readings.get('ft8')!;
    const symbol = sent.find((r) => r.label === 'Symbol')!;
    const carries = sent.find((r) => r.label === 'Carries')!;
    // The transmission starts at 0.5 s and each symbol lasts 0.16 s.
    assert.equal(readingAt(symbol, 0.4), undefined);
    assert.equal(readingAt(symbol, 0.51), '1 of 79');
    assert.equal(readingAt(symbol, 0.5 + 10 * 0.16 + 0.01), '11 of 79');
    assert.equal(readingAt(carries, 0.51), 'sync');
    assert.match(
      String(readingAt(carries, 0.5 + 7 * 0.16 + 0.01)),
      /^[01]{3}$/,
    );
    assert.equal(readingAt(symbol, undefined), '1–79');

    const heard = readings
      .get('decoder')!
      .find((r) => r.label === 'Tone heard')!;
    assert.match(String(heard.value), /^\d+ of 79 wrong$/);
    assert.match(String(readingAt(heard, 0.52 + 0.08)), /^\d [✓✗]/);
  });
});
