import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dictionary } from 'cmu-pronouncing-dictionary';

import { setDictionary } from '../src/blocks/pronouncing.ts';
import { welch } from '../src/dsp/spectrum.ts';
import { speak } from '../src/dsp/speech/english.ts';
import { synthesize } from '../src/dsp/speech/formants.ts';
import { sequence, type Spoken } from '../src/dsp/speech/sequence.ts';
import { plain, run, stream } from './helpers.ts';

const words = new Map(Object.entries(dictionary));

/** What `text` says, as words and their phonemes. */
const said = (text: string, from = words) =>
  speak(text, from)
    .map((s) =>
      s.kind === 'word'
        ? `|${s.text}`
        : s.kind === 'pause'
          ? `(${s.ms})`
          : s.code + (s.stressed ? "'" : ''),
    )
    .join(' ');

describe('English to phonemes', () => {
  test('looks words up in the CMU dictionary', () => {
    assert.equal(said('hello'), "|HELLO HH AH L OW'");
  });

  test('sounds out words the dictionary lacks by the NRL rules', () => {
    // "Blarg" isn't a word; the rules still make something of it.
    const sound = said('blarg', new Map());
    assert.match(sound, /^\|BLARG B L AA'? R G$/);
  });

  test('reads numbers as words, and spells callsigns and words with no vowel', () => {
    assert.equal(said('42').replace(/ [A-Z']+(?= |$)/g, ''), '|FORTY |TWO');
    assert.equal(
      said('CQ K1ABC')
        .split(' ')
        .filter((s) => s.startsWith('|'))
        .join(' '),
      '|C |Q |K |ONE |A |B |C',
    );
  });

  test('pauses at punctuation, longer at the end of a sentence', () => {
    const pauses = speak('one, two.', words).filter((s) => s.kind === 'pause');
    assert.deepEqual(
      pauses.map((p) => p.kind === 'pause' && p.ms),
      [120, 350],
    );
  });
});

describe('the formant voice', () => {
  test("puts a vowel's energy at its formants", () => {
    // "ah": F1 730 Hz and F2 1090 Hz in Klatt's table.
    const ah: Spoken[] = Array.from({ length: 6 }, () => ({
      kind: 'phoneme',
      code: 'AA',
      stressed: false,
    }));
    const utterance = sequence(ah, { pitch: 110, msPerPhoneme: 100 });
    const rate = 16000;
    const audio = synthesize(utterance.steps, rate, Math.ceil(0.6 * rate));
    assert.ok(audio.every(Number.isFinite));
    const { binWidth, power } = welch(audio.subarray(1600, 8000), rate, 2048);
    let loudest = 0;
    for (let k = 1; k < power.length; k++) {
      if (power[k] > power[loudest]) {
        loudest = k;
      }
    }

    const at = loudest * binWidth;
    assert.ok(at > 550 && at < 1250, `loudest at ${at} Hz`);
  });
});

describe('the Speech block', () => {
  test('waits for the dictionary before it speaks', () => {
    const { status } = run({
      seconds: 0.01,
      circuit: plain([['say', 'speech', { text: 'hello' }]], []),
    });
    const say = status.get('say');
    assert.equal(say?.state, 'error');
    assert.match(say.state === 'error' ? say.message : '', /dictionary/);
  });

  test('says its text when the button is pressed, and what word it is on', () => {
    setDictionary(words);
    const s = stream();
    const loaded = s.load(
      plain(
        [
          ['say', 'speech', { text: 'Hello radio world.', rate: 16000 }],
          ['push', 'button', {}],
        ],
        [['push', 'say:0']],
      ),
    );
    assert.equal(loaded.status.get('say')?.state, 'ok');
    const heard: number[] = [];
    const saying = new Set<string>();
    const take = (until: number) =>
      s.advance(until, (chunk) => {
        heard.push(...chunk.signals.get('say:0')!.data);
        const word = chunk.readings
          .get('say')
          ?.find((r) => r.label === 'Saying')?.value;
        if (typeof word === 'string') {
          saying.add(word);
        }
      });
    take(0.1);
    assert.ok(
      heard.every((v) => v === 0),
      'quiet until pressed',
    );
    s.press('push');
    take(3);
    const peak = Math.max(...heard.map(Math.abs));
    assert.ok(peak > 0.9, `peak ${peak}`);
    assert.deepEqual([...saying], ['HELLO', 'RADIO', 'WORLD']);
  });
});
