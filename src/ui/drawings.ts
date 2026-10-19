// Block icon definitions in a 24-unit coordinate system. Paths, circles, and
// rectangles are rendered by icons.ts. Keeping these definitions independent
// of the DOM lets geometry code inspect icon availability.

export type Part =
  | string
  | { readonly circle: readonly [x: number, y: number, r: number] }
  | {
      readonly box: readonly [x: number, y: number, w: number, h: number];
      readonly dashed?: boolean;
    };

const SINE = 'M2 12C5 4 9 4 12 12S19 20 22 12';
const STEPS = 'M3 17h4v-5h4v-6h4v9h4v-4h2';

export const DRAWINGS: Readonly<Record<string, readonly Part[]>> = {
  // Sources
  oscillator: [SINE],
  voice: ['M4 10v4M7 7v10M10 4v16M13 8v8M16 6v12M19 10v4'],
  recording: [
    { circle: [7, 11, 3.5] },
    { circle: [17, 11, 3.5] },
    'M7 14.5h10',
    'M3 19h18',
  ],
  speech: ['M4 5h16v10h-9l-4 4v-4H4z', 'M8 9h8M8 12h5'],
  noise: ['M2 12l2-5 2 8 2-6 2 8 2-11 2 8 2-6 2 8 2-6 2 2'],
  constant: ['M3 9h18', 'M3 18h18'],
  sweep: [
    'M2 12C3.5 4 5.5 4 7 12S10 20 11 12S13 5 13.8 12S15.4 18 16 12S17.2 7 17.6 12S18.6 16 19 12S19.8 9 20.2 12',
  ],
  vco: ['M2 15C5 8 9 8 12 15S19 22 22 15', 'M12 2v7', 'M9.5 6.5 12 9l2.5-2.5'],
  // Radio
  antenna: ['M12 22V9', 'M12 9 6 3M12 9l6-6', 'M15.5 14a5 5 0 0 0 0-7'],
  // Math
  gain: ['M5 4l14 8-14 8z'],
  offset: ['M4 18h16', 'M12 15V5', 'M8.5 8.5 12 5l3.5 3.5'],
  adder: [{ circle: [12, 12, 8.5] }, 'M12 7.5v9M7.5 12h9'],
  mixer: [{ circle: [12, 12, 8.5] }, 'M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4'],
  // Nonlinear
  rectifier: ['M3 18Q7 4 11 18Q15 4 19 18', 'M19 18q1-3 2-3'],
  diode: ['M3 12h5M16 12h5', 'M8 6l8 6-8 6z', 'M16 6v12'],
  square: ['M4 4q8 26 16 0', 'M3 20h18'],
  clipper: ['M2 12l3-6h4l3 6 3 6h4l3-6', 'M2 6h20M2 18h20'],
  // Filters, as their responses
  lowpass: ['M3 7h9q4 0 7 11', 'M3 19h18'],
  highpass: ['M5 18q3-11 7-11h9', 'M3 19h18'],
  bandpass: ['M3 18q5 0 7-11h4q2 11 7 11', 'M3 19h18'],
  gaussian: ['M3 18c5 0 6-13 9-13s4 13 9 13', 'M3 19h18'],
  // Detectors
  capacitor: ['M3 12h7M14 12h7', 'M10 5v14M14 5v14'],
  'template:envelope-detector': [
    'M3 8c5-5 13-5 18 0',
    'M3 17l2-8 2 8 2-9 2 9 2-10 2 10 2-9 2 9 2-8',
  ],
  'template:product-detector': [
    { circle: [9, 12, 6] },
    'M6.3 9.3l5.4 5.4M11.7 9.3l-5.4 5.4',
    'M15 12h6',
    'M9 3v3',
  ],
  // Meters
  meter: ['M3 17a9 9 0 0 1 18 0', 'M12 17l4-7', 'M3 20h18'],
  'snr-meter': [
    'M3 15a9 9 0 0 1 18 0',
    'M12 15 8 8',
    'M3 20l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5',
  ],
  // Digital modes
  'ft8-message': [{ box: [3, 5, 18, 14] }, 'M6 10h12M6 14h7'],
  crc14: [{ box: [3, 5, 18, 14] }, 'M8 12l3 3 5-6'],
  ldpc: [
    { box: [3, 4, 5, 5] },
    { box: [16, 4, 5, 5] },
    { box: [9.5, 15, 5, 5] },
    'M8 6.5h8M6.5 9l4.5 6M17.5 9 13 15',
  ],
  'ft8-mapper': ['M4 7h2M8 7h2M12 7h2M16 7h2', STEPS],
  'ft8-decoder': [
    { circle: [10, 10, 6.5] },
    'M14.8 14.8 21 21',
    'M6.5 12h2v-3h2v4h2v-2h1',
  ],
  'template:ft8-transmitter': [
    'M2 16h3v-5h3v7h3v-4h2',
    'M14 12c1.5-4 3-4 4 0s2.5 4 4 0',
  ],
  // Time and rate
  delay: [{ circle: [12, 12, 8.5] }, 'M12 7v5l3.5 2'],
  hilbert: ['M3 12h6', 'M9 12l5-5h7M9 12l5 5h7'],
  resample: [
    'M4 19v-8M8 19V6M12 19v-9M16 19V5M20 19v-7',
    { circle: [4, 11, 1.2] },
    { circle: [8, 6, 1.2] },
    { circle: [12, 10, 1.2] },
    { circle: [16, 5, 1.2] },
    { circle: [20, 12, 1.2] },
  ],
  // Subsystems
  'terminal-in': ['M3 12h10', 'M10 8.5 13.5 12 10 15.5', 'M17 4v16'],
  'terminal-out': ['M7 4v16', 'M10 12h10', 'M17 8.5l3.5 3.5-3.5 3.5'],
  'template:subsystem': [
    { box: [2.5, 4.5, 19, 15], dashed: true },
    { box: [6, 9, 4, 6] },
    { box: [14, 9, 4, 6] },
    'M10 12h4',
  ],
  // Instruments
  plot: [{ box: [3, 5, 18, 14] }, 'M5.5 12c1.5-4 3-4 4.5 0s3 4 4.5 0 3-4 4 0'],
  speaker: [
    'M4 9.5h3.5L12 6v12l-4.5-3.5H4z',
    'M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10',
  ],
  control: [
    { circle: [12, 13, 6] },
    'M12 13l3.5-4',
    'M3.5 13H5M19 13h1.5M12 4.5V6M6 7l1 1M18 7l-1 1',
  ],
  readout: [{ box: [3, 7, 18, 10] }, 'M6.5 10v4M6.5 10h3v4h-3M12 10h3v4h-3z'],
  symbols: ['M4 6h2M8 6h2M12 6h2M16 6h2', 'M3 19h4v-4h4v-3h4v5h4v-3h2'],
  button: [{ box: [3, 8, 18, 9] }, { circle: [12, 12.5, 1.4] }],
  note: ['M6 3h9l4 4v14H6z', 'M15 3v4h4', 'M9 11h7M9 15h7'],
};

/** Whether there is a drawing for a palette entry or block kind. */
export const hasIcon = (key: string) => key in DRAWINGS;
