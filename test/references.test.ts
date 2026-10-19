import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../src/blocks/terminals.ts';
import { control, diagram } from '../src/model/build.ts';
import {
  blockAt,
  diagramAt,
  duplicate,
  everyBlock,
  isSubsystem,
  FORMAT,
  renameParameterAt,
  renameProblem,
  resolveRef,
  updateDiagramAt,
  updateParameter,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { resolveBindings } from '../src/model/flatten.ts';
import {
  controlState,
  faceCards,
  faceItems,
  reachingIn,
} from '../src/model/instruments.ts';
import { groupAt, ungroupAt } from '../src/model/subsystems.ts';
import { simulateDocument } from './helpers.ts';

const documentOf = (inside: Diagram): LabDocument => ({
  format: FORMAT,
  title: 'test',
  notes: '',
  ...inside,
});

const am = () =>
  examples.find((e) => e.title === 'AM with an envelope detector')!.build();

/** The same signal from two documents, sample for sample. */
function sameOutput(a: LabDocument, b: LabDocument, port: string): void {
  const x = simulateDocument(a, 0.02).signals.get(port)!.data;
  const y = simulateDocument(b, 0.02).signals.get(port)!.data;
  assert.equal(x.length, y.length);
  assert.ok(
    x.every((v, i) => v === y[i]),
    `${port} changed`,
  );
}

const blockOf = (doc: LabDocument, id: string): LabBlock =>
  doc.blocks.find((b) => b.id === id)!;

/** A subsystem with its own parameter f driving an oscillator inside. */
const withF = (value: number) =>
  diagram(
    {
      osc: {
        kind: 'oscillator',
        x: 0,
        y: 0,
        params: { frequency: 1000, rate: 48000 },
        bindings: { frequency: 'f' },
      },
    },
    [],
    undefined,
    [{ name: 'f', value, min: 0, max: 20000 }],
  );

describe('ungrouping', () => {
  test("keeps the subsystem's parameters, and what they set", () => {
    // The detector's rc turned up from 20 us, as its slider would.
    const before = updateDiagramAt(am(), ['detector'], (d) =>
      updateParameter(d, 'rc', { value: 200e-6 }),
    );
    const after = ungroupAt(before, [], 'detector');
    assert.deepEqual([...resolveBindings(after).errors], []);
    assert.equal(
      after.parameters?.find((p) => p.name === 'rc')?.value,
      200e-6,
    );
    assert.deepEqual(resolveBindings(after).values.get('capacitor'), {
      rc: 200e-6,
    });
    sameOutput(before, after, 'audio:0');
  });

  test('a parameter bound outside brings its expression with it', () => {
    const doc = documentOf(
      diagram(
        { sub: { kind: 'subsystem', x: 0, y: 0, inner: withF(500) } },
        [],
        undefined,
        [{ name: 'k', value: 300, min: 0, max: 1000 }],
      ),
    );
    const bound = {
      ...doc,
      blocks: doc.blocks.map((b) => ({ ...b, bindings: { f: '2 * k' } })),
    };
    assert.deepEqual(resolveBindings(bound).values.get('sub/osc'), {
      frequency: 600,
    });
    const after = ungroupAt(bound, [], 'sub');
    assert.deepEqual([...resolveBindings(after).errors], []);
    assert.deepEqual(resolveBindings(after).values.get('osc'), {
      frequency: 600,
    });
  });

  test('a parameter whose name is taken outside moves out under a new one', () => {
    const doc = documentOf(
      diagram(
        {
          sub: { kind: 'subsystem', x: 0, y: 0, inner: withF(500) },
          knob: control(0, 100, 'sub.f'),
        },
        [],
        undefined,
        [{ name: 'f', value: 9000, min: 0, max: 20000 }],
      ),
    );
    const after = ungroupAt(doc, [], 'sub');
    assert.deepEqual([...resolveBindings(after).errors], []);
    assert.deepEqual(resolveBindings(after).values.get('osc'), {
      frequency: 500,
    });
    assert.deepEqual(
      after.parameters?.map((p) => [p.name, p.value]),
      [
        ['f', 9000],
        ['f2', 500],
      ],
    );
    // The knob that set the subsystem's f now sets the parameter it became.
    assert.equal(blockOf(after, 'knob').params.target, 'f2');
  });
});

describe('renaming a parameter', () => {
  test('leaves alone an inner scope with a parameter of its own by that name', () => {
    const doc = documentOf(
      diagram(
        { sub: { kind: 'subsystem', x: 0, y: 0, inner: withF(500) } },
        [],
        undefined,
        [{ name: 'f', value: 9000, min: 0, max: 20000 }],
      ),
    );
    const renamed = renameParameterAt(doc, [], 'f', 'g');
    assert.deepEqual(resolveBindings(renamed).values.get('sub/osc'), {
      frequency: 500,
    });
    assert.equal(
      diagramAt(renamed, ['sub'])!.blocks[0]!.bindings?.frequency,
      'f',
    );
  });

  test("a subsystem's own, and what sets it from outside", () => {
    const doc = documentOf(
      diagram(
        {
          sub: {
            kind: 'subsystem',
            x: 0,
            y: 0,
            inner: withF(500),
            bindings: { f: '700' },
          },
          knob: control(0, 100, 'sub.f'),
        },
        [],
      ),
    );
    const renamed = renameParameterAt(doc, ['sub'], 'f', 'g');
    assert.deepEqual([...resolveBindings(renamed).errors], []);
    assert.deepEqual(blockOf(renamed, 'sub').bindings, { g: '700' });
    assert.deepEqual(resolveBindings(renamed).values.get('sub/osc'), {
      frequency: 700,
    });
    const knob = blockOf(renamed, 'knob');
    assert.equal(knob.params.target, 'sub.g');
    assert.ok(
      !(
        'problem' in controlState(renamed, resolveBindings(renamed), [], knob)
      ),
    );
  });
});

describe('duplicating', () => {
  const panel = () =>
    diagram(
      {
        osc: { kind: 'oscillator', x: 0, y: 0, params: { rate: 48000 } },
        knob: control(0, 100, 'osc.frequency'),
        level: {
          kind: 'readout',
          x: 0,
          y: 200,
          params: { block: 'osc', reading: 'Frequency' },
        },
      },
      [],
    );

  test('copied instruments act on the copies of what they acted on', () => {
    const [next, ids] = duplicate(panel(), new Set(['osc', 'knob', 'level']));
    const copy = (kind: string) =>
      next.blocks.find((b) => ids.includes(b.id) && b.kind === kind)!;
    const osc = copy('oscillator').id;
    assert.equal(copy('control').params.target, `${osc}.frequency`);
    assert.equal(copy('readout').params.block, osc);
  });

  test('an instrument copied alone still acts on the original', () => {
    const [next, ids] = duplicate(panel(), new Set(['knob']));
    const knob = next.blocks.find((b) => b.id === ids[0])!;
    assert.equal(knob.params.target, 'osc.frequency');
  });

  test('a plot stacked under a view, copied with it, stacks under the copy', () => {
    const inner = diagram(
      {
        view: {
          kind: 'symbols',
          x: 0,
          y: 0,
          params: { block: 'mapper' },
        },
        scope: { kind: 'plot', x: 0, y: 100, params: { stack: 'sub/view' } },
      },
      [],
    );
    const [next, ids] = duplicate(inner, new Set(['view', 'scope']), 24, 24, [
      'sub',
    ]);
    const view = next.blocks.find(
      (b) => ids.includes(b.id) && b.kind === 'symbols',
    )!;
    const scope = next.blocks.find(
      (b) => ids.includes(b.id) && b.kind === 'plot',
    )!;
    assert.equal(scope.params.stack, `sub/${view.id}`);
  });
});

describe('names keep what they stand for', () => {
  /** An oscillator whose frequency is bound to `expression`. */
  const oscillator = (expression: string, y = 0) => ({
    kind: 'oscillator',
    x: 0,
    y,
    params: { frequency: 1, rate: 48000 },
    bindings: { frequency: expression },
  });
  const frequency = (doc: LabDocument, id: string) =>
    resolveBindings(doc).values.get(id)?.frequency;

  test('ungrouping keeps a bound expression meaning what it meant outside', () => {
    // f = 2 * k, with k = 300 out here; deeper inside, a k of its own is 100.
    const nested = diagram({ osc: oscillator('f') }, [], undefined, [
      { name: 'k', value: 100, min: 0, max: 1000 },
    ]);
    const inner = diagram(
      { deeper: { kind: 'subsystem', x: 0, y: 0, inner: nested } },
      [],
      undefined,
      [{ name: 'f', value: 1, min: 0, max: 20000 }],
    );
    const doc = documentOf(
      diagram(
        {
          sub: {
            kind: 'subsystem',
            x: 0,
            y: 0,
            inner,
            bindings: { f: '2 * k' },
          },
        },
        [],
        undefined,
        [{ name: 'k', value: 300, min: 0, max: 1000 }],
      ),
    );
    assert.equal(frequency(doc, 'sub/deeper/osc'), 600);
    const after = ungroupAt(doc, [], 'sub');
    assert.deepEqual([...resolveBindings(after).errors], []);
    assert.equal(frequency(after, 'deeper/osc'), 600);
  });

  test("ungrouping doesn't hide a parameter from further out", () => {
    // p = 7 at the top; inside "outer", x uses it, and "sub" has its own p = 3.
    const sub = diagram({ y: oscillator('p') }, [], undefined, [
      { name: 'p', value: 3, min: 0, max: 10 },
    ]);
    const outer = diagram(
      {
        x: oscillator('p'),
        sub: { kind: 'subsystem', x: 0, y: 100, inner: sub },
      },
      [],
    );
    const doc = documentOf(
      diagram(
        { outer: { kind: 'subsystem', x: 0, y: 0, inner: outer } },
        [],
        undefined,
        [{ name: 'p', value: 7, min: 0, max: 10 }],
      ),
    );
    const after = ungroupAt(doc, ['outer'], 'sub');
    assert.deepEqual([...resolveBindings(after).errors], []);
    assert.equal(frequency(after, 'outer/x'), 7);
    assert.equal(frequency(after, 'outer/y'), 3);
  });

  test('renaming refuses a name that something here uses from further out', () => {
    // g = 9000 at the top; inside, f = 500, and one oscillator uses g.
    const inner = diagram(
      { one: oscillator('f'), two: oscillator('g', 100) },
      [],
      undefined,
      [{ name: 'f', value: 500, min: 0, max: 20000 }],
    );
    const doc = documentOf(
      diagram(
        { sub: { kind: 'subsystem', x: 0, y: 0, inner } },
        [],
        undefined,
        [{ name: 'g', value: 9000, min: 0, max: 20000 }],
      ),
    );
    assert.match(renameProblem(doc, ['sub'], 'f', 'g') ?? '', /"g"/);
    assert.equal(renameProblem(doc, ['sub'], 'f', 'h'), undefined);
  });
});

describe('ungrouping feedback', () => {
  test('a loop wired around a subsystem goes on through what was inside', () => {
    // An accumulator: 1 in, and the sum delayed a sample comes back round.
    const inner = diagram(
      {
        x: { kind: INPUT_TERMINAL, x: 0, y: 0 },
        back: { kind: INPUT_TERMINAL, x: 0, y: 80 },
        sum: { kind: 'adder', x: 100, y: 0 },
        hold: { kind: 'delay', x: 200, y: 0, params: { time: 0.001 } },
        out: { kind: OUTPUT_TERMINAL, x: 300, y: 0 },
      },
      [
        ['x', 'sum:0'],
        ['back', 'sum:1'],
        ['sum', 'hold'],
        ['hold', 'out'],
      ],
    );
    const doc = documentOf(
      diagram(
        {
          one: { kind: 'constant', x: 0, y: 0, params: { rate: 1000 } },
          acc: { kind: 'subsystem', x: 100, y: 0, inner },
        },
        [
          ['one', 'acc:0'],
          ['acc', 'acc:1'],
        ],
      ),
    );
    const head = (d: LabDocument, port: string) => [
      ...simulateDocument(d, 0.01).signals.get(port)!.data.slice(0, 6),
    ];
    assert.deepEqual(head(doc, 'acc:0'), [0, 1, 2, 3, 4, 5]);
    const after = ungroupAt(doc, [], 'acc');
    assert.ok(
      after.wires.every((w) => w.from.block !== 'acc' && w.to.block !== 'acc'),
      JSON.stringify(after.wires),
    );
    assert.deepEqual(head(after, 'hold:0'), [0, 1, 2, 3, 4, 5]);
  });
});

describe('duplicating a subsystem', () => {
  test('a plot inside stacked under a view inside stacks under the copy', () => {
    const inner = diagram(
      {
        view: { kind: 'symbols', x: 0, y: 0, params: { block: 'mapper' } },
        scope: { kind: 'plot', x: 0, y: 100, params: { stack: 'sub/view' } },
      },
      [],
    );
    const doc = documentOf(
      diagram({ sub: { kind: 'subsystem', x: 0, y: 0, inner } }, []),
    );
    const [next, [copy]] = duplicate(doc, new Set(['sub']));
    const stackOf = (id: string) =>
      diagramAt(next, [id])!.blocks.find((b) => b.id === 'scope')!.params
        .stack;
    assert.equal(stackOf('sub'), 'sub/view');
    assert.equal(stackOf(copy!), `${copy}/view`);
    // Each plot joins its own view, so neither has a screen of its own.
    const plots = faceItems(next).filter((i) => i.block.kind === 'plot');
    assert.equal(plots.length, 2);
    assert.ok(!faceCards(next).some((i) => i.block.kind === 'plot'));
  });
});

describe('duplicating several subsystems', () => {
  const plot = (stack: string) => ({
    kind: 'plot',
    x: 0,
    y: 0,
    params: { stack },
  });
  const view = { kind: 'symbols', x: 0, y: 0, params: { block: 'mapper' } };
  const sub = (inner: Diagram) => ({ kind: 'subsystem', x: 0, y: 0, inner });

  test('a copied plot stacks under the copy of a view copied with it, wherever each sits', () => {
    for (const plotInside of [false, true]) {
      for (const viewInside of [false, true]) {
        const host = viewInside ? 'b/view' : 'view';
        const doc = documentOf(
          diagram(
            {
              ...(plotInside
                ? { a: sub(diagram({ scope: plot(host) }, [])) }
                : { scope: plot(host) }),
              ...(viewInside ? { b: sub(diagram({ view }, [])) } : { view }),
            },
            [],
          ),
        );
        const [next, [a, b]] = duplicate(
          doc,
          new Set(doc.blocks.map((block) => block.id)),
        );
        const copied = blockAt(next, plotInside ? `${a}/scope` : a!)!;
        assert.equal(
          copied.params.stack,
          viewInside ? `${b}/view` : b,
          `plot ${plotInside ? 'inside' : 'outside'}, view ${viewInside ? 'inside' : 'outside'}`,
        );
      }
    }
  });

  test('a control inside one sets the copy of what it set in the other', () => {
    const doc = documentOf(
      diagram(
        {
          a: sub(diagram({ knob: control(0, 0, '../b/osc.frequency') }, [])),
          b: sub(
            diagram(
              {
                osc: {
                  kind: 'oscillator',
                  x: 0,
                  y: 0,
                  params: { rate: 48000 },
                },
              },
              [],
            ),
          ),
        },
        [],
      ),
    );
    const [next, [a, b]] = duplicate(doc, new Set(['a', 'b']));
    assert.equal(
      blockAt(next, `${a}/knob`)!.params.target,
      `../${b}/osc.frequency`,
    );
    assert.equal(blockAt(next, 'a/knob')!.params.target, '../b/osc.frequency');
  });
});

describe('instruments across subsystem edges', () => {
  const oscillator = {
    kind: 'oscillator',
    x: 0,
    y: 0,
    params: { frequency: 1000, rate: 48000 },
  };

  test('a control outside follows a parameter out of a subsystem ungrouped further in', () => {
    const inner = diagram(
      { osc: { ...oscillator, bindings: { frequency: 'f' } } },
      [],
      undefined,
      [{ name: 'f', value: 500, min: 1, max: 10000 }],
    );
    const doc = documentOf(
      diagram(
        {
          outer: {
            kind: 'subsystem',
            x: 0,
            y: 0,
            inner: diagram(
              { sub: { kind: 'subsystem', x: 0, y: 0, inner } },
              [],
            ),
          },
          knob: control(0, 100, 'outer/sub.f'),
        },
        [],
      ),
    );
    const after = ungroupAt(doc, ['outer'], 'sub');
    const knob = blockOf(after, 'knob');
    assert.equal(knob.params.target, 'outer.f');
    const state = controlState(after, resolveBindings(after), [], knob);
    assert.ok(!('problem' in state), JSON.stringify(state));
    const turned = state.set(after, 700);
    assert.equal(
      resolveBindings(turned).values.get('outer/osc')?.frequency,
      700,
    );
  });

  test('a control grouped without what it sets reaches back out to it', () => {
    const doc = documentOf(
      diagram(
        {
          osc: oscillator,
          knob: control(0, 100, 'osc.frequency'),
          reading: {
            kind: 'readout',
            x: 0,
            y: 200,
            params: { block: 'osc', reading: 'Frequency' },
          },
        },
        [],
      ),
    );
    const { doc: grouped, id } = groupAt(
      doc,
      [],
      new Set(['knob', 'reading']),
    )!;
    const knob = blockAt(grouped, `${id}/knob`)!;
    assert.equal(knob.params.target, '../osc.frequency');
    assert.equal(blockAt(grouped, `${id}/reading`)!.params.block, '../osc');
    const state = controlState(grouped, resolveBindings(grouped), [id], knob);
    assert.ok(!('problem' in state), JSON.stringify(state));
    assert.equal(state.label, 'Oscillator › Frequency');
    assert.equal(
      blockOf(state.set(grouped, 440), 'osc').params.frequency,
      440,
    );

    // And back again.
    const back = ungroupAt(grouped, [], id);
    assert.equal(blockOf(back, 'knob').params.target, 'osc.frequency');
    assert.equal(blockOf(back, 'reading').params.block, 'osc');
  });

  test('a control in one subsystem reaching into another shows there', () => {
    const doc = documentOf(
      diagram(
        { osc: oscillator, knob: control(0, 100, 'osc.frequency', 'Pitch') },
        [],
      ),
    );
    const first = groupAt(doc, [], new Set(['osc']))!;
    const second = groupAt(first.doc, [], new Set(['knob']))!;
    const knob = blockAt(second.doc, `${second.id}/knob`)!;
    assert.equal(knob.params.target, `../${first.id}/osc.frequency`);
    assert.deepEqual(reachingIn(second.doc, [first.id]), [
      { id: `${second.id}/knob`, label: 'Pitch', sets: true, block: 'osc' },
    ]);
  });
});

describe('every example', () => {
  /**
   * What every instrument acts on, worked out, in a fixed order: a control's
   * setting and value, the kind of block a readout or view reads, and the kind
   * a plot is stacked under.
   */
  const actsOn = (doc: LabDocument) => {
    const bindings = resolveBindings(doc);
    const kindAt = (path: Path, ref: string) => {
      const id = resolveRef(path, ref);
      return (id !== undefined && blockAt(doc, id)?.kind) || 'nothing';
    };

    return everyBlock(doc)
      .flatMap(({ path, block }) => {
        switch (block.kind) {
          case 'control': {
            const state = controlState(doc, bindings, path, block);
            return [
              'problem' in state
                ? `control: ${state.problem}`
                : `control ${state.spec.label} ${state.value} ${state.bound}`,
            ];
          }

          case 'readout':
          case 'symbols':
            return [
              `${block.kind} ${kindAt(path, String(block.params.block ?? ''))}`,
            ];
          case 'plot':
            return block.params.stack
              ? [`plot under ${kindAt([], String(block.params.stack))}`]
              : [];
          default:
            return [];
        }
      })
      .sort();
  };

  test('grouping any block on its own, at any depth, leaves every instrument acting on what it did', () => {
    let checked = 0;
    for (const example of examples) {
      const doc = example.build();
      const before = actsOn(doc);
      for (const { path, block } of everyBlock(doc)) {
        const grouped = groupAt(doc, path, new Set([block.id]));
        if (!grouped) {
          continue;
        }

        const where = `${example.title}: ${[...path, block.id].join('/')}`;
        assert.deepEqual(actsOn(grouped.doc), before, where);
        assert.deepEqual(
          actsOn(ungroupAt(grouped.doc, path, grouped.id)),
          before,
          `${where}, and back`,
        );
        checked++;
      }
    }

    assert.ok(checked >= 100, `only ${checked} blocks`);
  });

  /** What every block that isn't a subsystem has bound, in a fixed order. */
  const boundValues = (doc: LabDocument) => {
    const { values } = resolveBindings(doc);
    return everyBlock(doc)
      .filter(({ block }) => !isSubsystem(block))
      .flatMap(({ id, block }) =>
        Object.entries(values.get(id) ?? {}).map(
          ([setting, value]) => `${block.kind} ${setting} ${value}`,
        ),
      )
      .sort();
  };

  test('ungrouping any subsystem, at any depth, leaves every bound value and instrument as it was', () => {
    let checked = 0;
    for (const example of examples) {
      const doc = example.build();
      const before = boundValues(doc);
      for (const { path, block } of everyBlock(doc)) {
        if (!isSubsystem(block)) {
          continue;
        }

        const after = ungroupAt(doc, path, block.id);
        assert.deepEqual(
          [...resolveBindings(after).errors],
          [...resolveBindings(doc).errors],
          `${example.title}: ${[...path, block.id].join('/')}`,
        );
        assert.deepEqual(
          boundValues(after),
          before,
          `${example.title}: ${[...path, block.id].join('/')}`,
        );
        assert.deepEqual(
          actsOn(after),
          actsOn(doc),
          `${example.title}: ${[...path, block.id].join('/')}`,
        );
        checked++;
      }
    }

    assert.ok(checked >= 5, `only ${checked} subsystems`);
  });
});
