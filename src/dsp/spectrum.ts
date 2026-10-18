import { fft, isPowerOfTwo } from "./fft.ts";

export interface Spectrum {
  /** Bin spacing in Hz: bin k is centered on k * binWidth. */
  readonly binWidth: number;
  /**
   * One-sided power per bin, bins 0 to size / 2. Scaled so a sine of amplitude A reads A^2 / 2
   * at its peak, the sine's power, whatever the window or FFT size.
   */
  readonly power: Float64Array;
}

/**
 * Averaged spectrum (Welch's method): Hann-windowed segments of `size` samples with 50%
 * overlap. A signal shorter than one segment is zero-padded.
 */
export function welch(data: Float32Array, rate: number, size: number): Spectrum {
  if (!isPowerOfTwo(size)) throw new Error(`FFT size ${size} is not a power of two.`);
  const window = new Float64Array(size);
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    windowSum += window[i];
  }

  const power = new Float64Array(size / 2 + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const hop = size / 2;
  const segments = Math.max(1, Math.floor((data.length - size) / hop) + 1);
  for (let s = 0; s < segments; s++) {
    const start = s * hop;
    for (let i = 0; i < size; i++) {
      const j = start + i;
      re[i] = j < data.length ? data[j] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }

  // |X|^2 / (sum w)^2 gives A^2 / 4 for each half of a sine; doubling folds in the negative
  // frequencies. DC and Nyquist have no mirror image.
  const scale = 1 / (segments * windowSum * windowSum);
  for (let k = 0; k <= size / 2; k++) power[k] *= k === 0 || k === size / 2 ? scale : 2 * scale;
  return { binWidth: rate / size, power };
}
