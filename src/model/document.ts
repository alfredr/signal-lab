// The lab document: a diagram, possibly containing subsystems, plus title, notes, duration and
// probes. Documents are immutable; every edit returns a new one, which keeps undo trivial.

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockNode, PortRef, Wire } from '../engine/circuit.ts';
import type { ParamValue, StoredParams } from '../engine/params.ts';

export const FORMAT = 'signal-lab/2';
export const SUBSYSTEM = 'subsystem';

/** A block on a diagram. A subsystem block carries a diagram of its own. */
export type LabBlock = BlockNode & {
  readonly inner?: Diagram;
};

export type Diagram = {
  readonly blocks: readonly LabBlock[];
  readonly wires: readonly Wire[];
};

export type ProbeView = 'time' | 'spectrum';

/**
 * A signal pinned to the bench. Its block is a path through subsystems, such
 * as "rx/diode".
 */
export type Probe = {
  readonly id: string;
  readonly at: PortRef;
  readonly view: ProbeView;
};

export type LabDocument = Diagram & {
  readonly format: typeof FORMAT;
  readonly title: string;
  readonly notes: string;
  /** Simulation window in seconds. */
  readonly duration: number;
  readonly probes: readonly Probe[];
};

/** Subsystem ids leading from the top-level diagram down to one inside it. */
export type Path = readonly string[];

/**
 * A block's id from the top of the document: the path and its own id joined
 * with "/".
 */
export function pathId(path: Path, id: string): string {
  return [...path, id].join('/');
}

export function isSubsystem(
  block: LabBlock,
): block is LabBlock & { readonly inner: Diagram } {
  return block.kind === SUBSYSTEM && block.inner !== undefined;
}

/** A subsystem's terminals, in the order that numbers its ports. */
export function terminals(inner: Diagram): {
  inputs: LabBlock[];
  outputs: LabBlock[];
} {
  return {
    inputs: inner.blocks.filter((block) => block.kind === INPUT_TERMINAL),
    outputs: inner.blocks.filter((block) => block.kind === OUTPUT_TERMINAL),
  };
}

export function emptyDocument(): LabDocument {
  return {
    format: FORMAT,
    title: 'Untitled',
    notes: '',
    duration: 1,
    blocks: [],
    wires: [],
    probes: [],
  };
}

export function sameRef(a: PortRef, b: PortRef): boolean {
  return a.block === b.block && a.port === b.port;
}

export function nextId(
  prefix: string,
  items: readonly { readonly id: string }[],
): string {
  let highest = 0;
  for (const { id } of items) {
    if (id.startsWith(prefix)) {
      highest = Math.max(highest, Number(id.slice(prefix.length)) || 0);
    }
  }

  return `${prefix}${highest + 1}`;
}

/**
 * Hands out ids with `prefix` that don't collide with `existing` or with each
 * other.
 */
export function idSource(
  prefix: string,
  existing: readonly { readonly id: string }[],
): () => string {
  let next = Number(nextId(prefix, existing).slice(prefix.length));
  return () => `${prefix}${next++}`;
}

// Navigating and editing nested diagrams.

export function diagramAt(doc: LabDocument, path: Path): Diagram | undefined {
  let diagram: Diagram = doc;
  for (const id of path) {
    const block = diagram.blocks.find((b) => b.id === id);
    if (!block || !isSubsystem(block)) {
      return undefined;
    }

    diagram = block.inner;
  }

  return diagram;
}

/** The block with a full id ("a/b/c"), if it exists. */
export function blockAt(
  doc: LabDocument,
  fullId: string,
): LabBlock | undefined {
  const parts = fullId.split('/');
  return diagramAt(doc, parts.slice(0, -1))?.blocks.find(
    (b) => b.id === parts[parts.length - 1],
  );
}

/**
 * Where each old port of a subsystem went after its inside changed: terminals
 * are matched by id, so adding or removing one renumbers the others rather
 * than shifting outside wires onto the wrong port.
 */
function portMoves(
  before: readonly LabBlock[],
  after: readonly LabBlock[],
): (port: number) => number | undefined {
  const index = new Map(after.map((terminal, i) => [terminal.id, i]));
  return (port) => {
    const id = before[port]?.id;
    return id === undefined ? undefined : index.get(id);
  };
}

function updateInner<D extends Diagram>(
  diagram: D,
  id: string,
  change: (inner: Diagram) => Diagram,
): D {
  const block = diagram.blocks.find((b) => b.id === id);
  if (!block || !isSubsystem(block)) {
    return diagram;
  }

  const after = change(block.inner);
  if (after === block.inner) {
    return diagram;
  }

  const old = terminals(block.inner);
  const now = terminals(after);
  const moveIn = portMoves(old.inputs, now.inputs);
  const moveOut = portMoves(old.outputs, now.outputs);
  const wires: Wire[] = [];
  for (const wire of diagram.wires) {
    const to = wire.to.block === id ? moveIn(wire.to.port) : wire.to.port;
    const from =
      wire.from.block === id ? moveOut(wire.from.port) : wire.from.port;
    if (to === undefined || from === undefined) {
      continue;
    }

    wires.push(
      to === wire.to.port && from === wire.from.port
        ? wire
        : {
            ...wire,
            from: { ...wire.from, port: from },
            to: { ...wire.to, port: to },
          },
    );
  }

  return {
    ...diagram,
    blocks: diagram.blocks.map((b) =>
      b.id === id ? { ...b, inner: after } : b,
    ),
    wires,
  };
}

/**
 * Applies `change` to the diagram at `path`, keeping every enclosing
 * subsystem's wiring consistent.
 */
export function updateDiagramAt<D extends Diagram>(
  root: D,
  path: Path,
  change: <T extends Diagram>(diagram: T) => T,
): D {
  if (path.length === 0) {
    return change(root);
  }

  const [head, ...rest] = path;
  return updateInner(root, head!, (inner) =>
    updateDiagramAt(inner, rest, change),
  );
}

// Edits to one diagram. Each works on any diagram, the document's top level included.

export function addBlock<D extends Diagram>(
  diagram: D,
  kind: string,
  x: number,
  y: number,
  extra: {
    readonly params?: StoredParams;
    readonly name?: string;
    readonly inner?: Diagram;
  } = {},
): [D, string] {
  const id = nextId('b', diagram.blocks);
  const block: LabBlock = {
    id,
    kind,
    x,
    y,
    params: extra.params ?? {},
    ...(extra.name ? { name: extra.name } : {}),
    ...(extra.inner ? { inner: extra.inner } : {}),
  };
  return [{ ...diagram, blocks: [...diagram.blocks, block] }, id];
}

function updateBlock<D extends Diagram>(
  diagram: D,
  id: string,
  change: (block: LabBlock) => LabBlock,
): D {
  return {
    ...diagram,
    blocks: diagram.blocks.map((block) =>
      block.id === id ? change(block) : block,
    ),
  };
}

export function moveBlocks<D extends Diagram>(
  diagram: D,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): D {
  return {
    ...diagram,
    blocks: diagram.blocks.map((b) =>
      ids.has(b.id) ? { ...b, x: b.x + dx, y: b.y + dy } : b,
    ),
  };
}

export function removeBlocks<D extends Diagram>(
  diagram: D,
  ids: ReadonlySet<string>,
): D {
  return {
    ...diagram,
    blocks: diagram.blocks.filter((block) => !ids.has(block.id)),
    wires: diagram.wires.filter(
      (wire) => !ids.has(wire.from.block) && !ids.has(wire.to.block),
    ),
  };
}

/**
 * Copies the blocks `ids`, and the wires among them, offset by (dx, dy) with
 * fresh ids. Returns the copies' ids. A subsystem's inside is shared, which is
 * safe because documents are never changed in place.
 */
export function duplicate<D extends Diagram>(
  diagram: D,
  ids: ReadonlySet<string>,
  dx = 24,
  dy = 24,
): [D, string[]] {
  const chosen = diagram.blocks.filter((block) => ids.has(block.id));
  const blockId = idSource('b', diagram.blocks);
  const wireId = idSource('w', diagram.wires);
  const renamed = new Map(chosen.map((block) => [block.id, blockId()]));
  const copies = chosen.map((block) => ({
    ...block,
    id: renamed.get(block.id)!,
    x: block.x + dx,
    y: block.y + dy,
  }));
  const wires = diagram.wires
    .filter(
      (wire) => renamed.has(wire.from.block) && renamed.has(wire.to.block),
    )
    .map((wire) => ({
      id: wireId(),
      from: { block: renamed.get(wire.from.block)!, port: wire.from.port },
      to: { block: renamed.get(wire.to.block)!, port: wire.to.port },
    }));
  return [
    {
      ...diagram,
      blocks: [...diagram.blocks, ...copies],
      wires: [...diagram.wires, ...wires],
    },
    copies.map((copy) => copy.id),
  ];
}

export function setParam<D extends Diagram>(
  diagram: D,
  id: string,
  name: string,
  value: ParamValue,
): D {
  return updateBlock(diagram, id, (block) => ({
    ...block,
    params: { ...block.params, [name]: value },
  }));
}

export function renameBlock<D extends Diagram>(
  diagram: D,
  id: string,
  name: string,
): D {
  return updateBlock(diagram, id, ({ name: _, ...block }) =>
    name.trim() ? { ...block, name: name.trim() } : block,
  );
}

export function wireInto(diagram: Diagram, to: PortRef): Wire | undefined {
  return diagram.wires.find((wire) => sameRef(wire.to, to));
}

/** Connects an output to an input, replacing whatever fed that input before. */
export function connect<D extends Diagram>(
  diagram: D,
  from: PortRef,
  to: PortRef,
): D {
  const existing = wireInto(diagram, to);
  if (existing && sameRef(existing.from, from)) {
    return diagram;
  }

  const wires = diagram.wires.filter((wire) => wire !== existing);
  return {
    ...diagram,
    wires: [...wires, { id: nextId('w', diagram.wires), from, to }],
  };
}

export function removeWire<D extends Diagram>(diagram: D, id: string): D {
  return { ...diagram, wires: diagram.wires.filter((wire) => wire.id !== id) };
}

// Probes.

export function probeAt(doc: LabDocument, at: PortRef): Probe | undefined {
  return doc.probes.find((probe) => sameRef(probe.at, at));
}

export function addProbe(
  doc: LabDocument,
  at: PortRef,
  view: ProbeView = 'time',
): LabDocument {
  if (probeAt(doc, at)) {
    return doc;
  }

  return {
    ...doc,
    probes: [...doc.probes, { id: nextId('p', doc.probes), at, view }],
  };
}

/** Pins the port to the bench, or unpins it if it already is. */
export function toggleProbe(doc: LabDocument, at: PortRef): LabDocument {
  const probe = probeAt(doc, at);
  return probe ? removeProbe(doc, probe.id) : addProbe(doc, at);
}

export function removeProbe(doc: LabDocument, id: string): LabDocument {
  return { ...doc, probes: doc.probes.filter((probe) => probe.id !== id) };
}

export function setProbeView(
  doc: LabDocument,
  id: string,
  view: ProbeView,
): LabDocument {
  return {
    ...doc,
    probes: doc.probes.map((probe) =>
      probe.id === id ? { ...probe, view } : probe,
    ),
  };
}

/**
 * Points probes at blocks that moved: `rename` maps an old full block id to
 * its new one.
 */
export function moveProbes(
  doc: LabDocument,
  rename: (fullId: string) => string | undefined,
): LabDocument {
  const probes = doc.probes.flatMap((probe) => {
    const block = rename(probe.at.block);
    if (block === undefined) {
      return [];
    }

    return [
      block === probe.at.block
        ? probe
        : { ...probe, at: { ...probe.at, block } },
    ];
  });
  return { ...doc, probes };
}

/**
 * Drops probes whose block no longer exists; returns the same document if none
 * do.
 */
export function pruneProbes(doc: LabDocument): LabDocument {
  const probes = doc.probes.filter((probe) => blockAt(doc, probe.at.block));
  return probes.length === doc.probes.length ? doc : { ...doc, probes };
}

export function setSettings(
  doc: LabDocument,
  change: Partial<Pick<LabDocument, 'title' | 'notes' | 'duration'>>,
): LabDocument {
  return { ...doc, ...change };
}

// Reading documents back from storage or a file, trusting nothing about their shape.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string =>
  typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function readRef(value: unknown): PortRef | undefined {
  if (!isRecord(value) || !isString(value.block) || !isNumber(value.port)) {
    return undefined;
  }

  return { block: value.block, port: Math.trunc(value.port) };
}

function readParams(value: unknown): StoredParams {
  if (!isRecord(value)) {
    return {};
  }

  const params: Record<string, ParamValue> = {};
  for (const [name, v] of Object.entries(value)) {
    if (isString(v) || isNumber(v) || typeof v === 'boolean') {
      params[name] = v;
    }
  }

  return params;
}

function readDiagram(value: Record<string, unknown>, depth: number): Diagram {
  const blocks: LabBlock[] = [];
  for (const b of Array.isArray(value.blocks) ? value.blocks : []) {
    if (
      !isRecord(b) ||
      !isString(b.id) ||
      b.id.includes('/') ||
      !isString(b.kind) ||
      !isNumber(b.x) ||
      !isNumber(b.y)
    ) {
      continue;
    }

    const inner =
      b.kind === SUBSYSTEM && isRecord(b.inner) && depth < 16
        ? readDiagram(b.inner, depth + 1)
        : undefined;
    if (b.kind === SUBSYSTEM && !inner) {
      continue;
    }

    blocks.push({
      id: b.id,
      kind: b.kind,
      x: b.x,
      y: b.y,
      params: readParams(b.params),
      ...(isString(b.name) && b.name ? { name: b.name } : {}),
      ...(inner ? { inner } : {}),
    });
  }

  const ids = new Set(blocks.map((block) => block.id));
  const wires: Wire[] = [];
  for (const w of Array.isArray(value.wires) ? value.wires : []) {
    if (!isRecord(w) || !isString(w.id)) {
      continue;
    }

    const from = readRef(w.from);
    const to = readRef(w.to);
    if (from && to && ids.has(from.block) && ids.has(to.block)) {
      wires.push({ id: w.id, from, to });
    }
  }

  return { blocks, wires };
}

/**
 * Validates a parsed JSON value as a document. Throws with a readable message
 * if it isn't one.
 */
export function readDocument(value: unknown): LabDocument {
  if (!isRecord(value) || value.format !== FORMAT) {
    throw new Error("This file isn't a Signal Lab diagram.");
  }

  const probes: Probe[] = [];
  for (const p of Array.isArray(value.probes) ? value.probes : []) {
    if (!isRecord(p) || !isString(p.id)) {
      continue;
    }

    const at = readRef(p.at);
    if (at) {
      probes.push({
        id: p.id,
        at,
        view: p.view === 'spectrum' ? 'spectrum' : 'time',
      });
    }
  }

  const doc: LabDocument = {
    format: FORMAT,
    title: isString(value.title) ? value.title : 'Untitled',
    notes: isString(value.notes) ? value.notes : '',
    duration:
      isNumber(value.duration) && value.duration > 0 ? value.duration : 1,
    ...readDiagram(value, 0),
    probes,
  };
  return {
    ...doc,
    probes: probes.filter((probe) => blockAt(doc, probe.at.block)),
  };
}
