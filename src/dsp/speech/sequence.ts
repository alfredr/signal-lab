// Schedules formant targets, phoneme durations, stop and diphthong
// transitions, and pitch. Timing rules follow klattsch's sequencer (MIT,
// copyright 2026 Tony Gies; see licenses/klattsch.txt). The pitch contour adds
// phrase declination, stressed-syllable rises, and rising question endings.

import type { Step, Voice } from './formants.ts';
import { PHONEMES } from './phonemes.ts';

/** What is said: phonemes (ARPABET), pauses, and where each word starts. */
export type Spoken =
  | {
      readonly kind: 'phoneme';
      readonly code: string;
      readonly stressed: boolean;
    }
  | {
      readonly kind: 'pause';
      readonly ms: number;
      readonly question?: boolean;
    }
  | { readonly kind: 'word'; readonly text: string };

/** A word and when it is said, in milliseconds. */
type Timed = {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
};

export type Utterance = {
  readonly steps: readonly Step[];
  readonly totalMs: number;
  readonly words: readonly Timed[];
};

/** How a stressed phoneme stretches, and how much higher it is. */
const STRESS_LENGTH = 1.4;
const STRESS_LIFT = 1.07;
/** The pitch over a phrase, from its start to its end, against the voice's own. */
const RISE = 1.12;
const FALL = 0.86;

export function sequence(
  said: readonly Spoken[],
  {
    pitch,
    msPerPhoneme,
  }: { readonly pitch: number; readonly msPerPhoneme: number },
): Utterance {
  const steps: Step[] = [];
  const words: Timed[] = [];
  let timeMs = 0;
  const emit = (target: Partial<Voice>, transitionMs: number) =>
    steps.push({ atMs: timeMs, target, transitionMs });
  const silence = (transitionMs = 30) =>
    emit({ A1: 0, A2: 0, A3: 0 }, transitionMs);
  const endWord = () => {
    const last = words.at(-1);
    if (last && last.endMs < 0) {
      words[words.length - 1] = { ...last, endMs: timeMs };
    }
  };

  // Each phrase, up to a pause, falls from RISE to FALL; a question's last
  // few phonemes rise instead.
  const phrases: { phonemes: number; question: boolean }[] = [];
  let count = 0;
  for (const s of said) {
    if (s.kind === 'phoneme') {
      count++;
    } else if (s.kind === 'pause') {
      phrases.push({ phonemes: count, question: Boolean(s.question) });
      count = 0;
    }
  }

  phrases.push({ phonemes: count, question: false });
  let phrase = 0;
  let index = 0;
  const pitchAt = () => {
    const { phonemes, question } = phrases[phrase]!;
    const along = phonemes > 1 ? index / (phonemes - 1) : 0;
    const base = pitch * (RISE + (FALL - RISE) * along);
    return question && phonemes - index <= 3
      ? pitch * (1.1 + 0.35 * along)
      : base;
  };

  for (const s of said) {
    if (s.kind === 'word') {
      endWord();
      words.push({ text: s.text, startMs: timeMs, endMs: -1 });
      continue;
    }

    if (s.kind === 'pause') {
      endWord();
      silence();
      timeMs += s.ms;
      phrase++;
      index = 0;
      continue;
    }

    const p = PHONEMES[s.code];
    if (!p) {
      continue;
    }

    const f0 = pitchAt() * (s.stressed ? STRESS_LIFT : 1);
    index++;
    const slot = s.stressed ? msPerPhoneme * STRESS_LENGTH : msPerPhoneme;
    const { glideTo, isStop, ...shape } = p;
    const target = { ...shape, F0: f0 };
    if (isStop) {
      // Silence while the mouth is closed, then a short burst.
      const burst = Math.min(25, slot * 0.3);
      silence(Math.min(20, (slot - burst) * 0.4));
      timeMs += slot - burst;
      emit(target, Math.min(5, burst * 0.2));
      timeMs += burst;
    } else if (glideTo) {
      emit(target, Math.min(20, slot * 0.25));
      timeMs += slot * 0.25;
      emit({ ...target, ...glideTo }, slot * 0.5);
      timeMs += slot * 0.75;
    } else {
      emit(target, Math.min(35, slot * 0.4));
      timeMs += slot;
    }
  }

  endWord();
  silence(100);
  timeMs += 150;
  return { steps, totalMs: timeMs, words };
}
