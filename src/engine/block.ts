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
 * A measurement reported by a running block, such as power, SNR, or decoded
 * text. The diagram, inspector, and readouts display readings at the playhead
 * time.
 */
export type Reading = {
  readonly label: string;
  readonly value: number | string;
  /** Display unit for numeric values. */
  readonly unit?: 'dB' | 'Hz' | 's' | 'x';
};

export type PortSpec = {
  readonly name: string;
  /** Where an input sits on the block. Outputs are always on the right. */
  readonly side?: 'left' | 'top' | 'bottom';
  /**
   * An internal port connected by the model and omitted from the diagram, such
   * as an antenna's air connection or a subsystem terminal's external link.
   */
  readonly hidden?: boolean;
  /** Whether the block can run without this input connected. */
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
 * A causal block processor with state retained between chunks. Each array
 * covers the same time interval at its port's sample rate. Equal-rate ports
 * share sample indices. The scheduler requests consecutive [start, end) spans:
 * whole chunks outside feedback loops and shorter spans inside them.
 */
export type Processor<P = never> = {
  /**
   * Writes output samples in [start, end), reading only available inputs
   * before `end`. Rate-changing blocks are excluded from feedback loops and
   * receive whole chunks, with different input and output sample counts.
   */
  process(
    inputs: readonly Float32Array[],
    outputs: readonly Float32Array[],
    start: number,
    end: number,
  ): void;
  /** Reports measurements after each chunk. */
  readings?(): readonly Reading[];
  /**
   * Applies new settings while preserving processor state. Returning false
   * requests a new processor.
   */
  update?(params: P): boolean;
  /**
   * Handles an external trigger, such as a panel button, starting with the
   * next chunk.
   */
  press?(): void;
};

/**
 * A processor whose output at sample i uses inputs no later than i - latency,
 * with latency >= 1. Feedback loops run in spans bounded by their shortest
 * delay. Delay processors run first, reading earlier spans or retained samples
 * from previous chunks.
 */
export type DelayProcessor<P = never> = Processor<P> & {
  readonly latency: number;
  /**
   * Retains input samples needed for the next chunk. Called after all `length`
   * samples have been processed.
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
   * Stream time when the processor is created, in seconds. This may be nonzero
   * when rebuilding during playback.
   */
  readonly time: number;
  /** Stable per-block seed for deterministic randomness. */
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
  /** Available reading labels for readout selection. */
  readonly reports?: readonly string[];
  /**
   * Reading labels to display on the diagram. Shows the first available label,
   * or all available labels when `together` is true. Defaults to the first
   * reported reading.
   */
  readonly glance?: {
    readonly labels: readonly string[];
    readonly together?: boolean;
  };
  readonly shape?: Shape;
  /** Short text drawn on the block, such as "4.5 kHz". */
  summary?(params: ParamValues<S>): string;
  /**
   * Output delay in seconds at sample rate `rate`, used to align related
   * signal views.
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
 * A configuration error with a user-facing message, such as an unsupported FT8
 * message.
 */
export class BlockError extends Error {
  override readonly name = 'BlockError';
}

/** A sample-rate incompatibility with a user-facing message. */
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
