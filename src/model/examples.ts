// Starter documents. Layout conventions are in build.ts.

import type { StoredParams } from '../engine/params.ts';
import {
  button,
  code,
  control,
  diagram,
  note,
  plot,
  readout,
  symbolView,
  speaker,
  type Link,
  type Part,
} from './build.ts';
import {
  FORMAT,
  type Diagram,
  type LabDocument,
  type Parameter,
} from './document.ts';
import { FT8_FILTER_DELAY, template } from './library.ts';

const RF = 384_000;

type DocumentSpec = {
  readonly title: string;
  readonly notes: string;
  readonly parts: Readonly<Record<string, Part>>;
  readonly links: readonly Link[];
  readonly parameters?: readonly Parameter[];
  /** How the face is organized: panels of panes of instruments. */
  readonly panels?: readonly PanelSpec[];
};

/** An instrument by id, or with a size in cells as [id, w, h]. */
type ItemSpec = string | readonly [string, number, number];
/** A pane's title and instruments. */
type PaneSpec = readonly [string, readonly ItemSpec[]];
/** A panel's title and panes. */
type PanelSpec = readonly [string, readonly PaneSpec[]];

function document({
  title,
  notes,
  parts,
  links,
  parameters = [],
  panels,
}: DocumentSpec): LabDocument {
  let panes = 0;
  return {
    format: FORMAT,
    title,
    notes,
    ...diagram(parts, links, undefined, parameters),
    ...(panels
      ? {
          panels: panels.map(([panelTitle, list], k) => ({
            id: `panel${k + 1}`,
            title: panelTitle,
            panes: list.map(([paneTitle, items]) => ({
              id: `pane${++panes}`,
              title: paneTitle,
              items: items.map((item) =>
                typeof item === 'string'
                  ? { id: item }
                  : { id: item[0], w: item[1], h: item[2] },
              ),
            })),
          })),
        }
      : {}),
  };
}

const library = (key: string): Diagram => template(key)!.build();

/** Settings to bind on some of a chain's parts, by part id. */
type ChainBindings = Readonly<
  Record<string, { readonly [setting: string]: string }>
>;

type Chain = {
  readonly parts: Readonly<Record<string, Part>>;
  readonly links: readonly Link[];
};

function bind(chain: Chain, bindings: ChainBindings): Chain {
  return {
    links: chain.links,
    parts: Object.fromEntries(
      Object.entries(chain.parts).map(([id, part]) => [
        id,
        bindings[id] ? { ...part, bindings: bindings[id] } : part,
      ]),
    ),
  };
}

/** An AM broadcast transmitter, ending at its antenna. */
function station(vowel: string, pitch: number, carrier: number): Diagram {
  return diagram(
    {
      voice: {
        kind: 'voice',
        x: 0,
        y: 80,
        params: { vowel, pitch, bandwidth: 4500, rate: 48000 },
      },
      mu: {
        kind: 'gain',
        x: 184,
        y: 80,
        name: 'μ',
        params: { gain: 0.8 },
        bindings: { gain: 'mu' },
      },
      dc: { kind: 'offset', x: 296, y: 80, params: { value: 1 } },
      up: {
        kind: 'resample',
        x: 480,
        y: 80,
        params: { direction: 'up', factor: 8 },
      },
      modulator: { kind: 'mixer', x: 664, y: 84, name: 'Modulator' },
      carrier: {
        kind: 'oscillator',
        x: 592,
        y: 176,
        name: 'Carrier',
        params: { frequency: carrier, rate: RF },
        bindings: { frequency: 'carrier' },
      },
      antenna: { kind: 'antenna', x: 760, y: 52 },
    },
    [
      ['voice', 'mu'],
      ['mu', 'dc'],
      ['dc', 'up'],
      ['up', 'modulator:0'],
      ['carrier', 'modulator:1'],
      ['modulator', 'antenna'],
    ],
    String.raw`An AM broadcast transmitter. The voice is scaled by $\mu$ and raised by 1, so the envelope $1 + \mu\, m(t)$ stays positive; it multiplies the carrier and the antenna puts the result on the air.

Its parameters, ${code('carrier')} and ${code('mu')}, are the transmitter's settings: select it from outside to change them.`,
    [
      { name: 'carrier', value: carrier, min: 20e3, max: 180e3, unit: 'Hz' },
      { name: 'mu', value: 0.8, min: 0, max: 1.5, unit: 'x' },
    ],
  );
}

/**
 * An AM receiver with its output port at height `y`: antenna, tuned circuit,
 * envelope detector, audio filter, back down to 48 kHz and a DC block.
 */
function amReceiver(y: number, tuned: StoredParams, noise: number): Chain {
  return {
    parts: {
      receiver: {
        kind: 'antenna',
        x: 40,
        y: y - 28,
        params: { noise, bandwidth: 9000 },
      },
      tuned: {
        kind: 'bandpass',
        x: 136,
        y,
        name: 'Tuned circuit',
        params: tuned,
      },
      detector: {
        kind: 'subsystem',
        x: 320,
        y,
        name: 'Envelope detector',
        inner: library('envelope-detector'),
      },
      audio: {
        kind: 'lowpass',
        x: 504,
        y,
        name: 'Audio filter',
        params: { cutoff: 4500, order: '4' },
      },
      down: {
        kind: 'resample',
        x: 688,
        y,
        params: { direction: 'down', factor: 8 },
      },
      dcBlock: {
        kind: 'highpass',
        x: 872,
        y,
        name: 'DC block',
        params: { cutoff: 50, order: '2' },
      },
    },
    links: [
      ['receiver', 'tuned'],
      ['tuned', 'detector'],
      ['detector', 'audio'],
      ['audio', 'down'],
      ['down', 'dcBlock'],
    ],
  };
}

/**
 * Where a radio example puts its carrier, and the sample rate of its RF
 * stages.
 */
type Band = { readonly carrier: number; readonly rate: number };
const BROADCAST: Band = { carrier: 100_000, rate: RF };

/**
 * An SSB transmitter by the phasing method, fed from `source`: a phase
 * splitter, two mixers on carriers 90 degrees apart, and their difference (the
 * upper sideband) to the antenna. The source sits at (0, 80).
 */
function phasingTransmitter(
  source: string,
  band: Band,
  factor: number,
): Chain {
  const up = { direction: 'up', factor };
  return {
    parts: {
      split: { kind: 'hilbert', x: 184, y: 76, params: { taps: '511' } },
      upI: { kind: 'resample', x: 400, y: 68, params: up },
      upQ: { kind: 'resample', x: 400, y: 220, params: up },
      mixI: { kind: 'mixer', x: 584, y: 72 },
      mixQ: { kind: 'mixer', x: 584, y: 224 },
      cos: {
        kind: 'oscillator',
        x: 528,
        y: 128,
        name: 'cos',
        params: { frequency: band.carrier, rate: band.rate },
      },
      sin: {
        kind: 'oscillator',
        x: 528,
        y: 296,
        name: 'sin',
        params: { frequency: band.carrier, phase: -90, rate: band.rate },
      },
      sideband: {
        kind: 'adder',
        x: 680,
        y: 72,
        name: 'SSB',
        params: { b: '-' },
      },
      transmitter: { kind: 'antenna', x: 776, y: 40 },
    },
    links: [
      [source, 'split'],
      ['split:0', 'upI'],
      ['split:1', 'upQ'],
      ['upI', 'mixI:0'],
      ['cos', 'mixI:1'],
      ['upQ', 'mixQ:0'],
      ['sin', 'mixQ:1'],
      ['mixI', 'sideband:0'],
      ['mixQ', 'sideband:1'],
      ['sideband', 'transmitter'],
    ],
  };
}

/**
 * A receiver that multiplies by its own oscillator `lo` (named `name`) and
 * low-pass filters the product, then returns to the audio rate: for DSB-SC and
 * SSB.
 */
function productReceiver(
  y: number,
  lo: string,
  name: string,
  noise: StoredParams,
  band: Band = BROADCAST,
  factor = 8,
): Chain {
  return {
    parts: {
      receiver: { kind: 'antenna', x: 40, y: y - 28, params: noise },
      detector: { kind: 'mixer', x: 136, y: y + 4, name: 'Detector' },
      [lo]: {
        kind: 'oscillator',
        x: 80,
        y: y + 112,
        name,
        params: { frequency: band.carrier, phase: 0, rate: band.rate },
      },
      audio: {
        kind: 'lowpass',
        x: 232,
        y,
        name: 'Audio filter',
        params: { cutoff: 4500, order: '4' },
      },
      down: {
        kind: 'resample',
        x: 416,
        y,
        params: { direction: 'down', factor },
      },
    },
    links: [
      ['receiver', 'detector:0'],
      [lo, 'detector:1'],
      ['detector', 'audio'],
      ['audio', 'down'],
    ],
  };
}

const am = (): LabDocument => {
  const transmitter = station('ah', 120, 100_000);
  const receiver = bind(
    amReceiver(300, { center: 100_000, bandwidth: 13_500, sections: 1 }, -30),
    { tuned: { center: 'carrier' }, receiver: { noise: '-3 - cn' } },
  );
  return document({
    title: 'AM with an envelope detector',
    notes: String.raw`The voice, raised by a constant so it never goes negative, sets the amplitude of a 100 kHz carrier:

$$x(t) = [1 + \mu\, m(t)] \cos 2\pi f_c t$$

The receiver's antenna picks the station up along with band noise, the **tuned circuit** selects it, and the **envelope detector** follows the carrier's peaks. Audio runs at 48 kHz and only the radio stages at 384 kHz; the Resample blocks move between the two.

The **parameters** above drive it. ${code('carrier')} tunes the transmitter and the tuned circuit together, ${code('mu')} sets the modulation depth, and ${code('cn')} is the carrier-to-noise ratio in 9 kHz: the carrier's power is $-3$ dB, so the antenna's noise is bound to $-3 - \mathrm{cn}$. Press ƒ beside any number setting to bind it.

### Things to try
- Push ${code('mu')} past 1 and listen to overmodulation.
- Double-click the envelope detector to see the diode and the capacitor feeding back to its cathode. Its $RC$ is its setting, here from outside.
- Lower ${code('cn')} toward 0 dB and listen to the detector give up.
- Zoom into the antenna's spectrum to find the carrier and its two sidebands.`,
    parts: {
      ...Object.fromEntries(
        transmitter.blocks.map(({ id, ...part }) => [id, part]),
      ),
      ...receiver.parts,
      voiceScope: plot(176, -136, 'time', { name: 'Voice', span: 0.02 }),
      muKnob: control(456, -96, 'mu'),
      carrierKnob: control(664, -96, 'carrier'),
      cnKnob: control(-120, 400, 'cn'),
      onAir: plot(120, 400, 'spectrum', { name: 'On the air' }),
      rcKnob: control(400, 408, 'detector.rc', 'RC'),
      audioOut: plot(1064, 256, 'time', { name: 'Audio out' }),
      speaker: speaker(1064, 424),
    },
    links: [
      ...transmitter.wires.map((w): Link => [
        `${w.from.block}:${w.from.port}`,
        `${w.to.block}:${w.to.port}`,
      ]),
      ...receiver.links,
      ['voice', 'voiceScope'],
      ['receiver', 'onAir'],
      ['dcBlock', 'audioOut'],
      ['dcBlock', 'speaker'],
    ],
    parameters: [
      ...(transmitter.parameters ?? []),
      { name: 'cn', value: 27, min: -20, max: 60, unit: 'dB' },
    ],
    panels: [
      [
        'Transmitter',
        [['Modulator', [['voiceScope', 7, 4], 'carrierKnob', 'muKnob']]],
      ],
      [
        'Receiver',
        [
          ['Antenna', ['onAir', 'cnKnob']],
          ['Detector', ['rcKnob', 'audioOut', 'speaker']],
        ],
      ],
    ],
  });
};

const talkingAm = (): LabDocument => {
  const transmitter = station('ah', 120, 100_000);
  const receiver = bind(
    amReceiver(300, { center: 100_000, bandwidth: 13_500, sections: 1 }, -30),
    { tuned: { center: 'carrier' }, receiver: { noise: '-3 - cn' } },
  );
  return document({
    title: 'Speech on an AM carrier',
    notes: String.raw`The AM station again, saying what you type. Press **Talk** on the panel (with the stream running and the speaker on) and it says it once over the air.

The voice is a **formant synthesizer**, the way talking computers worked around 1980: a buzz from the glottis, or a hiss for sounds like "s", through three resonators tuned to the formants of each phoneme in turn. The words come from the CMU Pronouncing Dictionary, and ones it lacks are sounded out by letter-to-sound rules from 1976. Numbers are read as words, and callsigns are spelled out.

### Things to try
- Type something else into **Says**.
- Lower ${code('cn')} and hear words go before the carrier does.
- Push ${code('mu')} past 1 and hear the speech break up.`,
    parts: {
      ...Object.fromEntries(
        transmitter.blocks.map(({ id, ...part }) =>
          id === 'voice'
            ? [
                id,
                {
                  kind: 'speech',
                  x: 0,
                  y: 80,
                  name: 'Speech',
                  params: {
                    text: 'CQ CQ, this is K1ABC. Can you hear me?',
                    pitch: 110,
                    rate: 48000,
                  },
                },
              ]
            : [id, part],
        ),
      ),
      ...receiver.parts,
      talk: button(0, -96, 'Talk'),
      says: control(176, -112, 'voice.text', 'Says', 'lcd'),
      saying: readout(400, -104, 'voice', 'Saying', 'lcd'),
      muKnob: control(624, -96, 'mu'),
      cnKnob: control(-120, 400, 'cn'),
      onAir: plot(120, 400, 'spectrum', { name: 'On the air' }),
      audioOut: plot(1064, 256, 'time', { name: 'Audio out', span: 0.5 }),
      speaker: speaker(1064, 424),
    },
    links: [
      ...transmitter.wires.map((w): Link => [
        `${w.from.block}:${w.from.port}`,
        `${w.to.block}:${w.to.port}`,
      ]),
      ...receiver.links,
      ['talk', 'voice:0'],
      ['receiver', 'onAir'],
      ['dcBlock', 'audioOut'],
      ['dcBlock', 'speaker'],
    ],
    parameters: [
      ...(transmitter.parameters ?? []),
      { name: 'cn', value: 27, min: -20, max: 60, unit: 'dB' },
    ],
    panels: [
      [
        'Transmitter',
        [
          ['Speech', [['says', 10, 2], 'talk', ['saying', 6, 2]]],
          ['Modulator', ['muKnob']],
        ],
      ],
      [
        'Receiver',
        [
          ['On the air', ['onAir', 'cnKnob']],
          ['Audio', ['audioOut', 'speaker']],
        ],
      ],
    ],
  });
};

const twoStations = (): LabDocument => {
  const receiver = bind(
    amReceiver(268, { center: 90_000, bandwidth: 9000, sections: 3 }, -40),
    { tuned: { center: 'tune' } },
  );
  return document({
    title: 'Two stations on the air',
    notes: String.raw`Two AM stations share the air: **Station A** sings "ah" on 90 kHz and **Station B** "oo" on 110 kHz. Each is a subsystem; select one to see its settings, ${code('carrier')} and ${code('mu')}, or open it to see the transmitter inside.

The receiver's tuned circuit follows the ${code('tune')} parameter, which decides the station you hear.

### Things to try
- Turn ${code('tune')} to 110 kHz to switch stations.
- Widen the tuned circuit, or drop it to one section, and the other station bleeds through. A single tuned circuit's skirts fall off slowly, which is why receivers moved to a fixed, sharp IF filter: the superhet.
- Move Station B's ${code('carrier')} toward 90 kHz and hear the two collide.`,
    parts: {
      stationA: {
        kind: 'subsystem',
        x: 0,
        y: 0,
        name: 'Station A, 90 kHz',
        inner: station('ah', 120, 90_000),
      },
      stationB: {
        kind: 'subsystem',
        x: 0,
        y: 88,
        name: 'Station B, 110 kHz',
        inner: station('oo', 180, 110_000),
      },
      ...receiver.parts,
      carrierB: control(-216, 48, 'stationB.carrier', 'B carrier'),
      muB: control(-216, 128, 'stationB.mu', 'B mu'),
      tunedScope: plot(336, 96, 'spectrum', {
        name: 'After the tuned circuit',
        low: 50e3,
        high: 150e3,
      }),
      tuneKnob: control(616, 120, 'tune'),
      onAir: plot(120, 368, 'spectrum', {
        name: 'On the air',
        low: 50e3,
        high: 150e3,
      }),
      audioOut: plot(1064, 224, 'time', { name: 'Audio out' }),
      speaker: speaker(1064, 392),
    },
    links: [
      ...receiver.links,
      ['tuned', 'tunedScope'],
      ['receiver', 'onAir'],
      ['dcBlock', 'audioOut'],
      ['dcBlock', 'speaker'],
    ],
    parameters: [
      { name: 'tune', value: 90e3, min: 60e3, max: 140e3, unit: 'Hz' },
    ],
    panels: [
      [
        'On the air',
        [
          ['Air', ['onAir']],
          ['Station B', ['carrierB', 'muB']],
        ],
      ],
      [
        'Receiver',
        [
          ['Tuning', ['tuneKnob', 'tunedScope']],
          ['Audio', [['audioOut', 7, 4], 'speaker']],
        ],
      ],
    ],
  });
};

const dsb = (): LabDocument => {
  const receiver = bind(
    productReceiver(300, 'lo', 'Receiver LO', { noise: -40, bandwidth: 9000 }),
    { lo: { frequency: '100e3 + detune', phase: 'phase' } },
  );
  return document({
    title: 'DSB-SC and the product detector',
    notes: String.raw`Drop the carrier and send only the sidebands, $m(t)\cos 2\pi f_c t$. The receiver has to supply its own carrier: it multiplies by a local oscillator and low-pass filters the product. With a phase error $\varphi$,

$$m(t)\cos\omega_c t \cdot \cos(\omega_c t + \varphi) = \tfrac12 m(t)\cos\varphi + \tfrac12 m(t)\cos(2\omega_c t + \varphi)$$

and the low-pass keeps only the first term, so the voice comes out scaled by $\cos\varphi$. The receiver LO follows the ${code('phase')} and ${code('detune')} parameters.

### Things to try
- Turn ${code('phase')} to $90^\circ$: the voice vanishes. Past $90^\circ$ it returns upside down.
- Set ${code('detune')} to a few hertz and the voice beats in and out.`,
    parts: {
      voice: { kind: 'voice', x: 0, y: 80, params: { rate: 48000 } },
      up: {
        kind: 'resample',
        x: 184,
        y: 80,
        params: { direction: 'up', factor: 8 },
      },
      modulator: { kind: 'mixer', x: 368, y: 84, name: 'Modulator' },
      carrier: {
        kind: 'oscillator',
        x: 296,
        y: 176,
        name: 'Carrier',
        params: { frequency: 100_000, rate: RF },
      },
      transmitter: { kind: 'antenna', x: 464, y: 52 },
      ...receiver.parts,
      voiceScope: plot(176, -136, 'time', { name: 'Voice' }),
      modScope: plot(448, -120, 'spectrum', {
        name: 'On the air',
        low: 90e3,
        high: 110e3,
      }),
      phaseKnob: control(-136, 400, 'phase'),
      detuneKnob: control(-136, 488, 'detune'),
      audioOut: plot(608, 256, 'time', { name: 'Audio out' }),
      speaker: speaker(608, 424),
    },
    links: [
      ['voice', 'up'],
      ['up', 'modulator:0'],
      ['carrier', 'modulator:1'],
      ['modulator', 'transmitter'],
      ...receiver.links,
      ['voice', 'voiceScope'],
      ['modulator', 'modScope'],
      ['down', 'audioOut'],
      ['down', 'speaker'],
    ],
    parameters: [
      { name: 'phase', value: 0, min: -180, max: 180, unit: 'deg' },
      { name: 'detune', value: 0, min: -20, max: 20, unit: 'Hz' },
    ],
    panels: [
      [
        'DSB-SC',
        [
          ['Transmitter', ['voiceScope', ['modScope', 8, 4]]],
          ['Product detector', ['phaseKnob', 'detuneKnob']],
          ['Audio', ['audioOut', 'speaker']],
        ],
      ],
    ],
  });
};

const ssb = (): LabDocument => {
  const transmitter = phasingTransmitter('voice', BROADCAST, 8);
  const receiver = bind(
    productReceiver(440, 'bfo', 'BFO', { noise: -40, bandwidth: 2500 }),
    { bfo: { frequency: '100e3 + bfo' } },
  );
  return document({
    title: 'SSB by the phasing method',
    notes: String.raw`The phase splitter makes two copies of the voice $90^\circ$ apart. Each multiplies a carrier, and the carriers are $90^\circ$ apart too, so when the products are combined one sideband cancels:

$$m\cos\omega_c t - \hat m\sin\omega_c t$$

keeps only the upper sideband. Switch the SSB adder's bottom input to *add* for the lower.

### Things to try
- Set the ${code('bfo')} offset to 50 Hz. Every component shifts by the same 50 Hz, which breaks the voice's harmonic ratios: it sounds wrong in a way a pitch change never does.
- The splitter holds $90^\circ$ only above a few hundred hertz, so the voice's lowest harmonics leak into the unwanted sideband. Zoom into the spectrum just below 100 kHz to see it.`,
    parts: {
      voice: { kind: 'voice', x: 0, y: 80, params: { rate: 48000 } },
      ...transmitter.parts,
      ...receiver.parts,
      sbScope: plot(760, -136, 'spectrum', {
        name: 'On the air',
        low: 95e3,
        high: 105e3,
      }),
      bfoKnob: control(-136, 540, 'bfo'),
      audioOut: plot(608, 396, 'time', { name: 'Audio out' }),
      speaker: speaker(608, 560),
    },
    links: [
      ...transmitter.links,
      ...receiver.links,
      ['sideband', 'sbScope'],
      ['down', 'audioOut'],
      ['down', 'speaker'],
    ],
    parameters: [{ name: 'bfo', value: 0, min: -300, max: 300, unit: 'Hz' }],
    panels: [
      [
        'SSB',
        [
          ['Sidebands', ['sbScope']],
          ['Receiver', ['bfoKnob', 'audioOut', 'speaker']],
        ],
      ],
    ],
  });
};

const ft8 = (): LabDocument => {
  const band: Band = { carrier: 30_000, rate: 96_000 };
  const transmitter = phasingTransmitter('ft8', band, 8);
  const receiver = bind(
    productReceiver(440, 'bfo', 'BFO', { noise: 7, bandwidth: 2500 }, band, 8),
    {
      receiver: { noise: '-3 - snr' },
      bfo: { frequency: `${band.carrier} + bfo` },
    },
  );
  return document({
    title: 'FT8 over SSB',
    notes: String.raw`FT8 sends 77 bits in 12.6 s as 79 tones 6.25 Hz apart, starting half a second into each 15 s slot. Here it goes out over SSB on a 30 kHz carrier and comes back through a product detector to the **FT8 decoder**, which decodes each slot as it ends and shows on its block what it found. Click the decoder to see its sync, SNR estimate and frequency.

The ${code('snr')} parameter is the SNR in 2500 Hz, the figure WSJT-X reports. The transmitter puts $-3$ dB on the air (a sine of amplitude 1), so the antenna's band noise is bound to

$$N = -3 - \mathrm{snr} \text{ dB in 2500 Hz}$$

- At $-10$ dB the decode is easy.
- At $-15$ dB it is still clean.
- Near $-17$ dB this decoder starts to miss. WSJT-X, which tries harder when belief propagation fails, reaches about $-21$ dB.

### Things to try
- Lower ${code('snr')} a decibel at a time and watch the waterfalls: the signal vanishes from view long before the decoder loses it. A change takes effect from then on, so give the decoder a whole slot to judge it.
- Set the ${code('bfo')} offset to 100 Hz. The whole signal shifts in frequency, and the decoder still finds it.
- Change the message. Only standard messages encode; anything else shows an error on the transmitter.`,
    parts: {
      ft8: {
        kind: 'subsystem',
        x: 0,
        y: 80,
        name: 'FT8 transmitter',
        inner: library('ft8-transmitter'),
      },
      ...transmitter.parts,
      ...receiver.parts,
      decoder: { kind: 'ft8-decoder', x: 600, y: 412 },
      howTo: note(
        -216,
        -184,
        'Press **Run**. **Sent** fills in as the bits go out and **Heard** as they arrive, uncorrected; **Message** is the decode as the slot ends.',
        true,
      ),
      message: control(-216, 80, 'ft8/message.message', 'Message', 'lcd'),
      sent: readout(-216, 168, 'ft8/message', 'Sent', 'lcd'),
      txTones: plot(176, -184, 'waterfall', {
        name: 'Tones sent',
        span: 2.4,
        low: 1480,
        high: 1560,
      }),
      symbol: readout(440, -184, 'ft8/mapper', 'Symbol'),
      tone: readout(440, -112, 'ft8/mapper', 'Tone'),
      carries: readout(440, -40, 'ft8/mapper', 'Carries'),
      snrKnob: control(-216, 400, 'snr'),
      bfoKnob: control(-216, 528, 'bfo'),
      heard: readout(800, 264, 'decoder', 'Heard', 'lcd'),
      decoded: readout(800, 336, 'decoder', 'Message', 'lcd'),
      toneErrors: readout(800, 408, 'decoder', 'Tone errors'),
      snrEstimate: readout(800, 480, 'decoder', 'SNR'),
      rxWaterfall: plot(600, 568, 'waterfall', {
        name: 'Receiver audio',
        span: 15,
        low: 1000,
        high: 2000,
      }),
      speaker: speaker(600, 728),
    },
    links: [
      ...transmitter.links,
      ...receiver.links,
      ['down', 'decoder'],
      ['ft8', 'txTones'],
      ['down', 'rxWaterfall'],
      ['down', 'speaker'],
    ],
    parameters: [
      { name: 'snr', value: -10, min: -30, max: 10, unit: 'dB' },
      { name: 'bfo', value: 0, min: -300, max: 300, unit: 'Hz' },
    ],
    panels: [
      [
        'Transmitter',
        [
          [
            'Message',
            [
              ['message', 8, 2],
              ['sent', 8, 2],
              ['symbol', 4, 2],
              ['tone', 2, 2],
              ['carries', 3, 2],
            ],
          ],
          ['Tones', [['txTones', 7, 5]]],
        ],
      ],
      [
        'Receiver',
        [
          ['Radio', ['snrKnob', 'bfoKnob', ['rxWaterfall', 9, 5], 'speaker']],
          [
            'Decoder',
            [
              ['heard', 8, 2],
              ['decoded', 8, 2],
              ['toneErrors', 4, 2],
              ['snrEstimate', 4, 2],
            ],
          ],
          ['How to', [['howTo', 9, 3]]],
        ],
      ],
    ],
  });
};

const ft8Encoding = (): LabDocument =>
  document({
    title: 'FT8: from a message to audio',
    notes: String.raw`The FT8 transmitter laid out flat, from text to bits to tones to sound, with a plot on the way. Run it at ⅛× to watch each bit and symbol go by.

Between the first four blocks the bits travel as **NRZ**: $+1$ for a 1, $-1$ for a 0, 0 between bits, a third of a symbol each. They run a symbol ahead of the tones that carry them, as a real modulator gathers a symbol's three bits before it sends the tone.

1. The **message** packs into 77 bits: 28 for each callsign, 15 for the grid or report, 3 for the kind of message. Each field is one number: a callsign's characters are the digits of a number in a mixed base, so no bit belongs to any one character. Select the message block to see each field worked out. The bits go out most significant first, so **Sent** fills in from the left, while **Field** and **Number** show what the bits going out belong to.
2. The **CRC-14** passes them on and adds 14 check bits, so the receiver can tell a good decode from a bad one. The **CRC** readout shows them.
3. The **LDPC encoder** passes those 91 on and adds 83 parity bits, which let the receiver correct bits it hears wrong: 174 coded bits.
4. The **symbol mapper** reads them three at a time and Gray-codes each three onto a **Tone** from 0 to 7, between three 7-tone Costas arrays for sync: 79 tones, one every 0.16 s. The **Bits to tones** view hanging off it lines up its last few symbols a column each: the three bits each **carries** and the tone they pick, the tone, the glide, and the baseband stacked under it.
5. The **Gaussian filter** smooths those steps into a **Glide** ($BT = 2$), so the tone moves rather than jumps and splashes less energy onto its neighbours.
6. The **VCO** turns the glide into audio, tone 0 at 1500 Hz and 6.25 Hz higher for each tone up, and the mapper's key turns it on once the filter has caught up. A second VCO at rest at 0 Hz makes the **Baseband**: the audio as if tone 0 sat at 0 Hz, so tone $k$ makes $k$ cycles a symbol and you can count them. The real audio is far too fast to see, so the waterfall shows it instead.

### Things to try
- Change the message; the new one goes out from the next slot.
- Probe a wire between two stages and compare: the CRC and LDPC pass the bits before them through unchanged.
- Lower the Gaussian filter's BT for gentler glides, and watch the waterfall's skirts narrow.
- Turn the speaker on at 1× to hear it.`,
    parts: {
      message: {
        kind: 'ft8-message',
        x: 0,
        y: 240,
        params: { message: 'K1ABC W9XYZ -12', start: 0.5, rate: 12000 },
      },
      crc: { kind: 'crc14', x: 176, y: 240, params: { start: 0.5 } },
      ldpc: { kind: 'ldpc', x: 352, y: 240, params: { start: 0.5 } },
      mapper: {
        kind: 'ft8-mapper',
        x: 528,
        y: 240,
        name: 'Symbol mapper',
        params: { start: 0.5 },
      },
      smooth: {
        kind: 'gaussian',
        x: 704,
        y: 232,
        params: { time: 0.16, bt: 2 },
      },
      vco: {
        kind: 'vco',
        x: 880,
        y: 232,
        params: { rest: 1500, sensitivity: 6.25 },
      },
      keyer: { kind: 'mixer', x: 1080, y: 240, name: 'Key' },
      wait: {
        kind: 'delay',
        x: 704,
        y: 352,
        name: 'Wait for the filter',
        params: { time: FT8_FILTER_DELAY },
      },
      slow: {
        kind: 'vco',
        x: 880,
        y: 448,
        name: 'Baseband VCO',
        params: { rest: 0, sensitivity: 6.25 },
      },
      slowKeyer: { kind: 'mixer', x: 1080, y: 456, name: 'Key' },
      messageText: control(-216, 136, 'message.message', 'Message', 'lcd'),
      sent: readout(-216, 224, 'message', 'Sent', 'lcd'),
      field: readout(-216, 304, 'message', 'Field', 'lcd'),
      number: readout(-216, 384, 'message', 'Number', 'lcd'),
      crcBits: readout(-216, 464, 'crc', 'CRC', 'lcd'),
      messageBits: plot(0, 40, 'time', { name: 'Message bits', span: 2.4 }),
      codedBits: plot(272, 40, 'time', { name: 'Coded bits', span: 2.4 }),
      bitsToTones: symbolView(560, 24, 'mapper'),
      basebandPlot: plot(1168, 448, 'time', {
        name: 'Baseband',
        span: 0.48,
        stack: 'bitsToTones',
      }),
      audio: plot(1168, 200, 'waterfall', {
        name: 'Audio',
        span: 2.4,
        low: 1480,
        high: 1560,
      }),
      speaker: speaker(1168, 360),
      howTo: note(
        -216,
        -88,
        'Press **Run**, then try ⅛×: a plot on each step from text to bits to tones to sound.',
        true,
      ),
    },
    links: [
      ['message', 'crc'],
      ['crc', 'ldpc'],
      ['ldpc', 'mapper'],
      ['mapper:0', 'smooth'],
      ['smooth', 'vco'],
      ['vco:0', 'keyer:0'],
      ['mapper:1', 'wait'],
      ['wait', 'keyer:1'],
      ['smooth', 'slow'],
      ['slow:0', 'slowKeyer:0'],
      ['wait', 'slowKeyer:1'],
      ['message', 'messageBits'],
      ['ldpc', 'codedBits'],
      ['slowKeyer', 'basebandPlot'],
      ['keyer', 'audio'],
      ['keyer', 'speaker'],
    ],
    panels: [
      [
        'Packing',
        [
          [
            'Message',
            [
              ['messageText', 6, 2],
              ['sent', 6, 2],
              ['field', 6, 2],
              ['number', 6, 2],
              ['crcBits', 6, 2],
            ],
          ],
          [
            'Bits',
            [
              ['messageBits', 7, 4],
              ['codedBits', 7, 4],
            ],
          ],
        ],
      ],
      [
        'Bits to tones',
        [
          ['Symbols', [['bitsToTones', 14, 10]]],
          ['Audio', [['audio', 6, 4], 'speaker']],
          ['How to', [['howTo', 14, 2]]],
        ],
      ],
    ],
  });

const echo = (): LabDocument =>
  document({
    title: 'Echo: a feedback loop',
    notes: String.raw`The sum's output, delayed and turned down, comes back into it:

$$y[n] = x[n] + g\, y[n - D]$$

The **Delay** is what makes the loop computable. Inside a loop the simulator steps every block together, one delay's worth of samples at a time, so each block only ever reads values that already exist.

### Things to try
- Raise ${code('feedback')} above 1 and the echoes grow instead of dying away.
- Shorten ${code('delay')} to a few milliseconds and the echoes merge into a comb filter; look at the spectrum.`,
    parts: {
      voice: {
        kind: 'voice',
        x: 0,
        y: 80,
        params: { vowel: 'oo', pitch: 180, rate: 48000 },
      },
      sum: { kind: 'adder', x: 184, y: 84, name: 'Sum' },
      delay: {
        kind: 'delay',
        x: 280,
        y: 80,
        params: { time: 0.3 },
        bindings: { time: 'delay' },
      },
      feedback: {
        kind: 'gain',
        x: 464,
        y: 80,
        name: 'Feedback',
        params: { gain: 0.5 },
        bindings: { gain: 'feedback' },
      },
      delayKnob: control(280, -24, 'delay'),
      feedbackKnob: control(480, -24, 'feedback'),
      output: plot(264, 200, 'time', { name: 'Output', span: 2 }),
      speaker: speaker(264, 368),
    },
    links: [
      ['voice', 'sum:0'],
      ['sum', 'delay'],
      ['delay', 'feedback'],
      ['feedback', 'sum:1'],
      ['sum', 'output'],
      ['sum', 'speaker'],
    ],
    parameters: [
      { name: 'feedback', value: 0.5, min: 0, max: 1.2, unit: 'x' },
      {
        name: 'delay',
        value: 0.3,
        min: 0.001,
        max: 1,
        unit: 's',
        scale: 'log',
      },
    ],
    panels: [
      [
        'Echo',
        [
          ['Echo', ['delayKnob', 'feedbackKnob']],
          ['Output', [['output', 10, 5], 'speaker']],
        ],
      ],
    ],
  });

const sweep = (): LabDocument =>
  document({
    title: 'Filter shapes from a sweep',
    notes: String.raw`The sweep glides from 20 Hz to 20 kHz every 4 s, so time stands in for frequency: the outline of each filter's output traces its frequency response on a log scale.

### Things to try
- Move ${code('cutoff')} and watch the low-pass's edge follow.
- Change the low-pass order and watch the skirt steepen.
- Add band-pass sections and the top flattens while the sides fall away faster.`,
    parts: {
      sweep: {
        kind: 'sweep',
        x: 0,
        y: 80,
        params: {
          from: 20,
          to: 20000,
          spacing: 'log',
          period: 4,
          rate: 48000,
        },
      },
      lowpass: {
        kind: 'lowpass',
        x: 184,
        y: 80,
        params: { cutoff: 1000, order: '4' },
        bindings: { cutoff: 'cutoff' },
      },
      bandpass: {
        kind: 'bandpass',
        x: 184,
        y: 176,
        params: { center: 3000, bandwidth: 500, sections: 2 },
      },
      orderSwitch: control(0, -32, 'lowpass.order', 'Low-pass order'),
      cutoffKnob: control(184, -32, 'cutoff'),
      lowpassScope: plot(376, 36, 'time', { name: 'Low-pass', span: 4 }),
      bandpassScope: plot(376, 200, 'time', { name: 'Band-pass', span: 4 }),
    },
    links: [
      ['sweep', 'lowpass'],
      ['sweep', 'bandpass'],
      ['lowpass', 'lowpassScope'],
      ['bandpass', 'bandpassScope'],
    ],
    parameters: [
      {
        name: 'cutoff',
        value: 1000,
        min: 100,
        max: 10000,
        unit: 'Hz',
        scale: 'log',
      },
    ],
    panels: [
      [
        'Filters',
        [
          ['Filter', ['cutoffKnob', ['orderSwitch', 6, 2]]],
          ['Responses', ['lowpassScope', 'bandpassScope']],
        ],
      ],
    ],
  });

export const examples: readonly {
  readonly title: string;
  readonly build: () => LabDocument;
}[] = [
  { title: 'AM with an envelope detector', build: am },
  { title: 'Speech on an AM carrier', build: talkingAm },
  { title: 'Two stations on the air', build: twoStations },
  { title: 'DSB-SC and the product detector', build: dsb },
  { title: 'SSB by the phasing method', build: ssb },
  { title: 'FT8 over SSB', build: ft8 },
  { title: 'FT8: from a message to audio', build: ft8Encoding },
  { title: 'Echo: a feedback loop', build: echo },
  { title: 'Filter shapes from a sweep', build: sweep },
];
