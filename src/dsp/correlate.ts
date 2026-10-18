import { fft } from './fft.ts';

/**
 * The longest stretch used to find a delay; plenty to lock on, and bounded in
 * memory.
 */
const LONGEST = 1 << 18;

/**
 * The delay L, within ±maxLag samples, at which `reference` delayed by L best
 * matches `signal`: the peak of their cross-correlation, found by FFT, over
 * the samples from `from` on.
 */
export function bestLag(
  signal: Float32Array,
  reference: Float32Array,
  from: number,
  maxLag: number,
): number {
  const n = Math.min(signal.length, reference.length, from + LONGEST) - from;
  if (n <= 0) {
    return 0;
  }

  let size = 1;
  while (size < n + maxLag) {
    size <<= 1;
  }

  const sRe = new Float64Array(size);
  const sIm = new Float64Array(size);
  const rRe = new Float64Array(size);
  const rIm = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    sRe[i] = signal[from + i];
    rRe[i] = reference[from + i];
  }

  fft(sRe, sIm);
  fft(rRe, rIm);

  // S times the conjugate of R, conjugated again so a forward FFT inverts it.
  for (let k = 0; k < size; k++) {
    const re = sRe[k] * rRe[k] + sIm[k] * rIm[k];
    const im = sIm[k] * rRe[k] - sRe[k] * rIm[k];
    sRe[k] = re;
    sIm[k] = -im;
  }

  fft(sRe, sIm);
  // Index L holds sum_j s[j + L] r[j]; negative lags wrap to the end.
  let best = 0;
  let bestValue = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const value = Math.abs(sRe[lag >= 0 ? lag : size + lag]);
    if (value > bestValue) {
      bestValue = value;
      best = lag;
    }
  }

  return best;
}

export type Fit = {
  /** Power of the part of `signal` explained by the reference. */
  readonly signal: number;
  /** Power of what is left over. */
  readonly error: number;
  readonly gain: number;
};

/**
 * Fits `signal` from `from` on as gain times the reference delayed by `lag`,
 * plus a little of its derivative, which absorbs a delay of a fraction of a
 * sample. Without that term, half a sample at 1.5 kHz and 12 kHz alone would
 * cap the SNR near 8 dB.
 */
export function fitReference(
  signal: Float32Array,
  reference: Float32Array,
  from: number,
  lag: number,
): Fit {
  const end = Math.min(signal.length, reference.length + lag) - 1;
  const start = Math.max(from, lag + 1, 1);
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = start; i < end; i++) {
    const e = reference[i - lag];
    const d = 0.5 * (reference[i - lag + 1] - reference[i - lag - 1]);
    a11 += e * e;
    a12 += e * d;
    a22 += d * d;
    b1 += signal[i] * e;
    b2 += signal[i] * d;
  }

  const det = a11 * a22 - a12 * a12;
  let g1 = a11 > 0 ? b1 / a11 : 0;
  let g2 = 0;
  if (a22 > 0 && Math.abs(det) > 1e-12 * a11 * a22) {
    g1 = (b1 * a22 - b2 * a12) / det;
    g2 = (a11 * b2 - a12 * b1) / det;
  }

  let explained = 0;
  let error = 0;
  for (let i = start; i < end; i++) {
    const e = reference[i - lag];
    const d = 0.5 * (reference[i - lag + 1] - reference[i - lag - 1]);
    const fit = g1 * e + g2 * d;
    explained += fit * fit;
    error += (signal[i] - fit) ** 2;
  }

  const count = Math.max(1, end - start);
  return { signal: explained / count, error: error / count, gain: g1 };
}
