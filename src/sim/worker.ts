// Owns the simulation stream and processor state. Retains recent output
// history so newly watched ports can return existing samples; only watched
// ports are sent to the page.

import { addClip } from '../blocks/clips.ts';
import { blockType } from '../blocks/index.ts';
import {
  pronouncingDictionary,
  readDictionary,
  setDictionary,
} from '../blocks/pronouncing.ts';
import { errorMessage } from '../engine/errors.ts';
import { Stream, type BlockStatus } from '../engine/simulator.ts';
import type { LabDocument } from '../model/document.ts';
import { blockStatuses, flatten, type Flattened } from '../model/flatten.ts';
import type { FromWorker, Samples, Stamped, ToWorker } from './protocol.ts';

/**
 * The worker's global scope. The app compiles against the DOM library, where
 * `self` is a Window, so describe the two members used here directly.
 */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
};

/** Samples of history kept for every port. */
const HISTORY = 1 << 17;

/** The latest samples of one port. */
class History {
  readonly rate: number;
  readonly #data = new Float32Array(HISTORY);
  /** The number in the stream of the sample after the newest. */
  end = 0;

  constructor(rate: number) {
    this.rate = rate;
  }

  add(start: number, data: Float32Array): void {
    for (let i = 0; i < data.length; i++) {
      this.#data[(start + i) % HISTORY] = data[i];
    }

    this.end = start + data.length;
  }

  /** Everything it holds, oldest first, as `key`'s samples. */
  latest(key: string): Samples {
    const count = Math.min(this.end, HISTORY);
    const start = this.end - count;
    const data = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      data[i] = this.#data[(start + i) % HISTORY];
    }

    return { key, rate: this.rate, start, data };
  }
}

const stream = new Stream(blockType);
let doc: LabDocument | undefined;
let flat: Flattened | undefined;
let watched: readonly string[] = [];
let epoch = 0;
const histories = new Map<string, History>();

let fetchingDictionary = false;

/**
 * Loads the pronunciation dictionary on first use and restarts waiting Speech
 * blocks. If loading fails, speech falls back to letter-to-sound rules.
 */
function fetchDictionary(): void {
  if (fetchingDictionary || pronouncingDictionary()) {
    return;
  }

  fetchingDictionary = true;
  fetch(new URL('../../vendor/cmudict.txt', import.meta.url))
    .then((response) => (response.ok ? response.text() : ''))
    .catch(() => '')
    .then((text) => {
      setDictionary(readDictionary(text));

      if (flat) {
        sendStatus(stream.load(flat.circuit).status);
      }
    });
}

/** The engine's key for a document port key: subsystem outputs live inside. */
const engineKey = (key: string) => flat?.aliases.get(key) ?? key;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function sendStatus(status: ReadonlyMap<string, BlockStatus>): void {
  if (doc && flat) {
    post({
      type: 'status',
      epoch,
      statuses: [...blockStatuses(doc, flat, status)],
    });
  }
}

/** Sends what the newly watched ports carried lately. */
function sendHistory(keys: readonly string[]): void {
  const samples: Samples[] = [];
  for (const key of keys) {
    const history = histories.get(engineKey(key));
    if (history && history.end > 0) {
      samples.push(history.latest(key));
    }
  }

  if (samples.length) {
    post(
      { type: 'history', epoch, samples },
      samples.map((s) => s.data.buffer),
    );
  }
}

function advance(until: number): void {
  const started = performance.now();
  const from = stream.time;
  const parts = new Map<
    string,
    { rate: number; start: number; parts: Float32Array[] }
  >();
  const readings: Stamped[] = [];
  const wanted = new Map(watched.map((key) => [engineKey(key), key]));
  stream.advance(until, (chunk) => {
    for (const [key, signal] of chunk.signals) {
      let history = histories.get(key);
      if (history?.rate !== signal.rate) {
        histories.set(key, (history = new History(signal.rate)));
      }

      history.add(signal.start, signal.data);
    }

    for (const [engine, key] of wanted) {
      const signal = chunk.signals.get(engine);
      if (!signal) {
        continue;
      }

      const entry = parts.get(key);
      if (entry && entry.rate === signal.rate) {
        entry.parts.push(signal.data.slice());
      } else {
        parts.set(key, {
          rate: signal.rate,
          start: signal.start,
          parts: [signal.data.slice()],
        });
      }
    }

    for (const [block, now] of chunk.readings) {
      readings.push({ at: chunk.to, block, readings: now });
    }

    if (chunk.status) {
      sendStatus(chunk.status);
    }
  });

  const samples: Samples[] = [...parts].map(([key, entry]) => {
    const data = new Float32Array(
      entry.parts.reduce((sum, part) => sum + part.length, 0),
    );
    let at = 0;
    for (const part of entry.parts) {
      data.set(part, at);
      at += part.length;
    }

    return { key, rate: entry.rate, start: entry.start, data };
  });
  post(
    {
      type: 'chunk',
      epoch,
      time: stream.time,
      elapsed: performance.now() - started,
      covered: stream.time - from,
      samples,
      readings,
    },
    samples.map((s) => s.data.buffer),
  );
}

scope.onmessage = ({ data: message }) => {
  try {
    switch (message.type) {
      case 'load': {
        doc = message.doc;
        flat = flatten(doc);
        sendStatus(stream.load(flat.circuit).status);

        if (flat.circuit.blocks.some((block) => block.kind === 'speech')) {
          fetchDictionary();
        }

        break;
      }

      case 'watch': {
        const fresh = message.keys.filter((key) => !watched.includes(key));
        watched = message.keys;
        sendHistory(fresh);
        break;
      }

      case 'advance':
        advance(message.until);
        break;

      case 'press':
        stream.press(message.block);
        break;

      case 'clips': {
        for (const clip of message.clips) {
          addClip(clip.id, { rate: clip.rate, data: clip.data });
        }

        // Blocks that were missing their recording can start now.
        if (flat) {
          sendStatus(stream.load(flat.circuit).status);
        }

        break;
      }

      case 'reset': {
        epoch++;
        histories.clear();
        const result = stream.reset();
        if (result) {
          sendStatus(result.status);
        }

        break;
      }
    }
  } catch (error) {
    post({ type: 'failed', error: errorMessage(error) });
  }
};
