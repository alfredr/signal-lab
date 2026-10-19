import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../src/blocks/terminals.ts';
import { diagram } from '../src/model/build.ts';
import {
  addParameter,
  diagramAt,
  FORMAT,
  freeParameterName,
  readDocument,
  renameParameter,
  setBinding,
  updateParameter,
  type Diagram,
  type LabDocument,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { flatten, resolveBindings } from '../src/model/flatten.ts';
import { simulateDocument } from './helpers.ts';

/** A document around a diagram. */
const documentOf = (inside: Diagram): LabDocument => ({
  format: FORMAT,
  title: 'test',
  notes: '',
  ...inside,
});

const engineParams = (doc: LabDocument, id: string) =>
  flatten(doc).circuit.blocks.find((b) => b.id === id)?.params;

/** A document with parameter fc driving an oscillator and a band-pass filter. */
function tuned(): LabDocument {
  const base: LabDocument = {
    format: FORMAT,
    title: 'test',
    notes: '',
    ...diagram(
      {
        lo: {
          kind: 'oscillator',
          x: 0,
          y: 0,
          params: { frequency: 1000, rate: 384000 },
        },
        filter: { kind: 'bandpass', x: 100, y: 0, params: { center: 1000 } },
      },
      [['lo', 'filter']],
    ),
  };
  const withParameter = addParameter(base, {
    name: 'fc',
    value: 90e3,
    min: 1e3,
    max: 190e3,
    unit: 'Hz',
  });
  return setBinding(
    setBinding(withParameter, 'lo', 'frequency', 'fc'),
    'filter',
    'center',
    'fc + 0',
  );
}

describe('parameters and bindings', () => {
  test('one parameter drives settings on several blocks', () => {
    const doc = tuned();
    assert.equal(engineParams(doc, 'lo')?.frequency, 90e3);
    assert.equal(engineParams(doc, 'filter')?.center, 90e3);
    // The stored values stay as they were; the bindings win.
    assert.equal(
      doc.blocks.find((b) => b.id === 'lo')?.params.frequency,
      1000,
    );
  });

  test("a subsystem's parameter, bound from outside, reaches the block inside", () => {
    const inner = addParameter(
      diagram(
        {
          in: { kind: INPUT_TERMINAL, x: 0, y: 0 },
          cap: { kind: 'capacitor', x: 100, y: 0 },
          out: { kind: OUTPUT_TERMINAL, x: 200, y: 0 },
        },
        [
          ['in', 'cap'],
          ['cap', 'out'],
        ],
      ),
      { name: 'rc', value: 20e-6, min: 1e-6, max: 1e-3, unit: 's' },
    );
    const bound = setBinding(inner, 'cap', 'rc', 'rc');
    const outer = addParameter(
      documentOf(
        diagram({ sub: { kind: 'subsystem', x: 0, y: 0, inner: bound } }, []),
      ),
      { name: 'base', value: 30e-6, min: 0, max: 1 },
    );
    assert.equal(engineParams(outer, 'sub/cap')?.rc, 20e-6);
    const driven = setBinding(outer, 'sub', 'rc', '2 * base');
    assert.equal(engineParams(driven, 'sub/cap')?.rc, 60e-6);
  });

  test('an inner parameter shadows an outer one of the same name', () => {
    const inner = setBinding(
      addParameter(diagram({ osc: { kind: 'oscillator', x: 0, y: 0 } }, []), {
        name: 'f',
        value: 500,
        min: 1,
        max: 1e4,
      }),
      'osc',
      'frequency',
      'f',
    );
    const doc = addParameter(
      documentOf(
        diagram({ sub: { kind: 'subsystem', x: 0, y: 0, inner } }, []),
      ),
      { name: 'f', value: 9000, min: 1, max: 1e4 },
    );
    assert.equal(engineParams(doc, 'sub/osc')?.frequency, 500);
  });

  test('a binding that fails shows as an error on its block', () => {
    const doc = setBinding(tuned(), 'filter', 'center', 'f0 * 2');
    const status = simulateDocument(doc).status.get('filter');
    assert.equal(status?.state, 'error');
    assert.match(
      status.state === 'error' ? status.message : '',
      /No parameter is called "f0"/,
    );
    const notNumber = setBinding(tuned(), 'filter', 'order', '4');
    const other = simulateDocument(notNumber).status.get('filter');
    assert.match(
      other?.state === 'error' ? other.message : '',
      /no number setting "order"/,
    );
  });

  test('renaming a parameter rewrites the bindings that use it, inside subsystems too', () => {
    const renamed = renameParameter(tuned(), 'fc', 'carrier');
    assert.deepEqual(
      renamed.blocks.map((b) => b.bindings),
      [{ frequency: 'carrier' }, { center: 'carrier + 0' }],
    );
    assert.equal(engineParams(renamed, 'lo')?.frequency, 90e3);
  });

  test('picks free, valid names', () => {
    assert.equal(freeParameterName(tuned(), 'fc'), 'fc2');
    assert.equal(freeParameterName(tuned(), 'Band noise'), 'Band_noise');
    assert.equal(freeParameterName(tuned(), 'pi'), 'pi2');
  });

  test('parameters and bindings survive saving and loading', () => {
    const doc = tuned();
    const back = readDocument(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(back.parameters, doc.parameters);
    assert.deepEqual(
      diagramAt(back, [])?.blocks.map((b) => b.bindings),
      doc.blocks.map((b) => b.bindings),
    );
  });

  test('every example binds without errors', () => {
    for (const example of examples) {
      const { errors } = resolveBindings(example.build());
      assert.deepEqual([...errors], [], example.title);
    }
  });

  test('example parameters reach the blocks, inside subsystems too', () => {
    const byTitle = (title: string) =>
      examples.find((e) => e.title === title)!.build();
    const am = byTitle('AM with an envelope detector');
    assert.equal(engineParams(am, 'receiver')?.noise, -30);
    assert.equal(engineParams(am, 'detector/capacitor')?.rc, 20e-6);

    const two = byTitle('Two stations on the air');
    assert.equal(engineParams(two, 'stationB/carrier')?.frequency, 110e3);
    const retuned = updateParameter(two, 'tune', { value: 110e3 });
    assert.equal(engineParams(retuned, 'tuned')?.center, 110e3);
  });
});
