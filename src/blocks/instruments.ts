// Instruments: the blocks a panel face is built from. They watch the circuit
// or set its parameters but take no part in the simulation, so flattening
// leaves them out. Each draws itself on the diagram and has a widget on the
// face below it.

import { defineBlock, type Processor } from '../engine/block.ts';
import { boolean, choice, number, text } from '../engine/params.ts';

export type PlotView = 'time' | 'spectrum' | 'waterfall';

export const PLOT = 'plot';
export const SPEAKER = 'speaker';
export const CONTROL = 'control';
export const READOUT = 'readout';
export const NOTE = 'note';

const INSTRUMENTS: ReadonlySet<string> = new Set([
  PLOT,
  SPEAKER,
  CONTROL,
  READOUT,
  NOTE,
]);

export const isInstrument = (kind: string): boolean => INSTRUMENTS.has(kind);

/** Never called: flattening leaves instruments out of the circuit. */
const inert = (): Processor => ({ process() {} });

export const plot = defineBlock({
  kind: PLOT,
  label: 'Plot',
  category: 'Instruments',
  description:
    'Shows the signal wired into it, here and as a screen on the face: over time, as a spectrum, or as a waterfall. Following the playhead, it shows a short window around it, so it animates as the playhead moves.',
  inputs: [{ name: 'in' }],
  outputs: [],
  params: {
    view: choice({
      label: 'View',
      default: 'time',
      options: [
        { value: 'time', label: 'Time' },
        { value: 'spectrum', label: 'Spectrum' },
        { value: 'waterfall', label: 'Waterfall' },
      ],
    }),
    follow: boolean({
      label: 'Follow the playhead',
      default: false,
    }),
    span: number({
      label: 'Window',
      unit: 's',
      default: 0.05,
      min: 0.001,
      max: 5,
      scale: 'log',
      help: 'How much of the run a following plot shows at once.',
    }),
    low: number({
      label: 'Lowest frequency',
      unit: 'Hz',
      default: 0,
      min: 0,
      max: 1e6,
      help: 'For spectra and waterfalls.',
    }),
    high: number({
      label: 'Highest frequency',
      unit: 'Hz',
      default: 0,
      min: 0,
      max: 1e6,
      help: 'For spectra and waterfalls; 0 goes up to half the sample rate.',
    }),
  },
  shape: { kind: 'instrument', width: 240, height: 144 },
  create: inert,
});

export const speaker = defineBlock({
  kind: SPEAKER,
  label: 'Speaker',
  category: 'Instruments',
  description:
    'Plays the signal wired into it: press Play here or on the face. Playback loops, follows changes live, and moves the playhead with the sound.',
  inputs: [{ name: 'in' }],
  outputs: [],
  params: {},
  shape: { kind: 'instrument', width: 64, height: 64 },
  create: inert,
});

export const control = defineBlock({
  kind: CONTROL,
  label: 'Control',
  category: 'Instruments',
  description:
    "A knob, switch or field on the face for one setting: a parameter of this diagram, or one of a block's settings. Dashed lines on the diagram lead to what it sets.",
  inputs: [],
  outputs: [],
  params: {
    target: text({
      label: 'Sets',
      default: '',
      maxLength: 120,
      help: 'A parameter, or a block and one of its settings.',
    }),
    style: choice({
      label: 'Number style',
      default: 'knob',
      options: [
        { value: 'knob', label: 'Knob' },
        { value: 'slider', label: 'Slider' },
      ],
    }),
  },
  shape: { kind: 'instrument', width: 176, height: 72 },
  create: inert,
});

export const readout = defineBlock({
  kind: READOUT,
  label: 'Readout',
  category: 'Instruments',
  description:
    "Shows one of a block's readings in large digits, such as the FT8 decoder's message. A reading that changes through the run, such as the symbol being sent, follows the playhead.",
  inputs: [],
  outputs: [],
  params: {
    block: text({ label: 'Block', default: '', maxLength: 200 }),
    reading: text({ label: 'Reading', default: '', maxLength: 80 }),
  },
  shape: { kind: 'instrument', width: 176, height: 64 },
  create: inert,
});

export const note = defineBlock({
  kind: NOTE,
  label: 'Note',
  category: 'Instruments',
  description:
    'Markdown on the diagram, with TeX between dollar signs. Shown on the face too, it becomes a label there.',
  inputs: [],
  outputs: [],
  params: {
    text: text({
      label: 'Text',
      default: 'A **note**.',
      maxLength: 4000,
      multiline: true,
    }),
    face: boolean({ label: 'Show on the face', default: false }),
  },
  shape: { kind: 'instrument', width: 240, height: 96 },
  create: inert,
});
