// The bench: plots of signals in the diagram. A scope follows the current selection, and
// probes pinned from the inspector stay until removed. Each panel shows time or spectrum,
// zooms with the wheel, pans by dragging and resets on double-click.

import { portKey, type PortRef } from "../engine/circuit.ts";
import { decibels, si, significant, toDecibels } from "../engine/format.ts";
import { peak, power, type Signal } from "../engine/signal.ts";
import { addProbe, removeProbe, setProbeView, type LabDocument, type ProbeView } from "../model/document.ts";
import { html } from "./dom.ts";
import type { ChangeMode } from "./controls.ts";
import { portLabel, probeColor } from "./labels.ts";
import { drawSpectrum, drawTime, frequencySpan, MARGIN, readTheme, timeSpan, type Range } from "./plot.ts";

export type BenchModel = {
  readonly doc: LabDocument;
  readonly signals: ReadonlyMap<string, Signal>;
  /** The output port the scope shows, from the current selection. */
  readonly scope: PortRef | undefined;
  /** Key of the port being played, if any. */
  readonly playing: string | undefined;
};

export type BenchEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  play(at: PortRef): void;
  stop(): void;
};

type PanelState = {
  readonly title: string;
  readonly signal: Signal | undefined;
  readonly view: ProbeView;
  /** CSS color for the trace. */
  readonly color: string;
  readonly playing: boolean;
};

type Scope = {
  readonly panel: SignalPanel;
  readonly pin: HTMLButtonElement;
  view: ProbeView;
  at: PortRef | undefined;
};

/** Canvas can't take var(--name) colors, so look them up. */
function resolveColor(element: Element, color: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  return name ? getComputedStyle(element).getPropertyValue(name).trim() : color;
}

const stats = new WeakMap<Float32Array, { power: number; peak: number }>();
function statsOf(data: Float32Array) {
  let cached = stats.get(data);
  if (!cached) stats.set(data, (cached = { power: power(data), peak: peak(data) }));
  return cached;
}

class SignalPanel {
  readonly element: HTMLElement;
  readonly #canvas = html("canvas", { class: "plot" });
  readonly #title = html("span", { class: "signal-title" });
  readonly #meta = html("span", { class: "signal-meta" });
  readonly #swatch = html("span", { class: "swatch", "aria-hidden": "true" });
  readonly #viewButtons: Record<ProbeView, HTMLButtonElement>;
  readonly #play = html("button", { type: "button", class: "small play" }, "Play");
  readonly #empty = html("p", { class: "panel-empty" });
  #state: PanelState | undefined;
  #ranges: Record<ProbeView, Range | undefined> = { time: undefined, spectrum: undefined };
  /** The signal's full extent last time, to tell when the zoom no longer applies. */
  #extent = "";
  #hover: number | undefined;
  #frame = 0;

  constructor(actions: { view(view: ProbeView): void; play(): void; extra: HTMLButtonElement }) {
    const viewButton = (view: ProbeView, label: string) => {
      const button = html("button", { type: "button", class: "segment-button" }, label);
      button.addEventListener("click", () => actions.view(view));
      return button;
    };
    this.#viewButtons = { time: viewButton("time", "Time"), spectrum: viewButton("spectrum", "Spectrum") };
    this.#play.addEventListener("click", () => actions.play());
    this.element = html(
      "section",
      { class: "signal-panel" },
      html(
        "header",
        { class: "signal-head" },
        this.#swatch,
        html("div", { class: "signal-name" }, this.#title, this.#meta),
        html("div", { class: "segmented-buttons", role: "group", "aria-label": "View" }, this.#viewButtons.time, this.#viewButtons.spectrum),
        this.#play,
        actions.extra,
      ),
      html("div", { class: "plot-wrap" }, this.#canvas, this.#empty),
    );
    this.#listen();
    new ResizeObserver(() => this.#schedule()).observe(this.#canvas);
  }

  update(state: PanelState): void {
    const previous = this.#state;
    this.#state = state;
    // The bench re-renders on every edit, including each frame of a drag; only redraw the plot
    // when what it shows has changed.
    const redraw = !previous || previous.signal !== state.signal || previous.view !== state.view || previous.color !== state.color;
    const { signal } = state;
    this.#title.textContent = state.title;
    this.#swatch.style.background = state.color;
    for (const [view, button] of Object.entries(this.#viewButtons)) button.setAttribute("aria-pressed", String(view === state.view));
    this.#play.textContent = state.playing ? "Stop" : "Play";
    this.#play.setAttribute("aria-pressed", String(state.playing));
    this.#play.disabled = !signal;
    if (signal) {
      const { power: p, peak: max } = statsOf(signal.data);
      this.#meta.textContent = `${si(signal.rate, "Hz")} · power ${decibels(toDecibels(p, -200))} · peak ${significant(max)}`;
      const extent = `${signal.rate}|${signal.data.length}`;
      if (extent !== this.#extent) {
        this.#extent = extent;
        this.#ranges = { time: undefined, spectrum: undefined };
      }
    } else {
      this.#meta.textContent = "no signal";
    }
    this.#empty.textContent = signal ? "" : "This output has no signal. Check the block for errors or missing inputs.";
    this.#empty.hidden = Boolean(signal);
    this.#canvas.hidden = !signal;
    if (redraw) this.#schedule();
  }

  #fullRange(): Range | undefined {
    const signal = this.#state?.signal;
    if (!signal) return undefined;
    return this.#state!.view === "time" ? timeSpan(signal) : frequencySpan(signal);
  }

  #range(): Range | undefined {
    return this.#ranges[this.#state?.view ?? "time"] ?? this.#fullRange();
  }

  #setRange(range: Range): void {
    const full = this.#fullRange();
    if (!full || !this.#state?.signal) return;
    const span = range.end - range.start;
    const fullSpan = full.end - full.start;
    // No closer than a few samples (or bins) across the plot, no wider than everything.
    const smallest = this.#state.view === "time" ? 8 / this.#state.signal.rate : fullSpan / 1e5;
    const width = Math.min(fullSpan, Math.max(smallest, span));
    const start = Math.min(full.end - width, Math.max(full.start, range.start + (span - width) / 2));
    this.#ranges[this.#state.view] = { start, end: start + width };
    this.#schedule();
  }

  #listen(): void {
    const canvas = this.#canvas;
    const position = (event: MouseEvent) => event.clientX - canvas.getBoundingClientRect().left;
    const plotWidth = () => Math.max(1, canvas.clientWidth - MARGIN.left - MARGIN.right);
    const plotFraction = (x: number) => (x - MARGIN.left) / plotWidth();

    canvas.addEventListener(
      "wheel",
      (event) => {
        const range = this.#range();
        if (!range) return;
        event.preventDefault();
        const span = range.end - range.start;
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          const shift = (event.deltaX / plotWidth()) * span;
          this.#setRange({ start: range.start + shift, end: range.end + shift });
          return;
        }
        const at = range.start + Math.min(1, Math.max(0, plotFraction(position(event)))) * span;
        const factor = Math.exp(event.deltaY * 0.002);
        this.#setRange({ start: at - (at - range.start) * factor, end: at + (range.end - at) * factor });
      },
      { passive: false },
    );

    let drag: { x: number; range: Range } | undefined;
    canvas.addEventListener("pointerdown", (event) => {
      const range = this.#range();
      if (!range) return;
      drag = { x: event.clientX, range };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      this.#hover = position(event);
      if (drag) {
        const span = drag.range.end - drag.range.start;
        const shift = (-(event.clientX - drag.x) / plotWidth()) * span;
        this.#setRange({ start: drag.range.start + shift, end: drag.range.end + shift });
      } else {
        this.#schedule();
      }
    });
    canvas.addEventListener("pointerup", () => (drag = undefined));
    canvas.addEventListener("pointerleave", () => {
      this.#hover = undefined;
      this.#schedule();
    });
    canvas.addEventListener("dblclick", () => {
      if (this.#state) this.#ranges[this.#state.view] = undefined;
      this.#schedule();
    });
  }

  #schedule(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #draw(): void {
    const state = this.#state;
    const range = this.#range();
    if (!state?.signal || !range) return;
    const theme = readTheme(this.element);
    const color = resolveColor(this.element, state.color);
    if (state.view === "time") drawTime(this.#canvas, theme, state.signal, range, color, this.#hover);
    else drawSpectrum(this.#canvas, theme, state.signal, range, color, this.#hover);
  }
}

export class Bench {
  readonly #list: HTMLElement;
  readonly #events: BenchEvents;
  readonly #hint = html("p", { class: "bench-hint" }, "Click a wire or a block to see its signal here, then pin the ones you want to keep.");
  #scope: Scope | undefined;
  readonly #probes = new Map<string, SignalPanel>();
  #model: BenchModel | undefined;

  constructor(host: HTMLElement, events: BenchEvents) {
    this.#events = events;
    this.#list = html("div", { class: "bench-list" });
    host.append(this.#list);
  }

  render(model: BenchModel): void {
    this.#model = model;
    const { doc, signals, scope, playing } = model;
    const panels: HTMLElement[] = [];

    if (scope) {
      const scopePanel = this.#scopePanel();
      scopePanel.at = scope;
      const pinned = doc.probes.some((probe) => probe.at.block === scope.block && probe.at.port === scope.port);
      scopePanel.pin.textContent = pinned ? "Pinned" : "Pin";
      scopePanel.pin.disabled = pinned;
      scopePanel.panel.update({
        title: portLabel(doc, scope),
        signal: signals.get(portKey(scope)),
        view: scopePanel.view,
        color: "var(--accent)",
        playing: playing === portKey(scope),
      });
      panels.push(scopePanel.panel.element);
    }

    const live = new Set<string>();
    doc.probes.forEach((probe, index) => {
      live.add(probe.id);
      let panel = this.#probes.get(probe.id);
      if (!panel) {
        const close = html("button", { type: "button", class: "small icon", "aria-label": "Remove from bench", title: "Remove from bench" }, "×");
        close.addEventListener("click", () => this.#events.change(removeProbe(this.#model!.doc, probe.id), "commit"));
        panel = new SignalPanel({
          view: (view) => this.#events.change(setProbeView(this.#model!.doc, probe.id, view), "commit"),
          play: () => this.#toggle(probe.at),
          extra: close,
        });
        this.#probes.set(probe.id, panel);
      }
      panel.update({
        title: `${index + 1}. ${portLabel(doc, probe.at)}`,
        signal: signals.get(portKey(probe.at)),
        view: probe.view,
        color: probeColor(index + 1),
        playing: playing === portKey(probe.at),
      });
      panels.push(panel.element);
    });
    for (const id of this.#probes.keys()) if (!live.has(id)) this.#probes.delete(id);

    this.#list.replaceChildren(...(panels.length ? panels : [this.#hint]));
  }

  #scopePanel(): Scope {
    if (!this.#scope) {
      const pin = html("button", { type: "button", class: "small" }, "Pin");
      const scope: Scope = {
        pin,
        view: "time",
        at: undefined,
        panel: new SignalPanel({
          view: (view) => {
            scope.view = view;
            if (this.#model) this.render(this.#model);
          },
          play: () => scope.at && this.#toggle(scope.at),
          extra: pin,
        }),
      };
      pin.addEventListener("click", () => scope.at && this.#events.change(addProbe(this.#model!.doc, scope.at, scope.view), "commit"));
      this.#scope = scope;
    }
    return this.#scope;
  }

  #toggle(at: PortRef): void {
    if (this.#model?.playing === portKey(at)) this.#events.stop();
    else this.#events.play(at);
  }
}
