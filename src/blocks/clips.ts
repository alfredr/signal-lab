// Recording data indexed by id. The page decodes and stores audio, then
// transfers the recordings used by a document to the worker.

import type { Signal } from '../engine/signal.ts';

const clips = new Map<string, Signal>();

export function addClip(id: string, clip: Signal): void {
  clips.set(id, clip);
}

export function clipFor(id: string): Signal | undefined {
  return clips.get(id);
}
