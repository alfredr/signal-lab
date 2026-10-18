// FT8: the weak-signal digital mode, as a transmitter and a decoder.

import {
  decode,
  encode,
  isSync,
  SYMBOL_SECONDS,
  SYMBOLS,
  synthesize,
  toneBits,
  TRANSMISSION_SECONDS,
} from '../dsp/ft8/ft8.ts';
import { BlockError, defineBlock, type Reading } from '../engine/block.ts';
import { si } from '../engine/format.ts';
import { number, text } from '../engine/params.ts';
import { sampleCount } from '../engine/signal.ts';
import { rate } from './sources.ts';

export const ft8Transmitter = defineBlock({
  kind: 'ft8-transmitter',
  label: 'FT8 transmitter',
  category: 'Digital modes',
  description: String.raw`Sends an FT8 message as audio, as WSJT-X does: 79 tones 6.25 Hz apart, 0.16 s each, 12.6 s in all, carrying 77 bits plus a CRC and LDPC parity. Standard messages only, such as **CQ K1ABC FN42**, **K1ABC W9XYZ -12** or **K1ABC W9XYZ RR73**.`,
  inputs: [],
  outputs: [{ name: 'out' }],
  params: {
    message: text({
      label: 'Message',
      default: 'CQ K1ABC FN42',
      maxLength: 40,
    }),
    offset: number({
      label: 'Audio offset',
      unit: 'Hz',
      default: 1500,
      min: 200,
      max: 2800,
      step: 1,
      help: 'Where tone 0 sits; the signal takes the 50 Hz above it.',
    }),
    start: number({
      label: 'Starts at',
      unit: 's',
      default: 0.5,
      min: 0,
      max: 10,
      step: 0.01,
      help: `The transmission lasts ${TRANSMISSION_SECONDS.toFixed(2)} s.`,
    }),
    rate: rate(12000),
  },
  summary: (p) => p.message.trim().toUpperCase(),
  rates: (_, p) => [p.rate],
  create(p, context) {
    const encoded = encode(p.message);
    if (!encoded.ok) {
      throw new BlockError(encoded.error);
    }

    const rate = context.outputRates[0];
    const audio = synthesize(
      encoded.tones,
      rate,
      p.offset,
      p.start,
      sampleCount(context.duration, rate),
    );
    // What it sends symbol by symbol, for readouts that follow the playhead.
    const track = (values: readonly (number | string)[]) => ({
      start: p.start,
      step: SYMBOL_SECONDS,
      values,
    });
    const { tones } = encoded;
    const readings: Reading[] = [
      {
        label: 'Symbol',
        value: `1–${SYMBOLS}`,
        track: track(tones.map((_, s) => `${s + 1} of ${SYMBOLS}`)),
      },
      {
        label: 'Tone',
        value: '0–7',
        track: track(tones),
      },
      {
        label: 'Carries',
        value: `${encoded.codeword.length} bits`,
        track: track(
          tones.map((tone, s) => (isSync(s) ? 'sync' : toneBits(tone))),
        ),
      },
    ];
    return {
      process(_, [out], start, end) {
        out.set(audio.subarray(start, end), start);
      },
      readings: () => readings,
    };
  },
});

/**
 * The decoder works at 6.4 kHz, so it needs at least that much bandwidth to
 * look at.
 */
const SLOWEST = 6400;

export const ft8Decoder = defineBlock({
  kind: 'ft8-decoder',
  label: 'FT8 decoder',
  category: 'Digital modes',
  description: String.raw`Finds the strongest FT8 signal in its search band and decodes it: a search for the three Costas sync arrays, soft decisions on each tone, LDPC error correction, then the CRC. One pass and one signal, so it holds to about $-17$ dB SNR in 2500 Hz where WSJT-X reaches $-21$. Its **Tone heard** reading follows the playhead, marking each symbol it heard wrong once the message decodes.`,
  inputs: [{ name: 'audio' }],
  outputs: [],
  params: {
    low: number({
      label: 'Search from',
      unit: 'Hz',
      default: 200,
      min: 0,
      max: 3000,
      step: 1,
    }),
    high: number({
      label: 'Search to',
      unit: 'Hz',
      default: 3000,
      min: 100,
      max: 3000,
      step: 1,
    }),
  },
  summary: (p) => `${si(p.low, 'Hz')} to ${si(p.high, 'Hz')}`,
  create(p, context) {
    const rate = context.inputRates[0];
    if (rate < SLOWEST) {
      throw new BlockError(
        `FT8 decoding needs audio at ${si(SLOWEST, 'Hz')} or more; this arrives at ${si(rate, 'Hz')}.`,
      );
    }

    let audio: Float32Array | undefined;
    return {
      // Never in a loop (it has no outputs), so this sees the whole window.
      process([x]) {
        audio = x;
      },
      readings(): Reading[] {
        if (!audio) {
          return [];
        }

        const result = decode(
          audio,
          rate,
          p.low,
          Math.max(p.low + 100, p.high),
        );
        const synced = result.sync >= 2.5;
        // Once the message decodes, re-encoding it says which tones were heard wrong.
        const sent = result.text ? encode(result.text) : undefined;
        const truth = sent?.ok ? sent.tones : undefined;
        const wrong = truth
          ? result.heard.filter((tone, s) => tone !== truth[s]).length
          : undefined;
        const heard: Reading[] = synced
          ? [
              {
                label: 'Tone heard',
                value:
                  wrong === undefined
                    ? `${result.heard.length} tones`
                    : `${wrong} of ${SYMBOLS} wrong`,
                track: {
                  start: result.start,
                  step: SYMBOL_SECONDS,
                  values: result.heard.map((tone, s) =>
                    !truth
                      ? tone
                      : tone === truth[s]
                        ? `${tone} ✓`
                        : `${tone} ✗ sent ${truth[s]}`,
                  ),
                },
              },
            ]
          : [];
        return [
          {
            label: 'Message',
            value:
              result.text ??
              (synced ? 'sync found, no decode' : 'nothing found'),
          },
          ...(synced
            ? ([
                { label: 'SNR', value: result.snr, unit: 'dB' },
                { label: 'Frequency', value: result.frequency, unit: 'Hz' },
                { label: 'Starts at', value: result.start, unit: 's' },
              ] satisfies Reading[])
            : []),
          ...heard,
          { label: 'Sync', value: result.sync },
          { label: 'LDPC iterations', value: result.iterations },
        ];
      },
    };
  },
});
