import { defineBlock } from '../engine/block.ts';
import { MINUS, significant } from '../engine/format.ts';
import { choice, number } from '../engine/params.ts';

export const gain = defineBlock({
  kind: 'gain',
  label: 'Gain',
  category: 'Math',
  description: String.raw`Multiplies by a constant $k$. As the modulation index $\mu$ it sets how deeply the message swings the carrier.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  shape: { kind: 'triangle' },
  params: {
    gain: number({
      label: 'Gain',
      unit: 'x',
      default: 1,
      min: -10,
      max: 10,
      step: 0.01,
    }),
  },
  summary: (p) => `×${significant(p.gain)}`,
  create(p) {
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = p.gain * x[i];
        }
      },
    };
  },
});

export const offset = defineBlock({
  kind: 'offset',
  label: 'Offset',
  category: 'Math',
  description: String.raw`Adds a constant: the 1 in $1 + \mu\, m(t)$, which keeps an AM envelope from going negative.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    value: number({ label: 'Add', default: 1, min: -10, max: 10, step: 0.01 }),
  },
  summary: (p) =>
    p.value < 0
      ? `${MINUS} ${significant(-p.value)}`
      : `+ ${significant(p.value)}`,
  create(p) {
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = x[i] + p.value;
        }
      },
    };
  },
});

const signOption = (label: string) =>
  choice({
    label,
    default: '+',
    options: [
      { value: '+', label: 'add' },
      { value: '-', label: 'subtract' },
    ],
  });

export const adder = defineBlock({
  kind: 'adder',
  label: 'Adder',
  category: 'Math',
  description: String.raw`Sums its inputs, $a \pm b \pm c$. Unconnected inputs count as zero.`,
  inputs: [
    { name: 'a' },
    { name: 'b', side: 'bottom' },
    { name: 'c', side: 'top' },
  ],
  outputs: [{ name: 'out' }],
  shape: { kind: 'circle', symbol: '+' },
  params: {
    b: signOption('Bottom input'),
    c: signOption('Top input'),
  },
  create(p) {
    const sb = p.b === '-' ? -1 : 1;
    const sc = p.c === '-' ? -1 : 1;
    return {
      process([a, b, c], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = a[i] + sb * b[i] + sc * c[i];
        }
      },
    };
  },
});

export const mixer = defineBlock({
  kind: 'mixer',
  label: 'Mixer',
  category: 'Math',
  description: String.raw`Multiplies its two inputs. Multiplying by $\cos 2\pi f_0 t$ shifts a spectrum up and down by $f_0$: the move behind modulation, product detection and every superhet.`,
  inputs: [{ name: 'a' }, { name: 'b', side: 'bottom' }],
  outputs: [{ name: 'out' }],
  shape: { kind: 'circle', symbol: '×' },
  params: {},
  create() {
    return {
      process([a, b], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = a[i] * b[i];
        }
      },
    };
  },
});
