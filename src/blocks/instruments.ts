// Instruments: the blocks a panel face is built from. Most watch the circuit
// or set its parameters but take no part in the simulation, so flattening
// leaves them out; a Button is the exception, a source the face can push.
// Each draws itself on the diagram and has a widget on the face below it.

import { defineBlock, type Processor } from '../engine/block.ts';
import { boolean, choice, number, text } from '../engine/params.ts';

export type PlotView = 'time' | 'spectrum' | 'waterfall';

export const PLOT = 'plot';
export const SPEAKER = 'speaker';
export const CONTROL = 'control';
export const READOUT = 'readout';
export const NOTE = 'note';
export const BUTTON = 'button';
export const SYMBOLS = 'symbols';

const INSTRUMENTS: ReadonlySet<string> = new Set([
  PLOT,
  SPEAKER,
  CONTROL,
  READOUT,
  NOTE,
  BUTTON,
  SYMBOLS,
]);

export const isInstrument = (kind: string): boolean => INSTRUMENTS.has(kind);

/** Whether an instrument takes part in the simulation, as a Button does. */
export const isSimulated = (kind: string): boolean => kind === BUTTON;

/** Never called: flattening leaves instruments out of the circuit. */
const inert = (): Processor => ({ process() {} });

export const plot = defineBlock({
  kind: PLOT,
  label: 'Plot',
  category: 'Instruments',
  description:
    'Shows the signal wired into it as the stream runs, here and as a screen on the face: its latest stretch over time, its spectrum, or a waterfall that grows at the top as time passes.',
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
    span: number({
      label: 'Shows the last',
      unit: 's',
      default: 0,
      min: 0,
      max: 60,
      help: 'Seconds across a time plot, averaged in a spectrum, or down a waterfall. 0 picks what suits the view.',
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
    stack: text({
      label: 'Stacked under',
      default: '',
      maxLength: 200,
      help: 'A Bits to tones view to join as a row, lined up with its symbols, in place of a screen of its own.',
    }),
  },
  shape: { kind: 'instrument', width: 240, height: 144 },
  create: inert,
});

export const symbols = defineBlock({
  kind: SYMBOLS,
  label: 'Bits to tones',
  category: 'Instruments',
  description:
    "Hangs off an FT8 symbol mapper and shows its last few symbols side by side, one column each: the three bits each carries and the tone the Gray code picks for them, the mapper's tone out, and the glide that the Gaussian filter after it makes of the steps. It scrolls with the playhead, now at the right, and each symbol's labels ride along in its column. A time plot can be stacked under it, such as the audio, to line up with its symbols.",
  inputs: [],
  outputs: [],
  params: {
    block: text({ label: 'Mapper', default: '', maxLength: 200 }),
    span: number({
      label: 'Shows the last',
      unit: 's',
      default: 2.4,
      min: 0.48,
      max: 12.64,
      step: 0.01,
      help: 'Seconds across, 0.16 to a symbol, as on a time plot.',
    }),
  },
  shape: { kind: 'instrument', width: 320, height: 176 },
  create: inert,
});

export const speaker = defineBlock({
  kind: SPEAKER,
  label: 'Speaker',
  category: 'Instruments',
  description:
    'A monitor for the signal wired into it: turn it on here or on the face to hear the stream as it runs. Turning it on or off leaves time alone; while it plays, the playhead keeps time with the sound. Away from 1× it plays like a tape at that speed: at ⅛× everything is three octaves lower.',
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
      label: 'Looks like',
      default: 'knob',
      help: 'A knob or slider sets a number; an LCD takes typing, and for a number the wheel and arrow keys too.',
      options: [
        { value: 'knob', label: 'Knob' },
        { value: 'slider', label: 'Slider' },
        { value: 'lcd', label: 'LCD' },
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
    "Shows one of a block's readings in large digits, such as the FT8 decoder's message, as it stood at the playhead.",
  inputs: [],
  outputs: [],
  params: {
    block: text({ label: 'Block', default: '', maxLength: 200 }),
    reading: text({ label: 'Reading', default: '', maxLength: 80 }),
    style: choice({
      label: 'Looks like',
      default: 'digits',
      options: [
        { value: 'digits', label: 'Digits' },
        { value: 'lcd', label: 'LCD' },
      ],
    }),
  },
  shape: { kind: 'instrument', width: 176, height: 64 },
  create: inert,
});

/** How long a Button's pulse lasts, in seconds. */
const PULSE = 0.01;

export const button = defineBlock({
  kind: BUTTON,
  label: 'Button',
  category: 'Instruments',
  description:
    "A push button on the face. Each press puts out a short pulse, 1 for 10 ms, that a Recording's trigger, or anything else, can start on.",
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    rate: number({
      label: 'Sample rate',
      unit: 'Hz',
      default: 1000,
      min: 100,
      max: 2_000_000,
      scale: 'log',
      help: 'Of the pulse. A trigger reads it at any rate.',
    }),
  },
  shape: { kind: 'instrument', width: 112, height: 72 },
  rates: (_, p) => [p.rate],
  create(_, context) {
    const length = Math.max(1, Math.round(PULSE * context.outputRates[0]));
    let left = 0;
    return {
      process(_, [out], start, end) {
        for (let i = start; i < end; i++) {
          out[i] = left > 0 ? 1 : 0;
          left = Math.max(0, left - 1);
        }
      },
      press() {
        left = length;
      },
    };
  },
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
