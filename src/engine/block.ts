import { si } from './format.ts';
import type { ParamSpecs, ParamValues } from './params.ts';

export type Category =
  | 'Sources'
  | 'Math'
  | 'Nonlinear'
  | 'Filters'
  | 'Detectors'
  | 'Radio'
  | 'Time and rate'
  | 'Subsystems';

export type PortSpec = {
  readonly name: string;
  /** Where an input sits on the block. Outputs are always on the right. */
  readonly side?: 'left' | 'top' | 'bottom';
  /**
   * Wired by the app rather than the user, and not drawn: an antenna's link to
   * the air, or a subsystem terminal's link to the outside.
   */
  readonly hidden?: boolean;
};

/** How the diagram draws a block. */
type Shape =
  | { readonly kind: 'box' }
  | { readonly kind: 'circle'; readonly symbol: string }
  | { readonly kind: 'triangle' }
  | { readonly kind: 'antenna' }
  | { readonly kind: 'terminal' };

/**
 * A running instance of a block. It is causal and keeps its own state. Every
 * array holds the whole simulation window, so index i is the same instant on
 * every port, and the simulator asks for consecutive spans [start, end): one
 * call covering everything for a block outside any feedback loop, short chunks
 * for blocks inside one.
 */
export type Processor = {
  /**
   * Computes samples [start, end) of every output from inputs up to `end`. A
   * block that changes the sample rate never sits in a loop, so it is always
   * called once with the whole window (start 0, end the length of its first
   * output) and indexes its arrays as it needs.
   */
  process(
    inputs: readonly Float32Array[],
    outputs: readonly Float32Array[],
    start: number,
    end: number,
  ): void;
};

/**
 * A processor whose output at sample i depends only on inputs up to sample i -
 * latency (latency >= 1). That lag is what lets it close a feedback loop: the
 * simulator steps a loop in chunks no longer than its shortest latency and
 * runs the delays first in each chunk, when the inputs they need are already
 * in the arrays from earlier chunks.
 */
export type DelayProcessor = Processor & {
  readonly latency: number;
};

export function isDelayProcessor(
  processor: Processor,
): processor is DelayProcessor {
  return (
    'latency' in processor &&
    typeof processor.latency === 'number' &&
    processor.latency >= 1
  );
}

type BuildContext = {
  /**
   * Sample rate of each input. An unconnected input reads silence at the
   * block's own rate.
   */
  readonly inputRates: readonly number[];
  readonly outputRates: readonly number[];
  /** Length of the simulation window in seconds. */
  readonly duration: number;
  /** Stable for a given block, for anything random. */
  readonly seed: number;
};

export type BlockType<S extends ParamSpecs = ParamSpecs> = {
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
   * Output sample rates, given the rate of each input (undefined when
   * unconnected). Throws a RateError when the inputs don't fit together.
   * Without it, a block requires all of its connected inputs to share one rate
   * and runs its outputs at that rate.
   */
  rates?(
    inputRates: readonly (number | undefined)[],
    params: ParamValues<S>,
  ): readonly number[];
  create(params: ParamValues<S>, context: BuildContext): Processor;
};

/** A block's ports that the user wires (not hidden), with their indices. */
export function visiblePorts(
  ports: readonly PortSpec[],
): { readonly port: PortSpec; readonly index: number }[] {
  return ports.flatMap((port, index) =>
    port.hidden ? [] : [{ port, index }],
  );
}

/** Lets a block literal infer its parameter types from its specs. */
export function defineBlock<const S extends ParamSpecs>(
  type: BlockType<S>,
): BlockType<S> {
  return type;
}

/**
 * Thrown by `rates` when a block's inputs don't fit together. Its message is
 * shown as is.
 */
export class RateError extends Error {
  override readonly name = 'RateError';
}

/**
 * The one rate shared by all connected inputs, or undefined when none are
 * connected.
 */
export function sharedRate(
  inputRates: readonly (number | undefined)[],
): number | undefined {
  let rate: number | undefined;
  for (const r of inputRates) {
    if (r === undefined) {
      continue;
    }

    if (rate !== undefined && Math.abs(r - rate) > 1e-9 * rate) {
      throw new RateError(
        `Inputs arrive at ${si(rate, 'Hz')} and ${si(r, 'Hz')}. Add a Resample block so they match.`,
      );
    }

    rate = r;
  }

  return rate;
}
