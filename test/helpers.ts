import { blockType } from "../src/blocks/index.ts";
import type { Circuit } from "../src/engine/circuit.ts";
import type { StoredParams } from "../src/engine/params.ts";
import { Simulator, type SimulationResult } from "../src/engine/simulator.ts";
import type { Signal } from "../src/engine/signal.ts";

type BlockSpec = readonly [id: string, kind: string, params?: StoredParams];
/** A wire written as ["source:port", "target:port"]. */
type WireSpec = readonly [from: string, to: string];

function ref(text: string) {
  const [block, port] = text.split(":");
  return { block: block!, port: Number(port ?? 0) };
}

export function circuit(duration: number, blocks: readonly BlockSpec[], wires: readonly WireSpec[]): Circuit {
  return {
    duration,
    blocks: blocks.map(([id, kind, params = {}]) => ({ id, kind, x: 0, y: 0, params })),
    wires: wires.map(([from, to], i) => ({ id: `w${i}`, from: ref(from), to: ref(to) })),
  };
}

export function simulator(): Simulator {
  return new Simulator(blockType);
}

export function output(result: SimulationResult, port: string): Signal {
  const signal = result.signals.get(port.includes(":") ? port : `${port}:0`);
  if (!signal) throw new Error(`No signal at ${port}: ${JSON.stringify(result.status.get(ref(port).block))}`);
  return signal;
}

export function decibels(power: number): number {
  return 10 * Math.log10(power);
}
