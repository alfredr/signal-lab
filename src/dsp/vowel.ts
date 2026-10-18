// A sung vowel, carried over from the Voice on an AM Carrier gadget: harmonics of the pitch,
// weighted by four formant resonances, with a little vibrato and two syllables.

import { mulberry32 } from '../engine/random.ts';

export type Vowel = 'ah' | 'ee' | 'oo';

/** Formant center frequency and bandwidth, in Hz. */
const FORMANTS: Record<Vowel, readonly (readonly [number, number])[]> = {
  ah: [
    [730, 70],
    [1090, 90],
    [2440, 120],
    [3400, 160],
  ],
  ee: [
    [270, 60],
    [2290, 100],
    [3010, 140],
    [3700, 180],
  ],
  oo: [
    [300, 60],
    [870, 80],
    [2240, 120],
    [3300, 160],
  ],
};

/** Length of one take: two syllables and the gaps around them. */
const VOWEL_SECONDS = 1.2;

/** Smooth on/off envelope for the two syllables. */
function syllables(t: number): number {
  const segment = (start: number, end: number, level: number): number => {
    if (t < start || t > end) {
      return 0;
    }

    const ramp = 0.04;
    if (t < start + ramp) {
      return level * (0.5 - 0.5 * Math.cos((Math.PI * (t - start)) / ramp));
    }

    if (t > end - ramp) {
      return level * (0.5 - 0.5 * Math.cos((Math.PI * (end - t)) / ramp));
    }

    return level;
  };

  return segment(0.06, 0.56, 1) + segment(0.68, 1.14, 0.7);
}

/**
 * One take of the vowel at `rate`, keeping harmonics below `bandwidth`. Scaled
 * so its most negative sample is -1, which is what decides overmodulation in
 * AM.
 */
export function synthesizeVowel(
  vowel: Vowel,
  pitch: number,
  bandwidth: number,
  rate: number,
): Float32Array {
  const formants = FORMANTS[vowel];
  const count = Math.max(
    1,
    Math.floor(Math.min(bandwidth, 0.45 * rate) / (pitch * 1.02)),
  );
  const random = mulberry32(7);
  const amplitudes: number[] = [];
  const phases: number[] = [];
  for (let k = 1; k <= count; k++) {
    const f = k * pitch;
    let gain = 1;
    for (const [center, width] of formants) {
      gain *=
        (center * center) /
        Math.sqrt((center * center - f * f) ** 2 + (width * f) ** 2);
    }

    amplitudes.push(gain / k);
    phases.push(random() * 2 * Math.PI);
  }

  const samples = new Float32Array(Math.round(VOWEL_SECONDS * rate));
  let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    phase +=
      (2 * Math.PI * pitch * (1 + 0.015 * Math.sin(2 * Math.PI * 5.2 * t))) /
      rate;
    const envelope = syllables(t);
    if (envelope <= 0) {
      continue;
    }

    let sum = 0;
    for (let k = 0; k < count; k++) {
      sum += amplitudes[k] * Math.cos((k + 1) * phase + phases[k]);
    }

    samples[i] = envelope * sum;
  }

  let negative = 0;
  let positive = 0;
  for (const value of samples) {
    negative = Math.max(negative, -value);
    positive = Math.max(positive, value);
  }

  const scale = negative < 0.05 * positive ? positive : negative;
  if (scale > 0) {
    for (let i = 0; i < samples.length; i++) {
      samples[i] /= scale;
    }
  }

  return samples;
}
