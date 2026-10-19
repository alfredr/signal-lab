// Streams a circuit forward from time zero in bounded chunks. Wires carry
// samples for the same time interval at their own rates; processors retain
// state between chunks.
//
// The scheduler orders strongly connected components upstream first. Acyclic
// blocks process whole chunks. Feedback components require a delay and a
// common sample rate, and run in spans bounded by their shortest delay.
//
// Circuit updates preserve simulation time and reuse compatible processors.
// Settings changes apply to subsequent samples without altering existing
// history.

import {
  isDelayProcessor,
  RateError,
  sharedRate,
  type BlockType,
  type Processor,
  type Reading,
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

/** One output chunk, with `start` giving its first absolute sample index. */
type ChunkSignal = Signal & { readonly start: number };

/** Simulation chunk delivered by `advance`. */
export type Chunk = {
  /** Its start and end, in seconds. */
  readonly from: number;
  readonly to: number;
  /**
   * Output samples indexed by port key. Arrays are reused on the next chunk;
   * copy any data that must be retained.
   */
  readonly signals: ReadonlyMap<string, ChunkSignal>;
  /** Readings from blocks whose reported values changed in this chunk. */
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
  /** Updated block statuses when processing fails. */
  readonly status?: ReadonlyMap<string, BlockStatus>;
};

export type LoadResult = {
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Ids of blocks rebuilt instead of reused or updated in place. */
  readonly rebuilt: number;
};

export type BlockLookup = (kind: string) => BlockType | undefined;

/** The longest chunk, in seconds and in samples on the fastest wire. */
const CHUNK_SECONDS = 1 / 32;
const CHUNK_SAMPLES = 32768;

type Params = ParamValues<ParamSpecs>;

type Node = {
  readonly id: string;
  /** The user's name for the block, or its type label. */
  readonly label: string;
  readonly type: BlockType;
  readonly params: Params;
  /** The output feeding each input port, if that input is wired. */
  readonly sources: readonly (PortRef | undefined)[];
};

/** Active processor and the configuration used to build it. */
type Running = {
  readonly kind: string;
  readonly processor: Processor<Params>;
  readonly inputRates: readonly number[];
  readonly outputRates: readonly number[];
  /** Its settings, as JSON. */
  params: string;
  /** Its readings as last reported, as JSON. */
  reported: string;
};

/** A scheduling unit: one acyclic block or a feedback component. */
type Step =
  | {
      readonly loop: false;
      readonly node: Node;
      readonly running: Running;
    }
  | {
      readonly loop: true;
      readonly nodes: readonly Node[];
      readonly running: readonly Running[];
      readonly rate: number;
      /** Member indices in execution order: delays first, then dependents. */
      readonly delays: readonly number[];
      readonly order: readonly number[];
      /** Maximum processing span, bounded by the shortest delay. */
      readonly span: number;
    };

/**
 * Errors with user-facing messages. Other exceptions are reported as processor
 * crashes.
 */
const EXPLAINED = new Set(['RateError', 'BlockError']);

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9 * v);

export class Stream {
  readonly #lookup: BlockLookup;
  #circuit: Circuit | undefined;
  #steps: readonly Step[] = [];
  /** The fastest rate anywhere, which sets how long a chunk can be. */
  #fastest = 1;
  #running = new Map<string, Running>();
  /** Processing failures retained until reset. */
  readonly #faults = new Map<string, string>();
  readonly #buffers = new Map<string, Float32Array>();
  #silence = new Float32Array(0);
  #time = 0;

  constructor(lookup: BlockLookup) {
    this.#lookup = lookup;
  }

  /** Seconds simulated so far. */
  get time(): number {
    return this.#time;
  }

  /** Loads a circuit without rewinding simulation time. */
  load(circuit: Circuit): LoadResult {
    this.#faults.clear();
    return this.#plan(circuit);
  }

  /** Sends an external trigger to a block. */
  press(id: string): void {
    this.#running.get(id)?.processor.press?.();
  }

  /** Resets time and rebuilds every processor. */
  reset(): LoadResult | undefined {
    this.#time = 0;
    this.#running.clear();
    this.#faults.clear();
    return this.#circuit && this.#plan(this.#circuit);
  }

  /** Simulates up to `until` seconds, handing over each chunk as it is done. */
  advance(until: number, onChunk?: (chunk: Chunk) => void): void {
    const longest = Math.min(CHUNK_SECONDS, CHUNK_SAMPLES / this.#fastest);
    while (until - this.#time > 1e-9) {
      const from = this.#time;
      const to = Math.min(until, from + longest);
      const chunk = this.#step(from, to);
      this.#time = to;
      onChunk?.(chunk);
    }
  }

  #plan(circuit: Circuit): LoadResult {
    this.#circuit = circuit;
    const { nodes, unknown } = this.#nodes(circuit);
    const status = new Map<string, BlockStatus>();
    const rates = new Map<string, number>();
    const running = new Map<string, Running>();
    const steps: Step[] = [];
    let rebuilt = 0;

    for (const block of unknown) {
      status.set(block.id, {
        state: 'error',
        message: `Unknown block type "${block.kind}".`,
      });
    }

    // Reuse processors with compatible kinds and rates, applying settings
    // updates when supported.
    const start = (
      node: Node,
      inputRates: readonly number[],
      outputRates: readonly number[],
    ): Running => {
      const old = this.#running.get(node.id);
      const params = JSON.stringify(node.params);
      if (
        old &&
        old.kind === node.type.kind &&
        same(old.inputRates, inputRates) &&
        same(old.outputRates, outputRates) &&
        (old.params === params || old.processor.update?.(node.params))
      ) {
        old.params = params;
        return old;
      }

      rebuilt++;
      return {
        kind: node.type.kind,
        processor: node.type.create(node.params, {
          inputRates,
          outputRates,
          time: this.#time,
          seed: seedOf(node),
        }),
        inputRates,
        outputRates,
        params,
        reported: '[]',
      };
    };

    const block = (node: Node): BlockStatus => {
      const { type, params } = node;
      const inputRates = node.sources.map((source) =>
        source ? rates.get(portKey(source)) : undefined,
      );
      for (let i = 0; i < inputRates.length; i++) {
        if (node.sources[i] && inputRates[i] === undefined) {
          return idle(`No signal reaches input "${type.inputs[i].name}".`);
        }
      }

      // Leave blocks idle when no input is connected unless every input is
      // optional.
      const needed = type.inputs.filter((port) => !port.optional);
      if (
        needed.length > 0 &&
        type.inputs.every((port, i) => port.optional || !node.sources[i])
      ) {
        return idle('Not connected.');
      }

      try {
        const outputRates = type.rates
          ? type.rates(inputRates, params)
          : defaultRates(type, inputRates);
        // An unconnected input reads silence at the rate of the connected ones.
        const fill =
          inputRates.find((rate) => rate !== undefined) ?? outputRates[0] ?? 0;
        const r = start(
          node,
          inputRates.map((rate) => rate ?? fill),
          outputRates,
        );
        running.set(node.id, r);
        steps.push({ loop: false, node, running: r });
        outputRates.forEach((rate, port) =>
          rates.set(portKey({ block: node.id, port }), rate),
        );
        return { state: 'ok', rates: outputRates };
      } catch (error) {
        return failed(error);
      }
    };

    const loop = (component: readonly Node[]): BlockStatus => {
      const members = new Map(component.map((node, k) => [node.id, k]));

      // Signals entering the loop from outside set its one sample rate.
      const entering: (number | undefined)[] = [];
      for (const node of component) {
        for (const source of node.sources) {
          if (source && !members.has(source.block)) {
            const rate = rates.get(portKey(source));
            if (rate === undefined) {
              return idle('No signal enters the loop.');
            }

            entering.push(rate);
          }
        }
      }

      let rate: number | undefined;
      try {
        rate = sharedRate(entering);
      } catch (error) {
        return failed(error);
      }

      if (rate === undefined) {
        return failure(
          'A feedback loop needs an input from outside it to set its sample rate.',
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
          if (
            outputRates.some((r) => Math.abs(r - loopRate) > 1e-9 * loopRate)
          ) {
            return failure(
              `${node.label} changes the sample rate, which a feedback loop can't do. Move it outside the loop.`,
            );
          }
        } catch (error) {
          return failed(error);
        }
      }

      let built: Running[];
      try {
        built = component.map((node) =>
          start(
            node,
            node.sources.map(() => loopRate),
            node.type.outputs.map(() => loopRate),
          ),
        );
      } catch (error) {
        return failed(error);
      }

      const isDelay = built.map((r) => isDelayProcessor(r.processor));
      const delays = isDelay.flatMap((delay, k) => (delay ? [k] : []));
      if (delays.length === 0) {
        return failure(
          'This feedback loop has no Delay block. Every loop needs one.',
        );
      }

      const order = orderWithinLoop(component, isDelay, members);
      if (!order) {
        return failure(
          'One of the loops here has no Delay block. Every loop needs one.',
        );
      }

      const span = Math.max(
        1,
        Math.min(
          ...delays.map((k) => {
            const processor = built[k].processor;
            return isDelayProcessor(processor) ? processor.latency : 1;
          }),
        ),
      );
      component.forEach((node, k) => {
        running.set(node.id, built[k]);
        node.type.outputs.forEach((_, port) =>
          rates.set(portKey({ block: node.id, port }), loopRate),
        );
      });
      steps.push({
        loop: true,
        nodes: component,
        running: built,
        rate: loopRate,
        delays,
        order,
        span,
      });
      return { state: 'ok', rates: [loopRate] };
    };

    for (const component of components(nodes)) {
      const fault = component
        .map((node) => this.#faults.get(node.id))
        .find(Boolean);
      const outcome = fault
        ? failure(fault)
        : isLoop(component)
          ? loop(component)
          : block(component[0]);

      for (const node of component) {
        status.set(
          node.id,
          outcome.state === 'ok'
            ? {
                state: 'ok',
                rates: node.type.outputs.map((_, port) =>
                  rates.get(portKey({ block: node.id, port }))!,
                ),
              }
            : outcome,
        );
      }
    }

    this.#running = running;
    this.#steps = steps;
    this.#fastest = Math.max(
      1,
      ...[...running.values()].flatMap((r) => [
        ...r.inputRates,
        ...r.outputRates,
      ]),
    );
    return { status, rebuilt };
  }

  #step(from: number, to: number): Chunk {
    const signals = new Map<string, ChunkSignal>();
    const count = (rate: number) =>
      sampleCount(to, rate) - sampleCount(from, rate);
    const output = (block: string, port: number, rate: number) => {
      const key = portKey({ block, port });
      const n = count(rate);
      let buffer = this.#buffers.get(key);
      if (!buffer || buffer.length < n) {
        buffer = new Float32Array(Math.max(n, 1024));
        this.#buffers.set(key, buffer);
      }

      const data = buffer.subarray(0, n);
      signals.set(key, { rate, start: sampleCount(from, rate), data });
      return data;
    };

    // Never written to: processors only read their inputs.
    const silence = (rate: number) => {
      const n = count(rate);
      if (this.#silence.length < n) {
        this.#silence = new Float32Array(n);
      }

      return this.#silence.subarray(0, n);
    };

    const input = (source: PortRef | undefined, rate: number) =>
      (source && signals.get(portKey(source))?.data) ?? silence(rate);

    let faulted = false;
    for (const step of this.#steps) {
      try {
        if (!step.loop) {
          const { node, running } = step;
          const outputs = running.outputRates.map((rate, port) =>
            output(node.id, port, rate),
          );
          const inputs = node.sources.map((source, i) =>
            input(source, running.inputRates[i]),
          );
          const end = outputs[0]?.length ?? count(running.inputRates[0] ?? 0);
          running.processor.process(inputs, outputs, 0, end);

          if (isDelayProcessor(running.processor)) {
            running.processor.keep(inputs, end);
          }

          continue;
        }

        const { nodes, running, rate } = step;
        const outputs = nodes.map((node) =>
          node.type.outputs.map((_, port) => output(node.id, port, rate)),
        );
        const members = new Map(nodes.map((node, k) => [node.id, k]));
        const inputs = nodes.map((node) =>
          node.sources.map((source) => {
            const member = source ? members.get(source.block) : undefined;
            return source && member !== undefined
              ? outputs[member][source.port]
              : input(source, rate);
          }),
        );
        const n = count(rate);
        const order = [...step.delays, ...step.order];
        // Delays first: their output for this span only needs input from earlier spans.
        for (let start = 0; start < n; start += step.span) {
          const end = Math.min(n, start + step.span);
          for (const k of order) {
            running[k].processor.process(inputs[k], outputs[k], start, end);
          }
        }

        for (const k of step.delays) {
          const processor = running[k].processor;
          if (isDelayProcessor(processor)) {
            processor.keep(inputs[k], n);
          }
        }
      } catch (error) {
        const message = failed(error);
        for (const node of step.loop ? step.nodes : [step.node]) {
          this.#faults.set(
            node.id,
            message.state === 'error' ? message.message : 'Failed.',
          );
        }

        faulted = true;
      }
    }

    const readings = new Map<string, readonly Reading[]>();
    for (const [id, running] of this.#running) {
      const now = running.processor.readings?.();
      if (!now) {
        continue;
      }

      const json = JSON.stringify(now);
      if (json !== running.reported) {
        running.reported = json;
        readings.set(id, now);
      }
    }

    return {
      from,
      to,
      signals,
      readings,
      ...(faulted && this.#circuit
        ? { status: this.#plan(this.#circuit).status }
        : {}),
    };
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

      nodes.push({
        id: block.id,
        label: block.name || type.label,
        type,
        params: resolveParams(type.params, block.params),
        sources: sources.get(block.id) ?? [],
      });
    }

    return { nodes, unknown };
  }
}

export type SimulationResult = {
  /** Every working output over the whole run, by port key. */
  readonly signals: ReadonlyMap<string, Signal>;
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Final block measurements. */
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
};

/** Runs a circuit from zero for `seconds`, collecting complete output signals. */
export function simulate(
  lookup: BlockLookup,
  circuit: Circuit,
  seconds: number,
): SimulationResult {
  const stream = new Stream(lookup);
  let { status } = stream.load(circuit);
  const pieces = new Map<
    string,
    { readonly rate: number; readonly parts: Float32Array[] }
  >();
  const readings = new Map<string, readonly Reading[]>();
  stream.advance(seconds, (chunk) => {
    for (const [key, signal] of chunk.signals) {
      let entry = pieces.get(key);
      if (!entry) {
        pieces.set(key, (entry = { rate: signal.rate, parts: [] }));
      }

      entry.parts.push(signal.data.slice());
    }

    for (const [id, now] of chunk.readings) {
      readings.set(id, now);
    }

    status = chunk.status ?? status;
  });

  const signals = new Map<string, Signal>();
  for (const [key, { rate, parts }] of pieces) {
    const data = new Float32Array(
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    let at = 0;
    for (const part of parts) {
      data.set(part, at);
      at += part.length;
    }

    signals.set(key, { rate, data });
  }

  return { signals, status, readings };
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

/**
 * Orders non-delay members after their dependencies. Delay outputs are
 * available at the start of each span, so their outgoing edges impose no
 * ordering constraint. Returns undefined if a cycle without a delay remains.
 */
function orderWithinLoop(
  component: readonly Node[],
  isDelay: readonly boolean[],
  members: ReadonlyMap<string, number>,
): number[] | undefined {
  const pending = new Map<number, number>();
  const feeds = new Map<number, number[]>();
  component.forEach((node, k) => {
    if (isDelay[k]) {
      return;
    }

    let count = 0;
    for (const source of node.sources) {
      const from = source ? members.get(source.block) : undefined;
      if (from === undefined || isDelay[from]) {
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

function seedOf(node: Node): number {
  return hash(node.id) % 4294967296;
}

function idle(reason: string): BlockStatus {
  return { state: 'idle', reason };
}

function failure(message: string): BlockStatus {
  return { state: 'error', message };
}

function failed(error: unknown): BlockStatus {
  const message = errorMessage(error);
  return failure(
    EXPLAINED.has(errorName(error) ?? '')
      ? message
      : `Simulation error: ${message}`,
  );
}
