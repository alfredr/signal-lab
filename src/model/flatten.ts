// Turning a document into the flat circuit the simulator runs. Subsystems dissolve: their blocks
// join the circuit under path ids ("rx/diode"), and each terminal's hidden port is wired to
// whatever connects to the subsystem outside. Antennas are joined through a hidden Air block.
// The engine never sees hierarchy, so caching and loops work across subsystem boundaries.
// Instruments only watch or set things, so they and the wires into them are left out.

import { blockType } from '../blocks/index.ts';
import { isInstrument } from '../blocks/instruments.ts';
import { airType } from '../blocks/radio.ts';
import {
  portKey,
  type BlockNode,
  type Circuit,
  type PortRef,
  type Wire,
} from '../engine/circuit.ts';
import type { Signal } from '../engine/signal.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  isSubsystem,
  pathId,
  terminals,
  type Diagram,
  type LabDocument,
  type Path,
} from './document.ts';
import { evaluate } from './expressions.ts';
import { displayName } from './subsystems.ts';

/** Id of the hidden block that carries everything transmitted. */
const AIR = '@air';
const TRANSMIT = 'antenna-tx';
const RECEIVE = 'antenna-rx';

/** Every binding in a document, worked out against the parameters in scope. */
export type Bindings = {
  /** The value of each bound setting, by full block id. */
  readonly values: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /** Why a block's bindings couldn't all be worked out, by full block id. */
  readonly errors: ReadonlyMap<string, string>;
};

type Lookup = (name: string) => number | undefined;

/**
 * Resolves bindings scope by scope. A block sees the parameters of its own
 * diagram, then of each diagram around it. A subsystem's bindings set the
 * parameters inside it, and are worked out where the subsystem sits.
 */
export function resolveBindings(doc: LabDocument): Bindings {
  const values = new Map<string, Readonly<Record<string, number>>>();
  const errors = new Map<string, string>();

  const visit = (
    diagram: Diagram,
    path: Path,
    outer: Lookup,
    overrides: ReadonlyMap<string, number>,
  ): void => {
    const own = new Map(
      (diagram.parameters ?? []).map((p) => [
        p.name,
        overrides.get(p.name) ?? p.value,
      ]),
    );
    const lookup: Lookup = (name) => own.get(name) ?? outer(name);
    for (const block of diagram.blocks) {
      const id = pathId(path, block.id);
      const settings = isSubsystem(block)
        ? new Set((block.inner.parameters ?? []).map((p) => p.name))
        : new Set(
            Object.entries(blockType(block.kind)?.params ?? {})
              .filter(([, spec]) => spec.type === 'number')
              .map(([name]) => name),
          );
      const resolved: Record<string, number> = {};
      const problems: string[] = [];
      for (const [setting, expression] of Object.entries(
        block.bindings ?? {},
      )) {
        if (!settings.has(setting)) {
          problems.push(`there is no number setting "${setting}" to bind`);
          continue;
        }

        const result = evaluate(expression, lookup);
        if (result.ok) {
          resolved[setting] = result.value;
        } else {
          problems.push(`${setting} = ${expression}: ${result.error}`);
        }
      }

      if (Object.keys(resolved).length) {
        values.set(id, resolved);
      }

      if (problems.length) {
        errors.set(id, problems.join('; '));
      }

      if (isSubsystem(block)) {
        visit(
          block.inner,
          [...path, block.id],
          lookup,
          new Map(Object.entries(resolved)),
        );
      }
    }
  };

  visit(doc, [], () => undefined, new Map());
  return { values, errors };
}

export type Flattened = {
  readonly circuit: Circuit;
  readonly bindings: Bindings;
  /** For each subsystem output port, the engine port that carries its signal. */
  readonly aliases: ReadonlyMap<string, string>;
  readonly transmitters: number;
};

export function flatten(doc: LabDocument): Flattened {
  const bindings = resolveBindings(doc);
  const blocks: BlockNode[] = [];
  const wires: Wire[] = [];
  const aliases = new Map<string, string>();
  const transmit: string[] = [];
  const receive: string[] = [];

  const walk = (diagram: Diagram, path: Path): void => {
    const byId = new Map(diagram.blocks.map((block) => [block.id, block]));
    // A subsystem's ports resolve to its terminals, whose hidden port 0 faces outward.
    const source = (ref: PortRef): PortRef | undefined => {
      const block = byId.get(ref.block);
      if (!block) {
        return undefined;
      }

      if (!isSubsystem(block)) {
        return { block: pathId(path, ref.block), port: ref.port };
      }

      const terminal = terminals(block.inner).outputs[ref.port];
      return (
        terminal && {
          block: pathId([...path, block.id], terminal.id),
          port: 0,
        }
      );
    };

    const target = (ref: PortRef): PortRef | undefined => {
      const block = byId.get(ref.block);
      if (!block || isInstrument(block.kind)) {
        return undefined;
      }

      if (!isSubsystem(block)) {
        return { block: pathId(path, ref.block), port: ref.port };
      }

      const terminal = terminals(block.inner).inputs[ref.port];
      return (
        terminal && {
          block: pathId([...path, block.id], terminal.id),
          port: 0,
        }
      );
    };

    for (const block of diagram.blocks) {
      const id = pathId(path, block.id);
      if (isSubsystem(block)) {
        walk(block.inner, [...path, block.id]);
        terminals(block.inner).outputs.forEach((terminal, port) =>
          aliases.set(
            portKey({ block: id, port }),
            portKey({
              block: pathId([...path, block.id], terminal.id),
              port: 0,
            }),
          ),
        );
        continue;
      }

      if (isInstrument(block.kind)) {
        continue;
      }

      // Bound settings take their worked-out values; the engine sees plain numbers.
      const bound = bindings.values.get(id);
      const params = bound ? { ...block.params, ...bound } : block.params;
      blocks.push({ id, kind: block.kind, x: 0, y: 0, params });

      if (block.kind === TRANSMIT) {
        transmit.push(id);
      }

      if (block.kind === RECEIVE) {
        receive.push(id);
      }
    }

    for (const wire of diagram.wires) {
      const from = source(wire.from);
      const to = target(wire.to);
      if (from && to) {
        wires.push({ id: `${pathId(path, wire.id)}`, from, to });
      }
    }
  };

  walk(doc, []);

  if (transmit.length) {
    blocks.push({
      id: AIR,
      kind: airType(transmit.length).kind,
      x: 0,
      y: 0,
      params: {},
    });
    transmit.forEach((id, k) =>
      wires.push({
        id: `${AIR}:in${k}`,
        from: { block: id, port: 0 },
        to: { block: AIR, port: k },
      }),
    );
    receive.forEach((id, k) =>
      wires.push({
        id: `${AIR}:out${k}`,
        from: { block: AIR, port: 0 },
        to: { block: id, port: 0 },
      }),
    );
  }

  return {
    circuit: { duration: doc.duration, blocks, wires },
    bindings,
    aliases,
    transmitters: transmit.length,
  };
}

/**
 * Signals by port key for every block at every level, subsystem outputs
 * included.
 */
export function signalsWithAliases(
  signals: ReadonlyMap<string, Signal>,
  aliases: ReadonlyMap<string, string>,
): Map<string, Signal> {
  const all = new Map(signals);
  for (const [key, engineKey] of aliases) {
    const signal = signals.get(engineKey);
    if (signal) {
      all.set(key, signal);
    }
  }

  return all;
}

/**
 * Status for every block in the document by full id. A subsystem reports the
 * first error inside it, or the rates of its outputs; a receive antenna
 * explains when nothing is on the air.
 */
export function blockStatuses(
  doc: LabDocument,
  flat: Flattened,
  engine: ReadonlyMap<string, BlockStatus>,
): Map<string, BlockStatus> {
  const statuses = new Map<string, BlockStatus>();
  const air = engine.get(AIR);

  const visit = (diagram: Diagram, path: Path): BlockStatus[] =>
    diagram.blocks.map((block) => {
      const id = pathId(path, block.id);
      let status: BlockStatus;
      const binding = flat.bindings.errors.get(id);
      if (binding) {
        status = { state: 'error', message: `Binding: ${binding}.` };
      } else if (isInstrument(block.kind)) {
        // Instruments aren't simulated; they work whenever the page does.
        status = { state: 'ok', rates: [] };
      } else if (isSubsystem(block)) {
        const inner = visit(block.inner, [...path, block.id]);
        const failing = inner.findIndex((s) => s.state === 'error');
        if (failing >= 0) {
          const culprit = block.inner.blocks[failing]!;
          const problem = inner[failing] as Extract<
            BlockStatus,
            { state: 'error' }
          >;
          status = {
            state: 'error',
            message: `Inside, ${displayName(culprit)}: ${problem.message}`,
          };
        } else {
          const rates = terminals(block.inner).outputs.map((t) => {
            const s = engine.get(pathId([...path, block.id], t.id));
            return s?.state === 'ok' ? (s.rates[0] ?? NaN) : NaN;
          });
          const running = inner.some((s) => s.state === 'ok');
          status = running
            ? { state: 'ok', rates }
            : { state: 'idle', reason: 'Nothing inside is running.' };
        }
      } else if (block.kind === RECEIVE && flat.transmitters === 0) {
        status = {
          state: 'idle',
          reason: 'Nothing is on the air. Add a Transmit antenna.',
        };
      } else if (block.kind === RECEIVE && air?.state === 'error') {
        status = { state: 'error', message: `On the air: ${air.message}` };
      } else {
        status = engine.get(id) ?? { state: 'idle', reason: 'Not simulated.' };
      }

      statuses.set(id, status);
      return status;
    });

  visit(doc, []);
  return statuses;
}
