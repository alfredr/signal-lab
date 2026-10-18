// Text with TeX math: $...$ inline and $$...$$ displayed, rendered to MathML by Temml. Temml is
// loaded as a classic script (vendor/temml.min.js) that defines a global; without it, math
// shows as its TeX source.

import type Temml from "temml";

const MATH = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$((?:\\.|[^$\\\n])+?)\$/g;

function renderMath(tex: string, display: boolean): Node {
  const temml = (globalThis as { temml?: typeof Temml }).temml;
  if (!temml) return document.createTextNode(display ? `$$${tex}$$` : `$${tex}$`);
  const holder = document.createElement("span");
  temml.render(tex, holder, { displayMode: display, throwOnError: false });
  return holder.firstChild ?? holder;
}

/** The text with its math rendered. */
export function richText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(MATH)) {
    fragment.append(text.slice(last, match.index).replace(/\\\$/g, "$"));
    const display = match[1] !== undefined;
    fragment.append(renderMath(display ? match[1]! : match[2]!, display));
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last).replace(/\\\$/g, "$"));
  return fragment;
}

/** One paragraph per blank-line-separated block of text, with math rendered. */
export function richParagraphs(text: string): HTMLParagraphElement[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const paragraph = document.createElement("p");
      paragraph.append(richText(part));
      return paragraph;
    });
}

const SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  eta: "η",
  mu: "μ",
  pi: "π",
  tau: "τ",
  phi: "φ",
  varphi: "φ",
  omega: "ω",
  pm: "±",
  cdot: "·",
  circ: "°",
  infty: "∞",
  sqrt: "√",
  tfrac12: "½",
};

/** A rough plain-text reading of TeX, for tooltips: $\cos 2\pi f_0 t$ becomes "cos 2π f_0 t". */
export function plainText(text: string): string {
  return text
    .replace(/(?<!\\)\$\$?/g, "")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\^\\circ/g, "°")
    .replace(/\\([a-zA-Z]+[0-9]*)/g, (_, name: string) => SYMBOLS[name] ?? name)
    .replace(/\\[,;! ]/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\\$/g, "$");
}
