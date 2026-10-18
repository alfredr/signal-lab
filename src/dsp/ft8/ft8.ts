// FT8: 79 symbols of 8-FSK, 6.25 Hz apart and 0.16 s long, carrying a 77-bit
// message plus CRC-14, LDPC-coded to 174 bits, with three 7-symbol Costas
// arrays for synchronization. Ported from the Voice on an AM Carrier gadget,
// whose encoder matches ft8_lib tone for tone and whose decoder was checked
// against ft8_lib's.

import { Biquads, butterworth } from '../biquad.ts';
import { fft } from '../fft.ts';
import { crc14, ldpcDecode, ldpcEncode } from './ldpc.ts';
import {
  bitsOf,
  packMessage,
  PAYLOAD_BITS,
  unpackMessage,
  valueOf,
} from './message.ts';

export const SYMBOLS = 79;
export const SYMBOL_SECONDS = 0.16;
const TONE_SPACING = 6.25;
/** A transmission's length: 79 symbols. */
export const TRANSMISSION_SECONDS = SYMBOLS * SYMBOL_SECONDS;

const COSTAS = [3, 1, 4, 0, 6, 5, 2];
const GRAY = [0, 1, 3, 2, 5, 6, 4, 7];
const GRAY_INVERSE = [0, 1, 3, 2, 6, 4, 5, 7];
const SYNC_STARTS = [0, 36, 72];
/** Whether symbol `s` is one of the Costas sync tones. */
export const isSync = (s: number): boolean =>
  s < 7 || (s >= 36 && s < 43) || s >= 72;

/** The three coded bits a data tone carries, through the Gray code: "101". */
export const toneBits = (tone: number): string =>
  (GRAY_INVERSE[tone] ?? 0).toString(2).padStart(3, '0');

const DATA_SYMBOLS = Array.from({ length: SYMBOLS }, (_, s) => s).filter(
  (s) => !isSync(s),
);

export type Encoded =
  | {
      readonly ok: true;
      readonly text: string;
      readonly tones: readonly number[];
      readonly codeword: readonly number[];
    }
  | { readonly ok: false; readonly error: string };

/** The 79 tones (0 to 7) for a standard message, or why it can't be sent. */
export function encode(message: string): Encoded {
  const packed = packMessage(message);
  if (!packed.ok) {
    return packed;
  }

  const crc = crc14([...packed.bits, 0, 0, 0, 0, 0]);
  const codeword = ldpcEncode([...packed.bits, ...bitsOf(crc, 14)]);
  const tones: number[] = [];
  let bit = 0;
  for (let s = 0; s < SYMBOLS; s++) {
    const sync = SYNC_STARTS.find((first) => s >= first && s < first + 7);
    if (sync !== undefined) {
      tones.push(COSTAS[s - sync]);
    } else {
      tones.push(
        GRAY[codeword[bit] * 4 + codeword[bit + 1] * 2 + codeword[bit + 2]],
      );
      bit += 3;
    }
  }

  return { ok: true, text: packed.text, tones, codeword };
}

/** The error function, to 1.5e-7 (Abramowitz and Stegun 7.1.26). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-a * a));
}

/**
 * FT8 audio of `length` samples at `rate`: the tones as GFSK (frequency steps
 * smoothed by a Gaussian with BT = 2, as WSJT-X sends them), tone 0 at
 * `offset` Hz, starting `start` seconds in, with short ramps at each end.
 */
export function synthesize(
  tones: readonly number[],
  rate: number,
  offset: number,
  start: number,
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  const perSymbol = Math.round(SYMBOL_SECONDS * rate);
  const total = SYMBOLS * perSymbol;
  const first = Math.round(start * rate);
  const kappa = 2 * Math.PI * Math.sqrt(2 / Math.LN2);
  const pulse = (u: number) =>
    0.5 * (erf(kappa * (u + 0.5)) - erf(kappa * (u - 0.5)));
  const ramp = Math.round(perSymbol / 8);
  let phase = 0;
  for (let j = 0; j < total && first + j < length; j++) {
    const u = j / perSymbol;
    const symbol = Math.floor(u);
    let shift = 0;
    for (let k = symbol - 2; k <= symbol + 2; k++) {
      shift +=
        tones[Math.min(SYMBOLS - 1, Math.max(0, k))] * pulse(u - (k + 0.5));
    }

    phase += (2 * Math.PI * (offset + TONE_SPACING * shift)) / rate;
    const envelope =
      j < ramp
        ? 0.5 - 0.5 * Math.cos((Math.PI * j) / ramp)
        : j > total - ramp
          ? 0.5 - 0.5 * Math.cos((Math.PI * (total - j)) / ramp)
          : 1;
    if (first + j >= 0) {
      out[first + j] = envelope * Math.sin(phase);
    }
  }

  return out;
}

export type Decoded = {
  /** The message, if one decoded with a good CRC. */
  readonly text: string | undefined;
  /**
   * Power in the Costas tones against the average of the others; above 2.5
   * counts as sync.
   */
  readonly sync: number;
  /** Frequency of tone 0, in Hz. */
  readonly frequency: number;
  /** When the transmission starts, in seconds. */
  readonly start: number;
  /** Estimated SNR in 2500 Hz, the figure WSJT-X reports. */
  readonly snr: number;
  readonly crcOk: boolean;
  readonly iterations: number;
  /**
   * The strongest tone in each of the 79 symbols where the signal was found;
   * empty if nothing was.
   */
  readonly heard: readonly number[];
};

const DECODE_RATE = 6400;
/** One symbol of samples at the decode rate. */
const WINDOW = 1024;
/** An eighth of a symbol. */
const HOP = 128;
/** Zero-padded so the tones, 6.25 Hz apart, fall two bins apart. */
const FFT_SIZE = 2048;
const BIN = DECODE_RATE / FFT_SIZE;
const SYNC_THRESHOLD = 2.5;

/**
 * Searches `audio` for the strongest FT8 signal between `low` and `high` Hz
 * and decodes it: resample to 6400 Hz, spectrogram of symbol-long frames every
 * eighth of a symbol, find the best Costas match, then soft-decision LDPC.
 */
export function decode(
  audio: Float32Array,
  rate: number,
  low = 200,
  high = 3000,
): Decoded {
  const none: Decoded = {
    text: undefined,
    sync: 0,
    frequency: 0,
    start: 0,
    snr: -Infinity,
    crcOk: false,
    iterations: 0,
    heard: [],
  };

  const filtered = new Float32Array(audio.length);
  new Biquads(butterworth('lowpass', 4, 3000, rate)).process(audio, filtered);
  const length = Math.floor((audio.length * DECODE_RATE) / rate);
  const x = new Float32Array(length);
  const step = rate / DECODE_RATE;
  for (let i = 0; i < length; i++) {
    const p = i * step;
    const j = Math.floor(p);
    const next = j + 1 < filtered.length ? filtered[j + 1] : filtered[j];
    x[i] = filtered[j] + (next - filtered[j]) * (p - j);
  }

  const firstBin = Math.floor(low / BIN);
  const bins = Math.ceil(high / BIN) - firstBin + 1;
  const frames = Math.floor((length - WINDOW) / HOP) + 1;
  const lastStart = frames - 1 - 8 * (SYMBOLS - 1);
  if (lastStart < 0) {
    return none;
  }

  const power = new Float32Array(frames * bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let frame = 0; frame < frames; frame++) {
    re.fill(0);
    im.fill(0);
    re.set(x.subarray(frame * HOP, frame * HOP + WINDOW));
    fft(re, im);

    for (let b = 0; b < bins; b++) {
      const k = firstBin + b;
      power[frame * bins + b] = re[k] * re[k] + im[k] * im[k];
    }
  }

  // Tone k of symbol s lies 8 frames per symbol and 2 bins per tone from the start.
  const toneAt = (t0: number, fb: number, s: number, k: number) =>
    power[(t0 + 8 * s) * bins + fb + 2 * k];
  let sync = -1;
  let bestStart = 0;
  let bestBin = 0;
  for (let t0 = 0; t0 <= lastStart; t0++) {
    for (let fb = 0; fb + 14 < bins; fb++) {
      let wanted = 0;
      let others = 0;
      for (const first of SYNC_STARTS) {
        for (let s = 0; s < 7; s++) {
          let all = 0;
          for (let k = 0; k < 8; k++) {
            all += toneAt(t0, fb, first + s, k);
          }

          const v = toneAt(t0, fb, first + s, COSTAS[s]);
          wanted += v;
          others += all - v;
        }
      }

      const metric = wanted / (others / 7 + 1e-30);
      if (metric > sync) {
        sync = metric;
        bestStart = t0;
        bestBin = fb;
      }
    }
  }

  const synced = sync >= SYNC_THRESHOLD;
  // Noise per bin from the six weakest tones of each data symbol; signal from the strongest.
  const tones = DATA_SYMBOLS.map((s) =>
    Array.from({ length: 8 }, (_, k) => toneAt(bestStart, bestBin, s, k)),
  );
  let noise = 0;
  let strongest = 0;
  let amplitude = 0;
  for (const p of tones) {
    const sorted = [...p].sort((a, b) => a - b);
    noise += sorted.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
    strongest += sorted[7];
    amplitude += Math.sqrt(sorted[7]);
  }

  noise /= tones.length;
  strongest /= tones.length;
  amplitude /= tones.length;
  const scale = (2 * amplitude) / Math.max(noise, 1e-30);

  const llr: number[] = [];
  for (const p of tones) {
    const a = p.map(Math.sqrt);
    for (let j = 0; j < 3; j++) {
      let zero = -1;
      let one = -1;
      for (let k = 0; k < 8; k++) {
        if ((GRAY_INVERSE[k] >> (2 - j)) & 1) {
          one = Math.max(one, a[k]);
        } else {
          zero = Math.max(zero, a[k]);
        }
      }

      llr.push(Math.max(-25, Math.min(25, scale * (zero - one))));
    }
  }

  const heard = synced
    ? Array.from({ length: SYMBOLS }, (_, s) => {
        let best = 0;
        for (let k = 1; k < 8; k++) {
          if (
            toneAt(bestStart, bestBin, s, k) >
            toneAt(bestStart, bestBin, s, best)
          ) {
            best = k;
          }
        }

        return best;
      })
    : [];
  const result = ldpcDecode(llr);
  const message = result.bits.slice(0, PAYLOAD_BITS);
  const crcOk =
    result.ok &&
    crc14([...message, 0, 0, 0, 0, 0]) ===
      valueOf(result.bits, PAYLOAD_BITS, PAYLOAD_BITS + 14);
  // Each bin sees noise from DECODE_RATE / WINDOW = 6.25 Hz; refer that to 2500 Hz.
  const snr =
    10 * Math.log10(Math.max(strongest / Math.max(noise, 1e-30) - 1, 1e-6)) -
    10 * Math.log10(2500 / (DECODE_RATE / WINDOW));
  return {
    text: synced && crcOk ? unpackMessage(message) : undefined,
    sync,
    frequency: (firstBin + bestBin) * BIN,
    start: (bestStart * HOP) / DECODE_RATE,
    snr,
    crcOk: synced && crcOk,
    iterations: result.iterations,
    heard,
  };
}
