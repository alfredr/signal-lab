// Runs a circuit over its simulation window.
//
// Time model: every wire carries a whole-window signal at its own sample rate. Blocks are
// causal stream processors. The simulator splits the block graph into strongly connected
// components and runs them upstream first. A lone block runs in a single call over the whole
// window. A feedback loop (a component with a cycle) must contain a delay, and its blocks are
// stepped together in chunks no longer than the shortest delay, so every value a block reads
// already exists. Loops run at a single sample rate. Processors index the whole-window arrays
// directly, so stepping a loop one sample at a time allocates nothing.
//
// Results are cached per block, keyed by a fingerprint of the block's settings and everything
// upstream of it, so changing one knob recomputes only what sits downstream of it.

import {
  isDelayProcessor,
  RateError,
  sharedRate,
  type BlockType,
  type DelayProcessor,
  type Processor,
} from './block.ts';
import {
  portKey,
  type BlockNode,
  type Circuit,
  type PortRef,
} from './circuit.ts';
import { errorMessage, errorName } from './errors.ts';
import { resolveParams, type ParamSpecs, type ParamValues } from './params.ts';
import { hash } from './random.ts';
import { sampleCount, type Signal } from './signal.ts';

export type BlockStatus =
  | { readonly state: 'ok'; readonly rates: readonly number[] }
  | { readonly state: 'idle'; readonly reason: string }
  | { readonly state: 'error'; readonly message: string };

export type SimulationResult = {
  /** Signals by output port, keyed with portKey. */
  readonly signals: ReadonlyMap<string, Signal>;
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Blocks computed afresh this run, rather than reused from the last one. */
  readonly recomputed: number;
};

export type BlockLookup = (kind: string) => BlockType | undefined;

/** The most samples held across all wires at once: 64 M floats, 256 MB. */
const SAMPLE_BUDGET = 64_000_000;

type Node = {
  readonly id: string;
  /** The user's name for the block, or its type label. */
  readonly label: string;
  readonly type: BlockType;
  readonly params: ParamValues<ParamSpecs>;
  /** The output feeding each input port, if that input is wired. */
  readonly sources: readonly (PortRef | undefined)[];
  /** Fingerprint of the block's own settings. */
  readonly local: string;
};

type Outcome = {
  readonly status: BlockStatus;
  readonly outputs: readonly Signal[];
};

type CacheEntry = Outcome & {
  readonly signature: number;
};

type Budget = {
  remaining: number;
};

class BudgetError extends Error {
  override readonly name = 'BudgetError';
}

/**
 * Errors whose message is written for the user; anything else is reported as a
 * crash.
 */
const EXPLAINED = new Set(['RateError', 'BudgetError']);

export class Simulator {
  readonly #lookup: BlockLookup;
  #cache = new Map<string, CacheEntry>();

  constructor(lookup: BlockLookup) {
    this.#lookup = lookup;
  }

  run(circuit: Circuit): SimulationResult {
    const { nodes, unknown } = this.#nodes(circuit);
    const signals = new Map<string, Signal>();
    const status = new Map<string, BlockStatus>();
    const signatures = new Map<string, number>();
    const cache = new Map<string, CacheEntry>();
    const budget: Budget = { remaining: SAMPLE_BUDGET };
    let recomputed = 0;

    for (const block of unknown) {
      status.set(block.id, {
        state: 'error',
        message: `Unknown block type "${block.kind}".`,
      });
    }

    for (const component of components(nodes)) {
      const signature = fingerprint(component, circuit.duration, signatures);
      const cached = component.map((node) => this.#cache.get(node.id));
      let outcomes: readonly Outcome[];
      if (cached.every((entry) => entry?.signature === signature)) {
        outcomes = cached as CacheEntry[];

        for (const outcome of outcomes) {
          budget.remaining -= samplesIn(outcome);
        }
      } else {
        outcomes = isLoop(component)
          ? runLoop(component, circuit.duration, signals, budget)
          : [runBlock(component[0], circuit.duration, signals, budget)];
        recomputed += component.length;
      }

      component.forEach((node, k) => {
        const outcome = outcomes[k];
        signatures.set(node.id, signature);
        cache.set(node.id, { ...outcome, signature });
        status.set(node.id, outcome.status);
        outcome.outputs.forEach((signal, port) =>
          signals.set(portKey({ block: node.id, port }), signal),
        );
      });
    }

    this.#cache = cache;
    return { signals, status, recomputed };
  }

  #nodes(circuit: Circuit): { nodes: Node[]; unknown: BlockNode[] } {
    const types = new Map<string, BlockType>();
    const unknown: BlockNode[] = [];
    for (const block of circuit.blocks) {
      const type = this.#lookup(block.kind);
      if (type) {
        types.set(block.id, type);
      } else {
        unknown.push(block);
      }
    }

    const sources = new Map<string, (PortRef | undefined)[]>();
    for (const [id, type] of types) {
      sources.set(
        id,
        type.inputs.map(() => undefined),
      );
    }

    for (const wire of circuit.wires) {
      const inputs = sources.get(wire.to.block);
      const from = types.get(wire.from.block);
      if (
        !inputs ||
        !from ||
        wire.to.port < 0 ||
        wire.to.port >= inputs.length
      ) {
        continue;
      }

      if (wire.from.port < 0 || wire.from.port >= from.outputs.length) {
        continue;
      }

      inputs[wire.to.port] = wire.from;
    }

    const nodes: Node[] = [];
    for (const block of circuit.blocks) {
      const type = types.get(block.id);
      if (!type) {
        continue;
      }

      const params = resolveParams(type.params, block.params);
      nodes.push({
        id: block.id,
        label: block.name || type.label,
        type,
        params,
        sources: sources.get(block.id) ?? [],
        local: `${block.id}|${block.kind}|${JSON.stringify(params)}`,
      });
    }

    return { nodes, unknown };
  }
}

/**
 * Strongly connected components of the block graph, upstream first (Tarjan's
 * algorithm).
 */
function components(nodes: readonly Node[]): Node[][] {
  const position = new Map(nodes.map((node, i) => [node.id, i]));
  const consumers = new Map<string, Node[]>(
    nodes.map((node) => [node.id, []]),
  );
  for (const node of nodes) {
    for (const source of node.sources) {
      if (source) {
        consumers.get(source.block)?.push(node);
      }
    }
  }

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: Node[] = [];
  const onStack = new Set<string>();
  const found: Node[][] = [];

  const visit = (node: Node): void => {
    index.set(node.id, counter);
    low.set(node.id, counter);
    counter++;
    stack.push(node);
    onStack.add(node.id);

    for (const next of consumers.get(node.id)!) {
      if (!index.has(next.id)) {
        visit(next);
        low.set(node.id, Math.min(low.get(node.id)!, low.get(next.id)!));
      } else if (onStack.has(next.id)) {
        low.set(node.id, Math.min(low.get(node.id)!, index.get(next.id)!));
      }
    }

    if (low.get(node.id) === index.get(node.id)) {
      const component: Node[] = [];
      let member: Node;
      do {
        member = stack.pop()!;
        onStack.delete(member.id);
        component.push(member);
      } while (member !== node);

      found.push(
        component.sort((a, b) => position.get(a.id)! - position.get(b.id)!),
      );
    }
  };

  for (const node of nodes) {
    if (!index.has(node.id)) {
      visit(node);
    }
  }

  // Tarjan finds downstream components first.
  return found.reverse();
}

function isLoop(component: readonly Node[]): boolean {
  const only = component[0];
  return (
    component.length > 1 ||
    only.sources.some((source) => source?.block === only.id)
  );
}

/** Hash of a component's settings and of everything feeding it from outside. */
function fingerprint(
  component: readonly Node[],
  duration: number,
  upstream: ReadonlyMap<string, number>,
): number {
  const members = new Set(component.map((node) => node.id));
  const parts = [String(duration)];
  for (const node of component) {
    parts.push(node.local);

    for (const source of node.sources) {
      if (!source) {
        parts.push('-');
      } else if (members.has(source.block)) {
        parts.push(`@${portKey(source)}`);
      } else {
        parts.push(`${upstream.get(source.block) ?? '?'}:${source.port}`);
      }
    }
  }

  return hash(parts.join('\n'));
}

function runBlock(
  node: Node,
  duration: number,
  signals: ReadonlyMap<string, Signal>,
  budget: Budget,
): Outcome {
  const { type, params } = node;
  const inputs = node.sources.map((source) =>
    source ? signals.get(portKey(source)) : undefined,
  );
  for (let i = 0; i < inputs.length; i++) {
    if (node.sources[i] && !inputs[i]) {
      return idle(`No signal reaches input "${type.inputs[i].name}".`);
    }
  }

  if (type.inputs.length > 0 && inputs.every((input) => !input)) {
    return idle('Not connected.');
  }

  try {
    const inputRates = inputs.map((input) => input?.rate);
    const outputRates = type.rates
      ? type.rates(inputRates, params)
      : defaultRates(type, inputRates);
    // An unconnected input reads silence at the rate of the connected ones.
    const fill =
      inputRates.find((rate) => rate !== undefined) ?? outputRates[0] ?? 0;
    const rates = inputRates.map((rate) => rate ?? fill);
    const outputs = allocate(outputRates, duration, budget);
    const processor = type.create(params, {
      inputRates: rates,
      outputRates,
      duration,
      seed: seedOf(node),
    });
    const end = outputs[0]?.length ?? sampleCount(duration, fill);
    processor.process(
      inputs.map(
        (input, i) =>
          input?.data ?? new Float32Array(sampleCount(duration, rates[i])),
      ),
      outputs,
      0,
      end,
    );
    return {
      status: { state: 'ok', rates: outputRates },
      outputs: outputs.map((data, i) => ({ rate: outputRates[i], data })),
    };
  } catch (error) {
    return failed(error);
  }
}

function runLoop(
  component: readonly Node[],
  duration: number,
  signals: ReadonlyMap<string, Signal>,
  budget: Budget,
): Outcome[] {
  const fail = (outcome: Outcome): Outcome[] => component.map(() => outcome);
  const members = new Map(component.map((node, k) => [node.id, k]));

  // Signals entering the loop from outside set its one sample rate.
  const entering = component.map((node) =>
    node.sources.map((source) =>
      source && !members.has(source.block)
        ? signals.get(portKey(source))
        : undefined,
    ),
  );
  for (const [k, node] of component.entries()) {
    for (const [i, source] of node.sources.entries()) {
      if (source && !members.has(source.block) && !entering[k][i]) {
        return fail(idle('No signal enters the loop.'));
      }
    }
  }

  let rate: number | undefined;
  try {
    rate = sharedRate(entering.flat().map((signal) => signal?.rate));
  } catch (error) {
    return fail(failed(error));
  }

  if (rate === undefined) {
    return fail(
      failure(
        'A feedback loop needs an input from outside it to set its sample rate.',
      ),
    );
  }

  const loopRate = rate;

  for (const node of component) {
    try {
      const inputRates = node.sources.map((source) =>
        source ? loopRate : undefined,
      );
      const outputRates = node.type.rates
        ? node.type.rates(inputRates, node.params)
        : node.type.outputs.map(() => loopRate);
      if (outputRates.some((r) => Math.abs(r - loopRate) > 1e-9 * loopRate)) {
        return fail(
          failure(
            `${node.label} changes the sample rate, which a feedback loop can't do. Move it outside the loop.`,
          ),
        );
      }
    } catch (error) {
      return fail(failed(error));
    }
  }

  const n = sampleCount(duration, loopRate);
  let outputs: Float32Array[][];
  let processors: Processor[];
  try {
    outputs = component.map((node) =>
      allocate(
        node.type.outputs.map(() => loopRate),
        duration,
        budget,
      ),
    );
    processors = component.map((node) =>
      node.type.create(node.params, {
        inputRates: node.sources.map(() => loopRate),
        outputRates: node.type.outputs.map(() => loopRate),
        duration,
        seed: seedOf(node),
      }),
    );
  } catch (error) {
    return fail(failed(error));
  }

  const silence = new Float32Array(n);
  const inputs = component.map((node, k) =>
    node.sources.map((source, i) => {
      if (!source) {
        return silence;
      }

      const member = members.get(source.block);
      // Checked above: every wired input from outside the loop has a signal.
      return member === undefined
        ? entering[k][i]!.data
        : outputs[member][source.port];
    }),
  );

  const delays = processors.flatMap((processor, k) =>
    isDelayProcessor(processor) ? [k] : [],
  );
  if (delays.length === 0) {
    return fail(
      failure('This feedback loop has no Delay block. Every loop needs one.'),
    );
  }

  const order = orderWithinLoop(component, processors, members);
  if (!order) {
    return fail(
      failure(
        'One of the loops here has no Delay block. Every loop needs one.',
      ),
    );
  }

  const chunk = Math.max(
    1,
    Math.min(...delays.map((k) => (processors[k] as DelayProcessor).latency)),
  );

  try {
    // Delays first: their output for this chunk only needs input from earlier chunks.
    const steps = [...delays, ...order].map(
      (k) => [processors[k], inputs[k], outputs[k]] as const,
    );
    for (let start = 0; start < n; start += chunk) {
      const end = Math.min(n, start + chunk);
      for (const [processor, input, out] of steps) {
        processor.process(input, out, start, end);
      }
    }
  } catch (error) {
    return fail(failed(error));
  }

  return component.map((node, k) => ({
    status: { state: 'ok', rates: node.type.outputs.map(() => loopRate) },
    outputs: outputs[k].map((data) => ({ rate: loopRate, data })),
  }));
}

/**
 * Order for the loop's non-delay blocks so each runs after the members feeding
 * it. Delay outputs are ready at the start of every chunk, so edges out of
 * delays impose no order. Returns undefined when a cycle remains, meaning some
 * loop has no delay in it.
 */
function orderWithinLoop(
  component: readonly Node[],
  processors: readonly Processor[],
  members: ReadonlyMap<string, number>,
): number[] | undefined {
  const pending = new Map<number, number>();
  const feeds = new Map<number, number[]>();
  component.forEach((node, k) => {
    if (isDelayProcessor(processors[k])) {
      return;
    }

    let count = 0;
    for (const source of node.sources) {
      const from = source ? members.get(source.block) : undefined;
      if (from === undefined || isDelayProcessor(processors[from])) {
        continue;
      }

      count++;
      feeds.set(from, [...(feeds.get(from) ?? []), k]);
    }

    pending.set(k, count);
  });

  const ready = [...pending]
    .filter(([, count]) => count === 0)
    .map(([k]) => k);
  const order: number[] = [];
  while (ready.length) {
    const k = ready.shift()!;
    order.push(k);

    for (const next of feeds.get(k) ?? []) {
      const count = pending.get(next)! - 1;
      pending.set(next, count);

      if (count === 0) {
        ready.push(next);
      }
    }
  }

  return order.length === pending.size ? order : undefined;
}

function defaultRates(
  type: BlockType,
  inputRates: readonly (number | undefined)[],
): readonly number[] {
  const rate = sharedRate(inputRates);
  if (rate === undefined) {
    throw new RateError(`${type.label} has no sample rate.`);
  }

  return type.outputs.map(() => rate);
}

function allocate(
  rates: readonly number[],
  duration: number,
  budget: Budget,
): Float32Array[] {
  const counts = rates.map((rate) => sampleCount(duration, rate));
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > budget.remaining) {
    throw new BudgetError(
      'Too many samples to hold in memory. Shorten the duration or lower the sample rates.',
    );
  }

  budget.remaining -= total;
  return counts.map((count) => new Float32Array(count));
}

function samplesIn(outcome: Outcome): number {
  return outcome.outputs.reduce((sum, signal) => sum + signal.data.length, 0);
}

function seedOf(node: Node): number {
  return hash(node.id) % 4294967296;
}

function idle(reason: string): Outcome {
  return { status: { state: 'idle', reason }, outputs: [] };
}

function failure(message: string): Outcome {
  return { status: { state: 'error', message }, outputs: [] };
}

function failed(error: unknown): Outcome {
  const message = errorMessage(error);
  return failure(
    EXPLAINED.has(errorName(error) ?? '')
      ? message
      : `Simulation error: ${message}`,
  );
}
