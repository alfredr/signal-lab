// Parameter names and the scopes they live in. A block's bindings, and a control set to a
// parameter, name parameters of their own diagram or of a diagram around it, the nearest
// declaration winning. Whatever moves blocks or parameters between diagrams, or renames one,
// has to leave every name pointing at the declaration it pointed at before; these are the tools
// for that.

import type { Diagram, LabBlock } from './document.ts';
import {
  isParameterName,
  namesIn,
  parseExpression,
  renameIn,
} from './expressions.ts';

// As in blocks/instruments.ts, which the model can't import without pulling
// in the block library.
const CONTROL_KIND = 'control';

/**
 * The names a block uses where it sits: in its bindings (for a subsystem, the
 * expressions that set its parameters) and, for a control, the parameter it
 * sets.
 */
function namesUsedBy(block: LabBlock): string[] {
  const names = Object.values(block.bindings ?? {}).flatMap((expression) => {
    const parsed = parseExpression(expression);
    return parsed.ok ? namesIn(parsed.value) : [];
  });
  const target = block.params.target;
  return block.kind === CONTROL_KIND &&
    typeof target === 'string' &&
    isParameterName(target)
    ? [...names, target]
    : names;
}

const declared = (diagram: Diagram) =>
  new Set(diagram.parameters?.map((p) => p.name));

/**
 * The names used in a diagram, or in the subsystems inside it, that it doesn't
 * declare itself: those that reach out to the diagrams around it.
 */
export function freeNames(diagram: Diagram): Set<string> {
  const own = declared(diagram);
  const free = new Set<string>();
  for (const block of diagram.blocks) {
    const used = [
      ...namesUsedBy(block),
      ...(block.inner ? freeNames(block.inner) : []),
    ];
    for (const name of used) {
      if (!own.has(name)) {
        free.add(name);
      }
    }
  }

  return free;
}

/** Every name declared in a diagram and in the subsystems inside it. */
export function declaredWithin(diagram: Diagram): Set<string> {
  return new Set([
    ...declared(diagram),
    ...diagram.blocks.flatMap((block) =>
      block.inner ? [...declaredWithin(block.inner)] : [],
    ),
  ]);
}

/** `base`, or `base` with a number after it, whichever `taken` lacks. */
export function freshName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let k = 2; taken.has(name); k++) {
    name = `${base}${k}`;
  }

  return name;
}

/**
 * Points what uses parameters in a diagram at new names, all at once: its
 * blocks' bindings and the controls that set them, and the same in the
 * subsystems inside it, except where a subsystem declares a parameter of that
 * name itself, which hides the one outside. A name can also map to an
 * expression in parentheses, which only bindings take.
 */
export function renameUses<D extends Diagram>(
  diagram: D,
  renames: ReadonlyMap<string, string>,
): D {
  if (!renames.size) {
    return diagram;
  }

  return {
    ...diagram,
    blocks: diagram.blocks.map((block) => {
      let next = block;
      const target = block.params.target;
      const to = typeof target === 'string' ? renames.get(target) : undefined;
      if (block.kind === CONTROL_KIND && to && isParameterName(to)) {
        next = { ...next, params: { ...next.params, target: to } };
      }

      if (block.bindings) {
        next = {
          ...next,
          bindings: Object.fromEntries(
            Object.entries(block.bindings).map(([setting, expression]) => [
              setting,
              renameIn(expression, renames),
            ]),
          ),
        };
      }

      if (block.inner) {
        const own = declared(block.inner);
        const seen = new Map([...renames].filter(([name]) => !own.has(name)));
        next = { ...next, inner: renameUses(block.inner, seen) };
      }

      return next;
    }),
  };
}
