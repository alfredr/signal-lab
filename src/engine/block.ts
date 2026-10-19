import { si } from './format.ts';
import type { ParamSpecs, ParamValues } from './params.ts';

export type Category =
  | 'Sources'
  | 'Math'
  | 'Nonlinear'
  | 'Filters'
  | 'Detectors'
  | 'Meters'
  | 'Digital modes'
  | 'Radio'
  | 'Time and rate'
  | 'Subsystems'
  | 'Instruments';

/**
 * A value a block measures as the stream runs: a power, an SNR, a decoded
 * message, the symbol being sent. Readings show on the block, in the inspector
 * and on readouts, as they stood at the playhead.
 */
export type Reading = {
  readonly label: string;
  readonly value: number | string;
  /** How to show a number. */
  readonly unit?: 'dB' | 'Hz' | 's' | 'x';
};

export type PortSpec = {
  readonly name: string;
  /** Where an input sits on the block. Outputs are always on the right. */
  readonly side?: 'left' | 'top' | 'bottom';
  /**
   * Wired by the app rather than the user, and not drawn: an antenna's link to
   * the air, or a subsystem terminal's link to the outside.
   */
  readonly hidden?: boolean;
  /** The block works without it, as a recording plays without a trigger. */
  readonly optional?: boolean;
};

/** How the diagram draws a block. */
type Shape =
  | { readonly kind: 'box' }
  | { readonly kind: 'circle'; readonly symbol: string }
  | { readonly kind: 'triangle' }
  | { readonly kind: 'antenna' }
  | { readonly kind: 'terminal' }
  /** Drawn by the instrument itself, at a fixed size. */
  | {
      readonly kind: 'instrument';
      readonly width: number;
      readonly height: number;
    };

/**
 * A running instance of a block. It is causal and keeps its own state from one
 * chunk of the stream to the next. Every array holds one chunk, the same
 * stretch of time on every port at that port's rate, so index i is the same
 * instant on every port at one rate. The stream asks for consecutive spans
 * [start, end) of each chunk: all of it at once for a block outside any
 * feedback loop, short spans for blocks inside one.
 */
export type Processor<P = never> = {
  /**
   * Computes samples [start, end) of every output from inputs up to `end`. A
   * block that changes the sample rate never sits in a loop, so it always gets
   * whole chunks, which hold different numbers of samples on each side.
   */
  process(
    inputs: readonly Float32Array[],
    outputs: readonly Float32Array[],
    start: number,
    end: number,
  ): void;
  /** What the block has measured so far, asked for after every chunk. */
  readings?(): readonly Reading[];
  /**
   * Takes new settings in place, keeping its state, the way turning a knob
   * leaves a circuit's capacitors charged. Returns false if it can't, and the
   * block is built afresh.
   */
  update?(params: P): boolean;
  /**
   * A push from outside the stream, such as a button pressed on the face. It
   * takes effect from the next chunk.
   */
  press?(): void;
};

/**
 * A processor whose output at sample i depends only on inputs up to sample i -
 * latency (latency >= 1). That lag is what lets it close a feedback loop: the
 * stream steps a loop in spans no longer than its shortest latency and runs
 * the delays first in each span, when the inputs they need are already in the
 * arrays from earlier spans, or kept from earlier chunks.
 */
export type DelayProcessor<P = never> = Processor<P> & {
  readonly latency: number;
  /**
   * The chunk is done and `inputs` hold all `length` of its samples: keep the
   * last `latency` of them for the start of the next one.
   */
  keep(inputs: readonly Float32Array[], length: number): void;
};

export function isDelayProcessor<P>(
  processor: Processor<P>,
): processor is DelayProcessor<P> {
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
  /**
   * Where the stream is when the block starts, in seconds: 0 at the start, or
   * later for a block built afresh as the stream runs.
   */
  readonly time: number;
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
  /** Labels of the readings it reports as it runs, for readouts to show. */
  readonly reports?: readonly string[];
  /**
   * The readings its block shows on the diagram: the first of `labels` it has,
   * or all it has of them side by side if `together`. Without it, the first
   * reading.
   */
  readonly glance?: {
    readonly labels: readonly string[];
    readonly together?: boolean;
  };
  readonly shape?: Shape;
  /** Short text drawn on the block, such as "4.5 kHz". */
  summary?(params: ParamValues<S>): string;
  /**
   * How far its output runs behind its input, in seconds, at output rate
   * `rate`: for lining up drawings of the signals either side of it.
   */
  lag?(params: ParamValues<S>, rate: number): number;
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
  create(
    params: ParamValues<S>,
    context: BuildContext,
  ): Processor<ParamValues<S>>;
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
 * Thrown by a block that can't run as set up, such as an FT8 message that
 * can't be encoded. Its message is shown as is.
 */
export class BlockError extends Error {
  override readonly name = 'BlockError';
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
