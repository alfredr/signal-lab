// Messages between the page and the simulation worker, which runs the document
// as a stream. The page loads documents, says which ports it watches, and asks
// the stream to advance a little ahead of the playhead; the worker answers with
// the watched ports' samples and the readings, stamped with the stream's time.
// A reset starts a new epoch, and the page drops anything from an older one.

import type { Reading } from '../engine/block.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import type { LabDocument } from '../model/document.ts';

export type ToWorker =
  /** Runs this document from where the stream is. */
  | { readonly type: 'load'; readonly doc: LabDocument }
  /** Sends these ports from now on, starting with what each carried lately. */
  | { readonly type: 'watch'; readonly keys: readonly string[] }
  /** Simulates up to `until` seconds. */
  | { readonly type: 'advance'; readonly until: number }
  /** Back to time 0, with every block afresh. */
  | { readonly type: 'reset' }
  /** Pushes a block, by full id, as a Button does. */
  | { readonly type: 'press'; readonly block: string }
  /** Recordings for the Recording blocks, by id. */
  | {
      readonly type: 'clips';
      readonly clips: readonly {
        readonly id: string;
        readonly rate: number;
        readonly data: Float32Array;
      }[];
    };

/** A run of one port's samples; `start` numbers the first in the stream. */
export type Samples = {
  readonly key: string;
  readonly rate: number;
  readonly start: number;
  readonly data: Float32Array;
};

/** A block's readings as they stood at time `at`. */
export type Stamped = {
  readonly at: number;
  readonly block: string;
  readonly readings: readonly Reading[];
};

export type FromWorker =
  | {
      readonly type: 'status';
      readonly epoch: number;
      /** Status of every block in the document, by full id. */
      readonly statuses: readonly (readonly [string, BlockStatus])[];
    }
  | {
      /** The answer to an advance. */
      readonly type: 'chunk';
      readonly epoch: number;
      /** Where the stream got to, in seconds. */
      readonly time: number;
      /** Milliseconds the work took, and the stream seconds it covered. */
      readonly elapsed: number;
      readonly covered: number;
      readonly samples: readonly Samples[];
      readonly readings: readonly Stamped[];
    }
  /** What newly watched ports carried lately. */
  | {
      readonly type: 'history';
      readonly epoch: number;
      readonly samples: readonly Samples[];
    }
  | { readonly type: 'failed'; readonly error: string };
