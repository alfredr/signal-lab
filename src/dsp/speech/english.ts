// Converts English text to ARPABET phonemes. Uses the CMU Pronouncing
// Dictionary when available, with NRL letter-to-sound rules as a fallback.
// Expands numbers into words, spells alphanumeric identifiers and short
// vowelless words, and converts punctuation to pauses.

import { RULES } from './rules.ts';
import type { Spoken } from './sequence.ts';

/**
 * Pronunciations by lower-case word, as the dictionary writes them: "HH AH0 L
 * OW1".
 */
export type Dictionary = ReadonlyMap<string, string>;

type Phone = { readonly code: string; readonly stressed: boolean };

/** How the rules' phoneme symbols are spelled in the synthesizer's bank. */
const SPELLINGS: Readonly<Record<string, string>> = {
  AX: 'AH',
  NX: 'NG',
  WH: 'W',
};

/** "AH1" and the like: a phoneme, stressed if it ends in 1. */
function phone(symbol: string): Phone {
  const code = symbol.replace(/[0-9]$/, '');
  return { code: SPELLINGS[code] ?? code, stressed: symbol.endsWith('1') };
}

const phones = (pronunciation: string): Phone[] =>
  pronunciation.split(/\s+/).filter(Boolean).map(phone);

const LETTERS: Readonly<Record<string, string>> = {
  A: 'EY1',
  B: 'B IY1',
  C: 'S IY1',
  D: 'D IY1',
  E: 'IY1',
  F: 'EH1 F',
  G: 'JH IY1',
  H: 'EY1 CH',
  I: 'AY1',
  J: 'JH EY1',
  K: 'K EY1',
  L: 'EH1 L',
  M: 'EH1 M',
  N: 'EH1 N',
  O: 'OW1',
  P: 'P IY1',
  Q: 'K Y UW1',
  R: 'AA1 R',
  S: 'EH1 S',
  T: 'T IY1',
  U: 'Y UW1',
  V: 'V IY1',
  W: 'D AH1 B AH0 L Y UW0',
  X: 'EH1 K S',
  Y: 'W AY1',
  Z: 'Z IY1',
};

const DIGITS = [
  'ZERO',
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
];
const TEENS = [
  'TEN',
  'ELEVEN',
  'TWELVE',
  'THIRTEEN',
  'FOURTEEN',
  'FIFTEEN',
  'SIXTEEN',
  'SEVENTEEN',
  'EIGHTEEN',
  'NINETEEN',
];
const TENS = [
  '',
  '',
  'TWENTY',
  'THIRTY',
  'FORTY',
  'FIFTY',
  'SIXTY',
  'SEVENTY',
  'EIGHTY',
  'NINETY',
];

/** A whole number as words, up to the millions; longer ones digit by digit. */
function numberWords(digits: string): string[] {
  const n = Number(digits);
  if (digits.length > 9 || (digits.length > 1 && digits.startsWith('0'))) {
    return [...digits].map((d) => DIGITS[Number(d)]!);
  }

  const below1000 = (v: number): string[] => {
    const words: string[] = [];
    if (v >= 100) {
      words.push(DIGITS[Math.floor(v / 100)]!, 'HUNDRED');
      v %= 100;
    }

    if (v >= 20) {
      words.push(TENS[Math.floor(v / 10)]!);
      v %= 10;

      if (v) {
        words.push(DIGITS[v]!);
      }
    } else if (v >= 10) {
      words.push(TEENS[v - 10]!);
    } else if (v || !words.length) {
      words.push(DIGITS[v]!);
    }

    return words;
  };

  if (n === 0) {
    return ['ZERO'];
  }

  const words: string[] = [];
  for (const [size, name] of [
    [1e6, 'MILLION'],
    [1e3, 'THOUSAND'],
  ] as const) {
    if (n >= size) {
      words.push(...below1000(Math.floor(n / size) % 1000), name);
    }
  }

  const rest = n % 1000;
  return rest ? [...words, ...below1000(rest)] : words;
}

/**
 * The letter-to-sound rules, ready to match: each a pattern, its length and
 * its phonemes.
 */
type Rule = {
  readonly pattern: RegExp;
  readonly length: number;
  readonly phones: readonly Phone[];
};

const CLASSES: Readonly<Record<string, string>> = {
  '#': '[AEIOUY]+',
  '.': '[BDVGJLMNRWZ]',
  '%': '(?:ER|E|ES|ED|ING|ELY)',
  '&': '(?:[SCGZXJ]|CH|SH)',
  '@': '(?:[TSRDLZNJ]|TH|CH|SH)',
  '^': '[BCDFGHJKLMNPQRSTVWXZ]',
  '+': '[EIY]',
  ':': '[BCDFGHJKLMNPQRSTVWXZ]*',
  ' ': '\\b',
};

let compiled: ReadonlyMap<string, readonly Rule[]> | undefined;

/**
 * Compiles rules to regular expressions. Lowercasing the current letter
 * anchors the rule's bracketed pattern at that position.
 */
function rules(): ReadonlyMap<string, readonly Rule[]> {
  compiled ??= new Map(
    Object.entries(RULES).map(([letter, list]) => [
      letter,
      list.map((rule): Rule => {
        const open = rule.indexOf('[');
        const close = rule.indexOf(']');
        const equals = rule.indexOf('=');
        const context = (part: string) =>
          [...part].map((c) => CLASSES[c] ?? c).join('');
        const letters = rule.slice(open + 1, close);
        return {
          pattern: new RegExp(
            context(rule.slice(0, open)) +
              letters[0]!.toLowerCase() +
              letters.slice(1) +
              context(rule.slice(close + 1, equals)),
          ),
          length: letters.length,
          phones: phones(rule.slice(equals + 1)),
        };
      }),
    ]),
  );
  return compiled;
}

/**
 * A word sounded out by the rules, its first vowel stressed if no rule
 * stressed one.
 */
function soundOut(word: string): Phone[] {
  const out: Phone[] = [];
  const table = rules();
  for (let i = 0; i < word.length;) {
    const letter = word[i]!;
    const marked = word.slice(0, i) + letter.toLowerCase() + word.slice(i + 1);
    const rule = table.get(letter)?.find((r) => r.pattern.test(marked));
    out.push(...(rule?.phones ?? []));
    i += rule?.length ?? 1;
  }

  const vowel = out.findIndex((p) => /^[AEIOU]/.test(p.code));
  if (vowel >= 0 && !out.some((p) => p.stressed)) {
    out[vowel] = { ...out[vowel]!, stressed: true };
  }

  return out;
}

const PAUSES: Readonly<Record<string, number>> = {
  ',': 120,
  ';': 200,
  ':': 200,
  '.': 350,
  '!': 350,
  '?': 350,
};

/** What `text` says, word by word, for the sequencer. */
export function speak(text: string, dictionary?: Dictionary): Spoken[] {
  const said: Spoken[] = [];
  const say = (word: string, sound: readonly Phone[]) => {
    said.push({ kind: 'word', text: word });

    for (const p of sound) {
      said.push({ kind: 'phoneme', code: p.code, stressed: p.stressed });
    }
  };

  const lookUp = (word: string) => dictionary?.get(word.toLowerCase());
  const sayWord = (word: string) => {
    const known = lookUp(word);
    say(word, known ? phones(known) : soundOut(word));
  };

  const spell = (token: string) => {
    for (const c of token) {
      if (/[0-9]/.test(c)) {
        sayWord(DIGITS[Number(c)]!);
      } else if (LETTERS[c]) {
        say(c, phones(LETTERS[c]));
      }
    }
  };

  const tokens = text
    .toUpperCase()
    .replace(/[‘’]/g, "'")
    .match(/[A-Z0-9']+|[.,;:!?]/g);
  for (const token of tokens ?? []) {
    const pause = PAUSES[token];
    if (pause !== undefined) {
      said.push({ kind: 'pause', ms: pause, question: token === '?' });
    } else if (/^[0-9]+$/.test(token)) {
      numberWords(token).forEach(sayWord);
    } else if (/[0-9]/.test(token)) {
      spell(token);
    } else if (lookUp(token)) {
      sayWord(token);
    } else if (!/[AEIOUY]/.test(token) || token.length === 1) {
      spell(token);
    } else {
      sayWord(token.replace(/'/g, ''));
    }
  }

  return said;
}
