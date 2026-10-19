// Compiles a document into a flat simulation circuit. Subsystem blocks receive
// full path ids and connect through terminal ports. Antennas become transmit
// and receive halves connected by hidden Air blocks. Display-only instruments
// are excluded; Buttons remain as sources.

import { blockType } from '../blocks/index.ts';
import { isInstrument, isSimulated } from '../blocks/instruments.ts';
import { airType, ANTENNA, HEAR, RADIATE } from '../blocks/radio.ts';
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

/** Ids of the hidden blocks that carry what antennas radiate. */
const AIR = '@air';

/**
 * Full id of an antenna's transmit half. Its receive half retains the original
 * id.
 */
const radiating = (id: string) => `${id}@radiate`;

/** Resolved bindings and errors for the document. */
export type Bindings = {
  /** The value of each bound setting, by full block id. */
  readonly values: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /** Binding errors indexed by full block id. */
  readonly errors: ReadonlyMap<string, string>;
};

type Lookup = (name: string) => number | undefined;

/**
 * Resolves bindings through nested scopes. Local parameters shadow enclosing
 * declarations. A subsystem's bindings are evaluated in its parent scope and
 * override parameters inside it.
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
  /** Air block feeding each receiving antenna, when another antenna transmits. */
  readonly airs: ReadonlyMap<string, string | undefined>;
};

export function flatten(doc: LabDocument): Flattened {
  const bindings = resolveBindings(doc);
  const blocks: BlockNode[] = [];
  const wires: Wire[] = [];
  const aliases = new Map<string, string>();
  const radiates: string[] = [];
  const hears: string[] = [];

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

      if (block.kind === ANTENNA) {
        return { block: radiating(pathId(path, ref.block)), port: 0 };
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

      if (isInstrument(block.kind) && !isSimulated(block.kind)) {
        continue;
      }

      // Replace binding expressions with their evaluated numeric values.
      const bound = bindings.values.get(id);
      const params = bound ? { ...block.params, ...bound } : block.params;
      if (block.kind !== ANTENNA) {
        blocks.push({ id, kind: block.kind, x: 0, y: 0, params });
        continue;
      }

      // An antenna radiates if something is wired in, and hears if its output goes anywhere.
      if (diagram.wires.some((w) => w.to.block === block.id)) {
        radiates.push(id);
        blocks.push({ id: radiating(id), kind: RADIATE, x: 0, y: 0, params });
      }

      if (diagram.wires.some((w) => w.from.block === block.id)) {
        hears.push(id);
        blocks.push({ id, kind: HEAR, x: 0, y: 0, params });
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

  // Each antenna that hears gets the sum of what the others radiate. Antennas
  // that hear the same others share one Air block.
  const airs = new Map<string, string | undefined>();
  const byOthers = new Map<string, string>();
  for (const id of hears) {
    const others = radiates.filter((other) => other !== id);
    if (!others.length) {
      airs.set(id, undefined);
      continue;
    }

    const key = others.join('\n');
    let air = byOthers.get(key);
    if (!air) {
      const made = byOthers.size ? `${AIR}${byOthers.size + 1}` : AIR;
      byOthers.set(key, made);
      blocks.push({
        id: made,
        kind: airType(others.length).kind,
        x: 0,
        y: 0,
        params: {},
      });
      others.forEach((other, k) =>
        wires.push({
          id: `${made}:in${k}`,
          from: { block: radiating(other), port: 0 },
          to: { block: made, port: k },
        }),
      );
      air = made;
    }

    airs.set(id, air);
    wires.push({
      id: `${air}:to:${id}`,
      from: { block: air, port: 0 },
      to: { block: id, port: 0 },
    });
  }

  return {
    circuit: { blocks, wires },
    bindings,
    aliases,
    airs,
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
 * Builds document-level statuses from engine results. Subsystems expose
 * internal errors or output rates; antennas combine their transmit and receive
 * statuses and report when no other antenna is transmitting.
 */
export function blockStatuses(
  doc: LabDocument,
  flat: Flattened,
  engine: ReadonlyMap<string, BlockStatus>,
): Map<string, BlockStatus> {
  const statuses = new Map<string, BlockStatus>();

  const visit = (diagram: Diagram, path: Path): BlockStatus[] =>
    diagram.blocks.map((block) => {
      const id = pathId(path, block.id);
      let status: BlockStatus;
      const binding = flat.bindings.errors.get(id);
      if (binding) {
        status = { state: 'error', message: `Binding: ${binding}.` };
      } else if (isInstrument(block.kind) && !isSimulated(block.kind)) {
        // Display-only instruments do not require an engine processor.
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
      } else if (block.kind === ANTENNA) {
        status = antennaStatus(id, flat, engine);
      } else {
        status = engine.get(id) ?? { state: 'idle', reason: 'Not simulated.' };
      }

      statuses.set(id, status);
      return status;
    });

  visit(doc, []);
  return statuses;
}

/**
 * Combines antenna halves, preferring errors, then receive status, then
 * transmit status.
 */
function antennaStatus(
  id: string,
  flat: Flattened,
  engine: ReadonlyMap<string, BlockStatus>,
): BlockStatus {
  const radiate = engine.get(radiating(id));
  const hear = engine.get(id);
  const air = flat.airs.has(id) ? flat.airs.get(id) : null;
  const carried = air ? engine.get(air) : undefined;
  if (radiate?.state === 'error') {
    return radiate;
  }

  if (carried?.state === 'error') {
    return { state: 'error', message: `On the air: ${carried.message}` };
  }

  if (air === undefined) {
    return {
      state: 'idle',
      reason:
        'Nothing else is on the air. Wire a signal into another antenna for this one to hear.',
    };
  }

  return (
    hear ??
    (radiate?.state === 'ok'
      ? { state: 'ok', rates: [] }
      : (radiate ?? { state: 'idle', reason: 'Not connected.' }))
  );
}
