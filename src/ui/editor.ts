// The block-diagram editor: an SVG canvas that draws one diagram (the document's top level or
// the inside of a subsystem) and turns pointer gestures into edits. It never changes anything
// itself; it reports new versions of the diagram through `change`, as previews while a gesture
// is under way and as a commit when it ends.

import type { BlockType } from "../engine/block.ts";
import { portKey, type PortRef } from "../engine/circuit.ts";
import { resolveParams } from "../engine/params.ts";
import type { BlockStatus } from "../engine/simulator.ts";
import { connect, isSubsystem, moveBlocks, pathId, removeWire, sameRef, terminals, wireInto, type Diagram, type LabBlock, type Path } from "../model/document.ts";
import { typeOf } from "../model/subsystems.ts";
import { visiblePorts } from "../engine/block.ts";
import { svg } from "./dom.ts";
import { layoutOf, roundedPath, route, snap, type BlockLayout, type Point, type PortPlace } from "./geometry.ts";
import { probeColor, rateLabel } from "./labels.ts";

export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "blocks"; readonly ids: readonly string[] }
  | { readonly kind: "wire"; readonly id: string };

export const NOTHING: Selection = { kind: "none" };

export function selectBlocks(ids: readonly string[]): Selection {
  return ids.length ? { kind: "blocks", ids } : NOTHING;
}

export function selectedBlocks(selection: Selection): readonly string[] {
  return selection.kind === "blocks" ? selection.ids : [];
}

export type EditorModel = {
  readonly diagram: Diagram;
  /** Where the diagram sits in the document; statuses and probes are keyed by full id. */
  readonly path: Path;
  readonly selection: Selection;
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Probe number (1-based) by full output port key. */
  readonly probes: ReadonlyMap<string, number>;
};

/** What a right-click landed on. Port refs are local to the diagram on screen. */
export type MenuTarget =
  | { readonly kind: "canvas" }
  | { readonly kind: "blocks"; readonly ids: readonly string[] }
  | { readonly kind: "wire"; readonly id: string }
  | { readonly kind: "port"; readonly direction: "in" | "out"; readonly ref: PortRef };

export type EditorEvents = {
  change(next: Diagram, mode: "preview" | "commit"): void;
  select(selection: Selection): void;
  /** Open a subsystem to edit what is inside. */
  open(id: string): void;
  /** Add a palette entry dropped on the canvas, centered on `at`. */
  add(key: string, at: Point): void;
  /** A right-click (or long press): `client` is where to show a menu, `at` the diagram point. */
  menu(target: MenuTarget, client: Point, at: Point): void;
};

/** Data type the palette puts on drag-and-drop transfers. */
export const BLOCK_DRAG_TYPE = "application/x-signal-lab-block";

type View = {
  readonly x: number;
  readonly y: number;
  /** Screen pixels per diagram unit. */
  readonly scale: number;
};

type Drag =
  | { readonly kind: "pan"; readonly origin: Point; readonly view: View; moved: boolean }
  | { readonly kind: "pinch"; readonly scale: number; readonly distance: number; readonly anchor: Point }
  | { readonly kind: "move"; readonly ids: ReadonlySet<string>; readonly origin: Point; readonly base: Diagram; readonly only: string | undefined; moved: boolean }
  | { readonly kind: "marquee"; readonly origin: Point; pointer: Point; readonly keep: readonly string[] }
  | { readonly kind: "wire"; readonly from: PortRef; readonly base: Diagram; readonly detached: boolean; pointer: Point; target: PortRef | undefined };

const UNKNOWN: BlockLayout = { width: 144, height: 56, inputs: [], outputs: [] };

function layoutFor(block: LabBlock): BlockLayout {
  const type = typeOf(block);
  return type ? layoutOf(type) : UNKNOWN;
}

function place(block: LabBlock, direction: "in" | "out", port: number): PortPlace | undefined {
  const layout = layoutFor(block);
  const local = (direction === "in" ? layout.inputs : layout.outputs)[port];
  return local && { x: block.x + local.x, y: block.y + local.y, side: local.side };
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
const probeStyle = (probe: number | undefined) => (probe === undefined ? undefined : `--probe: ${probeColor(probe)}`);

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
        svg("pattern", { id: "grid-dots", width: 24, height: 24, patternUnits: "userSpaceOnUse" }, svg("circle", { cx: 0.5, cy: 0.5, r: 1, class: "grid-dot" })),
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
    this.element.addEventListener("dblclick", (event) => {
      const id = (event.target as Element).closest<SVGElement>("[data-block]")?.dataset.block;
      const block = id ? this.#model?.diagram.blocks.find((b) => b.id === id) : undefined;
      if (block && isSubsystem(block)) this.#events.open(block.id);
    });
    this.element.addEventListener("contextmenu", (event) => this.#contextMenu(event));
    this.element.addEventListener("wheel", (event) => this.#wheel(event), { passive: false });
    this.element.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes(BLOCK_DRAG_TYPE)) event.preventDefault();
    });
    this.element.addEventListener("drop", (event) => {
      const key = event.dataTransfer?.getData(BLOCK_DRAG_TYPE);
      if (!key) return;
      event.preventDefault();
      this.#events.add(key, this.#toDiagram(event.clientX, event.clientY));
    });
    new ResizeObserver(() => this.#applyView()).observe(this.element);
  }

  render(model: EditorModel): void {
    this.#model = model;
    const { diagram, path, selection } = model;
    const blocks = new Map(diagram.blocks.map((block) => [block.id, block]));
    this.#wires.replaceChildren(
      ...diagram.wires.flatMap((wire) => {
        const from = blocks.get(wire.from.block);
        const to = blocks.get(wire.to.block);
        const start = from && place(from, "out", wire.from.port);
        const end = to && place(to, "in", wire.to.port);
        if (!start || !end) return [];
        const d = roundedPath(route(start, end));
        const source = { block: pathId(path, wire.from.block), port: wire.from.port };
        const probe = model.probes.get(portKey(source));
        const rate = rateLabel(model.status.get(source.block), wire.from.port);
        const selected = selection.kind === "wire" && selection.id === wire.id;
        return [
          svg(
            "g",
            { class: classes("wire", selected && "selected", probe !== undefined && "probed"), "data-wire": wire.id, style: probeStyle(probe) },
            svg("path", { class: "wire-hit", d }),
            svg("path", { class: "wire-line", d, "marker-end": "url(#arrow)" }),
            rate === undefined ? null : svg("title", {}, `${rate} sample rate`),
          ),
        ];
      }),
    );
    const terminalNumbers = new Map<string, string>();
    const { inputs, outputs } = terminals(diagram);
    inputs.forEach((t, i) => terminalNumbers.set(t.id, `in ${i + 1}`));
    outputs.forEach((t, i) => terminalNumbers.set(t.id, `out ${i + 1}`));
    this.#blocks.replaceChildren(...diagram.blocks.map((block) => this.#drawBlock(block, model, terminalNumbers.get(block.id))));
    this.#drawOverlay();
  }

  /** Zooms and pans so the whole diagram fits. */
  fit(): void {
    const blocks = this.#model?.diagram.blocks ?? [];
    const { width, height } = this.element.getBoundingClientRect();
    if (!width || !height) return;
    if (!blocks.length) {
      this.#view = { x: -40, y: -40, scale: 1 };
    } else {
      let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const block of blocks) {
        const layout = layoutFor(block);
        left = Math.min(left, block.x);
        top = Math.min(top, block.y - 24);
        right = Math.max(right, block.x + layout.width);
        bottom = Math.max(bottom, block.y + layout.height + 32);
      }
      const margin = 56;
      const scale = Math.min(width / (right - left + 2 * margin), height / (bottom - top + 2 * margin), 1.25);
      this.#view = { x: (left + right) / 2 - width / scale / 2, y: (top + bottom) / 2 - height / scale / 2, scale };
    }
    this.#applyView();
  }

  /** The diagram point at the middle of the visible area, where new blocks go. */
  center(): Point {
    const { width, height } = this.element.getBoundingClientRect();
    return { x: this.#view.x + width / this.#view.scale / 2, y: this.#view.y + height / this.#view.scale / 2 };
  }

  #drawBlock(block: LabBlock, model: EditorModel, terminalNumber: string | undefined): SVGGElement {
    const type = typeOf(block);
    const id = pathId(model.path, block.id);
    const status = model.status.get(id);
    const selected = selectedBlocks(model.selection).includes(block.id);
    const state = status?.state ?? "idle";
    const transform = `translate(${block.x},${block.y})`;
    if (!type) {
      return svg(
        "g",
        { class: classes("block", "error", selected && "selected"), "data-block": block.id, transform },
        svg("rect", { class: "body", width: 144, height: 56, rx: 8 }),
        svg("text", { class: "title", x: 72, y: 28 }, `Unknown: ${block.kind}`),
      );
    }

    const layout = layoutOf(type);
    const { width: w, height: h } = layout;
    const shape = type.shape ?? { kind: "box" };
    const subsystem = isSubsystem(block);
    const summary = subsystem ? `${block.inner.blocks.length} blocks inside` : (type.summary?.(resolveParams(type.params, block.params)) ?? "");
    const group = svg("g", {
      class: classes("block", `shape-${subsystem ? "subsystem" : shape.kind}`, selected && "selected", state !== "ok" && state),
      "data-block": block.id,
      transform,
    });

    switch (shape.kind) {
      case "circle": {
        group.append(svg("circle", { class: "body", cx: w / 2, cy: h / 2, r: w / 2 - 1 }), svg("text", { class: "symbol", x: w / 2, y: h / 2 + 1 }, shape.symbol));
        if (block.name) {
          // Centered above, unless a top input claims that spot; then up and to the right.
          const topInput = visiblePorts(type.inputs).some(({ port }) => port.side === "top");
          group.append(
            topInput
              ? svg("text", { class: "label", x: w + 2, y: -2, "text-anchor": "start" }, block.name)
              : svg("text", { class: "label", x: w / 2, y: -10 }, block.name),
          );
        }
        if (summary) group.append(svg("text", { class: "summary", x: w / 2, y: h + 16 }, summary));
        break;
      }
      case "triangle":
        group.append(svg("path", { class: "body", d: `M1,1 L${w - 1},${h / 2} L1,${h - 1} Z` }), svg("text", { class: "summary inside", x: w * 0.36, y: h / 2 + 1 }, summary));
        if (block.name) group.append(svg("text", { class: "label", x: w / 2, y: -8 }, block.name));
        break;
      case "antenna": {
        const transmit = visiblePorts(type.inputs).length > 0;
        const foot = 56;
        group.append(
          // A hit area, since the antenna itself is just lines.
          svg("rect", { class: "hit", x: 0, y: 0, width: w, height: h }),
          svg("path", { class: "antenna", d: `M${w / 2},${foot} V16 M10,2 L${w / 2},16 L${w - 10},2 M${transmit ? 0 : w / 2},${foot} H${transmit ? w / 2 : w}` }),
          svg("path", {
            class: "waves",
            d: transmit ? `M${w - 6},8 a10,10 0 0 1 0,14 M${w - 1},4 a16,16 0 0 1 0,22` : `M6,8 a10,10 0 0 0 0,14 M1,4 a16,16 0 0 0 0,22`,
          }),
          svg("text", { class: "label", x: w / 2, y: h + 14 }, block.name || (transmit ? "Transmit" : "Receive")),
        );
        if (summary) group.append(svg("text", { class: "summary", x: w / 2, y: h + 28 }, summary));
        break;
      }
      case "terminal":
        group.append(svg("rect", { class: "body", width: w, height: h, rx: h / 2 }), svg("text", { class: "title", x: w / 2, y: h / 2 + 1 }, block.name || terminalNumber || type.label));
        break;
      default:
        if (subsystem) group.append(svg("rect", { class: "body stack", x: 5, y: 5, width: w, height: h, rx: 8 }));
        group.append(
          svg("rect", { class: "body", width: w, height: h, rx: 8 }),
          svg("text", { class: "title", x: w / 2, y: summary ? h / 2 - 8 : h / 2 + 1 }, block.name || type.label),
        );
        if (summary) group.append(svg("text", { class: "summary", x: w / 2, y: h / 2 + 11 }, summary));
    }

    const named = (ports: BlockType["inputs"]) => shape.kind === "box" && visiblePorts(ports).length > 1;
    type.inputs.forEach((port, i) => {
      const p = layout.inputs[i];
      if (!p) return;
      const target = this.#drag?.kind === "wire" && this.#drag.target && sameRef(this.#drag.target, { block: block.id, port: i });
      group.append(
        svg("circle", { class: classes("port", "in", target && "target"), cx: p.x, cy: p.y, r: 4.5 }),
        svg("circle", { class: "port-hit", cx: p.x, cy: p.y, r: 11, "data-port": `in:${i}` }, svg("title", {}, `input ${port.name}`)),
      );
      if (named(type.inputs) && p.side === "left") group.append(svg("text", { class: "port-name", x: p.x + 12, y: p.y + 1, "text-anchor": "start" }, port.name));
    });
    type.outputs.forEach((port, i) => {
      const p = layout.outputs[i];
      if (!p) return;
      const probe = model.probes.get(portKey({ block: id, port: i }));
      group.append(
        svg("circle", { class: classes("port", "out", probe !== undefined && "probed"), cx: p.x, cy: p.y, r: 4.5, style: probeStyle(probe) }),
        svg("circle", { class: "port-hit", cx: p.x, cy: p.y, r: 11, "data-port": `out:${i}` }, svg("title", {}, `output ${port.name}`)),
      );
      if (named(type.outputs)) group.append(svg("text", { class: "port-name", x: p.x - 12, y: p.y + 1, "text-anchor": "end" }, port.name));
      if (probe !== undefined) group.append(svg("text", { class: "probe-tag", x: p.x + 8, y: p.y - 9, style: probeStyle(probe) }, String(probe)));
    });

    if (status?.state === "error") {
      group.append(svg("g", { class: "badge" }, svg("circle", { cx: w - 4, cy: 4, r: 8 }), svg("text", { x: w - 4, y: 5 }, "!"), svg("title", {}, status.message)));
    } else if (status?.state === "idle") {
      group.append(svg("title", {}, status.reason));
    }
    return group;
  }

  #drawOverlay(): void {
    const drag = this.#drag;
    const diagram = this.#model?.diagram;
    if (drag?.kind === "marquee") {
      const { x, y, width, height } = rectangle(drag.origin, drag.pointer);
      this.#overlay.replaceChildren(svg("rect", { class: "marquee", x, y, width, height }));
      return;
    }
    if (drag?.kind !== "wire" || !diagram) {
      this.#overlay.replaceChildren();
      return;
    }
    const source = diagram.blocks.find((b) => b.id === drag.from.block);
    const start = source && place(source, "out", drag.from.port);
    if (!start) return;
    const targetBlock = drag.target && diagram.blocks.find((b) => b.id === drag.target!.block);
    const end = (targetBlock && drag.target && place(targetBlock, "in", drag.target.port)) || { ...drag.pointer, side: "left" as const };
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
    const selected = selectedBlocks(model.selection);

    if (port && blockId) {
      const [direction, index] = port.dataset.port!.split(":");
      const ref = { block: blockId, port: Number(index) };
      if (direction === "out") {
        this.#drag = { kind: "wire", from: ref, base: model.diagram, detached: false, pointer, target: undefined };
      } else {
        // Grabbing a connected input picks up the wire's loose end.
        const wire = wireInto(model.diagram, ref);
        if (!wire) return;
        const base = removeWire(model.diagram, wire.id);
        this.#drag = { kind: "wire", from: wire.from, base, detached: true, pointer, target: ref };
        this.#events.change(base, "preview");
      }
    } else if (blockId) {
      let ids: readonly string[];
      if (event.shiftKey) {
        ids = selected.includes(blockId) ? selected.filter((id) => id !== blockId) : [...selected, blockId];
      } else {
        ids = selected.includes(blockId) ? selected : [blockId];
      }
      this.#events.select(selectBlocks(ids));
      if (!ids.includes(blockId)) return;
      // A plain click on one block of a larger selection narrows it to that block, unless it turns into a drag.
      const only = !event.shiftKey && ids.length > 1 ? blockId : undefined;
      this.#drag = { kind: "move", ids: new Set(ids), origin: pointer, base: model.diagram, only, moved: false };
    } else if (wireId) {
      this.#events.select({ kind: "wire", id: wireId });
      return;
    } else if (event.shiftKey) {
      this.#drag = { kind: "marquee", origin: pointer, pointer, keep: selected };
    } else {
      this.#drag = { kind: "pan", origin: { x: event.clientX, y: event.clientY }, view: this.#view, moved: false };
    }
    this.element.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #contextMenu(event: MouseEvent): void {
    const model = this.#model;
    if (!model) return;
    event.preventDefault();
    this.#cancelDrag();
    const target = event.target as Element;
    const port = target.closest<SVGElement>("[data-port]");
    const blockId = target.closest<SVGElement>("[data-block]")?.dataset.block;
    const wireId = target.closest<SVGElement>("[data-wire]")?.dataset.wire;
    let hit: MenuTarget = { kind: "canvas" };
    if (port && blockId) {
      const [direction, index] = port.dataset.port!.split(":");
      hit = { kind: "port", direction: direction === "in" ? "in" : "out", ref: { block: blockId, port: Number(index) } };
    } else if (blockId) {
      // Right-clicking outside the selection selects what was clicked, as in most editors.
      const selected = selectedBlocks(model.selection);
      const ids = selected.includes(blockId) ? selected : [blockId];
      if (ids !== selected) this.#events.select(selectBlocks(ids));
      hit = { kind: "blocks", ids };
    } else if (wireId) {
      this.#events.select({ kind: "wire", id: wireId });
      hit = { kind: "wire", id: wireId };
    }
    this.#events.menu(hit, { x: event.clientX, y: event.clientY }, this.#toDiagram(event.clientX, event.clientY));
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
        const dx = snap(pointer.x - drag.origin.x);
        const dy = snap(pointer.y - drag.origin.y);
        if (dx || dy || drag.moved) {
          drag.moved = true;
          this.#events.change(moveBlocks(drag.base, drag.ids, dx, dy), "preview");
        }
        break;
      }
      case "marquee": {
        drag.pointer = this.#toDiagram(event.clientX, event.clientY);
        const box = rectangle(drag.origin, drag.pointer);
        const inside = model.diagram.blocks
          .filter((block) => {
            const { width, height } = layoutFor(block);
            return block.x < box.x + box.width && block.x + width > box.x && block.y < box.y + box.height && block.y + height > box.y;
          })
          .map((block) => block.id);
        this.#events.select(selectBlocks([...new Set([...drag.keep, ...inside])]));
        break;
      }
      case "wire":
        drag.pointer = this.#toDiagram(event.clientX, event.clientY);
        drag.target = this.#inputUnder(event.clientX, event.clientY);
        this.render(model);
        break;
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
        if (drag.moved) this.#events.change(model.diagram, "commit");
        else if (drag.only) this.#events.select(selectBlocks([drag.only]));
        break;
      case "marquee":
        this.render(model);
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
    if (drag?.kind === "move" && drag.moved && this.#model) this.#events.change(this.#model.diagram, "commit");
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
}

function rectangle(a: Point, b: Point): { x: number; y: number; width: number; height: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
