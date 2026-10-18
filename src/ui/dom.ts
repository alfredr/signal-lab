// Small helpers for building DOM and SVG trees without a framework.

type Attributes = { readonly [name: string]: string | number | boolean | undefined };
type Child = Node | string | number | false | null | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(element: Element, attributes: Attributes, children: readonly Child[]): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "number" ? String(child) : child);
  }
}

export function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  apply(element, attributes, children);
  return element;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  apply(element, attributes, children);
  return element;
}

/** True when keyboard input is going to a text field rather than the app. */
export function isTyping(target: EventTarget | null): boolean {
  // A shape check: keyboard targets are elements, the window or the document.
  const element = target as Partial<HTMLElement> | null;
  return Boolean(element?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? "");
}
