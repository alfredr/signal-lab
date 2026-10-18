// The side panel: settings for the selected block or wire, or for the diagram as a whole when
// nothing is selected. It rebuilds only when the selection changes; otherwise it updates the
// existing controls in place, so a slider being dragged is never replaced under the pointer.

import { blockType } from "../blocks/index.ts";
import type { BlockType } from "../engine/block.ts";
import type { BlockNode, PortRef } from "../engine/circuit.ts";
import { si } from "../engine/format.ts";
import { number, resolveParams, type ParamValue } from "../engine/params.ts";
import type { BlockStatus } from "../engine/simulator.ts";
import { paramControl, type ChangeMode, type Control } from "./controls.ts";
import { addProbe, probeAt, removeBlock, removeProbe, removeWire, renameBlock, setParam, setSettings, type LabDocument } from "./doc.ts";
import { html } from "./dom.ts";
import { NOTHING, type Selection } from "./editor.ts";

export interface InspectorModel {
  readonly doc: LabDocument;
  readonly selection: Selection;
  readonly status: ReadonlyMap<string, BlockStatus>;
}

export interface InspectorEvents {
  change(next: LabDocument, mode: ChangeMode): void;
  select(selection: Selection): void;
}

const DURATION = number({ label: "Duration", unit: "s", default: 1, min: 0.01, max: 20, scale: "log", help: "Every signal covers this much time." });

/** Name for a block in messages: the user's label or the type's. */
export function blockName(block: BlockNode): string {
  return block.name || blockType(block.kind)?.label || block.kind;
}

/** "Mixer" for a single-output block, "Phase splitter Q" when the port needs naming. */
export function portName(doc: LabDocument, ref: PortRef, direction: "in" | "out" = "out"): string {
  const block = doc.blocks.find((b) => b.id === ref.block);
  if (!block) return "?";
  const ports = (direction === "out" ? blockType(block.kind)?.outputs : blockType(block.kind)?.inputs) ?? [];
  return ports.length > 1 ? `${blockName(block)} ${ports[ref.port]?.name ?? ref.port}` : blockName(block);
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
    const { selection, doc } = model;
    const block = selection.kind === "block" ? doc.blocks.find((b) => b.id === selection.id) : undefined;
    const wire = selection.kind === "wire" ? doc.wires.find((w) => w.id === selection.id) : undefined;
    const key = block ? `block:${block.id}:${block.kind}` : wire ? `wire:${wire.id}` : "diagram";
    if (key !== this.#builtFor) {
      this.#builtFor = key;
      const type = block && blockType(block.kind);
      this.#host.replaceChildren(block && type ? this.#blockPanel(block, type) : wire ? this.#wirePanel(wire.id) : this.#diagramPanel());
    }
    this.#sync(model);
  }

  #change(next: LabDocument, mode: ChangeMode): void {
    this.#events.change(next, mode);
  }

  #doc(): LabDocument {
    return this.#model!.doc;
  }

  #blockPanel(block: BlockNode, type: BlockType): HTMLElement {
    const id = block.id;
    const name = html("input", { type: "text", placeholder: type.label, value: block.name ?? "", spellcheck: "false", autocomplete: "off" });
    name.addEventListener("change", () => this.#change(renameBlock(this.#doc(), id, name.value), "commit"));

    const controls = new Map<string, Control>();
    const resolved = resolveParams(type.params, block.params);
    const params = html("div", { class: "params" });
    for (const [param, spec] of Object.entries(type.params)) {
      const control = paramControl(spec, resolved[param], (value: ParamValue, mode) => this.#change(setParam(this.#doc(), id, param, value), mode));
      controls.set(param, control);
      params.append(control.element);
    }

    const status = html("p", { class: "status-note", role: "status" });
    const outputs = type.outputs.map((port, index) => {
      const rate = html("span", { class: "port-rate" });
      const pin = html("button", { type: "button", class: "small" });
      pin.addEventListener("click", () => {
        const doc = this.#doc();
        const at = { block: id, port: index };
        const probe = probeAt(doc, at);
        this.#change(probe ? removeProbe(doc, probe.id) : addProbe(doc, at), "commit");
      });
      const row = html("div", { class: "port-row" }, html("span", { class: "port-label" }, type.outputs.length > 1 ? `Output ${port.name}` : "Output"), rate, pin);
      return { row, rate, pin, index };
    });

    const remove = html("button", { type: "button", class: "danger" }, "Delete block");
    remove.addEventListener("click", () => {
      this.#change(removeBlock(this.#doc(), id), "commit");
      this.#events.select(NOTHING);
    });

    this.#sync = (model) => {
      const current = model.doc.blocks.find((b) => b.id === id);
      if (!current) return;
      if (document.activeElement !== name) name.value = current.name ?? "";
      const values = resolveParams(type.params, current.params);
      for (const [param, control] of controls) control.update(values[param]);
      const state = model.status.get(id);
      status.textContent = state?.state === "error" ? state.message : state?.state === "idle" ? state.reason : "";
      status.dataset.state = state?.state ?? "idle";
      for (const output of outputs) {
        output.rate.textContent = state?.state === "ok" ? si(state.rates[output.index], "Hz") : "no signal";
        const pinned = probeAt(model.doc, { block: id, port: output.index }) !== undefined;
        output.pin.textContent = pinned ? "Unpin" : "Pin to bench";
        output.pin.setAttribute("aria-pressed", String(pinned));
      }
    };

    return html(
      "div",
      { class: "panel" },
      html("p", { class: "kicker" }, type.category),
      html("h2", {}, type.label),
      html("p", { class: "description" }, type.description),
      html("div", { class: "control" }, html("label", { class: "control-label" }, "Name", name)),
      params,
      status,
      outputs.length ? html("div", { class: "ports" }, ...outputs.map((o) => o.row)) : null,
      html("div", { class: "actions" }, remove),
    );
  }

  #wirePanel(id: string): HTMLElement {
    const route = html("p", { class: "description" });
    const rate = html("p", { class: "port-rate" });
    const pin = html("button", { type: "button", class: "small" });
    const remove = html("button", { type: "button", class: "danger" }, "Delete wire");
    pin.addEventListener("click", () => {
      const doc = this.#doc();
      const wire = doc.wires.find((w) => w.id === id);
      if (!wire) return;
      const probe = probeAt(doc, wire.from);
      this.#change(probe ? removeProbe(doc, probe.id) : addProbe(doc, wire.from), "commit");
    });
    remove.addEventListener("click", () => {
      this.#change(removeWire(this.#doc(), id), "commit");
      this.#events.select(NOTHING);
    });

    this.#sync = (model) => {
      const wire = model.doc.wires.find((w) => w.id === id);
      if (!wire) return;
      route.textContent = `From ${portName(model.doc, wire.from)} to ${portName(model.doc, wire.to, "in")}.`;
      const state = model.status.get(wire.from.block);
      rate.textContent = state?.state === "ok" ? `${si(state.rates[wire.from.port], "Hz")} sample rate` : "No signal";
      const pinned = probeAt(model.doc, wire.from) !== undefined;
      pin.textContent = pinned ? "Unpin signal" : "Pin signal to bench";
      pin.setAttribute("aria-pressed", String(pinned));
    };

    return html("div", { class: "panel" }, html("p", { class: "kicker" }, "Wire"), html("h2", {}, "Signal"), route, rate, html("div", { class: "actions" }, pin, remove));
  }

  #diagramPanel(): HTMLElement {
    const title = html("input", { type: "text", spellcheck: "false", autocomplete: "off" });
    title.addEventListener("change", () => this.#change(setSettings(this.#doc(), { title: title.value.trim() || "Untitled" }), "commit"));
    const duration = paramControl(DURATION, this.#doc().duration, (value, mode) => this.#change(setSettings(this.#doc(), { duration: value as number }), mode));

    const notesView = html("div", { class: "notes" });
    const notesEdit = html("textarea", { rows: 8, spellcheck: "true", hidden: true, "aria-label": "Notes" });
    const editNotes = html("button", { type: "button", class: "small" }, "Edit notes");
    editNotes.addEventListener("click", () => {
      const editing = notesEdit.hidden;
      notesEdit.hidden = !editing;
      notesView.hidden = editing;
      editNotes.textContent = editing ? "Done" : "Edit notes";
      if (editing) notesEdit.focus();
    });
    notesEdit.addEventListener("change", () => this.#change(setSettings(this.#doc(), { notes: notesEdit.value }), "commit"));

    this.#sync = (model) => {
      if (document.activeElement !== title) title.value = model.doc.title;
      duration.update(model.doc.duration);
      if (document.activeElement !== notesEdit) notesEdit.value = model.doc.notes;
      const paragraphs = model.doc.notes.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
      notesView.replaceChildren(...(paragraphs.length ? paragraphs.map((text) => html("p", {}, text)) : [html("p", { class: "muted" }, "No notes yet.")]));
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
          html("li", {}, "Click a wire to see its signal; pin it to keep it on the bench. Press play to listen."),
          html("li", {}, "Scroll to pan, pinch or ctrl+scroll to zoom. Delete removes the selection; ⌘Z undoes."),
        ),
      ),
    );
  }
}
