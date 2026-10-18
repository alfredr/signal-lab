// Ties the pieces together: the document history, the simulator, and the views that show and
// edit them. Every document change re-renders at once and schedules a simulation for the next
// frame; the simulator's cache keeps that cheap when only layout or one knob changed.

import { blockType } from "../blocks/index.ts";
import { portKey, type PortRef } from "../engine/circuit.ts";
import { si } from "../engine/format.ts";
import { Simulator, type SimulationResult } from "../engine/simulator.ts";
import { Player } from "./audio.ts";
import { Bench } from "./bench.ts";
import type { ChangeMode } from "./controls.ts";
import { addBlock, emptyDocument, readDocument, removeBlock, removeWire, type LabDocument } from "./doc.ts";
import { html, isTyping } from "./dom.ts";
import { DiagramEditor, NOTHING, type Selection } from "./editor.ts";
import { examples } from "./examples.ts";
import { layoutBlock, snap } from "./geometry.ts";
import { History } from "./history.ts";
import { Inspector } from "./inspector.ts";
import { renderPalette } from "./palette.ts";

const STORAGE_KEY = "signal-lab:document";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}.`);
  return element as T;
}

/** The diagram saved in this browser, if there is a readable one. */
function loadSaved(): LabDocument | undefined {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? readDocument(JSON.parse(text)) : undefined;
  } catch {
    return undefined;
  }
}

export class App {
  readonly #history: History<LabDocument>;
  readonly #simulator = new Simulator(blockType);
  readonly #player = new Player();
  readonly #editor: DiagramEditor;
  readonly #inspector: Inspector;
  readonly #bench: Bench;
  readonly #status = byId("status");
  readonly #title = byId("doc-title");
  readonly #undo = byId<HTMLButtonElement>("undo");
  readonly #redo = byId<HTMLButtonElement>("redo");
  #result: SimulationResult = { signals: new Map(), status: new Map(), recomputed: 0 };
  #simulated: LabDocument | undefined;
  #selection: Selection = NOTHING;
  #summary = "";
  #frame = 0;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.#history = new History(loadSaved() ?? examples[0]!.build());
    const change = (next: LabDocument, mode: ChangeMode) => (mode === "preview" ? this.#history.preview(next) : this.#history.commit(next));
    const select = (selection: Selection) => {
      this.#selection = selection;
      this.#render();
    };
    this.#editor = new DiagramEditor(byId("canvas"), { change, select });
    this.#inspector = new Inspector(byId("inspector"), { change, select });
    this.#bench = new Bench(byId("bench"), {
      change,
      play: (at) => this.#play(at),
      stop: () => this.#player.stop(),
    });
    renderPalette(byId("palette"), (kind) => this.#add(kind));

    this.#history.subscribe(() => {
      this.#dropStaleSelection();
      this.#render();
      this.#scheduleRun();
      this.#scheduleSave();
    });
    this.#player.subscribe(() => this.#render());
    this.#bindToolbar();
    addEventListener("keydown", (event) => this.#keydown(event));

    this.#render();
    this.#editor.fit();
    this.#scheduleRun();
  }

  get #doc(): LabDocument {
    return this.#history.present;
  }

  #render(): void {
    const doc = this.#doc;
    const { status, signals } = this.#result;
    const probes = new Map(doc.probes.map((probe, i) => [portKey(probe.at), i + 1]));
    this.#editor.render({ doc, selection: this.#selection, status, probes });
    this.#inspector.render({ doc, selection: this.#selection, status });
    this.#bench.render({ doc, signals, scope: this.#scopeTarget(), playing: this.#player.playing });
    this.#title.textContent = doc.title;
    this.#undo.disabled = !this.#history.canUndo;
    this.#redo.disabled = !this.#history.canRedo;
    this.#status.textContent = this.#summary;
  }

  /** The signal the selection points at: a wire's source, or a block's first output. */
  #scopeTarget(): PortRef | undefined {
    const selection = this.#selection;
    if (selection.kind === "wire") return this.#doc.wires.find((wire) => wire.id === selection.id)?.from;
    if (selection.kind === "block") {
      const block = this.#doc.blocks.find((b) => b.id === selection.id);
      if (block && blockType(block.kind)?.outputs.length) return { block: block.id, port: 0 };
    }
    return undefined;
  }

  #scheduleRun(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#run();
    });
  }

  #run(): void {
    const doc = this.#doc;
    if (doc === this.#simulated) return;
    const started = performance.now();
    this.#result = this.#simulator.run(doc);
    const elapsed = performance.now() - started;
    this.#simulated = doc;

    const errors = [...this.#result.status.values()].filter((status) => status.state === "error").length;
    if (this.#result.recomputed > 0) {
      const blocks = this.#result.recomputed === 1 ? "1 block" : `${this.#result.recomputed} blocks`;
      this.#summary = `Simulated ${si(doc.duration, "s")} in ${Math.max(1, Math.round(elapsed))} ms (${blocks})`;
    }
    if (errors) this.#summary = `${this.#summary.replace(/ · .*$/, "")} · ${errors === 1 ? "1 block has" : `${errors} blocks have`} an error`;

    const playing = this.#player.playing;
    if (playing) this.#player.refresh(this.#result.signals.get(playing));
    this.#render();
  }

  #play(at: PortRef): void {
    const signal = this.#result.signals.get(portKey(at));
    if (signal) this.#player.play(portKey(at), signal);
  }

  /** Adds a block near the middle of the view, nudged clear of any block already there. */
  #add(kind: string): void {
    const type = blockType(kind);
    if (!type) return;
    const layout = layoutBlock(type);
    const center = this.#editor.center();
    let x = snap(center.x - layout.width / 2);
    let y = snap(center.y - layout.height / 2);
    while (this.#doc.blocks.some((block) => block.x === x && block.y === y)) {
      x += 24;
      y += 24;
    }
    const [next, id] = addBlock(this.#doc, kind, x, y);
    this.#selection = { kind: "block", id };
    this.#history.commit(next);
  }

  #deleteSelection(): void {
    const selection = this.#selection;
    if (selection.kind === "none") return;
    this.#selection = NOTHING;
    this.#history.commit(selection.kind === "block" ? removeBlock(this.#doc, selection.id) : removeWire(this.#doc, selection.id));
  }

  #dropStaleSelection(): void {
    const selection = this.#selection;
    const exists =
      selection.kind === "none" ||
      (selection.kind === "block" ? this.#doc.blocks.some((b) => b.id === selection.id) : this.#doc.wires.some((w) => w.id === selection.id));
    if (!exists) this.#selection = NOTHING;
  }

  #load(doc: LabDocument): void {
    this.#selection = NOTHING;
    this.#history.commit(doc);
    requestAnimationFrame(() => this.#editor.fit());
  }

  #scheduleSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#doc));
      } catch {
        // Storage can be full or blocked; the diagram just won't survive a reload.
      }
    }, 400);
  }

  #keydown(event: KeyboardEvent): void {
    if (isTyping(event.target)) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this.#history.redo();
      else this.#history.undo();
    } else if (command && key === "y") {
      event.preventDefault();
      this.#history.redo();
    } else if (!command && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      this.#deleteSelection();
    } else if (event.key === "Escape") {
      this.#selection = NOTHING;
      this.#render();
    }
  }

  #bindToolbar(): void {
    const picker = byId<HTMLSelectElement>("examples");
    picker.append(...examples.map((example, i) => html("option", { value: i }, example.title)));
    picker.addEventListener("change", () => {
      const example = examples[Number(picker.value)];
      picker.value = "";
      if (example) this.#load(example.build());
    });

    byId("new").addEventListener("click", () => this.#load(emptyDocument()));
    this.#undo.addEventListener("click", () => this.#history.undo());
    this.#redo.addEventListener("click", () => this.#history.redo());
    byId("fit").addEventListener("click", () => this.#editor.fit());

    byId("export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(this.#doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = html("a", { href: url, download: `${this.#doc.title.replace(/[^\w-]+/g, "-").toLowerCase() || "diagram"}.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const file = byId<HTMLInputElement>("import-file");
    byId("import").addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const chosen = file.files?.[0];
      file.value = "";
      if (!chosen) return;
      try {
        this.#load(readDocument(JSON.parse(await chosen.text())));
      } catch (error) {
        this.#summary = error instanceof SyntaxError ? "That file isn't valid JSON." : error instanceof Error ? error.message : String(error);
        this.#render();
      }
    });
  }
}
