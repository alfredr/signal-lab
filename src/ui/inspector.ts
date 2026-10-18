// The side panel: settings for what is selected, or for the document when nothing is. It
// rebuilds only when the selection changes; otherwise it updates the existing controls in
// place, so a slider being dragged is never replaced under the pointer.

import { visiblePorts, type BlockType } from "../engine/block.ts";
import { number, resolveParams, type ParamValue } from "../engine/params.ts";
import type { BlockStatus } from "../engine/simulator.ts";
import {
  diagramAt,
  isSubsystem,
  pathId,
  probeAt,
  removeBlocks,
  removeWire,
  renameBlock,
  setParam,
  setSettings,
  toggleProbe,
  updateDiagramAt,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from "../model/document.ts";
import { displayName, typeOf } from "../model/subsystems.ts";
import { paramControl, type ChangeMode, type Control } from "./controls.ts";
import { html } from "./dom.ts";
import { NOTHING, selectedBlocks, type Selection } from "./editor.ts";
import { portLabel, rateLabel } from "./labels.ts";
import { richParagraphs, richText } from "./math.ts";

export type InspectorModel = {
  readonly doc: LabDocument;
  /** The diagram being edited, and where it sits in the document. */
  readonly path: Path;
  readonly diagram: Diagram;
  readonly selection: Selection;
  /** Block statuses by full id. */
  readonly status: ReadonlyMap<string, BlockStatus>;
};

export type InspectorEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  select(selection: Selection): void;
  open(path: Path): void;
  group(ids: readonly string[]): void;
  ungroup(id: string): void;
};

const DURATION = number({ label: "Duration", unit: "s", default: 1, min: 0.01, max: 20, scale: "log", help: "Every signal covers this much time." });

/** Status text for a block, empty when it is running. */
function statusText(status: BlockStatus | undefined): string {
  return status?.state === "error" ? status.message : status?.state === "idle" ? status.reason : "";
}

export class Inspector {
  readonly #host: HTMLElement;
  readonly #events: InspectorEvents;
  #model: InspectorModel | undefined;
  /** Identifies what the panel was built for; a change means rebuilding it. */
  #builtFor = "";
  /** Brings the built panel up to date with a new model. */
  #sync: (model: InspectorModel) => void = () => {};

  constructor(host: HTMLElement, events: InspectorEvents) {
    this.#host = host;
    this.#events = events;
  }

  render(model: InspectorModel): void {
    this.#model = model;
    const { selection, diagram, path } = model;
    const ids = selectedBlocks(selection);
    const block = ids.length === 1 ? diagram.blocks.find((b) => b.id === ids[0]) : undefined;
    const wire = selection.kind === "wire" ? diagram.wires.find((w) => w.id === selection.id) : undefined;
    const key = block
      ? `block:${pathId(path, block.id)}:${block.kind}`
      : ids.length > 1
        ? `blocks:${path.join("/")}`
        : wire
          ? `wire:${path.join("/")}:${wire.id}`
          : "document";
    if (key !== this.#builtFor) {
      this.#builtFor = key;
      const type = block && typeOf(block);
      let panel: HTMLElement;
      if (block && type && isSubsystem(block)) panel = this.#subsystemPanel(block, type);
      else if (block && type) panel = this.#blockPanel(block, type);
      else if (ids.length > 1) panel = this.#selectionPanel();
      else if (wire) panel = this.#wirePanel(wire.id);
      else panel = this.#documentPanel();
      this.#host.replaceChildren(panel);
    }
    this.#sync(model);
  }

  get #now(): InspectorModel {
    return this.#model!;
  }

  /** Applies an edit to the diagram on screen. */
  #edit(change: <T extends Diagram>(diagram: T) => T, mode: ChangeMode): void {
    const { doc, path } = this.#now;
    this.#events.change(updateDiagramAt(doc, path, change), mode);
  }

  #nameField(block: LabBlock, type: BlockType): { element: HTMLElement; sync(block: LabBlock): void } {
    const input = html("input", { type: "text", placeholder: type.label, value: block.name ?? "", spellcheck: "false", autocomplete: "off" });
    input.addEventListener("change", () => this.#edit((d) => renameBlock(d, block.id, input.value), "commit"));
    return {
      element: html("div", { class: "control" }, html("label", { class: "control-label" }, "Name", input)),
      sync: (current) => {
        if (document.activeElement !== input) input.value = current.name ?? "";
      },
    };
  }

  /** Rows for a block's outputs: sample rate and a button to pin each to the bench. */
  #outputRows(fullId: string, type: BlockType): { element: HTMLElement | null; sync(model: InspectorModel): void } {
    const outputs = visiblePorts(type.outputs);
    const rows = outputs.map(({ port, index }) => {
      const rate = html("span", { class: "port-rate" });
      const pin = html("button", { type: "button", class: "small" });
      pin.addEventListener("click", () => this.#events.change(toggleProbe(this.#now.doc, { block: fullId, port: index }), "commit"));
      return { index, rate, pin, row: html("div", { class: "port-row" }, html("span", { class: "port-label" }, outputs.length > 1 ? `Output ${port.name}` : "Output"), rate, pin) };
    });
    return {
      element: rows.length ? html("div", { class: "ports" }, ...rows.map((r) => r.row)) : null,
      sync: (model) => {
        const status = model.status.get(fullId);
        for (const row of rows) {
          row.rate.textContent = rateLabel(status, row.index) ?? "no signal";
          const pinned = probeAt(model.doc, { block: fullId, port: row.index }) !== undefined;
          row.pin.textContent = pinned ? "Unpin" : "Pin to bench";
          row.pin.setAttribute("aria-pressed", String(pinned));
        }
      },
    };
  }

  /** Controls for one block's parameters, editing it wherever it sits in the document. */
  #paramControls(path: Path, block: LabBlock, type: BlockType): { element: HTMLElement; sync(block: LabBlock): void } {
    const controls = new Map<string, Control>();
    const values = resolveParams(type.params, block.params);
    const element = html("div", { class: "params" });
    for (const [param, spec] of Object.entries(type.params)) {
      const control = paramControl(spec, values[param], (value: ParamValue, mode) =>
        this.#events.change(updateDiagramAt(this.#now.doc, path, (d) => setParam(d, block.id, param, value)), mode),
      );
      controls.set(param, control);
      element.append(control.element);
    }
    return {
      element,
      sync: (current) => {
        const now = resolveParams(type.params, current.params);
        for (const [param, control] of controls) control.update(now[param]);
      },
    };
  }

  #deleteButton(ids: readonly string[], label: string): HTMLButtonElement {
    const button = html("button", { type: "button", class: "danger" }, label);
    button.addEventListener("click", () => {
      this.#edit((d) => removeBlocks(d, new Set(ids)), "commit");
      this.#events.select(NOTHING);
    });
    return button;
  }

  #blockPanel(block: LabBlock, type: BlockType): HTMLElement {
    const { path } = this.#now;
    const fullId = pathId(path, block.id);
    const name = this.#nameField(block, type);
    const params = this.#paramControls(path, block, type);
    const outputs = this.#outputRows(fullId, type);
    const status = html("p", { class: "status-note", role: "status" });

    this.#sync = (model) => {
      const current = model.diagram.blocks.find((b) => b.id === block.id);
      if (!current) return;
      name.sync(current);
      params.sync(current);
      outputs.sync(model);
      const state = model.status.get(fullId);
      status.textContent = statusText(state);
      status.dataset.state = state?.state ?? "idle";
    };

    return html(
      "div",
      { class: "panel" },
      html("p", { class: "kicker" }, type.category),
      html("h2", {}, type.label),
      html("p", { class: "description" }, richText(type.description)),
      name.element,
      params.element,
      status,
      outputs.element,
      html("div", { class: "actions" }, this.#deleteButton([block.id], "Delete block")),
    );
  }

  #subsystemPanel(block: LabBlock & { inner: Diagram }, type: BlockType): HTMLElement {
    const { path } = this.#now;
    const inside = [...path, block.id];
    const fullId = pathId(path, block.id);
    const name = this.#nameField(block, type);
    const outputs = this.#outputRows(fullId, type);
    const status = html("p", { class: "status-note", role: "status" });

    // The parameters of everything inside, one group per block, so a ready-made subsystem can
    // be adjusted without opening it.
    const groups = block.inner.blocks.flatMap((inner): { id: string; element: HTMLElement; sync(block: LabBlock): void }[] => {
      const innerType = typeOf(inner);
      if (!innerType) return [];
      if (isSubsystem(inner)) {
        const open = html("button", { type: "button", class: "small" }, "Open");
        open.addEventListener("click", () => this.#events.open([...inside, inner.id]));
        return [{ id: inner.id, element: html("div", { class: "inner-block" }, html("span", { class: "inner-name" }, displayName(inner)), open), sync: () => {} }];
      }
      if (Object.keys(innerType.params).length === 0) return [];
      const controls = this.#paramControls(inside, inner, innerType);
      return [{ id: inner.id, element: html("fieldset", { class: "inner-params" }, html("legend", {}, displayName(inner)), controls.element), sync: controls.sync }];
    });

    const open = html("button", { type: "button" }, "Open");
    open.addEventListener("click", () => this.#events.open(inside));
    const ungroup = html("button", { type: "button" }, "Ungroup");
    ungroup.addEventListener("click", () => this.#events.ungroup(block.id));

    this.#sync = (model) => {
      const current = model.diagram.blocks.find((b) => b.id === block.id);
      if (!current) return;
      name.sync(current);
      outputs.sync(model);
      const innerNow = diagramAt(model.doc, inside);
      for (const group of groups) {
        const innerBlock = innerNow?.blocks.find((b) => b.id === group.id);
        if (innerBlock) group.sync(innerBlock);
      }
      const state = model.status.get(fullId);
      status.textContent = statusText(state);
      status.dataset.state = state?.state ?? "idle";
    };

    return html(
      "div",
      { class: "panel" },
      html("p", { class: "kicker" }, "Subsystem"),
      html("h2", {}, block.name || "Subsystem"),
      html("p", { class: "description" }, `${block.inner.blocks.length} blocks inside. Double-click it, or press Open, to see and edit them. Its ports are the Input and Output terminals inside.`),
      name.element,
      html("div", { class: "actions" }, open, ungroup),
      groups.length ? html("div", { class: "params" }, ...groups.map((g) => g.element)) : null,
      status,
      outputs.element,
      html("div", { class: "actions" }, this.#deleteButton([block.id], "Delete subsystem")),
    );
  }

  #selectionPanel(): HTMLElement {
    const count = html("h2", {});
    const group = html("button", { type: "button" }, "Group into subsystem");
    group.addEventListener("click", () => this.#events.group(selectedBlocks(this.#now.selection)));
    const remove = html("button", { type: "button", class: "danger" }, "Delete blocks");
    remove.addEventListener("click", () => {
      const ids = new Set(selectedBlocks(this.#now.selection));
      this.#edit((d) => removeBlocks(d, ids), "commit");
      this.#events.select(NOTHING);
    });
    this.#sync = (model) => {
      count.textContent = `${selectedBlocks(model.selection).length} blocks`;
    };
    return html(
      "div",
      { class: "panel" },
      html("p", { class: "kicker" }, "Selection"),
      count,
      html("p", { class: "description" }, "Group them into a subsystem to tidy the diagram or treat them as one block. Wires crossing the edge of the selection become the subsystem's inputs and outputs."),
      html("div", { class: "actions" }, group, remove),
    );
  }

  #wirePanel(id: string): HTMLElement {
    const description = html("p", { class: "description" });
    const rate = html("p", { class: "port-rate" });
    const pin = html("button", { type: "button", class: "small" });
    const remove = html("button", { type: "button", class: "danger" }, "Delete wire");
    const source = () => {
      const { diagram, path } = this.#now;
      const wire = diagram.wires.find((w) => w.id === id);
      return wire && { block: pathId(path, wire.from.block), port: wire.from.port };
    };
    pin.addEventListener("click", () => {
      const at = source();
      if (at) this.#events.change(toggleProbe(this.#now.doc, at), "commit");
    });
    remove.addEventListener("click", () => {
      this.#edit((d) => removeWire(d, id), "commit");
      this.#events.select(NOTHING);
    });

    this.#sync = (model) => {
      const wire = model.diagram.wires.find((w) => w.id === id);
      const at = source();
      if (!wire || !at) return;
      const to = { block: pathId(model.path, wire.to.block), port: wire.to.port };
      description.textContent = `From ${portLabel(model.doc, at)} to ${portLabel(model.doc, to, "in")}.`;
      const value = rateLabel(model.status.get(at.block), at.port);
      rate.textContent = value ? `${value} sample rate` : "No signal";
      const pinned = probeAt(model.doc, at) !== undefined;
      pin.textContent = pinned ? "Unpin signal" : "Pin signal to bench";
      pin.setAttribute("aria-pressed", String(pinned));
    };

    return html("div", { class: "panel" }, html("p", { class: "kicker" }, "Wire"), html("h2", {}, "Signal"), description, rate, html("div", { class: "actions" }, pin, remove));
  }

  #documentPanel(): HTMLElement {
    const title = html("input", { type: "text", spellcheck: "false", autocomplete: "off" });
    title.addEventListener("change", () => this.#events.change(setSettings(this.#now.doc, { title: title.value.trim() || "Untitled" }), "commit"));
    const duration = paramControl(DURATION, this.#now.doc.duration, (value, mode) => this.#events.change(setSettings(this.#now.doc, { duration: value as number }), mode));

    const notesView = html("div", { class: "notes" });
    const notesEdit = html("textarea", { rows: 10, spellcheck: "true", hidden: true, "aria-label": "Notes" });
    const editNotes = html("button", { type: "button", class: "small" }, "Edit notes");
    editNotes.addEventListener("click", () => {
      const editing = notesEdit.hidden;
      notesEdit.hidden = !editing;
      notesView.hidden = editing;
      editNotes.textContent = editing ? "Done" : "Edit notes";
      if (editing) notesEdit.focus();
    });
    notesEdit.addEventListener("change", () => this.#events.change(setSettings(this.#now.doc, { notes: notesEdit.value }), "commit"));
    let shownNotes: string | undefined;

    this.#sync = (model) => {
      if (document.activeElement !== title) title.value = model.doc.title;
      duration.update(model.doc.duration);
      if (document.activeElement !== notesEdit) notesEdit.value = model.doc.notes;
      if (model.doc.notes !== shownNotes) {
        shownNotes = model.doc.notes;
        const paragraphs = richParagraphs(model.doc.notes);
        notesView.replaceChildren(...(paragraphs.length ? paragraphs : [html("p", { class: "muted" }, "No notes yet.")]));
      }
    };

    return html(
      "div",
      { class: "panel" },
      html("p", { class: "kicker" }, "Diagram"),
      html("div", { class: "control" }, html("label", { class: "control-label" }, "Title", title)),
      duration.element,
      html("div", { class: "notes-block" }, html("div", { class: "notes-head" }, html("span", { class: "control-label" }, "Notes"), editNotes), notesView, notesEdit),
      html(
        "div",
        { class: "help" },
        html("p", { class: "control-label" }, "How it works"),
        html(
          "ul",
          {},
          html("li", {}, "Drag blocks in from the palette, or click one to add it."),
          html("li", {}, "Drag from an output (right side) to an input to wire them. Drag a wire's end off an input to remove it."),
          html("li", {}, "Click a wire or block to see its signal; pin it to keep it on the bench. Press Play to listen."),
          html("li", {}, "Shift-click or shift-drag to select several blocks, then group them into a subsystem. Double-click a subsystem to open it."),
          html("li", {}, "Scroll to pan; pinch or ctrl+scroll to zoom. Delete removes the selection, ⌘Z undoes, Esc steps out of a subsystem."),
          html("li", {}, "Notes and descriptions take TeX math between dollar signs."),
        ),
      ),
    );
  }
}
