// FIR design (Kaiser-windowed sinc and Hilbert transformers) and a streaming FIR filter.

/**
 * Zeroth-order modified Bessel function of the first kind, by its power
 * series.
 */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= quarter / (k * k);
    sum += term;

    if (term < 1e-12 * sum) {
      break;
    }
  }

  return sum;
}

/** Kaiser beta that gives about `attenuation` dB of stopband rejection. */
export function kaiserBeta(attenuation: number): number {
  if (attenuation > 50) {
    return 0.1102 * (attenuation - 8.7);
  }

  if (attenuation >= 21) {
    return 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21);
  }

  return 0;
}

/**
 * Taps needed for `attenuation` dB with a transition band `width` wide
 * (fraction of the rate).
 */
export function kaiserLength(attenuation: number, width: number): number {
  return Math.ceil((attenuation - 8) / (2.285 * 2 * Math.PI * width)) + 1;
}

function kaiserWindow(length: number, beta: number): Float64Array {
  const window = new Float64Array(length);
  const middle = (length - 1) / 2;
  const norm = besselI0(beta);
  for (let n = 0; n < length; n++) {
    const r = middle === 0 ? 0 : (n - middle) / middle;
    window[n] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
  }

  return window;
}

/**
 * Windowed-sinc low-pass taps with DC gain `gain`. `cutoff` is the -6 dB point
 * as a fraction of the sample rate, between 0 and 0.5.
 */
export function lowpassTaps(
  length: number,
  cutoff: number,
  beta: number,
  gain = 1,
): Float64Array {
  const taps = kaiserWindow(length, beta);
  const middle = (length - 1) / 2;
  let sum = 0;
  for (let n = 0; n < length; n++) {
    const t = n - middle;
    taps[n] *=
      t === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    sum += taps[n];
  }

  for (let n = 0; n < length; n++) {
    taps[n] *= gain / sum;
  }

  return taps;
}

/**
 * Hilbert transformer taps (odd length): h[n] = 2 / (pi n) at odd offsets from
 * the middle and 0 elsewhere, windowed. The output is the input shifted by -90
 * degrees and delayed by (length - 1) / 2 samples.
 */
export function hilbertTaps(length: number, beta = 8): Float64Array {
  const taps = kaiserWindow(length, beta);
  const middle = (length - 1) / 2;
  for (let n = 0; n < length; n++) {
    const t = n - middle;
    taps[n] *= t % 2 === 0 ? 0 : 2 / (Math.PI * t);
  }

  return taps;
}

/**
 * Streaming FIR filter; the last taps.length - 1 inputs carry over between
 * calls.
 */
export class Fir {
  readonly #taps: Float64Array;
  /**
   * Input history written twice, so the latest `taps.length` values are always
   * contiguous.
   */
  readonly #history: Float64Array;
  #position = 0;

  constructor(taps: Float64Array) {
    this.#taps = taps;
    this.#history = new Float64Array(2 * taps.length);
  }

  /** Filters samples [start, end) of `input` into `output`. */
  process(
    input: Float32Array,
    output: Float32Array,
    start = 0,
    end = output.length,
  ): void {
    const taps = this.#taps;
    const length = taps.length;
    const history = this.#history;
    for (let i = start; i < end; i++) {
      this.#position = (this.#position + length - 1) % length;
      history[this.#position] = input[i];
      history[this.#position + length] = input[i];
      let sum = 0;
      for (let k = 0; k < length; k++) {
        sum += taps[k] * history[this.#position + k];
      }

      output[i] = sum;
    }
  }
}

/**
 * Streaming delay by a whole number of samples (zero passes the input
 * through).
 */
export class SampleDelay {
  readonly #buffer: Float32Array;
  #position = 0;

  constructor(samples: number) {
    this.#buffer = new Float32Array(samples);
  }

  /** Delays samples [start, end) of `input` into `output`. */
  process(
    input: Float32Array,
    output: Float32Array,
    start = 0,
    end = output.length,
  ): void {
    const buffer = this.#buffer;
    if (buffer.length === 0) {
      output.set(input.subarray(start, end), start);
      return;
    }

    for (let i = start; i < end; i++) {
      const value = input[i];
      output[i] = buffer[this.#position];
      buffer[this.#position] = value;
      this.#position = (this.#position + 1) % buffer.length;
    }
  }
}
