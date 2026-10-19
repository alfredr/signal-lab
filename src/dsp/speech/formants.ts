// Parallel formant synthesizer ported from klattsch's FormantSynth (MIT,
// copyright 2026 Tony Gies; see licenses/klattsch.txt). Glottal pulses and
// noise excite three parallel band-pass resonators. Parameters interpolate
// linearly between phoneme targets.

/** Everything the synthesizer is told, at any moment. */
export type Voice = {
  /** Pitch of the glottal pulse, in Hz. */
  readonly F0: number;
  /** From 0, all noise (as in "s"), to 1, all pulse (as in a vowel). */
  readonly voicing: number;
  /** Each formant's frequency, bandwidth and amplitude. */
  readonly F1: number;
  readonly BW1: number;
  readonly A1: number;
  readonly F2: number;
  readonly BW2: number;
  readonly A2: number;
  readonly F3: number;
  readonly BW3: number;
  readonly A3: number;
  readonly gain: number;
  /** Breathiness: noise mixed into the voiced sound, 0 to 1. */
  readonly aspiration: number;
  /** Spectral tilt, from -0.95 (darker) to 0.95 (brighter). */
  readonly tilt: number;
  /** The glottal pulse's shape, from 0 (lax) to 1 (tense). */
  readonly effort: number;
};

/** One change of target, and how long the glide to it takes. */
export type Step = {
  readonly atMs: number;
  readonly target: Partial<Voice>;
  readonly transitionMs: number;
};

const KEYS = [
  'F0',
  'voicing',
  'F1',
  'BW1',
  'A1',
  'F2',
  'BW2',
  'A2',
  'F3',
  'BW3',
  'A3',
  'gain',
  'aspiration',
  'tilt',
  'effort',
] as const satisfies readonly (keyof Voice)[];

const QUIET: Voice = {
  F0: 120,
  voicing: 0,
  F1: 500,
  BW1: 80,
  A1: 0,
  F2: 1500,
  BW2: 120,
  A2: 0,
  F3: 2500,
  BW3: 160,
  A3: 0,
  gain: 3.5,
  aspiration: 0,
  tilt: 0,
  effort: 0.5,
};

/**
 * A constant-skirt-gain band-pass biquad (RBJ cookbook), redesigned only when
 * its frequency or bandwidth changes.
 */
class Resonator {
  #b0 = 0;
  #b2 = 0;
  #a1 = 0;
  #a2 = 0;
  #x1 = 0;
  #x2 = 0;
  #y1 = 0;
  #y2 = 0;
  #f = -1;
  #bw = -1;

  tune(frequency: number, bandwidth: number, rate: number): void {
    if (frequency === this.#f && bandwidth === this.#bw) {
      return;
    }

    this.#f = frequency;
    this.#bw = bandwidth;
    const f = Math.max(40, Math.min(rate * 0.45, frequency));
    const w = (2 * Math.PI * f) / rate;
    const alpha = Math.sin(w) / (2 * (f / Math.max(20, bandwidth)));
    const a0 = 1 + alpha;
    this.#b0 = alpha / a0;
    this.#b2 = -alpha / a0;
    this.#a1 = (-2 * Math.cos(w)) / a0;
    this.#a2 = (1 - alpha) / a0;
  }

  filter(x: number): number {
    const y =
      this.#b0 * x +
      this.#b2 * this.#x2 -
      this.#a1 * this.#y1 -
      this.#a2 * this.#y2;
    this.#x2 = this.#x1;
    this.#x1 = x;
    this.#y2 = this.#y1;
    this.#y1 = y;
    return y;
  }
}

/**
 * Derivative of a Rosenberg glottal pulse at normalized `phase` in [0, 1):
 * opening rise, closing fall, and a closed interval. `effort` sharpens the
 * closing transition.
 */
function glottalPulse(phase: number, effort: number): number {
  const e = Math.min(1, Math.max(0, effort));
  const open = 0.5 - e * 0.2;
  const closing = 0.25 - e * 0.17;
  if (phase < open) {
    return 0.05 * (Math.PI / open) * Math.sin((Math.PI * phase) / open);
  }

  if (phase < open + closing) {
    return (
      -0.1 *
      (Math.PI / (2 * closing)) *
      Math.sin((Math.PI * (phase - open)) / (2 * closing))
    );
  }

  return 0;
}

/** Linear up to 0.85, then a soft knee, so loud moments round off. */
function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.85) {
    return x;
  }

  const excess = a - 0.85;
  return Math.sign(x) * (0.85 + (0.15 * excess) / (excess + 1));
}

/** Renders `steps` (in time order) to `length` samples at `rate`. */
export function synthesize(
  steps: readonly Step[],
  rate: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  const current: Record<keyof Voice, number> = { ...QUIET };
  const target: Record<keyof Voice, number> = { ...QUIET };
  const increment = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<
    keyof Voice,
    number
  >;
  const resonators = [new Resonator(), new Resonator(), new Resonator()];
  let left = 0;
  let phase = 0;
  let noise = 0xace1ace1 | 0;
  let previous = 0;
  let next = 0;
  for (let i = 0; i < length; i++) {
    while (next < steps.length && (steps[next].atMs * rate) / 1000 <= i) {
      const step = steps[next++];
      left = Math.max(1, Math.floor((step.transitionMs * rate) / 1000));

      for (const k of KEYS) {
        target[k] = step.target[k] ?? target[k];
        increment[k] = (target[k] - current[k]) / left;
      }
    }

    if (left > 0) {
      left--;

      for (const k of KEYS) {
        current[k] = left === 0 ? target[k] : current[k] + increment[k];
      }
    }

    // xorshift noise, and the pulse, mixed by how voiced the sound is.
    noise ^= noise << 13;
    noise ^= noise >>> 17;
    noise ^= noise << 5;
    const hiss = noise / 2147483648;
    const voiced = Math.min(1, Math.max(0, current.voicing));
    const excitation =
      voiced *
        glottalPulse(phase, current.effort) *
        (1 - current.aspiration * 0.85) +
      (1 - voiced) * hiss * 0.35 +
      current.aspiration * hiss * 0.5;
    phase += current.F0 / rate;
    phase -= Math.floor(phase);

    resonators[0].tune(current.F1, current.BW1, rate);
    resonators[1].tune(current.F2, current.BW2, rate);
    resonators[2].tune(current.F3, current.BW3, rate);
    const y =
      (resonators[0].filter(excitation) * current.A1 +
        resonators[1].filter(excitation) * current.A2 +
        resonators[2].filter(excitation) * current.A3) *
      current.gain;
    out[i] = softClip(y - current.tilt * previous);
    previous = y;
  }

  return out;
}
