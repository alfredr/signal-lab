// Subsystems: blocks that contain a diagram. Their ports come from the Input and Output
// terminals inside. Grouping turns a selection into a subsystem, rewiring whatever crossed the
// selection's edge through new terminals; ungrouping splices a subsystem's contents back out.

import { blockType } from '../blocks/index.ts';
import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockType } from '../engine/block.ts';
import { portKey, type PortRef, type Wire } from '../engine/circuit.ts';
import {
  diagramAt,
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
  type Parameter,
  type Path,
} from './document.ts';
import { declaredWithin, freeNames, freshName, renameUses } from './scopes.ts';

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

export const isTerminal = (block: LabBlock) =>
  block.kind === INPUT_TERMINAL || block.kind === OUTPUT_TERMINAL;

/** A block outside a subsystem that one of its terminals is wired to. */
export type Outside = {
  /** The block's full id. */
  readonly id: string;
  /** Its name, and the port's when it has several. */
  readonly label: string;
};

/**
 * What `terminal`, inside the subsystem at `path`, is wired to outside: the
 * block at the far end of each wire, followed on out through the terminals of
 * any subsystems around it. Each copy of a subsystem is wired on its own, so
 * this is for the copy that `path` leads to.
 */
export function wiredOutside(
  doc: LabDocument,
  path: Path,
  terminal: LabBlock,
): Outside[] {
  const around = path.slice(0, -1);
  const id = path[path.length - 1];
  const parent = diagramAt(doc, around);
  const holder = parent?.blocks.find((b) => b.id === id);
  if (!parent || !holder || !isSubsystem(holder)) {
    return [];
  }

  const input = terminal.kind === INPUT_TERMINAL;
  const { inputs, outputs } = terminals(holder.inner);
  const port = (input ? inputs : outputs).findIndex(
    (t) => t.id === terminal.id,
  );
  const ends = parent.wires.flatMap((wire) => {
    const [near, far] = input ? [wire.to, wire.from] : [wire.from, wire.to];
    return near.block === id && near.port === port ? [far] : [];
  });
  return ends.flatMap((end) => {
    const block = parent.blocks.find((b) => b.id === end.block);
    if (!block) {
      return [];
    }

    if (around.length && isTerminal(block)) {
      return wiredOutside(doc, around, block);
    }

    const type = typeOf(block);
    const ports = (input ? type?.outputs : type?.inputs) ?? [];
    const name = displayName(block);
    return [
      {
        id: pathId(around, block.id),
        label:
          ports.filter((p) => !p.hidden).length > 1
            ? `${name} › ${ports[end.port]?.name ?? end.port + 1}`
            : name,
      },
    ];
  });
}

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
 * ran through its terminals are joined up directly, around any loop through it
 * too. Returns the new id of every block that came out. `visible` holds the
 * parameter names declared in the diagrams around this one.
 */
function ungroup<D extends Diagram>(
  diagram: D,
  id: string,
  visible: ReadonlySet<string> = new Set(),
):
  | {
      diagram: D;
      renamed: ReadonlyMap<string, string>;
      /** The new name of each parameter that came out. */
      parameters: ReadonlyMap<string, string>;
    }
  | undefined {
  const block = diagram.blocks.find((b) => b.id === id);
  if (!block || !isSubsystem(block)) {
    return undefined;
  }

  // The subsystem's parameters come out with it, each name still meaning what
  // it meant. One bound outside gives way to its expression, which means the
  // same out here; a subsystem further in that used it gets a parameter of
  // its own, bound to that expression from out here. The others join this
  // diagram's, under a new name where theirs would hide a name in use here,
  // or a name further in would hide theirs.
  const bound = block.bindings ?? {};
  const avoid = new Set([
    ...visible,
    ...(diagram.parameters ?? []).map((p) => p.name),
    ...freeNames({ ...diagram, parameters: [] }),
    ...block.inner.blocks.flatMap((b) =>
      b.inner ? [...declaredWithin(b.inner)] : [],
    ),
  ]);
  const renames = new Map<string, string>();
  const kept = new Map<string, string>();
  const moved: Parameter[] = [];
  const handed: { readonly parameter: Parameter; expression: string }[] = [];
  for (const parameter of block.inner.parameters ?? []) {
    const expression = bound[parameter.name];
    if (expression !== undefined) {
      renames.set(parameter.name, `(${expression})`);
      handed.push({ parameter, expression });
      continue;
    }

    const name = freshName(parameter.name, avoid);
    avoid.add(name);
    moved.push({ ...parameter, name });
    renames.set(parameter.name, name);
    kept.set(parameter.name, name);
  }

  // Subsystems further in that use a bound parameter declare it themselves,
  // so the expression stops at their edge.
  const handedTo = new Map<string, typeof handed>();
  const prepared = block.inner.blocks.map((b) => {
    if (!b.inner) {
      return b;
    }

    const free = freeNames(b.inner);
    const theirs = handed.filter(({ parameter }) => free.has(parameter.name));
    if (!theirs.length) {
      return b;
    }

    handedTo.set(b.id, theirs);
    return {
      ...b,
      inner: {
        ...b.inner,
        parameters: [
          ...(b.inner.parameters ?? []),
          ...theirs.map(({ parameter }) => parameter),
        ],
      },
    };
  });
  const inner = {
    ...renameUses(
      { ...block.inner, blocks: prepared, parameters: [] },
      renames,
    ),
  };
  inner.blocks = inner.blocks.map((b) => {
    const theirs = handedTo.get(b.id);
    return theirs
      ? {
          ...b,
          bindings: {
            ...b.bindings,
            ...Object.fromEntries(
              theirs.map(({ parameter, expression }) => [
                parameter.name,
                expression,
              ]),
            ),
          },
        }
      : b;
  });

  const { inputs, outputs } = terminals(inner);
  const contents = inner.blocks.filter((b) => !isTerminal(b));
  const others = diagram.blocks.filter((b) => b.id !== id);

  const renamed = new Map<string, string>();
  const taken = [...others];
  for (const each of contents) {
    const fresh = taken.some((b) => b.id === each.id)
      ? nextId('b', taken)
      : each.id;
    renamed.set(each.id, fresh);
    taken.push({ ...each, id: fresh });
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
  const outside = (ref: PortRef) => ({
    block: renamed.get(ref.block)!,
    port: ref.port,
  });

  // What feeds input `k` once the subsystem is gone. A wire from one of its
  // own outputs, around a loop, comes from whatever fed that output inside.
  const sourcesOf = (k: number, seen: ReadonlySet<number>): PortRef[] =>
    seen.has(k)
      ? []
      : diagram.wires
          .filter((w) => w.to.block === id && w.to.port === k)
          .flatMap((w) =>
            w.from.block !== id
              ? [w.from]
              : inner.wires
                  .filter((v) => outputIndex.get(v.to.block) === w.from.port)
                  .flatMap((v) => {
                    const through = inputIndex.get(v.from.block);
                    return through === undefined
                      ? [outside(v.from)]
                      : sourcesOf(through, new Set([...seen, k]));
                  }),
          );
  // What output `j` feeds outside. Wires back into the subsystem itself are
  // made from the input side.
  const targetsOf = (j: number): PortRef[] =>
    diagram.wires
      .filter(
        (w) => w.from.block === id && w.from.port === j && w.to.block !== id,
      )
      .map((w) => w.to);

  const nextWire = idSource('w', diagram.wires);
  const joined: Wire[] = [];
  const made = new Set<string>();
  for (const wire of inner.wires) {
    const fromInput = inputIndex.get(wire.from.block);
    const toOutput = outputIndex.get(wire.to.block);
    // Every source a wire inside starts from, and every target it ends at, seen from outside.
    const froms =
      fromInput !== undefined
        ? sourcesOf(fromInput, new Set())
        : renamed.has(wire.from.block)
          ? [outside(wire.from)]
          : [];
    const tos =
      toOutput !== undefined
        ? targetsOf(toOutput)
        : renamed.has(wire.to.block)
          ? [outside(wire.to)]
          : [];
    for (const from of froms) {
      for (const to of tos) {
        const key = `${portKey(from)}>${portKey(to)}`;
        if (!made.has(key)) {
          made.add(key);
          joined.push({ id: nextWire(), from, to });
        }
      }
    }
  }

  const wires = [
    ...diagram.wires.filter((w) => w.from.block !== id && w.to.block !== id),
    ...joined,
  ];
  const parameters = [...(diagram.parameters ?? []), ...moved];
  return {
    diagram: {
      ...diagram,
      blocks: [...others, ...placed],
      wires,
      ...(parameters.length ? { parameters } : {}),
    },
    renamed,
    parameters: kept,
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
  let parameters: ReadonlyMap<string, string> = new Map();
  // The names declared around the diagram it is in.
  const visible = new Set(
    path.flatMap(
      (_, depth) =>
        diagramAt(doc, path.slice(0, depth))?.parameters?.map((p) => p.name) ??
        [],
    ),
  );
  const next = updateDiagramAt(doc, path, (diagram) => {
    const result = ungroup(diagram, id, visible);
    if (!result) {
      return diagram;
    }

    renamed = result.renamed;
    parameters = result.parameters;
    return result.diagram;
  });
  if (!renamed) {
    return doc;
  }

  const map = renamed;
  const holder = pathId(path, id);
  const inside = `${holder}/`;
  return moveRefs(
    doc,
    next,
    (full) => {
      if (full === holder) {
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
    },
    // Its own parameters join the diagram it was in, but those bound from
    // there are gone, and what set them has nothing left to set.
    (was, followed) => {
      if (was.scope.join('/') !== holder) {
        return followed;
      }

      const name = parameters.get(was.parameter);
      return name === undefined ? undefined : { scope: path, parameter: name };
    },
  );
}
