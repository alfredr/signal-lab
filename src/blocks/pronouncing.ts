// Pronunciation dictionary shared by Speech blocks. The worker loads it on
// demand; blocks wait during loading and use letter-to-sound rules if it is
// unavailable.

import type { Dictionary } from '../dsp/speech/english.ts';

let dictionary: Dictionary | undefined;

export function setDictionary(loaded: Dictionary): void {
  dictionary = loaded;
}

export function pronouncingDictionary(): Dictionary | undefined {
  return dictionary;
}

/**
 * The dictionary from its text: a word and its phonemes on each line, as in
 * "hello HH AH0 L OW1".
 */
export function readDictionary(text: string): Dictionary {
  const words = new Map<string, string>();
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) {
      words.set(line.slice(0, space), line.slice(space + 1));
    }
  }

  return words;
}
