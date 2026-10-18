// Sample-rate changes by whole-number factors: polyphase filtering with a Kaiser-windowed
// low-pass at the higher rate. Both directions are causal and delay the signal by half the
// filter length, as a real resampler would.

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

/** Delay a factor-F resampler adds, in samples at the higher rate. */
export function resamplerDelay(factor: number): number {
  return (resamplerTaps(factor, 1).length - 1) / 2;
}

/**
 * Raises the rate by `factor`: zero-stuffing then interpolation, computed one
 * phase at a time.
 */
export function upsample(
  input: Float32Array,
  factor: number,
  output: Float32Array,
): void {
  // Gain `factor` makes up for the zeros stuffed between samples.
  const taps = resamplerTaps(factor, factor);
  for (let n = 0; n < output.length; n++) {
    const phase = n % factor;
    let sum = 0;
    // Only every factor-th tap meets a real input sample: tap phase + k*factor meets input base - k.
    for (
      let k = phase, j = (n - phase) / factor;
      k < taps.length && j >= 0;
      k += factor, j--
    ) {
      if (j < input.length) {
        sum += taps[k] * input[j];
      }
    }

    output[n] = sum;
  }
}

/**
 * Lowers the rate by `factor`: anti-alias filtering, computed only at the kept
 * samples.
 */
export function downsample(
  input: Float32Array,
  factor: number,
  output: Float32Array,
): void {
  const taps = resamplerTaps(factor, 1);
  for (let m = 0; m < output.length; m++) {
    const n = m * factor;
    let sum = 0;
    for (let k = 0; k < taps.length && k <= n; k++) {
      if (n - k < input.length) {
        sum += taps[k] * input[n - k];
      }
    }

    output[m] = sum;
  }
}
