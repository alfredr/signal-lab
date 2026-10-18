// Ready-made subsystems for the palette. Each is an ordinary subsystem once placed: open it to
// see the parts, probe inside, or change anything.

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { Category } from '../engine/block.ts';
import { code, diagram } from './build.ts';
import type { Diagram } from './document.ts';

export type Template = {
  readonly key: string;
  readonly label: string;
  readonly category: Category;
  readonly description: string;
  build(): Diagram;
};

const RF = 384_000;

export const templates: readonly Template[] = [
  {
    key: 'subsystem',
    label: 'Subsystem',
    category: 'Subsystems',
    description:
      'An empty subsystem with one input wired straight to one output. Open it and build inside, adding Input and Output terminals for more ports.',
    build: () =>
      diagram(
        {
          in: { kind: INPUT_TERMINAL, x: 0, y: 40 },
          out: { kind: OUTPUT_TERMINAL, x: 240, y: 40 },
        },
        [['in', 'out']],
        String.raw`Build inside here. Add **Input** and **Output** terminals from the palette for more ports; the subsystem block lists them in the order they were added.

Parameters added here become the subsystem's settings, which you can change or bind from outside.`,
      ),
  },
  {
    key: 'envelope-detector',
    label: 'Envelope detector',
    category: 'Detectors',
    description: String.raw`A diode charging a capacitor that discharges through a resistor. The diode conducts only while the input is above the capacitor's voltage, so the capacitor jumps up to each carrier peak and sags between them as $e^{-t/RC}$. Too short an $RC$ leaves carrier ripple; too long and it can't follow the envelope down.`,
    build: () =>
      diagram(
        {
          in: { kind: INPUT_TERMINAL, x: 0, y: 40 },
          diode: { kind: 'diode', x: 128, y: 28 },
          capacitor: {
            kind: 'capacitor',
            x: 320,
            y: 136,
            params: { rc: 20e-6 },
            bindings: { rc: 'rc' },
          },
          out: { kind: OUTPUT_TERMINAL, x: 400, y: 40 },
        },
        [
          ['in', 'diode:0'],
          ['diode', 'out'],
          ['diode', 'capacitor'],
          ['capacitor', 'diode:1'],
        ],
        String.raw`The diode conducts only while the input is above the capacitor's voltage, so the capacitor charges to each carrier peak, then discharges through the resistor:

$$v(t) = v_\text{peak}\, e^{-t/RC}$$

Choosing $RC$, the ${code('rc')} parameter, is a trade-off:
- long compared with a carrier period, $RC \gg 1/f_c$, or the output keeps carrier ripple;
- short enough to follow the envelope down, $RC \le \dfrac{\sqrt{1 - \mu^2}}{2\pi f_m \mu}$ for a tone $f_m$ at depth $\mu$, or the output misses the troughs (*diagonal clipping*).`,
        [
          {
            name: 'rc',
            value: 20e-6,
            min: 1e-6,
            max: 1e-3,
            unit: 's',
            scale: 'log',
          },
        ],
      ),
  },
  {
    key: 'product-detector',
    label: 'Product detector',
    category: 'Detectors',
    description: String.raw`Multiplies the signal by a local oscillator and low-pass filters the product, which shifts a station at the LO frequency down to audio. Its output scales with $\cos\varphi$, the phase difference between the LO and the carrier it replaces.`,
    build: () =>
      diagram(
        {
          in: { kind: INPUT_TERMINAL, x: 0, y: 40 },
          mixer: { kind: 'mixer', x: 128, y: 32 },
          lo: {
            kind: 'oscillator',
            x: 72,
            y: 120,
            name: 'LO',
            params: { frequency: 100_000, rate: RF },
            bindings: { frequency: 'lo', phase: 'phase' },
          },
          audio: {
            kind: 'lowpass',
            x: 224,
            y: 28,
            name: 'Audio filter',
            params: { cutoff: 4500, order: '4' },
          },
          out: { kind: OUTPUT_TERMINAL, x: 416, y: 40 },
        },
        [
          ['in', 'mixer:0'],
          ['lo', 'mixer:1'],
          ['mixer', 'audio'],
          ['audio', 'out'],
        ],
        String.raw`Multiplying by the LO shifts the station at $f_\text{LO}$ down to audio, and up to $2 f_\text{LO}$, which the low-pass removes:

$$\cos\omega t \cdot \cos(\omega t + \varphi) = \tfrac12\cos\varphi + \tfrac12\cos(2\omega t + \varphi)$$

So the audio comes out scaled by $\cos\varphi$. For SSB the LO, the ${code('lo')} parameter, only needs to be within about 20 Hz; for DSB-SC it must be locked in ${code('phase')}.`,
        [
          {
            name: 'lo',
            value: 100e3,
            min: 1e3,
            max: 1e6,
            unit: 'Hz',
            scale: 'log',
          },
          { name: 'phase', value: 0, min: -180, max: 180, unit: 'deg' },
        ],
      ),
  },
];

export function template(key: string): Template | undefined {
  return templates.find((t) => t.key === key);
}
