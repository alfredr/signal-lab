import type { StoredParams } from './params.ts';

/**
 * One port of one block: an output when it is a wire's source, an input when
 * it is a target.
 */
export type PortRef = {
  readonly block: string;
  readonly port: number;
};

export type BlockNode = {
  readonly id: string;
  readonly kind: string;
  /** Optional label the user gave this block. */
  readonly name?: string;
  /** Top-left corner on the diagram. */
  readonly x: number;
  readonly y: number;
  readonly params: StoredParams;
};

export type Wire = {
  readonly id: string;
  readonly from: PortRef;
  readonly to: PortRef;
};

/**
 * Everything the simulator needs: the blocks, how they connect, and how long
 * to run.
 */
export type Circuit = {
  /** Simulation window in seconds. */
  readonly duration: number;
  readonly blocks: readonly BlockNode[];
  readonly wires: readonly Wire[];
};

/** Key for an output port, used to look up its signal. */
export function portKey(ref: PortRef): string {
  return `${ref.block}:${ref.port}`;
}
