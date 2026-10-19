// Browser client for the simulation worker. Sends document and watch-list
// changes immediately, with at most one advance request in flight so loads and
// resets are not blocked by queued simulation work.

import type { BlockStatus } from '../engine/simulator.ts';
import type { LabDocument } from '../model/document.ts';
import type { FromWorker, Samples, ToWorker } from './protocol.ts';

export type Chunk = Extract<FromWorker, { type: 'chunk' }>;

export type StreamEvents = {
  status(statuses: ReadonlyMap<string, BlockStatus>): void;
  /** The stream reached `chunk.time`, with what the watched ports carried. */
  chunk(chunk: Chunk): void;
  /** History for ports just watched. */
  history(samples: readonly Samples[]): void;
  error(message: string): void;
};

export class StreamClient {
  readonly #worker: Worker;
  readonly #events: StreamEvents;
  #epoch = 0;
  /** Advances sent and not yet answered. */
  #pending = 0;
  #doc: LabDocument | undefined;
  #watched = '';
  /** Recordings already handed to the worker. */
  readonly #clips = new Set<string>();

  constructor(events: StreamEvents) {
    this.#events = events;
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
    this.#worker.addEventListener(
      'message',
      (event: MessageEvent<FromWorker>) => this.#receive(event.data),
    );
    this.#worker.addEventListener('error', (event) =>
      events.error(event.message || 'The simulation worker failed to start.'),
    );
  }

  /** Whether an advance is under way. */
  get advancing(): boolean {
    return this.#pending > 0;
  }

  /** Runs `doc` from where the stream is, if it isn't already running it. */
  load(doc: LabDocument): void {
    if (doc !== this.#doc) {
      this.#doc = doc;
      this.#send({ type: 'load', doc });
    }
  }

  /** Watches these port keys, if they aren't the ones watched already. */
  watch(keys: readonly string[]): void {
    const signature = [...keys].sort().join('\n');
    if (signature !== this.#watched) {
      this.#watched = signature;
      this.#send({ type: 'watch', keys });
    }
  }

  /** Asks the stream to reach `until` seconds, unless an advance is under way. */
  advance(until: number): void {
    if (this.#pending === 0) {
      this.#pending++;
      this.#send({ type: 'advance', until });
    }
  }

  /** Pushes a block, by full id, as a Button does. */
  press(block: string): void {
    this.#send({ type: 'press', block });
  }

  /** Hands the worker recordings, once each. */
  clips(
    clips: readonly {
      readonly id: string;
      readonly rate: number;
      readonly data: Float32Array;
    }[],
  ): void {
    const fresh = clips.filter((clip) => !this.#clips.has(clip.id));
    for (const clip of fresh) {
      this.#clips.add(clip.id);
    }

    if (fresh.length) {
      this.#send({ type: 'clips', clips: fresh });
    }
  }

  /** Whether the worker has a recording. */
  hasClip(id: string): boolean {
    return this.#clips.has(id);
  }

  /** Back to time 0; anything already on its way from before is dropped. */
  reset(): void {
    this.#epoch++;
    this.#send({ type: 'reset' });
  }

  #send(message: ToWorker): void {
    this.#worker.postMessage(message);
  }

  #receive(message: FromWorker): void {
    if (message.type === 'failed') {
      // Whatever was under way has stopped.
      this.#pending = 0;
      this.#events.error(message.error);
      return;
    }

    if (message.type === 'chunk') {
      this.#pending = Math.max(0, this.#pending - 1);
    }

    if (message.epoch !== this.#epoch) {
      return;
    }

    switch (message.type) {
      case 'status':
        this.#events.status(new Map(message.statuses));
        break;
      case 'chunk':
        this.#events.chunk(message);
        break;
      case 'history':
        this.#events.history(message.samples);
    }
  }
}
