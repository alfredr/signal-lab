// The lab document: a diagram, possibly containing subsystems, plus title, notes, duration
// and the layout of its panel face. Documents are immutable; every edit returns a new one, which keeps undo trivial.

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockNode, PortRef, Wire } from '../engine/circuit.ts';
import type { ParamValue, StoredParams, Unit } from '../engine/params.ts';
import { isParameterName } from './expressions.ts';

// Instrument kinds, as in blocks/instruments.ts, which the model can't import
// without pulling in the block library.
const PLOT_KIND = 'plot';
const CONTROL_KIND = 'control';
const READOUT_KIND = 'readout';

export const FORMAT = 'signal-lab/2';
export const SUBSYSTEM = 'subsystem';

/** A block on a diagram. A subsystem block carries a diagram of its own. */
export type LabBlock = BlockNode & {
  readonly inner?: Diagram;
  /**
   * Settings computed from parameters: setting name to an expression such as
   * `fc` or `-3 - snr`. For a subsystem, the names are its parameters.
   */
  readonly bindings?: { readonly [setting: string]: string };
};

/**
 * A named number that blocks in this diagram, and in subsystems inside it, can
 * use in their bindings. A subsystem's parameters are also its settings.
 */
export type Parameter = {
  readonly name: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly unit?: Unit;
  readonly scale?: 'linear' | 'log';
};

export type Diagram = {
  readonly blocks: readonly LabBlock[];
  readonly wires: readonly Wire[];
  /** Notes about this diagram, in the Markdown of markdown.ts. */
  readonly notes?: string;
  readonly parameters?: readonly Parameter[];
};

/**
 * Where an instrument's widget sits on the panel face, in grid cells from the
 * top left.
 */
export type FaceSpot = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type LabDocument = Diagram & {
  readonly format: typeof FORMAT;
  readonly title: string;
  readonly notes: string;
  /** Simulation window in seconds. */
  readonly duration: number;
  /**
   * Where each instrument's widget sits on the face, by the instrument's full
   * id. Instruments without a spot are placed in the first free space.
   */
  readonly face?: Readonly<Record<string, FaceSpot>>;
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

/** Binds a block's setting to an expression, or unbinds it given none. */
export function setBinding<D extends Diagram>(
  diagram: D,
  id: string,
  setting: string,
  expression: string | undefined,
): D {
  return updateBlock(diagram, id, ({ bindings, ...block }) => {
    const { [setting]: _, ...rest } = bindings ?? {};
    const next = expression?.trim()
      ? { ...rest, [setting]: expression.trim() }
      : rest;
    return Object.keys(next).length ? { ...block, bindings: next } : block;
  });
}

/** A parameter name based on `base` that isn't taken in the diagram. */
export function freeParameterName(diagram: Diagram, base: string): string {
  const stem =
    base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(?=\d)/, '_') || 'p';
  const taken = new Set((diagram.parameters ?? []).map((p) => p.name));
  if (!taken.has(stem) && isParameterName(stem)) {
    return stem;
  }

  for (let n = 2; ; n++) {
    if (!taken.has(`${stem}${n}`)) {
      return `${stem}${n}`;
    }
  }
}

export function addParameter<D extends Diagram>(
  diagram: D,
  parameter: Parameter,
): D {
  return {
    ...diagram,
    parameters: [...(diagram.parameters ?? []), parameter],
  };
}

export function updateParameter<D extends Diagram>(
  diagram: D,
  name: string,
  change: Partial<Parameter>,
): D {
  return {
    ...diagram,
    parameters: (diagram.parameters ?? []).map((p) =>
      p.name === name ? { ...p, ...change } : p,
    ),
  };
}

export function removeParameter<D extends Diagram>(
  diagram: D,
  name: string,
): D {
  return {
    ...diagram,
    parameters: (diagram.parameters ?? []).filter((p) => p.name !== name),
  };
}

/**
 * Renames a parameter and rewrites the bindings that use it, in this diagram
 * and in the subsystems inside it.
 */
export function renameParameter<D extends Diagram>(
  diagram: D,
  from: string,
  to: string,
): D {
  const word = new RegExp(`\\b${from}\\b`, 'g');
  const rewrite = <T extends Diagram>(d: T): T => ({
    ...d,
    blocks: d.blocks.map((block) => ({
      ...block,
      ...(block.kind === CONTROL_KIND && block.params.target === from
        ? { params: { ...block.params, target: to } }
        : {}),
      ...(block.bindings
        ? {
            bindings: Object.fromEntries(
              Object.entries(block.bindings).map(([setting, expression]) => [
                setting,
                expression.replace(word, to),
              ]),
            ),
          }
        : {}),
      ...(block.inner ? { inner: rewrite(block.inner) } : {}),
    })),
  });
  return rewrite(updateParameter(diagram, from, { name: to }));
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

/**
 * What an instrument refers to: a readout's block, or the block whose setting
 * a control sets, as a path relative to the instrument's own diagram.
 */
function instrumentRef(block: LabBlock): string | undefined {
  const { params } = block;
  if (block.kind === READOUT_KIND && typeof params.block === 'string') {
    return params.block || undefined;
  }

  if (block.kind === CONTROL_KIND && typeof params.target === 'string') {
    const dot = params.target.lastIndexOf('.');
    return dot > 0 ? params.target.slice(0, dot) : undefined;
  }

  return undefined;
}

function withInstrumentRef(block: LabBlock, ref: string): LabBlock {
  if (block.kind === READOUT_KIND) {
    return { ...block, params: { ...block.params, block: ref } };
  }

  const target = String(block.params.target);
  return {
    ...block,
    params: {
      ...block.params,
      target: `${ref}${target.slice(target.lastIndexOf('.'))}`,
    },
  };
}

/** Every block in the document with its full id, depth first. */
export function everyBlock(
  diagram: Diagram,
  path: Path = [],
): { readonly id: string; readonly path: Path; readonly block: LabBlock }[] {
  return diagram.blocks.flatMap((block) => [
    { id: pathId(path, block.id), path, block },
    ...(block.inner ? everyBlock(block.inner, [...path, block.id]) : []),
  ]);
}

/**
 * Follows blocks that moved between diagrams (by grouping or ungrouping) from
 * `before` to `after`: the face layout, and what readouts and controls refer
 * to. `rename` gives a block's new full id, or undefined if it is gone.
 */
export function moveRefs(
  before: LabDocument,
  after: LabDocument,
  rename: (fullId: string) => string | undefined,
): LabDocument {
  let next = after;
  for (const { id, path, block } of everyBlock(before)) {
    const ref = instrumentRef(block);
    const moved = rename(id);
    if (ref === undefined || moved === undefined) {
      continue;
    }

    const target = rename(pathId(path, ref)) ?? pathId(path, ref);
    const parts = moved.split('/');
    const prefix = parts.slice(0, -1).join('/');
    const relative = prefix
      ? target.startsWith(`${prefix}/`)
        ? target.slice(prefix.length + 1)
        : undefined
      : target;
    if (relative !== undefined && relative !== ref) {
      next = updateDiagramAt(next, parts.slice(0, -1), (d) =>
        updateBlock(d, parts[parts.length - 1]!, (b) =>
          withInstrumentRef(b, relative),
        ),
      );
    }
  }

  const face = before.face && {
    ...Object.fromEntries(
      Object.entries(before.face).flatMap(([id, spot]) => {
        const moved = rename(id);
        return moved === undefined ? [] : [[moved, spot]];
      }),
    ),
  };
  return face ? { ...next, face } : next;
}

/** Drops face spots whose instruments are gone. */
export function pruneRefs(doc: LabDocument): LabDocument {
  if (!doc.face) {
    return doc;
  }

  const entries = Object.entries(doc.face);
  const kept = entries.filter(([id]) => blockAt(doc, id));
  return kept.length === entries.length
    ? doc
    : { ...doc, face: Object.fromEntries(kept) };
}

/**
 * Renames a parameter of the diagram at `path`, rewriting the bindings and
 * controls that use it.
 */
export function renameParameterAt(
  doc: LabDocument,
  path: Path,
  from: string,
  to: string,
): LabDocument {
  return updateDiagramAt(doc, path, (d) => renameParameter(d, from, to));
}

export function setFaceSpot(
  doc: LabDocument,
  id: string,
  spot: FaceSpot,
): LabDocument {
  return { ...doc, face: { ...doc.face, [id]: spot } };
}

/**
 * Sets the notes of the diagram at `path`: the document's own, or a
 * subsystem's.
 */
export function setNotes(
  doc: LabDocument,
  path: Path,
  notes: string,
): LabDocument {
  return updateDiagramAt(doc, path, (diagram) => ({ ...diagram, notes }));
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

function readFace(value: unknown): Pick<LabDocument, 'face'> {
  if (!isRecord(value)) {
    return {};
  }

  const face: Record<string, FaceSpot> = {};
  for (const [id, spot] of Object.entries(value)) {
    if (
      isRecord(spot) &&
      [spot.x, spot.y, spot.w, spot.h].every(
        (n) => isNumber(n) && n >= 0 && n < 1000,
      )
    ) {
      const [x, y, w, h] = [spot.x, spot.y, spot.w, spot.h].map((n) =>
        Math.round(n as number),
      );
      face[id] = { x: x!, y: y!, w: Math.max(1, w!), h: Math.max(1, h!) };
    }
  }

  return Object.keys(face).length ? { face } : {};
}

/**
 * Documents saved before instruments pinned signals to the bench as probes;
 * each becomes a Plot block wired to the same output.
 */
function plotsFromProbes(doc: LabDocument, probes: unknown): LabDocument {
  let next = doc;
  let k = 0;
  for (const probe of Array.isArray(probes) ? probes : []) {
    const at = isRecord(probe) ? readRef(probe.at) : undefined;
    const source = at && blockAt(next, at.block);
    if (!at || !source) {
      continue;
    }

    const parts = at.block.split('/');
    const view = isRecord(probe) ? probe.view : undefined;
    next = updateDiagramAt(next, parts.slice(0, -1), (d) => {
      const [added, id] = addBlock(
        d,
        PLOT_KIND,
        source.x + 200,
        source.y + 96 + 24 * k++,
        {
          params: {
            view: view === 'spectrum' || view === 'waterfall' ? view : 'time',
          },
        },
      );
      return connect(
        added,
        { block: parts[parts.length - 1]!, port: at.port },
        { block: id, port: 0 },
      );
    });
  }

  return next;
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

function readBindings(value: unknown): Pick<LabBlock, 'bindings'> {
  if (!isRecord(value)) {
    return {};
  }

  const bindings = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        isString(entry[1]) && entry[1].trim() !== '',
    ),
  );
  return Object.keys(bindings).length ? { bindings } : {};
}

const UNITS = new Set(['Hz', 's', 'dB', 'deg', 'V', 'x']);

function readParameters(value: unknown): Pick<Diagram, 'parameters'> {
  const parameters: Parameter[] = [];
  for (const p of Array.isArray(value) ? value : []) {
    if (
      !isRecord(p) ||
      !isString(p.name) ||
      !isParameterName(p.name) ||
      !isNumber(p.value) ||
      !isNumber(p.min) ||
      !isNumber(p.max) ||
      p.min >= p.max
    ) {
      continue;
    }

    if (parameters.some((other) => other.name === p.name)) {
      continue;
    }

    parameters.push({
      name: p.name,
      value: p.value,
      min: p.min,
      max: p.max,
      ...(isString(p.unit) && UNITS.has(p.unit)
        ? { unit: p.unit as Unit }
        : {}),
      ...(p.scale === 'log' && p.min > 0 ? { scale: 'log' as const } : {}),
    });
  }

  return parameters.length ? { parameters } : {};
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
      ...readBindings(b.bindings),
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

  return {
    blocks,
    wires,
    ...(isString(value.notes) && value.notes ? { notes: value.notes } : {}),
    ...readParameters(value.parameters),
  };
}

/**
 * Validates a parsed JSON value as a document. Throws with a readable message
 * if it isn't one.
 */
export function readDocument(value: unknown): LabDocument {
  if (!isRecord(value) || value.format !== FORMAT) {
    throw new Error("This file isn't a Signal Lab diagram.");
  }

  const doc: LabDocument = {
    format: FORMAT,
    title: isString(value.title) ? value.title : 'Untitled',
    notes: isString(value.notes) ? value.notes : '',
    duration:
      isNumber(value.duration) && value.duration > 0 ? value.duration : 1,
    ...readDiagram(value, 0),
    ...readFace(value.face),
  };
  return pruneRefs(plotsFromProbes(doc, value.probes));
}
