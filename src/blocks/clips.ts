// Recordings for the Recording block, by id. The page decodes them and keeps
// them in the browser, and the worker gets a copy of each one a document uses.

import type { Signal } from '../engine/signal.ts';

const clips = new Map<string, Signal>();

export function addClip(id: string, clip: Signal): void {
  clips.set(id, clip);
}

export function clipFor(id: string): Signal | undefined {
  return clips.get(id);
}
