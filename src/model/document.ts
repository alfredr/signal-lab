// Immutable document model: nested diagrams, parameters, notes, and panel
// organization. Edit functions return new documents for undo and redo.

import { INPUT_TERMINAL, OUTPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockNode, PortRef, Wire } from '../engine/circuit.ts';
import type { ParamValue, StoredParams, Unit } from '../engine/params.ts';
import { isParameterName } from './expressions.ts';
import { freeNames, renameUses } from './scopes.ts';

// Keep these kind names local to avoid importing the full block library.
const PLOT_KIND = 'plot';
const CONTROL_KIND = 'control';
const READOUT_KIND = 'readout';
const SYMBOLS_KIND = 'symbols';
/** Instruments that refer to a block by its `block` setting. */
const READS_BLOCK: ReadonlySet<string> = new Set([READOUT_KIND, SYMBOLS_KIND]);

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
 * A named numeric parameter available to this diagram and its descendants. A
 * subsystem also exposes its parameters as block settings.
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
  /** Diagram notes using the Markdown syntax supported by markdown.ts. */
  readonly notes?: string;
  readonly parameters?: readonly Parameter[];
};

/** An instrument's full id and optional grid-size overrides within a pane. */
export type PaneItem = {
  readonly id: string;
  readonly w?: number;
  readonly h?: number;
};

/** A titled group of panel instruments. */
type Pane = {
  readonly id: string;
  readonly title: string;
  readonly items: readonly PaneItem[];
};

/** A titled collection of panes. */
export type Panel = {
  readonly id: string;
  readonly title: string;
  readonly panes: readonly Pane[];
};

export type LabDocument = Diagram & {
  readonly format: typeof FORMAT;
  readonly title: string;
  readonly notes: string;
  /**
   * Saved panel and pane membership. Unassigned instruments receive default
   * panes; screen positions are calculated from the available space.
   */
  readonly panels?: readonly Panel[];
};

/** Subsystem ids from the document root to a nested diagram. */
export type Path = readonly string[];

/** Joins a diagram path and local block id into a full id. */
export function pathId(path: Path, id: string): string {
  return [...path, id].join('/');
}

/**
 * Resolves an instrument's block reference relative to `path`. Subsystem ids
 * descend into diagrams; leading ".." segments ascend to parent diagrams.
 */
export function resolveRef(path: Path, ref: string): string | undefined {
  const parts = ref.split('/');
  const up = parts.findIndex((part) => part !== '..');
  return up < 0 || up > path.length
    ? undefined
    : pathId(path.slice(0, path.length - up), parts.slice(up).join('/'));
}

/** Builds a reference from diagram `path` to full block id `id`. */
function relativeRef(path: Path, id: string): string {
  const parts = id.split('/');
  let shared = 0;
  while (
    shared < path.length &&
    shared < parts.length - 1 &&
    path[shared] === parts[shared]
  ) {
    shared++;
  }

  return [
    ...Array<string>(path.length - shared).fill('..'),
    ...parts.slice(shared),
  ].join('/');
}

export function isSubsystem(
  block: LabBlock,
): block is LabBlock & { readonly inner: Diagram } {
  return block.kind === SUBSYSTEM && block.inner !== undefined;
}

/** Input and output terminals in port-number order. */
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

/** Generates ids that are unique against `existing` and previous results. */
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
 * Maps old subsystem ports to new indices by terminal id. Adding or removing
 * terminals must not redirect existing wires to different terminals.
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
 * Duplicates selected blocks and their connecting wires with fresh ids and an
 * (dx, dy) offset. Returns the new block ids. Nested diagrams are shared
 * unless their instrument references need updating. References follow copied
 * targets at any depth; `path` resolves references outside this diagram.
 */
export function duplicate<D extends Diagram>(
  diagram: D,
  ids: ReadonlySet<string>,
  dx = 24,
  dy = 24,
  path: Path = [],
): [D, string[]] {
  const chosen = diagram.blocks.filter((block) => ids.has(block.id));
  const blockId = idSource('b', diagram.blocks);
  const wireId = idSource('w', diagram.wires);
  const renamed = new Map(chosen.map((block) => [block.id, blockId()]));
  // Map selected blocks and their descendants to copied full ids.
  const prefix = path.length ? `${path.join('/')}/` : '';
  const copied = (id: string) => {
    const [head, ...rest] = id.startsWith(prefix)
      ? id.slice(prefix.length).split('/')
      : [];
    const copy = head === undefined ? undefined : renamed.get(head);
    return copy === undefined ? id : pathId(path, [copy, ...rest].join('/'));
  };

  const copies = chosen.map((block) => {
    const id = renamed.get(block.id)!;
    return {
      ...withCopiedRefs(block, path, path, id, copied),
      id,
      x: block.x + dx,
      y: block.y + dy,
    };
  });
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

/** Sets a binding expression, or removes the binding when none is supplied. */
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

/** Finds an unused parameter name derived from `base`. */
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

/** Renames a parameter and its uses in this scope. */
export function renameParameter<D extends Diagram>(
  diagram: D,
  from: string,
  to: string,
): D {
  return renameUses(
    updateParameter(diagram, from, { name: to }),
    new Map([[from, to]]),
  );
}

/**
 * Returns a reason the rename would change name resolution. Rejects duplicate
 * declarations, capture of inherited names, and descendant declarations that
 * would shadow the renamed parameter.
 */
export function renameProblem(
  doc: LabDocument,
  path: Path,
  from: string,
  to: string,
): string | undefined {
  const diagram = diagramAt(doc, path);
  if (to === from || !diagram) {
    return undefined;
  }

  if (diagram.parameters?.some((p) => p.name === to)) {
    return `There is already a parameter called "${to}" here.`;
  }

  if (freeNames(diagram).has(to)) {
    return `Something here already uses a "${to}" from further out, which this would hide.`;
  }

  const captured = (d: Diagram): boolean =>
    d.blocks.some(
      (block) =>
        block.inner !== undefined &&
        !block.inner.parameters?.some((p) => p.name === from) &&
        ((block.inner.parameters?.some((p) => p.name === to) &&
          freeNames({ ...block.inner, parameters: [] }).has(from)) ||
          captured(block.inner)),
    );
  return captured(diagram)
    ? `A subsystem inside has a parameter of its own called "${to}", which would take this one's place there.`
    : undefined;
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

/** Extracts an instrument's block reference relative to its containing diagram. */
function instrumentRef(block: LabBlock): string | undefined {
  const { params } = block;
  if (READS_BLOCK.has(block.kind) && typeof params.block === 'string') {
    return params.block || undefined;
  }

  if (block.kind === CONTROL_KIND && typeof params.target === 'string') {
    const dot = params.target.lastIndexOf('.');
    return dot > 0 ? params.target.slice(0, dot) : undefined;
  }

  return undefined;
}

function withInstrumentRef(block: LabBlock, ref: string): LabBlock {
  if (READS_BLOCK.has(block.kind)) {
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

/**
 * Rewrites references in a duplicated block and its descendants. `from` and
 * `to` are the original and destination diagram paths; `copied` maps full ids
 * to their destinations.
 */
function withCopiedRefs(
  block: LabBlock,
  from: Path,
  to: Path,
  id: string,
  copied: (id: string) => string,
): LabBlock {
  let next = block;
  const ref = instrumentRef(block);
  const full = ref === undefined ? undefined : resolveRef(from, ref);
  const now = full === undefined ? undefined : relativeRef(to, copied(full));
  if (now !== undefined && now !== ref) {
    next = withInstrumentRef(next, now);
  }

  // A plot stacked under a view names it by full id.
  const host = block.kind === PLOT_KIND ? block.params.stack : undefined;
  if (typeof host === 'string' && host && copied(host) !== host) {
    next = { ...next, params: { ...next.params, stack: copied(host) } };
  }

  if (block.inner) {
    const inside = [...from, block.id];
    const there = [...to, id];
    const blocks = block.inner.blocks.map((b) =>
      withCopiedRefs(b, inside, there, b.id, copied),
    );
    if (blocks.some((b, i) => b !== block.inner!.blocks[i])) {
      next = { ...next, inner: { ...block.inner, blocks } };
    }
  }

  return next;
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

/** A parameter identified by its declaring diagram. */
type ParameterRef = {
  readonly scope: Path;
  readonly parameter: string;
};

/**
 * A resolved instrument target: a block and optional setting, or a parameter
 * in its declaring scope. Controls may refer to parameters directly or through
 * subsystem settings.
 */
type Reference =
  | { readonly block: string; readonly setting?: string }
  | ParameterRef;

export function referenceOf(
  doc: LabDocument,
  path: Path,
  block: LabBlock,
): Reference | undefined {
  const { params } = block;
  if (READS_BLOCK.has(block.kind)) {
    const id =
      typeof params.block === 'string' && params.block
        ? resolveRef(path, params.block)
        : undefined;
    return id === undefined ? undefined : { block: id };
  }

  const target = params.target;
  if (block.kind !== CONTROL_KIND || typeof target !== 'string') {
    return undefined;
  }

  const dot = target.lastIndexOf('.');
  if (dot <= 0) {
    // Find the nearest declaration in the scope chain.
    for (let depth = path.length; depth >= 0; depth--) {
      const scope = path.slice(0, depth);
      if (diagramAt(doc, scope)?.parameters?.some((p) => p.name === target)) {
        return { scope, parameter: target };
      }
    }

    return undefined;
  }

  const id = resolveRef(path, target.slice(0, dot));
  if (id === undefined) {
    return undefined;
  }

  const setting = target.slice(dot + 1);
  const holder = blockAt(doc, id);
  return holder &&
    isSubsystem(holder) &&
    holder.inner.parameters?.some((p) => p.name === setting)
    ? { scope: id.split('/'), parameter: setting }
    : { block: id, setting };
}

/**
 * Formats a resolved reference for an instrument at `path`. Parameters use a
 * bare name when visible, otherwise a subsystem setting reference. Returns
 * undefined when a root parameter is shadowed and cannot be addressed.
 */
function referenceText(
  doc: LabDocument,
  path: Path,
  reference: Reference,
): string | undefined {
  if ('block' in reference) {
    const ref = relativeRef(path, reference.block);
    return reference.setting === undefined
      ? ref
      : `${ref}.${reference.setting}`;
  }

  const { scope, parameter } = reference;
  const around =
    scope.length <= path.length && scope.every((id, i) => path[i] === id);
  const hidden = path
    .slice(scope.length)
    .some((_, i) =>
      diagramAt(doc, path.slice(0, scope.length + i + 1))?.parameters?.some(
        (p) => p.name === parameter,
      ),
    );
  if (around && !hidden) {
    return parameter;
  }

  return scope.length
    ? `${relativeRef(path, scope.join('/'))}.${parameter}`
    : undefined;
}

/**
 * Updates instrument references and panel membership after a structural edit.
 * `rename` maps old full ids to new ids, returning undefined for removed
 * blocks. Parameters follow their declaring subsystems unless the optional
 * callback remaps them. References to removed targets are cleared.
 */
export function moveRefs(
  before: LabDocument,
  after: LabDocument,
  rename: (fullId: string) => string | undefined,
  parameter: (
    was: ParameterRef,
    followed: ParameterRef | undefined,
  ) => ParameterRef | undefined = (_, followed) => followed,
): LabDocument {
  const follow = (reference: Reference): Reference | undefined => {
    if ('block' in reference) {
      const id = rename(reference.block);
      return id === undefined ? undefined : { ...reference, block: id };
    }

    const holder = reference.scope.length
      ? rename(reference.scope.join('/'))
      : '';
    return parameter(
      reference,
      holder === undefined
        ? undefined
        : { ...reference, scope: holder ? holder.split('/') : [] },
    );
  };

  let next = after;
  for (const { id, path, block } of everyBlock(before)) {
    const moved = rename(id);
    if (moved === undefined) {
      continue;
    }

    const parts = moved.split('/');
    const at = parts.slice(0, -1);
    const local = parts[parts.length - 1]!;
    const reference = referenceOf(before, path, block);
    if (reference) {
      const now = follow(reference);
      const text = (now && referenceText(after, at, now)) ?? '';
      const key = block.kind === CONTROL_KIND ? 'target' : 'block';
      if (text !== blockAt(after, moved)?.params[key]) {
        next = updateDiagramAt(next, at, (d) => setParam(d, local, key, text));
      }
    }

    // A plot stacked under a view refers to it by full id.
    const host = block.kind === PLOT_KIND ? block.params.stack : undefined;
    const now = typeof host === 'string' && host ? rename(host) : undefined;
    if (now !== undefined && now !== host) {
      next = updateDiagramAt(next, at, (d) =>
        setParam(d, local, 'stack', now),
      );
    }
  }

  // Panes list their instruments by full id.
  const panels = before.panels?.map((panel) => ({
    ...panel,
    panes: panel.panes.map((pane) => ({
      ...pane,
      items: pane.items.flatMap((item) => {
        const moved = rename(item.id);
        return moved === undefined ? [] : [{ ...item, id: moved }];
      }),
    })),
  }));
  return panels ? { ...next, panels } : next;
}

/** Removes deleted instruments from saved panes. */
export function pruneRefs(doc: LabDocument): LabDocument {
  let changed = false;
  const panels = doc.panels?.map((panel) => ({
    ...panel,
    panes: panel.panes.map((pane) => {
      const items = pane.items.filter((item) => blockAt(doc, item.id));
      if (items.length === pane.items.length) {
        return pane;
      }

      changed = true;
      return { ...pane, items };
    }),
  }));
  return changed && panels ? { ...doc, panels } : doc;
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
  let next = updateDiagramAt(doc, path, (d) => renameParameter(d, from, to));
  // Rename the binding key on the subsystem that exposes this parameter.
  if (path.length) {
    next = updateDiagramAt(next, path.slice(0, -1), (d) =>
      updateBlock(d, path[path.length - 1]!, (block) =>
        block.bindings && from in block.bindings
          ? {
              ...block,
              bindings: Object.fromEntries(
                Object.entries(block.bindings).map(([setting, expression]) => [
                  setting === from ? to : setting,
                  expression,
                ]),
              ),
            }
          : block,
      ),
    );
  }

  // Update controls targeting the parameter throughout the document.
  const here = path.join('/');
  return moveRefs(
    doc,
    next,
    (id) => id,
    (was, followed) =>
      was.scope.join('/') === here && was.parameter === from
        ? { scope: path, parameter: to }
        : followed,
  );
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
  change: Partial<Pick<LabDocument, 'title' | 'notes'>>,
): LabDocument {
  return { ...doc, ...change };
}

// Validate documents read from browser storage or JSON files.

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

/** Maximum instrument width or height in grid cells. */
export const MOST_CELLS = 40;

/** Parses a supported grid dimension. */
function readCells(value: unknown): number | undefined {
  return isNumber(value) && value >= 1 && value <= MOST_CELLS
    ? Math.round(value)
    : undefined;
}

/**
 * Reads panel organization. Legacy documents with grid-based face layouts have
 * no saved panels and use automatically generated panes.
 */
function readPanels(value: unknown): Pick<LabDocument, 'panels'> {
  const ids = new Set<string>();
  // Require unique ids across panels and panes.
  const fresh = (id: unknown): id is string => {
    if (!isString(id) || id === '' || ids.has(id)) {
      return false;
    }

    ids.add(id);
    return true;
  };

  const panels: Panel[] = [];
  for (const panel of Array.isArray(value) ? value : []) {
    if (!isRecord(panel) || !fresh(panel.id) || !Array.isArray(panel.panes)) {
      continue;
    }

    const panes: Pane[] = [];
    for (const pane of panel.panes as unknown[]) {
      if (!isRecord(pane) || !fresh(pane.id) || !Array.isArray(pane.items)) {
        continue;
      }

      const items = (pane.items as unknown[]).flatMap((item): PaneItem[] => {
        if (!isRecord(item) || !isString(item.id)) {
          return [];
        }

        const w = readCells(item.w);
        const h = readCells(item.h);
        return [{ id: item.id, ...(w ? { w } : {}), ...(h ? { h } : {}) }];
      });
      panes.push({
        id: pane.id,
        title: isString(pane.title) ? pane.title : '',
        items,
      });
    }

    panels.push({
      id: panel.id,
      title: isString(panel.title) ? panel.title : '',
      panes,
    });
  }

  return panels.length ? { panels } : {};
}

/** Migrates legacy probes to Plot blocks connected to the same outputs. */
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

/** Map legacy transmit and receive antenna kinds to the unified Antenna block. */
const RENAMED: Readonly<Record<string, string>> = {
  'antenna-tx': 'antenna',
  'antenna-rx': 'antenna',
};

function readDiagram(value: Record<string, unknown>, depth: number): Diagram {
  const blocks: LabBlock[] = [];
  for (const b of Array.isArray(value.blocks) ? value.blocks : []) {
    if (
      !isRecord(b) ||
      !isString(b.id) ||
      b.id.includes('/') ||
      b.id === '..' ||
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
      kind: RENAMED[b.kind] ?? b.kind,
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

/** Validates parsed JSON and returns a document, or throws a descriptive error. */
export function readDocument(value: unknown): LabDocument {
  if (!isRecord(value) || value.format !== FORMAT) {
    throw new Error("This file isn't a Signal Lab diagram.");
  }

  const doc: LabDocument = {
    format: FORMAT,
    title: isString(value.title) ? value.title : 'Untitled',
    notes: isString(value.notes) ? value.notes : '',
    ...readDiagram(value, 0),
    ...readPanels(value.panels),
  };
  return pruneRefs(plotsFromProbes(doc, value.probes));
}
