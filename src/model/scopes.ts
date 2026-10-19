// Parameter scope analysis and reference rewriting. Bindings and controls
// resolve names to the nearest enclosing declaration. Structural edits and
// renames must preserve that resolution.

import type { Diagram, LabBlock } from './document.ts';
import {
  isParameterName,
  namesIn,
  parseExpression,
  renameIn,
} from './expressions.ts';

// Keep the kind name local to avoid importing the full block library.
const CONTROL_KIND = 'control';

/**
 * Names referenced by a block's bindings or by a control's parameter target.
 * Subsystem bindings are evaluated in the containing diagram.
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
 * Finds names used by this diagram or its descendants without a local
 * declaration.
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

/** Collects parameter declarations in this diagram and all descendants. */
export function declaredWithin(diagram: Diagram): Set<string> {
  return new Set([
    ...declared(diagram),
    ...diagram.blocks.flatMap((block) =>
      block.inner ? [...declaredWithin(block.inner)] : [],
    ),
  ]);
}

/** Finds an unused name by appending a number to `base` when necessary. */
export function freshName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let k = 2; taken.has(name); k++) {
    name = `${base}${k}`;
  }

  return name;
}

/**
 * Rewrites parameter uses simultaneously in bindings and controls, stopping at
 * descendant scopes that redeclare a name. Bindings also accept replacements
 * with parenthesized expressions; controls accept names only.
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
