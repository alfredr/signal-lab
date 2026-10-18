// Instruments in the document: what controls set and readouts read, what
// they connect to on the diagram, and where their widgets sit on the panel
// face. The face is a grid like the front of a radio; the document saves each
// widget's spot by instrument, and widgets without one fill the first free
// space.

import {
  CONTROL,
  isInstrument,
  NOTE,
  PLOT,
  READOUT,
  SPEAKER,
} from '../blocks/instruments.ts';
import type { PortRef } from '../engine/circuit.ts';
import {
  number,
  resolveParams,
  type NumberParam,
  type ParamSpec,
  type ParamValue,
} from '../engine/params.ts';
import {
  blockAt,
  diagramAt,
  everyBlock,
  isSubsystem,
  pathId,
  setParam,
  updateDiagramAt,
  updateParameter,
  type Diagram,
  type FaceSpot,
  type LabBlock,
  type LabDocument,
  type Parameter,
  type Path,
} from './document.ts';
import { namesIn, parseExpression } from './expressions.ts';
import type { Bindings } from './flatten.ts';
import { displayName, typeOf } from './subsystems.ts';

/** A parameter as a setting spec, for its control. */
export function parameterSpec(parameter: Parameter): NumberParam {
  return number({
    label: parameter.name,
    default: parameter.value,
    min: parameter.min,
    max: parameter.max,
    ...(parameter.unit ? { unit: parameter.unit } : {}),
    ...(parameter.scale ? { scale: parameter.scale } : {}),
  });
}

/**
 * What a control sets: a parameter by name, or `block.setting`, where the
 * block is a path relative to the control's diagram and a subsystem's settings
 * are its parameters.
 */
type Target =
  | { readonly kind: 'parameter'; readonly name: string }
  | {
      readonly kind: 'setting';
      readonly block: string;
      readonly setting: string;
    };

function parseTarget(target: string): Target | undefined {
  const dot = target.lastIndexOf('.');
  if (dot > 0) {
    return {
      kind: 'setting',
      block: target.slice(0, dot),
      setting: target.slice(dot + 1),
    };
  }

  return target ? { kind: 'parameter', name: target } : undefined;
}

/** A control's setting, worked out against the document. */
export type ControlState = {
  readonly label: string;
  readonly spec: ParamSpec;
  /** The value set directly, which a binding overrides. */
  readonly value: ParamValue;
  /** The expression the setting is bound to, if any. */
  readonly binding: string | undefined;
  /** What the binding works out to. */
  readonly bound: number | undefined;
  readonly set: (doc: LabDocument, value: ParamValue) => LabDocument;
};

/** The diagram, at `path` or around it, that declares parameter `name`. */
function parameterScope(
  doc: LabDocument,
  path: Path,
  name: string,
): { path: Path; parameter: Parameter } | undefined {
  for (let depth = path.length; depth >= 0; depth--) {
    const scope = path.slice(0, depth);
    const parameter = diagramAt(doc, scope)?.parameters?.find(
      (p) => p.name === name,
    );
    if (parameter) {
      return { path: scope, parameter };
    }
  }

  return undefined;
}

/** A parameter of the diagram at `path`, and how a binding outside sets it. */
function parameterState(
  doc: LabDocument,
  bindings: Bindings,
  path: Path,
  parameter: Parameter,
  label: string,
): ControlState {
  const holder = path.length ? blockAt(doc, path.join('/')) : undefined;
  return {
    label,
    spec: parameterSpec(parameter),
    value: parameter.value,
    binding: holder?.bindings?.[parameter.name],
    bound: bindings.values.get(path.join('/'))?.[parameter.name],
    set: (d, value) =>
      updateDiagramAt(d, path, (inner) =>
        updateParameter(inner, parameter.name, { value: value as number }),
      ),
  };
}

/** What the control at `path` sets, or why it can't. */
export function controlState(
  doc: LabDocument,
  bindings: Bindings,
  path: Path,
  control: LabBlock,
): ControlState | { readonly problem: string } {
  const target = parseTarget(String(control.params.target ?? ''));
  if (!target) {
    return { problem: 'Choose what this sets.' };
  }

  if (target.kind === 'parameter') {
    const scope = parameterScope(doc, path, target.name);
    return scope
      ? parameterState(doc, bindings, scope.path, scope.parameter, target.name)
      : { problem: `No parameter is called "${target.name}".` };
  }

  const id = pathId(path, target.block);
  const block = blockAt(doc, id);
  if (!block) {
    return { problem: 'The block it set is gone.' };
  }

  const label = `${displayName(block)} › `;
  if (isSubsystem(block)) {
    const parameter = block.inner.parameters?.find(
      (p) => p.name === target.setting,
    );
    return parameter
      ? parameterState(
          doc,
          bindings,
          id.split('/'),
          parameter,
          label + parameter.name,
        )
      : { problem: `${displayName(block)} has no "${target.setting}".` };
  }

  const spec = typeOf(block)?.params[target.setting];
  if (!spec) {
    return { problem: `${displayName(block)} has no "${target.setting}".` };
  }

  const parts = id.split('/');
  return {
    label: label + spec.label,
    spec,
    value: resolveParams({ [target.setting]: spec }, block.params)[
      target.setting
    ]!,
    binding: block.bindings?.[target.setting],
    bound: bindings.values.get(id)?.[target.setting],
    set: (d, value) =>
      updateDiagramAt(d, parts.slice(0, -1), (inner) =>
        setParam(inner, parts[parts.length - 1]!, target.setting, value),
      ),
  };
}

/** Something a control can set, for choosing one. */
export type Settable = { readonly target: string; readonly label: string };

/**
 * Everything a control at `path` can set: the parameters in scope, then each
 * block's settings.
 */
export function settables(doc: LabDocument, path: Path): Settable[] {
  const diagram = diagramAt(doc, path);
  if (!diagram) {
    return [];
  }

  const parameters = path
    .map((_, i) => path.slice(0, path.length - i))
    .concat([[]])
    .flatMap((scope) => diagramAt(doc, scope)?.parameters ?? [])
    .map((p) => ({ target: p.name, label: p.name }));
  const settings = diagram.blocks.flatMap((block): Settable[] => {
    if (isInstrument(block.kind)) {
      return [];
    }

    const name = displayName(block);
    if (isSubsystem(block)) {
      return (block.inner.parameters ?? []).map((p) => ({
        target: `${block.id}.${p.name}`,
        label: `${name} › ${p.name}`,
      }));
    }

    return Object.entries(typeOf(block)?.params ?? {}).map(
      ([setting, spec]) => ({
        target: `${block.id}.${setting}`,
        label: `${name} › ${spec.label}`,
      }),
    );
  });
  return [
    ...new Map(
      [...parameters, ...settings].map((s) => [s.target, s]),
    ).values(),
  ];
}

/** Whether any binding in the block, or inside it, uses parameter `name`. */
function usesParameter(block: LabBlock, name: string): boolean {
  const inBindings = Object.values(block.bindings ?? {}).some((expression) => {
    const parsed = parseExpression(expression);
    return parsed.ok && namesIn(parsed.value).includes(name);
  });
  return (
    inBindings ||
    // A parameter of the same name inside hides this one.
    (block.inner !== undefined &&
      !block.inner.parameters?.some((p) => p.name === name) &&
      block.inner.blocks.some((inner) => usesParameter(inner, name)))
  );
}

/**
 * The blocks of the same diagram an instrument acts on or reads from, which
 * the diagram joins to it with dashed lines.
 */
export function instrumentLeads(diagram: Diagram, block: LabBlock): string[] {
  const local = (ref: string) => {
    const [first] = ref.split('/');
    return diagram.blocks.some((b) => b.id === first) ? [first!] : [];
  };

  if (block.kind === READOUT) {
    return local(String(block.params.block ?? ''));
  }

  if (block.kind !== CONTROL) {
    return [];
  }

  const target = parseTarget(String(block.params.target ?? ''));
  if (target?.kind === 'setting') {
    return local(target.block);
  }

  return target
    ? diagram.blocks
        .filter((b) => b.id !== block.id && usesParameter(b, target.name))
        .map((b) => b.id)
    : [];
}

export type FaceItem = {
  /** The instrument's full id. */
  readonly id: string;
  readonly path: Path;
  readonly block: LabBlock;
};

/**
 * The instruments with a widget on the face, depth first: all but the notes
 * kept to the diagram.
 */
export function faceItems(doc: LabDocument): FaceItem[] {
  return everyBlock(doc).filter(
    ({ block }) =>
      isInstrument(block.kind) &&
      (block.kind !== NOTE || block.params.face === true),
  );
}

/** A widget's size in grid cells until someone resizes it. */
export function defaultSize(
  block: LabBlock,
  wide: boolean,
): { readonly w: number; readonly h: number } {
  switch (block.kind) {
    case PLOT:
      return { w: 8, h: 5 };
    case SPEAKER:
      return { w: 3, h: 3 };
    case READOUT:
      return { w: 5, h: 2 };
    case CONTROL:
      return wide ? { w: 6, h: 2 } : { w: 3, h: 3 };
    default:
      return { w: 6, h: 2 };
  }
}

/**
 * Where every widget goes: its saved spot, or the first free space scanning
 * row by row across `columns`.
 */
export function layoutFace(
  items: readonly FaceItem[],
  spots: Readonly<Record<string, FaceSpot>> | undefined,
  columns: number,
  sizeOf: (item: FaceItem) => { readonly w: number; readonly h: number },
): Map<string, FaceSpot> {
  const layout = new Map<string, FaceSpot>();
  const taken = new Set<string>();
  const occupy = (spot: FaceSpot) => {
    for (let y = spot.y; y < spot.y + spot.h; y++) {
      for (let x = spot.x; x < spot.x + spot.w; x++) {
        taken.add(`${x},${y}`);
      }
    }
  };

  const free = (spot: FaceSpot) => {
    for (let y = spot.y; y < spot.y + spot.h; y++) {
      for (let x = spot.x; x < spot.x + spot.w; x++) {
        if (taken.has(`${x},${y}`)) {
          return false;
        }
      }
    }

    return true;
  };

  for (const item of items) {
    const spot = spots?.[item.id];
    if (spot) {
      layout.set(item.id, spot);
      occupy(spot);
    }
  }

  for (const item of items) {
    if (layout.has(item.id)) {
      continue;
    }

    const { w, h } = sizeOf(item);
    for (let y = 0; !layout.has(item.id); y++) {
      for (let x = 0; x <= Math.max(0, columns - w); x++) {
        const spot = { x, y, w, h };
        if (free(spot)) {
          layout.set(item.id, spot);
          occupy(spot);
          break;
        }
      }
    }
  }

  return layout;
}

/** A Plot block in the diagram already showing the output `from`, if any. */
export function plotFrom(diagram: Diagram, from: PortRef): string | undefined {
  return diagram.wires.find(
    (wire) =>
      wire.from.block === from.block &&
      wire.from.port === from.port &&
      diagram.blocks.find((b) => b.id === wire.to.block)?.kind === PLOT,
  )?.to.block;
}

/** Whether the diagram already has a control for `target`. */
export function hasControl(diagram: Diagram, target: string): boolean {
  return diagram.blocks.some(
    (block) => block.kind === CONTROL && block.params.target === target,
  );
}

/** A reading a readout can show: a block, given relative to the readout. */
export type Readable = {
  readonly block: string;
  readonly reading: string;
  readonly label: string;
};

/**
 * Every reading in the diagram at `path`, including inside its subsystems, for
 * choosing what a readout shows.
 */
export function readables(
  doc: LabDocument,
  path: Path,
  readings: ReadonlyMap<string, readonly { readonly label: string }[]>,
): Readable[] {
  const diagram = diagramAt(doc, path);
  if (!diagram) {
    return [];
  }

  return everyBlock(diagram).flatMap(({ id, block }) =>
    (readings.get(pathId(path, id)) ?? []).map((reading) => ({
      block: id,
      reading: reading.label,
      label: `${displayName(block)} › ${reading.label}`,
    })),
  );
}
