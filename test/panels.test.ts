import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { control, diagram, plot } from '../src/model/build.ts';
import {
  FORMAT,
  pruneRefs,
  readDocument,
  removeBlocks,
  type LabDocument,
} from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { faceCards } from '../src/model/instruments.ts';
import {
  addPane,
  addPanel,
  facePanels,
  moveInstrument,
  movePane,
  movePanel,
  layoutPane,
  paneWidth,
  removePane,
  removePanel,
  resizeInstrument,
  retitle,
  type Box,
  type FacePanel,
} from '../src/model/panels.ts';
import { groupAt, ungroupAt } from '../src/model/subsystems.ts';

const am = () =>
  examples.find((e) => e.title === 'AM with an envelope detector')!.build();

/** The face in short: each panel's title and its panes' titles and ids. */
const outline = (panels: readonly FacePanel[]) =>
  panels.map(
    (panel) =>
      `${panel.title}: ${panel.panes
        .map(
          (pane) =>
            `${pane.title} [${pane.entries.map((e) => e.id).join(' ')}]`,
        )
        .join(', ')}`,
  );

/** A document with three knobs and a plot at the top and none organized. */
const loose = (): LabDocument => ({
  format: FORMAT,
  title: 'loose',
  notes: '',
  ...diagram(
    {
      osc: { kind: 'oscillator', x: 0, y: 0, params: { rate: 48000 } },
      a: control(0, 100, 'osc.frequency'),
      b: control(0, 200, 'osc.amplitude'),
      scope: plot(200, 0, 'time'),
    },
    [['osc', 'scope']],
  ),
});

describe('panels and panes', () => {
  test('every example puts each of its instruments in a pane of its own choosing, once', () => {
    for (const example of examples) {
      const doc = example.build();
      const listed = (doc.panels ?? [])
        .flatMap((panel) => panel.panes)
        .flatMap((pane) => pane.items.map((item) => item.id));
      assert.equal(new Set(listed).size, listed.length, example.title);
      assert.deepEqual(
        listed.toSorted(),
        faceCards(doc)
          .map((item) => item.id)
          .toSorted(),
        example.title,
      );
    }
  });

  test('instruments in no pane get one for their kind, or their subsystem', () => {
    const doc = loose();
    assert.deepEqual(outline(facePanels(doc)), [
      ': Controls [a b], Screens [scope]',
    ]);
    // Grouped into a subsystem, the knobs get a pane named after it.
    const grouped = groupAt(doc, [], new Set(['osc', 'a', 'b']))!;
    assert.deepEqual(outline(facePanels(grouped.doc)), [
      `: Screens [scope], Subsystem [${grouped.id}/a ${grouped.id}/b]`,
    ]);
  });

  test('a new instrument shows in a pane at the end of the first panel', () => {
    const doc = am();
    const added: LabDocument = {
      ...doc,
      blocks: [
        ...doc.blocks,
        { id: 'extra', kind: 'plot', x: 0, y: 0, params: {} },
      ],
    };
    const [first] = facePanels(added);
    assert.deepEqual(
      first!.panes.at(-1)!.entries.map((e) => e.id),
      ['extra'],
    );
  });

  test('moving instruments and panes, and naming them', () => {
    let doc = am();
    doc = moveInstrument(doc, 'cnKnob', 'pane3', 0);
    doc = movePane(doc, 'pane3', 'panel1', 1);
    doc = retitle(doc, 'pane2', 'Air');
    doc = retitle(doc, 'panel2', 'Band');
    assert.deepEqual(outline(facePanels(doc)), [
      'Transmitter: Modulator [voiceScope carrierKnob muKnob], Detector [cnKnob rcKnob audioOut speaker]',
      'Band: Air [onAir]',
    ]);
    doc = movePanel(doc, 'panel2', 0);
    assert.equal(facePanels(doc)[0]!.title, 'Band');
  });

  test('adding and taking away panes and panels', () => {
    let doc = am();
    let pane: string | undefined;
    [doc, pane] = addPane(doc, 'panel1');
    doc = moveInstrument(doc, 'muKnob', pane!, 0);
    let panel: string;
    [doc, panel] = addPanel(doc);
    assert.equal(facePanels(doc).length, 3);
    // A pane taken away gives its instruments to the one before it.
    doc = removePane(doc, pane!);
    assert.deepEqual(
      facePanels(doc)[0]!.panes.map((q) =>
        q.entries.map((e) => e.id).join(' '),
      ),
      ['voiceScope carrierKnob muKnob'],
    );
    // A panel taken away gives its panes to the one before it; the last stays.
    doc = removePanel(doc, panel);
    doc = removePanel(doc, 'panel2');
    assert.deepEqual(outline(facePanels(doc)), [
      'Transmitter: Modulator [voiceScope carrierKnob muKnob], Antenna [onAir cnKnob], Detector [rcKnob audioOut speaker]',
    ]);
    assert.equal(removePanel(doc, 'panel1'), doc);
  });

  test('an instrument keeps the size it is given, until it is given its own back', () => {
    let doc = resizeInstrument(am(), 'onAir', { w: 10, h: 6 });
    const entry = () =>
      facePanels(doc)
        .flatMap((p) => p.panes)
        .flatMap((q) => q.entries)
        .find((e) => e.id === 'onAir')!;
    assert.deepEqual([entry().w, entry().h], [10, 6]);
    doc = resizeInstrument(doc, 'onAir', undefined);
    assert.deepEqual([entry().w, entry().h], [undefined, undefined]);
  });

  test('panes follow their instruments through grouping, deleting, saving and loading', () => {
    const doc = am();
    const grouped = groupAt(doc, [], new Set(['dcBlock', 'audioOut']))!;
    const paneOf = (d: LabDocument, id: string) =>
      facePanels(d)
        .flatMap((p) => p.panes)
        .find((q) => q.entries.some((e) => e.id === id))?.id;
    assert.equal(paneOf(grouped.doc, `${grouped.id}/audioOut`), 'pane3');
    assert.equal(
      paneOf(ungroupAt(grouped.doc, [], grouped.id), 'audioOut'),
      'pane3',
    );

    const pruned = pruneRefs(removeBlocks(doc, new Set(['speaker'])));
    assert.ok(
      !pruned
        .panels!.flatMap((p) => p.panes)
        .some((q) => q.items.some((i) => i.id === 'speaker')),
    );

    const loaded = readDocument(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(loaded.panels, doc.panels);
    // Saved with the old grid of spots, a document's instruments get panes.
    const { panels: _, ...old } = doc;
    const legacy = readDocument({
      ...JSON.parse(JSON.stringify(old)),
      face: { onAir: { x: 0, y: 0, w: 8, h: 5 } },
    });
    assert.equal(legacy.panels, undefined);
    assert.ok(facePanels(legacy).length === 1);
  });
});

describe('laying out a pane', () => {
  const knob = { kind: 'knob', w: 112, h: 112 } as const;
  const screen = { kind: 'screen', w: 312, h: 192 } as const;
  const lcd = { kind: 'display', w: 232, h: 72 } as const;

  /** No two boxes overlap, and every one is inside the width. */
  const tidy = (boxes: readonly Box[], width: number) => {
    boxes.forEach((a, i) => {
      assert.ok(
        a.x >= -0.5 && a.x + a.w <= width + 0.5,
        `box ${i} sticks out`,
      );
      boxes.slice(i + 1).forEach((b, k) => {
        const apart =
          a.x + a.w <= b.x + 0.5 ||
          b.x + b.w <= a.x + 0.5 ||
          a.y + a.h <= b.y + 0.5 ||
          b.y + b.h <= a.y + 0.5;
        assert.ok(apart, `boxes ${i} and ${i + 1 + k} overlap`);
      });
    });
  };

  /** The tops of the rows, and how many boxes are in each. */
  const rowsOf = (boxes: readonly Box[]) =>
    [...Map.groupBy(boxes, (b) => Math.round(b.y + b.h)).values()].map(
      (row) => row.length,
    );

  test('knobs fill the width in rows as even as can be, none left alone', () => {
    // Four fit across 500; five go three and two, not four and one.
    const { boxes } = layoutPane(Array(5).fill(knob), 500);
    tidy(boxes, 500);
    assert.deepEqual(rowsOf(boxes), [3, 2]);

    // Each row reaches from one side to the other.
    for (const row of [boxes.slice(0, 3), boxes.slice(3)]) {
      assert.ok(Math.abs(row[0]!.x) < 0.5);
      assert.ok(Math.abs(row.at(-1)!.x + row.at(-1)!.w - 500) < 0.5);
    }
  });

  test('displays fill their row, but beside knobs grow to no more than twice their width', () => {
    const { boxes } = layoutPane([lcd, lcd], 600);
    tidy(boxes, 600);
    assert.ok(boxes.every((b) => Math.abs(b.w - 296) < 0.5));
    // Alone in a row it reaches across, so its edge lines up with the rest.
    assert.equal(layoutPane([lcd], 900).boxes[0]!.w, 900);
    const beside = layoutPane([lcd, knob], 900).boxes;
    tidy(beside, 900);
    assert.equal(beside[0]!.w, 464);
  });

  test('controls go beside a screen when the pane is wide, under it when narrow', () => {
    const wide = layoutPane([screen, knob, knob], 900).boxes;
    tidy(wide, 900);
    assert.ok(wide[1]!.x >= wide[0]!.x + wide[0]!.w);
    const narrow = layoutPane([screen, knob, knob], 340).boxes;
    tidy(narrow, 340);
    assert.ok(narrow[1]!.y >= narrow[0]!.y + narrow[0]!.h);
  });

  test('given more height, screens take it, or else knobs grow and rows spread', () => {
    const screens = layoutPane([screen, knob], 340, 500);
    assert.ok(screens.boxes[0]!.h > 192);
    const knobs = layoutPane([knob, knob], 240, 400);
    tidy(knobs.boxes, 240);
    assert.equal(knobs.height, 112);
    assert.equal(knobs.boxes[0]!.h, 168);
  });

  test('a pane asks to be wide enough for its widest, and not much taller than wide', () => {
    assert.equal(paneWidth([screen], 960, 40), 312);
    const lcds = paneWidth(Array(5).fill(lcd), 960, 40);
    const { height } = layoutPane(Array(5).fill(lcd), lcds);
    assert.ok(height <= lcds, `${lcds} wide, ${height} tall`);
  });
});
