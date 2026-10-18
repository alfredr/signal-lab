// The simulation worker. It owns the simulator, so the engine's cache lives
// here between runs, and the page only ever receives the signals it asks for.

import { blockType } from '../blocks/index.ts';
import { errorMessage } from '../engine/errors.ts';
import { Simulator } from '../engine/simulator.ts';
import {
  blockStatuses,
  flatten,
  signalsWithAliases,
} from '../model/flatten.ts';
import type {
  SignalCopy,
  SimulationRequest,
  SimulationResponse,
} from './protocol.ts';

/**
 * The worker's global scope. The app compiles against the DOM library, where
 * `self` is a Window, so describe the two members used here directly.
 */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SimulationRequest>) => void) | null;
  postMessage(message: SimulationResponse, transfer: Transferable[]): void;
};

const simulator = new Simulator(blockType);

/** A signal's version is the identity of its array: new data, new version. */
const versions = new WeakMap<Float32Array, number>();
let nextVersion = 1;
function versionOf(data: Float32Array): number {
  let version = versions.get(data);
  if (version === undefined) {
    version = nextVersion++;
    versions.set(data, version);
  }

  return version;
}

scope.onmessage = ({ data: request }) => {
  try {
    const started = performance.now();
    const flat = flatten(request.doc);
    const result = simulator.run(flat.circuit);
    const statuses = blockStatuses(request.doc, flat, result.status);
    const signals = signalsWithAliases(result.signals, flat.aliases);

    const copies: SignalCopy[] = [];
    const present: [string, number][] = [];
    for (const [key, held] of request.wanted) {
      const signal = signals.get(key);
      if (!signal) {
        continue;
      }

      const version = versionOf(signal.data);
      present.push([key, version]);

      if (version !== held) {
        // A copy, so the cache keeps its own; the copy's buffer moves to the page.
        copies.push({
          key,
          version,
          rate: signal.rate,
          data: signal.data.slice(),
        });
      }
    }

    scope.postMessage(
      {
        id: request.id,
        ok: true,
        statuses: [...statuses],
        readings: [...result.readings],
        recomputed: result.recomputed,
        errors: [...result.status.values()].filter((s) => s.state === 'error')
          .length,
        elapsed: performance.now() - started,
        signals: copies,
        versions: present,
      },
      copies.map((copy) => copy.data.buffer),
    );
  } catch (error) {
    scope.postMessage(
      { id: request.id, ok: false, error: errorMessage(error) },
      [],
    );
  }
};
