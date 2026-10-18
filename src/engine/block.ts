import { si } from "./format.ts";
import type { ParamSpecs, ParamValues } from "./params.ts";

export type Category = "Sources" | "Math" | "Nonlinear" | "Filters" | "Detectors" | "Time and rate";

export interface PortSpec {
  readonly name: string;
  /** Where an input sits on the block. Outputs are always on the right. */
  readonly side?: "left" | "top" | "bottom";
}

/** How the diagram draws a block: a labeled box, a circle with a symbol, or an amplifier triangle. */
export type Shape =
  | { readonly kind: "box" }
  | { readonly kind: "circle"; readonly symbol: string }
  | { readonly kind: "triangle" };

/**
 * A running instance of a block. It is causal and keeps its own state, so the simulator can
 * feed it time in consecutive spans: a block outside any feedback loop gets one call covering
 * the whole window, while blocks inside a loop are stepped together in short chunks.
 */
export interface Processor {
  /**
   * Computes the next span of output. All arrays cover the same stretch of time, so each one's
   * length follows its port's sample rate.
   */
  process(inputs: readonly Float32Array[], outputs: readonly Float32Array[]): void;
}

/**
 * A processor whose output lags its input by at least `latency` samples. That lag is what lets
 * it close a feedback loop: within a loop the simulator asks for its output first (pull) and
 * hands it the matching input once the rest of the loop has produced it (push). Spans passed
 * to pull and push are never longer than `latency`.
 */
export interface DelayProcessor extends Processor {
  readonly latency: number;
  pull(outputs: readonly Float32Array[]): void;
  push(inputs: readonly Float32Array[]): void;
}

export function isDelayProcessor(processor: Processor): processor is DelayProcessor {
  return "pull" in processor && "push" in processor;
}

export interface BuildContext {
  /** Sample rate of each input. An unconnected input reads silence at the block's own rate. */
  readonly inputRates: readonly number[];
  readonly outputRates: readonly number[];
  /** Length of the simulation window in seconds. */
  readonly duration: number;
  /** Stable for a given block, for anything random. */
  readonly seed: number;
}

export interface BlockType<S extends ParamSpecs = ParamSpecs> {
  readonly kind: string;
  readonly label: string;
  readonly category: Category;
  /** One or two sentences for the inspector. */
  readonly description: string;
  readonly inputs: readonly PortSpec[];
  readonly outputs: readonly PortSpec[];
  readonly params: S;
  readonly shape?: Shape;
  /** Short text drawn on the block, such as "4.5 kHz". */
  summary?(params: ParamValues<S>): string;
  /**
   * Output sample rates, given the rate of each input (undefined when unconnected). Throws a
   * RateError when the inputs don't fit together. Without it, a block requires all of its
   * connected inputs to share one rate and runs its outputs at that rate.
   */
  rates?(inputRates: readonly (number | undefined)[], params: ParamValues<S>): readonly number[];
  create(params: ParamValues<S>, context: BuildContext): Processor;
}

/** Lets a block literal infer its parameter types from its specs. */
export function defineBlock<const S extends ParamSpecs>(type: BlockType<S>): BlockType<S> {
  return type;
}

export class RateError extends Error {
  override readonly name = "RateError";
}

/** The one rate shared by all connected inputs, or undefined when none are connected. */
export function sharedRate(inputRates: readonly (number | undefined)[]): number | undefined {
  let rate: number | undefined;
  for (const r of inputRates) {
    if (r === undefined) continue;
    if (rate !== undefined && Math.abs(r - rate) > 1e-9 * rate) {
      throw new RateError(`Inputs arrive at ${si(rate, "Hz")} and ${si(r, "Hz")}. Add a Resample block so they match.`);
    }
    rate = r;
  }
  return rate;
}
