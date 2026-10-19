// Speech: typed text, said in a 1980s formant voice.

import { speak } from '../dsp/speech/english.ts';
import { synthesize } from '../dsp/speech/formants.ts';
import { sequence } from '../dsp/speech/sequence.ts';
import { BlockError, defineBlock } from '../engine/block.ts';
import { si } from '../engine/format.ts';
import { boolean, number, text } from '../engine/params.ts';
import { pronouncingDictionary } from './pronouncing.ts';
import { playback, rate } from './sources.ts';

/** Milliseconds a phoneme lasts at speed 1, about twelve a second. */
const PHONEME_MS = 85;

export const speech = defineBlock({
  kind: 'speech',
  label: 'Speech',
  category: 'Sources',
  description: String.raw`Says what you type, in a formant voice of the early 1980s: a glottal pulse or a hiss through three resonators, one for each formant of the vocal tract, tuned phoneme by phoneme. Words come from the CMU Pronouncing Dictionary, or are sounded out by the 1976 Navy letter-to-sound rules. Numbers are read as words, and callsigns, grid squares and short words with no vowel are spelled out. It plays once each time its **trigger** input rises (wire a Button to it) or Play is pressed in the inspector, or over and over if it loops. Scaled so its loudest peak is 1.`,
  inputs: [{ name: 'trigger', side: 'bottom', optional: true }],
  outputs: [{ name: 'out' }],
  reports: ['Saying', 'Playing'],
  params: {
    text: text({
      label: 'Says',
      default: 'CQ CQ, this is K1ABC.',
      maxLength: 400,
      multiline: true,
    }),
    pitch: number({
      label: 'Pitch',
      unit: 'Hz',
      default: 110,
      min: 50,
      max: 400,
      scale: 'log',
    }),
    speed: number({
      label: 'Speed',
      unit: 'x',
      default: 1,
      min: 0.25,
      max: 3,
      step: 0.05,
    }),
    loop: boolean({ label: 'Loop', default: false }),
    rate: rate(),
  },
  summary: (p) => {
    const said = p.text.trim().replace(/\s+/g, ' ');
    return said.length > 18
      ? `${said.slice(0, 17)}…`
      : said || si(p.pitch, 'Hz');
  },
  rates: (_, p) => [p.rate],
  create(p, context) {
    const dictionary = pronouncingDictionary();
    if (!dictionary) {
      throw new BlockError('Loading the pronouncing dictionary…');
    }

    const rate = context.outputRates[0];
    const utterance = sequence(speak(p.text, dictionary), {
      pitch: p.pitch,
      msPerPhoneme: PHONEME_MS / p.speed,
    });
    const take = synthesize(
      utterance.steps,
      rate,
      Math.max(1, Math.ceil((utterance.totalMs * rate) / 1000)),
    );
    let peak = 0;
    for (const v of take) {
      peak = Math.max(peak, Math.abs(v));
    }

    if (peak > 0) {
      for (let i = 0; i < take.length; i++) {
        take[i] /= peak;
      }
    }

    return playback(take, rate, p.loop, context.time, (at) => {
      const ms = (at / rate) * 1000;
      const word = utterance.words.find(
        (w) => w.startMs <= ms && ms < w.endMs,
      );
      return word ? [{ label: 'Saying', value: word.text }] : [];
    });
  },
});
