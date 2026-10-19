// Sample-rate changes by whole-number factors: polyphase filtering with a Kaiser-windowed
// low-pass at the higher rate. Both directions are causal and work a chunk at a time, keeping
// the inputs their filter still reaches. They delay the signal by half the filter length, as a
// real resampler would; raising the rate costs one more input sample, so that a chunk's outputs
// never need an input from the next chunk. The Interpolator at the end reads a signal at any
// fractional position instead, for the speaker, filtered for the rate it is read at.

import { kaiserBeta, kaiserLength, lowpassTaps } from './fir.ts';

/** Alias and image rejection in dB. */
const ATTENUATION = 80;

/**
 * Filter for a rate change by `factor`, at the higher rate. It passes up to
 * 80% of the lower rate's Nyquist frequency and rejects everything from that
 * Nyquist frequency up.
 */
function resamplerTaps(factor: number, gain: number): Float64Array {
  const width = 0.1 / factor;
  const length = kaiserLength(ATTENUATION, width) | 1;
  return lowpassTaps(
    length,
    0.5 / factor - width / 2,
    kaiserBeta(ATTENUATION),
    gain,
  );
}

/** Delay a factor-F rate change adds, in samples at the higher rate. */
export function resamplerDelay(
  factor: number,
  direction: 'up' | 'down',
): number {
  const half = (resamplerTaps(factor, 1).length - 1) / 2;
  return direction === 'up' ? half + factor : half;
}

/**
 * The inputs a resampler has seen, the latest `kept` of them carried over from
 * chunk to chunk: `work[i]` is input number `first + i` in the stream.
 */
class Inputs {
  readonly #kept: number;
  work: Float64Array;
  length: number;
  first: number;

  constructor(kept: number, next: number) {
    this.#kept = kept;
    this.work = new Float64Array(kept);
    this.length = kept;
    this.first = next - kept;
  }

  /** Adds a chunk after the inputs kept from before. */
  add(chunk: Float32Array): void {
    const kept = this.#kept;
    const length = kept + chunk.length;
    if (this.work.length < length) {
      const work = new Float64Array(length);
      work.set(this.work.subarray(this.length - kept, this.length));
      this.work = work;
    } else {
      this.work.copyWithin(0, this.length - kept, this.length);
    }

    for (let i = 0; i < chunk.length; i++) {
      this.work[kept + i] = chunk[i];
    }

    this.first += this.length - kept;
    this.length = length;
  }
}

/**
 * Raises the rate by `factor`: zero-stuffing then interpolation, computed one
 * phase at a time. `first` and `next` say where the stream is when it starts:
 * the numbers of the first input it will get and of the first output.
 */
export class Upsampler {
  readonly #factor: number;
  readonly #taps: Float64Array;
  readonly #inputs: Inputs;
  #next: number;

  constructor(factor: number, first = 0, next = first * factor) {
    this.#factor = factor;
    // Gain `factor` makes up for the zeros stuffed between samples.
    this.#taps = resamplerTaps(factor, factor);
    this.#inputs = new Inputs(
      Math.ceil(this.#taps.length / factor) + 2,
      first,
    );
    this.#next = next;
  }

  /** Takes the next chunk of input and fills `output` with what follows. */
  process(input: Float32Array, output: Float32Array): void {
    const factor = this.#factor;
    const taps = this.#taps;
    const inputs = this.#inputs;
    inputs.add(input);
    const { work, first } = inputs;
    for (let i = 0; i < output.length; i++) {
      const n = this.#next + i;
      // Tap phase + q * factor meets input floor(n / factor) - 1 - q.
      let j = Math.floor(n / factor) - 1 - first;
      let sum = 0;
      for (let k = n % factor; k < taps.length && j >= 0; k += factor, j--) {
        sum += taps[k] * work[j];
      }

      output[i] = sum;
    }

    this.#next += output.length;
  }
}

/**
 * Lowers the rate by `factor`: anti-alias filtering, computed only at the kept
 * samples.
 */
export class Downsampler {
  readonly #factor: number;
  readonly #taps: Float64Array;
  readonly #inputs: Inputs;
  #next: number;

  constructor(factor: number, first = 0, next = Math.floor(first / factor)) {
    this.#factor = factor;
    this.#taps = resamplerTaps(factor, 1);
    this.#inputs = new Inputs(this.#taps.length + factor, first);
    this.#next = next;
  }

  process(input: Float32Array, output: Float32Array): void {
    const taps = this.#taps;
    const inputs = this.#inputs;
    inputs.add(input);
    const { work, first } = inputs;
    for (let i = 0; i < output.length; i++) {
      const j = (this.#next + i) * this.#factor - first;
      let sum = 0;
      for (let k = 0; k < taps.length && k <= j; k++) {
        sum += taps[k] * work[j - k];
      }

      output[i] = sum;
    }

    this.#next += output.length;
  }
}

/** Raises the rate of a whole signal by `factor` into `output`. */
export function upsample(
  input: Float32Array,
  factor: number,
  output: Float32Array,
): void {
  new Upsampler(factor).process(input, output);
}

/** Lowers the rate of a whole signal by `factor` into `output`. */
export function downsample(
  input: Float32Array,
  factor: number,
  output: Float32Array,
): void {
  new Downsampler(factor).process(input, output);
}

/**
 * A whole signal at another rate, by any ratio: low-pass filtered first if the
 * new rate is lower, then interpolated with a cubic (Catmull-Rom).
 */
export function resampleTo(
  input: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (Math.abs(from - to) < 1e-9 * from) {
    return input;
  }

  let source = input;
  if (to < from) {
    // Keep below 90% of the new Nyquist frequency, so nothing folds back.
    const width = (0.1 * to) / 2 / from;
    const taps = lowpassTaps(
      kaiserLength(ATTENUATION, width) | 1,
      (0.45 * to) / from,
      kaiserBeta(ATTENUATION),
    );
    const half = (taps.length - 1) / 2;
    source = new Float32Array(input.length);

    for (let i = 0; i < input.length; i++) {
      let sum = 0;
      for (let k = 0; k < taps.length; k++) {
        const j = i + half - k;
        if (j >= 0 && j < input.length) {
          sum += taps[k] * input[j];
        }
      }

      source[i] = sum;
    }
  }

  const length = Math.max(1, Math.floor((input.length * to) / from));
  const out = new Float32Array(length);
  const at = (j: number) =>
    source[Math.min(source.length - 1, Math.max(0, j))];
  for (let n = 0; n < length; n++) {
    const p = (n * from) / to;
    const j = Math.floor(p);
    const f = p - j;
    const [a, b, c, d] = [at(j - 1), at(j), at(j + 1), at(j + 2)];
    out[n] =
      b +
      0.5 *
        f *
        (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
  }

  return out;
}

/** Points per zero crossing in the interpolator's table of its kernel. */
const RESOLUTION = 512;

/**
 * How much wider than a sinc at the signal's own rate the kernel spreads: by
 * the ratio when reading sparser than the signal's rate, so its cutoff falls
 * to 90% of half the rate it is read at.
 */
const stretch = (ratio: number) => Math.max(1, ratio) / 0.9;

/**
 * Reads a signal at any fractional sample position through a Blackman-windowed
 * sinc, cut off below half the rate it is read at. Reading a signal sparser
 * than its own rate, as a speaker at a lower rate or a tape played fast does,
 * then folds nothing above that back down.
 */
export class Interpolator {
  /** Zero crossings of the sinc each side. */
  readonly #zeros: number;
  /** The kernel from 0 out to `#zeros` zero crossings. */
  readonly #table: Float32Array;

  constructor(zeros = 8) {
    this.#zeros = zeros;
    this.#table = new Float32Array(zeros * RESOLUTION + 2);

    for (let k = 0; k < zeros * RESOLUTION; k++) {
      const x = k / RESOLUTION;
      const sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = x / zeros;
      this.#table[k] =
        sinc *
        (0.42 +
          0.5 * Math.cos(Math.PI * u) +
          0.08 * Math.cos(2 * Math.PI * u));
    }
  }

  /**
   * How many samples either side of a position a read `ratio` samples apart
   * reaches.
   */
  reach(ratio: number): number {
    return Math.ceil(this.#zeros * stretch(ratio)) + 1;
  }

  /** `data` at `position`, read `ratio` of its samples apart. */
  at(data: Float32Array, position: number, ratio: number): number {
    const scale = RESOLUTION / stretch(ratio);
    const reach = this.#zeros * stretch(ratio);
    const first = Math.max(0, Math.ceil(position - reach));
    const last = Math.min(data.length - 1, Math.floor(position + reach));
    let sum = 0;
    let weight = 0;

    for (let i = first; i <= last; i++) {
      const x = Math.abs(position - i) * scale;
      const k = Math.floor(x);
      const w =
        this.#table[k]! + (x - k) * (this.#table[k + 1]! - this.#table[k]!);
      sum += w * data[i]!;
      weight += w;
    }

    // Dividing by the weights keeps a steady level exactly as it was.
    return weight > 0 ? sum / weight : 0;
  }
}
