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

/**
 * How long FT8's Gaussian filter (BT = 2, T = 0.16 s) holds the tones back:
 * four standard deviations, sqrt(ln 2) / (2 pi BT) T each.
 */
export const FT8_FILTER_DELAY = 0.0424;

const ft8Notes = String.raw`FT8's transmitter in steps, from text to bits to tones to sound. Probe any wire: between the first four steps the bits go as NRZ, $+1$ for a 1 and $-1$ for a 0, a third of a symbol each.

1. The **message** packs into 77 bits: 28 for each callsign, 15 for the grid or report, 3 for the kind of message. Each field is one number: a callsign's characters are the digits of a number in a mixed base. Select the message block to see each field worked out.
2. The **CRC-14** adds 14 check bits, so the receiver can tell a good decode from a bad one: 91.
3. The **LDPC encoder** adds 83 parity bits, which let the receiver correct bits it hears wrong: 174.
4. The **symbol mapper** reads them three at a time, Gray-codes each three onto a tone from 0 to 7, and sets them between three Costas arrays for sync: 79 tones, one every $T = 0.16$ s.
5. The **Gaussian filter** smooths each step from tone to tone into a glide ($BT = 2$), so the signal throws less energy onto its neighbours.
6. The **VCO** turns the glide into audio: tone 0 at ${code('offset')}, and 6.25 Hz higher for each tone up. Its phase adds up the frequency, so it never jumps, and since $6.25 \text{ Hz} \times 0.16 \text{ s} = 1$, tone $k$ makes exactly $k$ more cycles a symbol than tone 0.
7. The mapper's **key** turns it on for the transmission, once it has waited the 42.4 ms the filter takes, so the first tone starts on its own frequency.`;

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
  {
    key: 'ft8-transmitter',
    label: 'FT8 transmitter',
    category: 'Digital modes',
    description: String.raw`Sends an FT8 message as audio in every 15 s slot, as WSJT-X does, built from its steps: the message packs into bits, a **CRC-14** and an **LDPC encoder** add check and parity bits, a **symbol mapper** turns them into tones, a **Gaussian filter** smooths each step into a glide, and a **VCO** turns the glide into audio, keyed on for the transmission. Open it to probe each step. Its message is the message block's setting.`,
    build: () =>
      diagram(
        {
          message: {
            kind: 'ft8-message',
            x: 0,
            y: 40,
            params: { message: 'CQ K1ABC FN42', start: 0.5, rate: 12000 },
          },
          crc: { kind: 'crc14', x: 176, y: 40, params: { start: 0.5 } },
          ldpc: { kind: 'ldpc', x: 352, y: 40, params: { start: 0.5 } },
          mapper: {
            kind: 'ft8-mapper',
            x: 528,
            y: 40,
            name: 'Symbol mapper',
            params: { start: 0.5 },
          },
          smooth: {
            kind: 'gaussian',
            x: 704,
            y: 32,
            params: { time: 0.16, bt: 2 },
          },
          vco: {
            kind: 'vco',
            x: 880,
            y: 32,
            params: { rest: 1500, sensitivity: 6.25 },
            bindings: { rest: 'offset' },
          },
          wait: {
            kind: 'delay',
            x: 880,
            y: 136,
            name: 'Wait for the filter',
            params: { time: FT8_FILTER_DELAY },
          },
          keyer: { kind: 'mixer', x: 1080, y: 40, name: 'Key' },
          out: { kind: OUTPUT_TERMINAL, x: 1176, y: 48 },
        },
        [
          ['message', 'crc'],
          ['crc', 'ldpc'],
          ['ldpc', 'mapper'],
          ['mapper:0', 'smooth'],
          ['smooth', 'vco'],
          ['vco:0', 'keyer:0'],
          ['mapper:1', 'wait'],
          ['wait', 'keyer:1'],
          ['keyer', 'out'],
        ],
        ft8Notes,
        [{ name: 'offset', value: 1500, min: 200, max: 2800, unit: 'Hz' }],
      ),
  },
];

export function template(key: string): Template | undefined {
  return templates.find((t) => t.key === key);
}
