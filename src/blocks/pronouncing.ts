// The CMU Pronouncing Dictionary for the Speech block, once the worker has
// fetched it. It is big, so it loads only for documents that speak; until it
// does, Speech blocks wait, and without it they sound words out by rule.

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
