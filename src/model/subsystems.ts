// Subsystems: blocks that contain a diagram. Their ports come from the Input and Output
// terminals inside. Grouping turns a selection into a subsystem, rewiring whatever crossed the
// selection's edge through new terminals; ungrouping splices a subsystem's contents back out.

import { blockType } from '../blocks/index.ts';
import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockType } from '../engine/block.ts';
import { portKey, type PortRef, type Wire } from '../engine/circuit.ts';
import {
  idSource,
  isSubsystem,
  moveRefs,
  nextId,
  pathId,
  SUBSYSTEM,
  terminals,
  updateDiagramAt,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from './document.ts';

const subsystemTypes = new WeakMap<Diagram, BlockType>();

/**
 * A block's type: its registered type, or one made up from a subsystem's
 * terminals.
 */
export function typeOf(block: LabBlock): BlockType | undefined {
  if (!isSubsystem(block)) {
    return blockType(block.kind);
  }

  let type = subsystemTypes.get(block.inner);
  if (!type) {
    const { inputs, outputs } = terminals(block.inner);
    const named = (list: LabBlock[], fallback: string) =>
      list.map((t, i) => ({
        name: t.name || (list.length > 1 ? `${fallback} ${i + 1}` : fallback),
      }));
    type = {
      kind: SUBSYSTEM,
      label: 'Subsystem',
      category: 'Subsystems',
      description:
        'A diagram inside a block. Double-click it, or press Open, to see and edit what is inside; its inputs and outputs are the Input and Output terminals there.',
      inputs: named(inputs, 'in'),
      outputs: named(outputs, 'out'),
      params: {},
      create() {
        throw new Error('Subsystems are flattened before simulation.');
      },
    };
    subsystemTypes.set(block.inner, type);
  }

  return type;
}

/** The user's name for a block, or its type's label. */
export function displayName(block: LabBlock): string {
  return block.name || typeOf(block)?.label || block.kind;
}

const isTerminal = (block: LabBlock) =>
  block.kind === INPUT_TERMINAL || block.kind === OUTPUT_TERMINAL;

/**
 * Moves the blocks `ids` into a new subsystem in their place. Each outside
 * output feeding the selection gets an Input terminal, and each selected
 * output feeding the outside gets an Output terminal. Terminals themselves
 * stay where they are.
 */
function group<D extends Diagram>(
  diagram: D,
  ids: ReadonlySet<string>,
): { diagram: D; id: string } | undefined {
  const inside = diagram.blocks.filter(
    (block) => ids.has(block.id) && !isTerminal(block),
  );
  if (inside.length === 0) {
    return undefined;
  }

  const chosen = new Set(inside.map((block) => block.id));
  const internal = diagram.wires.filter(
    (w) => chosen.has(w.from.block) && chosen.has(w.to.block),
  );
  const incoming = diagram.wires.filter(
    (w) => !chosen.has(w.from.block) && chosen.has(w.to.block),
  );
  const outgoing = diagram.wires.filter(
    (w) => chosen.has(w.from.block) && !chosen.has(w.to.block),
  );
  const unique = (refs: PortRef[]) => [
    ...new Map(refs.map((ref) => [portKey(ref), ref])).values(),
  ];
  const sources = unique(incoming.map((w) => w.from));
  const exits = unique(outgoing.map((w) => w.from));

  const left = Math.min(...inside.map((b) => b.x));
  const right = Math.max(...inside.map((b) => b.x));
  const top = Math.min(...inside.map((b) => b.y));
  const inputIds = sources.map((_, k) => `in${k + 1}`);
  const outputIds = exits.map((_, j) => `out${j + 1}`);
  const innerBlocks: LabBlock[] = [
    ...inside,
    ...inputIds.map((id, k): LabBlock => ({
      id,
      kind: INPUT_TERMINAL,
      x: left - 160,
      y: top + 12 + 64 * k,
      params: {},
    })),
    ...outputIds.map((id, j): LabBlock => ({
      id,
      kind: OUTPUT_TERMINAL,
      x: right + 200,
      y: top + 12 + 64 * j,
      params: {},
    })),
  ];
  const innerId = idSource('w', internal);
  const innerWires: Wire[] = [
    ...internal,
    ...incoming.map((w) => ({
      id: innerId(),
      from: {
        block:
          inputIds[sources.findIndex((s) => portKey(s) === portKey(w.from))]!,
        port: 0,
      },
      to: w.to,
    })),
    ...exits.map((from, j) => ({
      id: innerId(),
      from,
      to: { block: outputIds[j]!, port: 0 },
    })),
  ];

  const id = nextId('b', diagram.blocks);
  const outerId = idSource('w', diagram.wires);
  const outerWires: Wire[] = [
    ...diagram.wires.filter(
      (w) => !chosen.has(w.from.block) && !chosen.has(w.to.block),
    ),
    ...sources.map((from, k) => ({
      id: outerId(),
      from,
      to: { block: id, port: k },
    })),
    ...outgoing.map((w) => ({
      id: outerId(),
      from: {
        block: id,
        port: exits.findIndex((e) => portKey(e) === portKey(w.from)),
      },
      to: w.to,
    })),
  ];
  const block: LabBlock = {
    id,
    kind: SUBSYSTEM,
    name: 'Subsystem',
    x: left,
    y: top,
    params: {},
    inner: { blocks: innerBlocks, wires: innerWires },
  };
  return {
    diagram: {
      ...diagram,
      blocks: [...diagram.blocks.filter((b) => !chosen.has(b.id)), block],
      wires: outerWires,
    },
    id,
  };
}

/**
 * Replaces a subsystem with its contents, placed where it stood. Wires that
 * ran through its terminals are joined up directly. Returns the new id of
 * every block that came out.
 */
function ungroup<D extends Diagram>(
  diagram: D,
  id: string,
): { diagram: D; renamed: ReadonlyMap<string, string> } | undefined {
  const block = diagram.blocks.find((b) => b.id === id);
  if (!block || !isSubsystem(block)) {
    return undefined;
  }

  const { inputs, outputs } = terminals(block.inner);
  const contents = block.inner.blocks.filter((b) => !isTerminal(b));
  const others = diagram.blocks.filter((b) => b.id !== id);

  const renamed = new Map<string, string>();
  const taken = [...others];
  for (const inner of contents) {
    const fresh = taken.some((b) => b.id === inner.id)
      ? nextId('b', taken)
      : inner.id;
    renamed.set(inner.id, fresh);
    taken.push({ ...inner, id: fresh });
  }

  const dx = contents.length
    ? block.x - Math.min(...contents.map((b) => b.x))
    : 0;
  const dy = contents.length
    ? block.y - Math.min(...contents.map((b) => b.y))
    : 0;
  const placed = contents.map((b) => ({
    ...b,
    id: renamed.get(b.id)!,
    x: b.x + dx,
    y: b.y + dy,
  }));

  const inputIndex = new Map(inputs.map((t, k) => [t.id, k]));
  const outputIndex = new Map(outputs.map((t, j) => [t.id, j]));
  const feeding = (port: number) =>
    diagram.wires
      .filter((w) => w.to.block === id && w.to.port === port)
      .map((w) => w.from);
  const fedBy = (port: number) =>
    diagram.wires
      .filter((w) => w.from.block === id && w.from.port === port)
      .map((w) => w.to);
  const outside = (ref: PortRef) => ({
    block: renamed.get(ref.block)!,
    port: ref.port,
  });

  const nextWire = idSource('w', diagram.wires);
  const joined: Wire[] = [];
  for (const wire of block.inner.wires) {
    const fromInput = inputIndex.get(wire.from.block);
    const toOutput = outputIndex.get(wire.to.block);
    // Every source a wire inside starts from, and every target it ends at, seen from outside.
    const froms =
      fromInput !== undefined
        ? feeding(fromInput)
        : renamed.has(wire.from.block)
          ? [outside(wire.from)]
          : [];
    const tos =
      toOutput !== undefined
        ? fedBy(toOutput)
        : renamed.has(wire.to.block)
          ? [outside(wire.to)]
          : [];
    for (const from of froms) {
      for (const to of tos) {
        joined.push({ id: nextWire(), from, to });
      }
    }
  }

  const wires = [
    ...diagram.wires.filter((w) => w.from.block !== id && w.to.block !== id),
    ...joined,
  ];
  return {
    diagram: { ...diagram, blocks: [...others, ...placed], wires },
    renamed,
  };
}

/**
 * Groups blocks of the diagram at `path`, keeping their face spots and what
 * instruments refer to.
 */
export function groupAt(
  doc: LabDocument,
  path: Path,
  ids: ReadonlySet<string>,
): { doc: LabDocument; id: string } | undefined {
  let made: string | undefined;
  let moved = new Set<string>();
  const next = updateDiagramAt(doc, path, (diagram) => {
    const result = group(diagram, ids);
    if (!result) {
      return diagram;
    }

    made = result.id;
    moved = new Set(
      diagram.blocks
        .filter((b) => !result.diagram.blocks.some((kept) => kept.id === b.id))
        .map((b) => b.id),
    );
    return result.diagram;
  });
  if (made === undefined) {
    return undefined;
  }

  const id = made;
  const prefix = path.length ? `${path.join('/')}/` : '';
  return {
    doc: moveRefs(doc, next, (full) => {
      const local = full.slice(prefix.length).split('/')[0]!;
      return full.startsWith(prefix) && moved.has(local)
        ? `${prefix}${id}/${full.slice(prefix.length)}`
        : full;
    }),
    id,
  };
}

/**
 * Ungroups a subsystem in the diagram at `path`, keeping the face spots and
 * instrument references of the blocks that came out.
 */
export function ungroupAt(
  doc: LabDocument,
  path: Path,
  id: string,
): LabDocument {
  let renamed: ReadonlyMap<string, string> | undefined;
  const next = updateDiagramAt(doc, path, (diagram) => {
    const result = ungroup(diagram, id);
    if (!result) {
      return diagram;
    }

    renamed = result.renamed;
    return result.diagram;
  });
  if (!renamed) {
    return doc;
  }

  const map = renamed;
  const inside = `${pathId(path, id)}/`;
  return moveRefs(doc, next, (full) => {
    if (full === pathId(path, id)) {
      return undefined;
    }

    if (!full.startsWith(inside)) {
      return full;
    }

    const [first, ...rest] = full.slice(inside.length).split('/');
    const fresh = map.get(first!);
    return fresh === undefined
      ? undefined
      : pathId(path, [fresh, ...rest].join('/'));
  });
}
