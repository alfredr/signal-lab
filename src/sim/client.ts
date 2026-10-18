// The page's side of the simulation worker. One run at a time: while one is
// under way only the newest request waits, so dragging a slider never builds
// a backlog, and the page stays responsive however long a run takes.

import type { Reading } from '../engine/block.ts';
import type { Signal } from '../engine/signal.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import type { LabDocument } from '../model/document.ts';
import type { SimulationRequest, SimulationResponse } from './protocol.ts';

export type Simulation = {
  /** The document this is the result for. */
  readonly doc: LabDocument;
  readonly statuses: ReadonlyMap<string, BlockStatus>;
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
  /** The signals asked for, by port key. */
  readonly signals: ReadonlyMap<string, Signal>;
  readonly recomputed: number;
  readonly errors: number;
  readonly elapsed: number;
};

type Held = { readonly version: number; readonly signal: Signal };

export class SimulationClient {
  readonly #worker: Worker;
  readonly #onResult: (simulation: Simulation) => void;
  readonly #onError: (message: string) => void;
  #held = new Map<string, Held>();
  #running: { readonly id: number; readonly doc: LabDocument } | undefined;
  #waiting:
    | { readonly doc: LabDocument; readonly wanted: readonly string[] }
    | undefined;
  #nextId = 1;

  constructor(
    onResult: (simulation: Simulation) => void,
    onError: (message: string) => void,
  ) {
    this.#onResult = onResult;
    this.#onError = onError;
    this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
    this.#worker.addEventListener(
      'message',
      (event: MessageEvent<SimulationResponse>) => this.#receive(event.data),
    );
    this.#worker.addEventListener('error', (event) =>
      this.#onError(event.message || 'The simulation worker failed to start.'),
    );
  }

  /** Whether a run is under way. */
  get busy(): boolean {
    return this.#running !== undefined;
  }

  /** Simulates `doc` and returns the signals for the `wanted` port keys. */
  request(doc: LabDocument, wanted: readonly string[]): void {
    this.#waiting = { doc, wanted };

    if (!this.#running) {
      this.#send();
    }
  }

  #send(): void {
    const next = this.#waiting;
    if (!next) {
      return;
    }

    this.#waiting = undefined;
    const id = this.#nextId++;
    this.#running = { id, doc: next.doc };
    const request: SimulationRequest = {
      id,
      doc: next.doc,
      wanted: next.wanted.map((key) => [key, this.#held.get(key)?.version]),
    };
    this.#worker.postMessage(request);
  }

  #receive(response: SimulationResponse): void {
    const running = this.#running;
    this.#running = undefined;

    if (running?.id === response.id) {
      if (response.ok) {
        // Keep held signals the worker says are unchanged; take the new copies.
        const held = new Map<string, Held>();
        for (const copy of response.signals) {
          held.set(copy.key, {
            version: copy.version,
            signal: { rate: copy.rate, data: copy.data },
          });
        }

        for (const [key, version] of response.versions) {
          const old = this.#held.get(key);
          if (!held.has(key) && old?.version === version) {
            held.set(key, old);
          }
        }

        this.#held = held;
        this.#onResult({
          doc: running.doc,
          statuses: new Map(response.statuses),
          readings: new Map(response.readings),
          signals: new Map(
            [...held].map(([key, { signal }]) => [key, signal]),
          ),
          recomputed: response.recomputed,
          errors: response.errors,
          elapsed: response.elapsed,
        });
      } else {
        this.#onError(response.error);
      }
    }

    this.#send();
  }
}
