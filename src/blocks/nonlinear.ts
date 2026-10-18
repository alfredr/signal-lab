import { defineBlock } from '../engine/block.ts';
import { si, significant } from '../engine/format.ts';
import { choice, number } from '../engine/params.ts';

const drop = number({
  label: 'Forward drop',
  unit: 'V',
  default: 0,
  min: 0,
  max: 1,
  step: 0.01,
  help: '0 is an ideal diode.',
});

export const rectifier = defineBlock({
  kind: 'rectifier',
  label: 'Rectifier',
  category: 'Nonlinear',
  description: String.raw`A diode into a resistor. Half-wave passes $\max(0,\ x - V_d)$; full-wave flips the negative half up as well. Being nonlinear, it creates new frequencies.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    mode: choice({
      label: 'Mode',
      default: 'half',
      options: [
        { value: 'half', label: 'half-wave' },
        { value: 'full', label: 'full-wave' },
      ],
    }),
    drop,
  },
  summary: (p) =>
    p.drop > 0 ? `${p.mode}, ${si(p.drop, 'V')}` : `${p.mode}-wave`,
  create(p) {
    const full = p.mode === 'full';
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = Math.max(0, (full ? Math.abs(x[i]) : x[i]) - p.drop);
        }
      },
    };
  },
});

export const diode = defineBlock({
  kind: 'diode',
  label: 'Diode',
  category: 'Nonlinear',
  description: String.raw`An ideal diode charging a node. It conducts while the anode is higher, so the node sits at $\max(v_\text{anode} - V_d,\ v_\text{cathode})$, where the cathode input is what the node would otherwise hold. Feed a capacitor's voltage back to the cathode and it becomes a peak detector.`,
  inputs: [{ name: 'anode' }, { name: 'cathode', side: 'bottom' }],
  outputs: [{ name: 'out' }],
  params: { drop },
  summary: (p) => (p.drop > 0 ? `drop ${si(p.drop, 'V')}` : 'ideal'),
  create(p) {
    return {
      process([anode, cathode], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = Math.max(anode[i] - p.drop, cathode[i]);
        }
      },
    };
  },
});

export const square = defineBlock({
  kind: 'square',
  label: 'Square law',
  category: 'Nonlinear',
  description: String.raw`Squares the signal. $x^2$ contains every sum and difference of the frequencies in $x$, so a square-law device can detect AM.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {},
  summary: () => 'x²',
  create() {
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = x[i] * x[i];
        }
      },
    };
  },
});

export const clipper = defineBlock({
  kind: 'clipper',
  label: 'Clipper',
  category: 'Nonlinear',
  description: String.raw`Limits the signal to $\pm L$, sharply or along $L \tanh(x / L)$. Clipping spreads energy into new frequencies, heard as distortion.`,
  inputs: [{ name: 'in' }],
  outputs: [{ name: 'out' }],
  params: {
    mode: choice({
      label: 'Curve',
      default: 'soft',
      options: [
        { value: 'soft', label: 'soft' },
        { value: 'hard', label: 'hard' },
      ],
    }),
    level: number({
      label: 'Level',
      default: 1,
      min: 0.01,
      max: 10,
      step: 0.01,
    }),
  },
  summary: (p) => `${p.mode}, ±${significant(p.level)}`,
  create(p) {
    const { level } = p;
    const curve =
      p.mode === 'soft'
        ? (v: number) => level * Math.tanh(v / level)
        : (v: number) => Math.max(-level, Math.min(level, v));
    return {
      process([x], [y], start, end) {
        for (let i = start; i < end; i++) {
          y[i] = curve(x[i]);
        }
      },
    };
  },
});
