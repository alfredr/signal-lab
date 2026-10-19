import { blockType } from '../src/blocks/index.ts';
import type { Circuit } from '../src/engine/circuit.ts';
import type { StoredParams } from '../src/engine/params.ts';
import { seededNoise } from '../src/engine/random.ts';
import type { Signal } from '../src/engine/signal.ts';
import {
  simulate,
  Stream,
  type SimulationResult,
} from '../src/engine/simulator.ts';
import { ref } from '../src/model/build.ts';
import type { LabDocument } from '../src/model/document.ts';
import {
  blockStatuses,
  flatten,
  signalsWithAliases,
} from '../src/model/flatten.ts';

type BlockSpec = readonly [id: string, kind: string, params?: StoredParams];
/** A wire written as ["source:port", "target:port"]. */
type WireSpec = readonly [from: string, to: string];

/** A circuit and how long to run it, in seconds. */
type Run = { readonly circuit: Circuit; readonly seconds: number };

export function circuit(
  seconds: number,
  blocks: readonly BlockSpec[],
  wires: readonly WireSpec[],
): Run {
  return { seconds, circuit: plain(blocks, wires) };
}

/** A circuit from blocks and wires written briefly. */
export function plain(
  blocks: readonly BlockSpec[],
  wires: readonly WireSpec[],
): Circuit {
  return {
    blocks: blocks.map(([id, kind, params = {}]) => ({
      id,
      kind,
      x: 0,
      y: 0,
      params,
    })),
    wires: wires.map(([from, to], i) => ({
      id: `w${i}`,
      from: ref(from),
      to: ref(to),
    })),
  };
}

/** Streams a circuit for its seconds, keeping every signal. */
export function run({ circuit, seconds }: Run): SimulationResult {
  return simulate(blockType, circuit, seconds);
}

export function stream(): Stream {
  return new Stream(blockType);
}

/**
 * Simulates the first `seconds` of a document the way the app does: flattened,
 * with statuses for every block.
 */
export function simulateDocument(doc: LabDocument, seconds = 1) {
  const flat = flatten(doc);
  const result = simulate(blockType, flat.circuit, seconds);
  return {
    signals: signalsWithAliases(result.signals, flat.aliases),
    status: blockStatuses(doc, flat, result.status),
    readings: result.readings,
  };
}

export function output(result: SimulationResult, port: string): Signal {
  const signal = result.signals.get(port.includes(':') ? port : `${port}:0`);
  if (!signal) {
    throw new Error(
      `No signal at ${port}: ${JSON.stringify(result.status.get(ref(port).block))}`,
    );
  }

  return signal;
}

export function decibels(power: number): number {
  return 10 * Math.log10(power);
}

/** `length` standard normal samples, the same for a given seed. */
export function gaussianNoise(length: number, seed: number): Float32Array {
  const normal = seededNoise(seed, 1);
  return Float32Array.from({ length }, () => normal());
}
