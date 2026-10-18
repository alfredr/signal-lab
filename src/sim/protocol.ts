// Messages between the page and the simulation worker.

import type { Reading } from '../engine/block.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import type { LabDocument } from '../model/document.ts';

export type SimulationRequest = {
  readonly id: number;
  readonly doc: LabDocument;
  /**
   * Port keys whose signals the page wants, each with the version it already
   * holds, so an unchanged signal isn't copied again.
   */
  readonly wanted: readonly (readonly [
    key: string,
    version: number | undefined,
  ])[];
};

export type SignalCopy = {
  readonly key: string;
  readonly version: number;
  readonly rate: number;
  readonly data: Float32Array;
};

export type SimulationResponse =
  | {
      readonly id: number;
      readonly ok: true;
      /** Status of every block in the document, by full id. */
      readonly statuses: readonly (readonly [string, BlockStatus])[];
      readonly readings: readonly (readonly [string, readonly Reading[]])[];
      /** Blocks the engine computed afresh, and how many of its blocks failed. */
      readonly recomputed: number;
      readonly errors: number;
      /** Milliseconds the run took. */
      readonly elapsed: number;
      /** The wanted signals that changed. */
      readonly signals: readonly SignalCopy[];
      /** Every wanted key that has a signal, with its current version. */
      readonly versions: readonly (readonly [string, number])[];
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
