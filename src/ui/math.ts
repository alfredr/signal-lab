// TeX math rendered to MathML by Temml. Temml is loaded as a classic script
// (vendor/temml.min.js) that defines a global; without it, math shows as its TeX source.

import type Temml from 'temml';

export function renderMath(tex: string, display: boolean): Node {
  const temml = (globalThis as { temml?: typeof Temml }).temml;
  if (!temml) {
    return document.createTextNode(display ? `$$${tex}$$` : `$${tex}$`);
  }

  const holder = document.createElement('span');
  temml.render(tex, holder, { displayMode: display, throwOnError: false });
  return holder.firstChild ?? holder;
}
