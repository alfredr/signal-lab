// The block-diagram editor: an SVG canvas that draws the document and turns pointer gestures
// into document edits. It never changes the document itself; it reports new versions through
// `change`, as previews while a gesture is under way and as a commit when it ends.

import { blockType } from "../blocks/index.ts";
import type { BlockType } from "../engine/block.ts";
import { portKey, type BlockNode, type PortRef } from "../engine/circuit.ts";
import { si } from "../engine/format.ts";
import { resolveParams } from "../engine/params.ts";
import type { BlockStatus } from "../engine/simulator.ts";
import { addBlock, connect, moveBlock, removeWire, sameRef, wireInto, type LabDocument } from "./doc.ts";
import { svg } from "./dom.ts";
import { layoutBlock, roundedPath, route, snap, type BlockLayout, type Point, type PortPlace } from "./geometry.ts";

export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "block"; readonly id: string }
  | { readonly kind: "wire"; readonly id: string };

export const NOTHING: Selection = { kind: "none" };

export interface EditorModel {
  readonly doc: LabDocument;
  readonly selection: Selection;
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Probe number (1-based) for each probed output port, by port key. */
  readonly probes: ReadonlyMap<string, number>;
}

export interface EditorEvents {
  change(next: LabDocument, mode: "preview" | "commit"): void;
  select(selection: Selection): void;
}

/** Data type the palette puts on drag-and-drop transfers. */
export const BLOCK_DRAG_TYPE = "application/x-signal-lab-block";

interface View {
  readonly x: number;
  readonly y: number;
  /** Screen pixels per diagram unit. */
  readonly scale: number;
}

type Drag =
  | { readonly kind: "pan"; readonly origin: Point; readonly view: View; moved: boolean }
  | { readonly kind: "pinch"; readonly scale: number; readonly distance: number; readonly anchor: Point }
  | { readonly kind: "move"; readonly id: string; readonly grab: Point; moved: boolean }
  | { readonly kind: "wire"; readonly from: PortRef; readonly base: LabDocument; readonly detached: boolean; pointer: Point; target: PortRef | undefined };

const layouts = new Map<string, BlockLayout>();
function layoutOf(type: BlockType): BlockLayout {
  let layout = layouts.get(type.kind);
  if (!layout) layouts.set(type.kind, (layout = layoutBlock(type)));
  return layout;
}

function place(block: BlockNode, layout: BlockLayout, direction: "in" | "out", port: number): PortPlace | undefined {
  const local = (direction === "in" ? layout.inputs : layout.outputs)[port];
  return local && { x: block.x + local.x, y: block.y + local.y, side: local.side };
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export class DiagramEditor {
  readonly element: SVGSVGElement;
  readonly #events: EditorEvents;
  readonly #grid: SVGRectElement;
  readonly #wires: SVGGElement;
  readonly #blocks: SVGGElement;
  readonly #overlay: SVGGElement;
  #model: EditorModel | undefined;
  #view: View = { x: -40, y: -40, scale: 1 };
  #drag: Drag | undefined;
  /** Pointers currently down, in client coordinates; two of them make a pinch. */
  readonly #pointers = new Map<number, Point>();

  constructor(host: HTMLElement, events: EditorEvents) {
    this.#events = events;
    this.#grid = svg("rect", { class: "grid", fill: "url(#grid-dots)" });
    this.#wires = svg("g", { class: "wires" });
    this.#blocks = svg("g", { class: "blocks" });
    this.#overlay = svg("g", { class: "overlay" });
    this.element = svg(
      "svg",
      { class: "diagram", role: "application", "aria-label": "Block diagram", tabindex: 0 },
      svg(
        "defs",
        {},
        svg(
          "pattern",
          { id: "grid-dots", width: 24, height: 24, patternUnits: "userSpaceOnUse" },
          svg("circle", { cx: 0.5, cy: 0.5, r: 1, class: "grid-dot" }),
        ),
        svg(
          "marker",
          { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" },
          svg("path", { d: "M0,1 L9,5 L0,9 z", fill: "context-stroke" }),
        ),
      ),
      this.#grid,
      this.#wires,
      this.#blocks,
      this.#overlay,
    );
    host.append(this.element);

    this.element.addEventListener("pointerdown", (event) => this.#pointerDown(event));
    this.element.addEventListener("pointermove", (event) => this.#pointerMove(event));
    this.element.addEventListener("pointerup", (event) => this.#pointerUp(event));
    this.element.addEventListener("pointercancel", (event) => {
      this.#pointers.delete(event.pointerId);
      this.#cancelDrag();
    });
    this.element.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    this.element.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes(BLOCK_DRAG_TYPE)) event.preventDefault();
    });
    this.element.addEventListener("drop", (event) => this.#drop(event));
    new ResizeObserver(() => this.#applyView()).observe(this.element);
  }

  render(model: EditorModel): void {
    this.#model = model;
    const blocks = new Map(model.doc.blocks.map((block) => [block.id, block]));
    this.#wires.replaceChildren(
      ...model.doc.wires.flatMap((wire) => {
        const from = blocks.get(wire.from.block);
        const to = blocks.get(wire.to.block);
        const fromType = from && blockType(from.kind);
        const toType = to && blockType(to.kind);
        const start = from && fromType && place(from, layoutOf(fromType), "out", wire.from.port);
        const end = to && toType && place(to, layoutOf(toType), "in", wire.to.port);
        if (!start || !end) return [];
        const d = roundedPath(route(start, end));
        const probe = model.probes.get(portKey(wire.from));
        const status = model.status.get(wire.from.block);
        const rate = status?.state === "ok" ? status.rates[wire.from.port] : undefined;
        const selected = model.selection.kind === "wire" && model.selection.id === wire.id;
        return [
          svg(
            "g",
            {
              class: classes("wire", selected && "selected", probe !== undefined && "probed"),
              "data-wire": wire.id,
              style: probe !== undefined ? `--probe: var(--probe-${((probe - 1) % 6) + 1})` : undefined,
            },
            svg("path", { class: "wire-hit", d }),
            svg("path", { class: "wire-line", d, "marker-end": "url(#arrow)" }),
            rate === undefined ? null : svg("title", {}, `${si(rate, "Hz")} sample rate`),
          ),
        ];
      }),
    );
    this.#blocks.replaceChildren(...model.doc.blocks.map((block) => this.#drawBlock(block, model)));
    this.#drawDragWire();
  }

  /** Zooms and pans so the whole diagram fits. */
  fit(): void {
    const blocks = this.#model?.doc.blocks ?? [];
    const { width, height } = this.element.getBoundingClientRect();
    if (!width || !height) return;
    if (!blocks.length) {
      this.#view = { x: -40, y: -40, scale: 1 };
    } else {
      let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const block of blocks) {
        const type = blockType(block.kind);
        const layout = type ? layoutOf(type) : { width: 144, height: 56 };
        left = Math.min(left, block.x);
        top = Math.min(top, block.y - 24);
        right = Math.max(right, block.x + layout.width);
        bottom = Math.max(bottom, block.y + layout.height + 32);
      }
      const margin = 40;
      const scale = Math.min(width / (right - left + 2 * margin), height / (bottom - top + 2 * margin), 1.25);
      this.#view = {
        x: (left + right) / 2 - width / scale / 2,
        y: (top + bottom) / 2 - height / scale / 2,
        scale,
      };
    }
    this.#applyView();
  }

  /** The diagram point at the middle of the visible area, where new blocks go. */
  center(): Point {
    const { width, height } = this.element.getBoundingClientRect();
    return { x: this.#view.x + width / this.#view.scale / 2, y: this.#view.y + height / this.#view.scale / 2 };
  }

  #drawBlock(block: BlockNode, model: EditorModel): SVGGElement {
    const type = blockType(block.kind);
    const status = model.status.get(block.id);
    const selected = model.selection.kind === "block" && model.selection.id === block.id;
    if (!type) {
      return svg(
        "g",
        { class: classes("block", "error", selected && "selected"), "data-block": block.id, transform: `translate(${block.x},${block.y})` },
        svg("rect", { class: "body", width: 144, height: 56, rx: 8 }),
        svg("text", { class: "title", x: 72, y: 28 }, `Unknown: ${block.kind}`),
      );
    }

    const layout = layoutOf(type);
    const { width: w, height: h } = layout;
    const shape = type.shape ?? { kind: "box" };
    const summary = type.summary?.(resolveParams(type.params, block.params)) ?? "";
    const state = status?.state ?? "idle";
    const group = svg("g", {
      class: classes("block", `shape-${shape.kind}`, selected && "selected", state !== "ok" && state),
      "data-block": block.id,
      transform: `translate(${block.x},${block.y})`,
    });

    if (shape.kind === "circle") {
      group.append(
        svg("circle", { class: "body", cx: w / 2, cy: h / 2, r: w / 2 - 1 }),
        svg("text", { class: "symbol", x: w / 2, y: h / 2 + 1 }, shape.symbol),
      );
      if (block.name) {
        // Centered above, unless a top input claims that spot; then up and to the right.
        const topInput = type.inputs.some((port) => port.side === "top");
        group.append(
          topInput
            ? svg("text", { class: "label", x: w + 2, y: -2, "text-anchor": "start" }, block.name)
            : svg("text", { class: "label", x: w / 2, y: -10 }, block.name),
        );
      }
      if (summary) group.append(svg("text", { class: "summary", x: w / 2, y: h + 16 }, summary));
    } else if (shape.kind === "triangle") {
      group.append(
        svg("path", { class: "body", d: `M1,1 L${w - 1},${h / 2} L1,${h - 1} Z` }),
        svg("text", { class: "summary inside", x: w * 0.36, y: h / 2 + 1 }, summary),
      );
      if (block.name) group.append(svg("text", { class: "label", x: w / 2, y: -8 }, block.name));
    } else {
      group.append(
        svg("rect", { class: "body", width: w, height: h, rx: 8 }),
        svg("text", { class: "title", x: w / 2, y: summary ? h / 2 - 8 : h / 2 + 1 }, block.name || type.label),
      );
      if (summary) group.append(svg("text", { class: "summary", x: w / 2, y: h / 2 + 11 }, summary));
    }

    const named = (count: number) => shape.kind === "box" && count > 1;
    type.inputs.forEach((port, i) => {
      const p = layout.inputs[i];
      const ref = { block: block.id, port: i };
      const target = this.#drag?.kind === "wire" && this.#drag.target && sameRef(this.#drag.target, ref);
      group.append(
        svg("circle", { class: classes("port", "in", target && "target"), cx: p.x, cy: p.y, r: 4.5 }),
        svg("circle", { class: "port-hit", cx: p.x, cy: p.y, r: 11, "data-port": `in:${i}` }, svg("title", {}, `input ${port.name}`)),
      );
      if (named(type.inputs.length) && p.side === "left") group.append(svg("text", { class: "port-name", x: p.x + 9, y: p.y + 1, "text-anchor": "start" }, port.name));
    });
    type.outputs.forEach((port, i) => {
      const p = layout.outputs[i];
      const probe = model.probes.get(portKey({ block: block.id, port: i }));
      group.append(
        svg("circle", {
          class: classes("port", "out", probe !== undefined && "probed"),
          cx: p.x,
          cy: p.y,
          r: 4.5,
          style: probe !== undefined ? `--probe: var(--probe-${((probe - 1) % 6) + 1})` : undefined,
        }),
        svg("circle", { class: "port-hit", cx: p.x, cy: p.y, r: 11, "data-port": `out:${i}` }, svg("title", {}, `output ${port.name}`)),
      );
      if (named(type.outputs.length)) group.append(svg("text", { class: "port-name", x: p.x - 9, y: p.y + 1, "text-anchor": "end" }, port.name));
      if (probe !== undefined) {
        group.append(svg("text", { class: "probe-tag", x: p.x + 8, y: p.y - 9, style: `--probe: var(--probe-${((probe - 1) % 6) + 1})` }, String(probe)));
      }
    });

    if (status?.state === "error") {
      group.append(
        svg("g", { class: "badge" }, svg("circle", { cx: w - 4, cy: 4, r: 8 }), svg("text", { x: w - 4, y: 5 }, "!"), svg("title", {}, status.message)),
      );
    } else if (status?.state === "idle") {
      group.append(svg("title", {}, status.reason));
    }
    return group;
  }

  #drawDragWire(): void {
    const drag = this.#drag;
    const doc = this.#model?.doc;
    if (drag?.kind !== "wire" || !doc) {
      this.#overlay.replaceChildren();
      return;
    }
    const block = doc.blocks.find((b) => b.id === drag.from.block);
    const type = block && blockType(block.kind);
    const start = block && type && place(block, layoutOf(type), "out", drag.from.port);
    if (!start) return;
    let end: PortPlace = { ...drag.pointer, side: "left" };
    if (drag.target) {
      const targetBlock = doc.blocks.find((b) => b.id === drag.target!.block);
      const targetType = targetBlock && blockType(targetBlock.kind);
      end = (targetBlock && targetType && place(targetBlock, layoutOf(targetType), "in", drag.target.port)) || end;
    }
    this.#overlay.replaceChildren(svg("path", { class: "wire-line dragging", d: roundedPath(route(start, end)) }));
  }

  #toDiagram(clientX: number, clientY: number): Point {
    const rect = this.element.getBoundingClientRect();
    return { x: this.#view.x + (clientX - rect.left) / this.#view.scale, y: this.#view.y + (clientY - rect.top) / this.#view.scale };
  }

  #applyView(): void {
    const { width, height } = this.element.getBoundingClientRect();
    const { x, y, scale } = this.#view;
    const box = { x, y, width: width / scale, height: height / scale };
    this.element.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    for (const [name, value] of Object.entries(box)) this.#grid.setAttribute(name, String(value));
  }

  #inputUnder(clientX: number, clientY: number): PortRef | undefined {
    const hit = document.elementFromPoint(clientX, clientY)?.closest<SVGElement>("[data-port^='in:']");
    const block = hit?.closest<SVGElement>("[data-block]")?.dataset.block;
    return hit && block ? { block, port: Number(hit.dataset.port!.slice(3)) } : undefined;
  }

  #pinchState(): { middle: Point; distance: number } {
    const [a, b] = [...this.#pointers.values()];
    return { middle: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)) };
  }

  #pointerDown(event: PointerEvent): void {
    const model = this.#model;
    if (!model || (event.pointerType === "mouse" && event.button !== 0)) return;
    this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.#pointers.size === 2) {
      // A second finger turns whatever the first one started into a pinch.
      this.#cancelDrag();
      const { middle, distance } = this.#pinchState();
      this.#drag = { kind: "pinch", scale: this.#view.scale, distance, anchor: this.#toDiagram(middle.x, middle.y) };
      this.element.setPointerCapture(event.pointerId);
      return;
    }
    this.element.focus({ preventScroll: true });
    const target = event.target as Element;
    const port = target.closest<SVGElement>("[data-port]");
    const blockId = target.closest<SVGElement>("[data-block]")?.dataset.block;
    const wireId = target.closest<SVGElement>("[data-wire]")?.dataset.wire;
    const pointer = this.#toDiagram(event.clientX, event.clientY);

    if (port && blockId) {
      const [direction, index] = port.dataset.port!.split(":");
      const ref = { block: blockId, port: Number(index) };
      if (direction === "out") {
        this.#drag = { kind: "wire", from: ref, base: model.doc, detached: false, pointer, target: undefined };
      } else {
        // Grabbing a connected input picks up the wire's loose end.
        const wire = wireInto(model.doc, ref);
        if (!wire) return;
        const base = removeWire(model.doc, wire.id);
        this.#drag = { kind: "wire", from: wire.from, base, detached: true, pointer, target: ref };
        this.#events.change(base, "preview");
      }
    } else if (blockId) {
      const block = model.doc.blocks.find((b) => b.id === blockId)!;
      this.#events.select({ kind: "block", id: blockId });
      this.#drag = { kind: "move", id: blockId, grab: { x: pointer.x - block.x, y: pointer.y - block.y }, moved: false };
    } else if (wireId) {
      this.#events.select({ kind: "wire", id: wireId });
      return;
    } else {
      this.#drag = { kind: "pan", origin: { x: event.clientX, y: event.clientY }, view: this.#view, moved: false };
    }
    this.element.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #pointerMove(event: PointerEvent): void {
    if (this.#pointers.has(event.pointerId)) this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const drag = this.#drag;
    const model = this.#model;
    if (!drag || !model) return;
    switch (drag.kind) {
      case "pinch": {
        if (this.#pointers.size < 2) break;
        const { middle, distance } = this.#pinchState();
        const scale = Math.min(3, Math.max(0.2, (drag.scale * distance) / drag.distance));
        const rect = this.element.getBoundingClientRect();
        // Keep the diagram point that started under the fingers under them.
        this.#view = { x: drag.anchor.x - (middle.x - rect.left) / scale, y: drag.anchor.y - (middle.y - rect.top) / scale, scale };
        this.#applyView();
        break;
      }
      case "pan": {
        const dx = event.clientX - drag.origin.x;
        const dy = event.clientY - drag.origin.y;
        drag.moved ||= Math.hypot(dx, dy) > 3;
        this.#view = { ...drag.view, x: drag.view.x - dx / drag.view.scale, y: drag.view.y - dy / drag.view.scale };
        this.#applyView();
        break;
      }
      case "move": {
        const pointer = this.#toDiagram(event.clientX, event.clientY);
        const block = model.doc.blocks.find((b) => b.id === drag.id);
        const x = snap(pointer.x - drag.grab.x);
        const y = snap(pointer.y - drag.grab.y);
        if (block && (block.x !== x || block.y !== y)) {
          drag.moved = true;
          this.#events.change(moveBlock(model.doc, drag.id, x, y), "preview");
        }
        break;
      }
      case "wire": {
        drag.pointer = this.#toDiagram(event.clientX, event.clientY);
        drag.target = this.#inputUnder(event.clientX, event.clientY);
        this.render(model);
        break;
      }
    }
  }

  #pointerUp(event: PointerEvent): void {
    this.#pointers.delete(event.pointerId);
    const drag = this.#drag;
    const model = this.#model;
    this.#drag = undefined;
    if (!drag || !model) return;
    switch (drag.kind) {
      case "pinch":
        break;
      case "pan":
        if (!drag.moved) this.#events.select(NOTHING);
        break;
      case "move":
        if (drag.moved) this.#events.change(model.doc, "commit");
        break;
      case "wire": {
        const target = this.#inputUnder(event.clientX, event.clientY);
        if (target && target.block !== drag.from.block) this.#events.change(connect(drag.base, drag.from, target), "commit");
        else if (drag.detached) this.#events.change(drag.base, "commit");
        else this.render(model);
        break;
      }
    }
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag?.kind === "move" && drag.moved && this.#model) this.#events.change(this.#model.doc, "commit");
    if (drag?.kind === "wire" && drag.detached) this.#events.change(drag.base, "commit");
    if (this.#model) this.render(this.#model);
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y, scale } = this.#view;
    if (event.ctrlKey || event.metaKey) {
      // Pinch gestures and ctrl+wheel zoom around the pointer.
      const pointer = this.#toDiagram(event.clientX, event.clientY);
      const next = Math.min(3, Math.max(0.2, scale * Math.exp(-event.deltaY * 0.01)));
      this.#view = { x: pointer.x - ((pointer.x - x) * scale) / next, y: pointer.y - ((pointer.y - y) * scale) / next, scale: next };
    } else {
      this.#view = { x: x + event.deltaX / scale, y: y + event.deltaY / scale, scale };
    }
    this.#applyView();
  }

  #drop(event: DragEvent): void {
    const kind = event.dataTransfer?.getData(BLOCK_DRAG_TYPE);
    const model = this.#model;
    const type = kind ? blockType(kind) : undefined;
    if (!type || !model) return;
    event.preventDefault();
    const pointer = this.#toDiagram(event.clientX, event.clientY);
    const layout = layoutOf(type);
    const [next, id] = addBlock(model.doc, type.kind, snap(pointer.x - layout.width / 2), snap(pointer.y - layout.height / 2));
    this.#events.change(next, "commit");
    this.#events.select({ kind: "block", id });
  }
}
