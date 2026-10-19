// IIR filters as cascades of second-order sections. Designs follow the RBJ audio-EQ cookbook
// with coefficients normalized so a0 = 1; first-order sections are biquads with b2 = a2 = 0.

export type Section = {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
};

/** Keeps a design frequency strictly inside (0, Nyquist). */
function clampFrequency(frequency: number, rate: number): number {
  return Math.min(Math.max(frequency, 1e-6 * rate), 0.499 * rate);
}

function lowpassSection(cutoff: number, rate: number, q: number): Section {
  const w = (2 * Math.PI * clampFrequency(cutoff, rate)) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b = (1 - cos) / 2 / a0;
  return {
    b0: b,
    b1: 2 * b,
    b2: b,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassSection(cutoff: number, rate: number, q: number): Section {
  const w = (2 * Math.PI * clampFrequency(cutoff, rate)) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b = (1 + cos) / 2 / a0;
  return {
    b0: b,
    b1: -2 * b,
    b2: b,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Resonator with unity gain at `center`; `bandwidth` is its -3 dB width in Hz. */
export function bandpassSection(
  center: number,
  bandwidth: number,
  rate: number,
): Section {
  const f = clampFrequency(center, rate);
  const w = (2 * Math.PI * f) / rate;
  const alpha = Math.sin(w) / (2 * (f / Math.max(bandwidth, 1e-9)));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** First-order (RC) low-pass, matched to the analog pole. */
function onePoleLowpass(cutoff: number, rate: number): Section {
  const a = Math.exp((-2 * Math.PI * clampFrequency(cutoff, rate)) / rate);
  return { b0: 1 - a, b1: 0, b2: 0, a1: -a, a2: 0 };
}

/** First-order (RC) high-pass. */
function onePoleHighpass(cutoff: number, rate: number): Section {
  const a = Math.exp((-2 * Math.PI * clampFrequency(cutoff, rate)) / rate);
  const g = (1 + a) / 2;
  return { b0: g, b1: -g, b2: 0, a1: -a, a2: 0 };
}

/**
 * Sections of an order-n Butterworth filter. An odd order adds one first-order
 * section; each pole pair k contributes a biquad with Q = 1 / (2
 * cos(theta_k)).
 */
export function butterworth(
  type: 'lowpass' | 'highpass',
  order: number,
  cutoff: number,
  rate: number,
): Section[] {
  const sections: Section[] = [];
  if (order % 2 === 1) {
    sections.push(
      type === 'lowpass'
        ? onePoleLowpass(cutoff, rate)
        : onePoleHighpass(cutoff, rate),
    );
  }

  for (let k = 0; k < Math.floor(order / 2); k++) {
    const theta =
      order % 2 === 0
        ? ((2 * k + 1) * Math.PI) / (2 * order)
        : ((k + 1) * Math.PI) / order;
    const q = 1 / (2 * Math.cos(theta));
    sections.push(
      type === 'lowpass'
        ? lowpassSection(cutoff, rate, q)
        : highpassSection(cutoff, rate, q),
    );
  }

  return sections;
}

/**
 * A cascade of sections, run in transposed direct form II with
 * double-precision state.
 */
export class Biquads {
  #sections: readonly Section[];
  readonly #state: Float64Array;

  constructor(sections: readonly Section[]) {
    this.#sections = sections;
    this.#state = new Float64Array(2 * sections.length);
  }

  /**
   * Takes new coefficients and keeps the state, as when a knob turns; false if
   * the number of sections differs.
   */
  retune(sections: readonly Section[]): boolean {
    if (sections.length !== this.#sections.length) {
      return false;
    }

    this.#sections = sections;
    return true;
  }

  /**
   * Filters samples [start, end) of `input` into `output`, which may be the
   * same array.
   */
  process(
    input: Float32Array,
    output: Float32Array,
    start = 0,
    end = output.length,
  ): void {
    if (this.#sections.length === 0 && input !== output) {
      output.set(input.subarray(start, end), start);
    }

    const state = this.#state;
    this.#sections.forEach(({ b0, b1, b2, a1, a2 }, k) => {
      // The first section reads the input; the rest refine the output in place.
      const source = k === 0 ? input : output;
      let s1 = state[2 * k];
      let s2 = state[2 * k + 1];
      for (let i = start; i < end; i++) {
        const x = source[i];
        const y = b0 * x + s1;
        s1 = b1 * x - a1 * y + s2;
        s2 = b2 * x - a2 * y;
        output[i] = y;
      }

      state[2 * k] = s1;
      state[2 * k + 1] = s2;
    });
  }
}

/** Gain magnitude of a cascade at `frequency`. */
export function magnitude(
  sections: readonly Section[],
  frequency: number,
  rate: number,
): number {
  const w = (2 * Math.PI * frequency) / rate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let gain = 1;
  for (const { b0, b1, b2, a1, a2 } of sections) {
    const numRe = b0 + b1 * c1 + b2 * c2;
    const numIm = -(b1 * s1 + b2 * s2);
    const denRe = 1 + a1 * c1 + a2 * c2;
    const denIm = -(a1 * s1 + a2 * s2);
    gain *= Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm);
  }

  return gain;
}
