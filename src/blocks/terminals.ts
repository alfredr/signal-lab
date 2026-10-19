// Subsystem Input and Output terminals. The model connects each terminal's
// hidden port to the corresponding external subsystem connection.

import { defineBlock } from '../engine/block.ts';

export const INPUT_TERMINAL = 'terminal-in';
export const OUTPUT_TERMINAL = 'terminal-out';

export const inputTerminal = defineBlock({
  kind: INPUT_TERMINAL,
  label: 'Input',
  category: 'Subsystems',
  description:
    "One of a subsystem's inputs: whatever is wired to that input of the subsystem block comes out here. The subsystem's inputs are listed in the order these were added.",
  inputs: [{ name: 'outside', hidden: true }],
  outputs: [{ name: 'out' }],
  shape: { kind: 'terminal' },
  params: {},
  create() {
    return {
      process([x], [y], start, end) {
        y.set(x.subarray(start, end), start);
      },
    };
  },
});

export const outputTerminal = defineBlock({
  kind: OUTPUT_TERMINAL,
  label: 'Output',
  category: 'Subsystems',
  description:
    "One of a subsystem's outputs: what is wired in here leaves the subsystem block from that output. The outputs are listed in the order these were added.",
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'outside', hidden: true }],
  shape: { kind: 'terminal' },
  params: {},
  create() {
    return {
      process([x], [y], start, end) {
        y.set(x.subarray(start, end), start);
      },
    };
  },
});
