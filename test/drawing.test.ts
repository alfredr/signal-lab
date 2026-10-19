import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { blockType } from '../src/blocks/index.ts';
import { drawingOf, layoutOf } from '../src/ui/geometry.ts';

const kindOf = (kind: string) => drawingOf(blockType(kind)!).kind;

describe('drawing blocks on the diagram', () => {
  test('a block with a drawing and a port a side is a schematic symbol', () => {
    for (const kind of [
      'lowpass',
      'diode',
      'capacitor',
      'resample',
      'noise',
    ]) {
      assert.equal(kindOf(kind), 'symbol', kind);
    }
  });

  test('one with more ports keeps a box, and shaped ones keep their shapes', () => {
    assert.equal(kindOf('hilbert'), 'box');
    assert.equal(kindOf('mixer'), 'circle');
    assert.equal(kindOf('gain'), 'triangle');
  });

  test('a symbol keeps the footprint and ports of the box it was', () => {
    const symbol = layoutOf(blockType('lowpass')!);
    const box = layoutOf(blockType('hilbert')!);
    assert.equal(symbol.width, box.width);
    assert.deepEqual(symbol.inputs[0], { x: 0, y: 28, side: 'left' });
  });
});
