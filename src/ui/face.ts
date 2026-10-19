// The panel face: the front of the instrument, built from the instruments on
// the diagram. Every plot is a screen, every control a knob, switch or field,
// every readout a display and every speaker a grille with Play; notes marked
// for the face become labels. They sit in panes, and the panes in panels, as
// the document has them organized; where everything goes is worked out to
// fit, so the face rearranges itself when the dock changes shape. Panels show
// stacked, tiled side by side as they fit, or as tabs. Arrange lets the
// instruments, panes and panels be dragged about, renamed, added and taken
// away. The transport runs the stream, and the selection's signal gets a
// screen at the end, to look at before adding a plot for it.

import type { PlotView } from '../blocks/instruments.ts';
import {
  CONTROL,
  NOTE,
  PLOT,
  SPEAKER,
  SYMBOLS,
} from '../blocks/instruments.ts';
import type { PortRef } from '../engine/circuit.ts';
import type { LabDocument } from '../model/document.ts';
import type { Bindings } from '../model/flatten.ts';
import {
  controlState,
  defaultSize,
  type FaceItem,
} from '../model/instruments.ts';
import {
  addPane,
  addPanel,
  facePanels,
  moveInstrument,
  movePane,
  movePanel,
  layoutPane,
  paneWidth,
  removePane,
  removePanel,
  resizeInstrument,
  retitle,
  type FacePane,
  type Piece,
  type PieceKind,
} from '../model/panels.ts';
import type { ChangeMode } from './controls.ts';
import { html } from './dom.ts';
import type { Trace } from './live.ts';
import { defaultSettings, SignalPanel } from './signal-panel.ts';
import type { Widgets } from './widgets.ts';

/** Grid cell size and the gap between cells, in CSS pixels. */
const CELL = 32;
const GAP = 8;
const PITCH = CELL + GAP;
/**
 * A knob's own size, the most it grows to, and the room around it for its
 * label, rim and range, in pixels.
 */
const KNOB_SIZE = 60;
const KNOB_LARGEST = 96;
const KNOB_MARGIN = { w: 28, h: 52 };
/** How readily a pane takes spare width, by the most stretchable it holds. */
const STRETCH = { screen: 100, display: 20, knob: 1 } as const;
/** A pane's padding and border across, around its instruments. */
const PANE_EDGES = 22;
/**
 * The gap between panes, and a panel's padding and border across: wider than
 * the gaps inside a pane, so what belongs together looks it.
 */
const PANE_GAP = 10;
const PANEL_EDGES = 14;
/** The widest a pane would like to be, in cells. */
const WIDEST = 24;

/**
 * How fast the stream can run against the clock; speakers play at that speed,
 * like a tape.
 */
const SPEEDS: readonly (readonly [number, string])[] = [
  [8, '8×'],
  [4, '4×'],
  [2, '2×'],
  [1, '1×'],
  [0.5, '½×'],
  [0.25, '¼×'],
  [0.125, '⅛×'],
];

export type Transport = {
  /** The playhead's time. */
  readonly time: number;
  /** Whether the stream is running. */
  readonly running: boolean;
  readonly speed: number;
  /** Whether the simulation can't keep up with the speed asked for. */
  readonly behind: boolean;
};

/** A speed as the transport shows it: ⅛×, 1×, 4×. */
export function speedLabel(speed: number): string {
  return (
    SPEEDS.find(([s]) => s === speed)?.[1] ?? `${Number(speed.toFixed(2))}×`
  );
}

/** A time on the stream's clock: seconds, then minutes and seconds. */
export function clockTime(t: number): string {
  if (t < 60) {
    return `${t.toFixed(1)} s`;
  }

  const minutes = Math.floor(t / 60);
  return `${minutes}:${(t - 60 * minutes).toFixed(1).padStart(4, '0')}`;
}

/** The selection's signal, for its screen. */
export type ScopeState = {
  readonly at: PortRef;
  readonly title: string;
  readonly trace: Trace | undefined;
  readonly problem: string | undefined;
  readonly listening: boolean;
};

export type FaceModel = {
  readonly doc: LabDocument;
  readonly widgets: Widgets;
  readonly bindings: Bindings;
  /** The signal the selection points at, unless a plot already shows it. */
  readonly scope: ScopeState | undefined;
  /** Full ids of the selected instruments, to highlight. */
  readonly selected: ReadonlySet<string>;
  readonly transport: Transport;
};

export type FaceEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  /** Shows an instrument on the diagram. */
  reveal(id: string): void;
  addPlot(at: PortRef): void;
  /** Starts or stops listening to a port. */
  listen(at: PortRef): void;
  /** Starts or pauses the stream. */
  run(): void;
  /** Takes the stream back to time 0. */
  reset(): void;
  speed(speed: number): void;
};

/**
 * How the panels show: one under another, side by side as they fit, or as
 * tabs.
 */
type Mode = 'stack' | 'tile' | 'tabs';

const MODES: readonly (readonly [Mode, string, string])[] = [
  ['stack', 'Stack', 'Panels one under another'],
  ['tile', 'Tile', 'Panels side by side, as they fit'],
  ['tabs', 'Tabs', 'One panel at a time'],
];

/** This browser's way of showing the panels, and the tab last shown. */
type View = { readonly mode: Mode; readonly tab: string | undefined };

const VIEW_KEY = 'signal-lab:panels';

function loadView(): View {
  try {
    const saved = JSON.parse(
      localStorage.getItem(VIEW_KEY) ?? 'null',
    ) as Partial<View> | null;
    return {
      mode: MODES.some(([mode]) => mode === saved?.mode)
        ? saved!.mode!
        : 'tile',
      tab: typeof saved?.tab === 'string' ? saved.tab : undefined,
    };
  } catch {
    return { mode: 'tile', tab: undefined };
  }
}

type Frame = {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
};

type PaneView = {
  readonly element: HTMLElement;
  readonly title: HTMLElement;
  readonly name: HTMLInputElement;
  readonly grid: HTMLElement;
};

type PanelView = {
  readonly element: HTMLElement;
  readonly head: HTMLElement;
  readonly title: HTMLElement;
  readonly name: HTMLInputElement;
  readonly panes: HTMLElement;
  readonly remove: HTMLButtonElement;
};

/** Something being dragged while arranging, and where it would land. */
type Drag =
  | {
      readonly kind: 'instrument' | 'pane' | 'panel';
      readonly id: string;
      readonly element: HTMLElement;
      target?: { readonly into: string; readonly index: number };
    }
  | {
      readonly kind: 'resize';
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      /** The document before, to go back to if the resize is called off. */
      readonly before: LabDocument;
    };

const SCOPE = '@scope';
const scopeSettings: Record<PlotView, ReturnType<typeof defaultSettings>> = {
  time: defaultSettings('time'),
  spectrum: defaultSettings('spectrum'),
  waterfall: defaultSettings('waterfall'),
};

/** A button for the panes and panels while arranging. */
const tool = (label: string, title: string) =>
  html('button', { type: 'button', class: 'small', title }, label);

/**
 * Of `elements`, the one nearest the point, and whether the point is past it:
 * below it, or beside it and past its middle, across where they flow in
 * `rows`, otherwise down. `beside` says whether the point is level with it.
 */
function nearest(
  elements: readonly HTMLElement[],
  x: number,
  y: number,
  rows: boolean,
): {
  readonly index: number;
  readonly after: boolean;
  readonly beside: boolean;
  readonly box: DOMRect;
} {
  let best = {
    index: 0,
    after: false,
    beside: false,
    box: new DOMRect(),
    distance: Infinity,
  };
  elements.forEach((element, index) => {
    const box = element.getBoundingClientRect();
    const dx = Math.max(box.left - x, 0, x - box.right);
    const dy = Math.max(box.top - y, 0, y - box.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance < best.distance) {
      const beside = rows && y >= box.top && y <= box.bottom;
      best = {
        index,
        after: beside
          ? x > box.left + box.width / 2
          : y > box.top + box.height / 2,
        beside,
        box,
        distance,
      };
    }
  });
  return best;
}

/** Puts `children` in `parent`, in order, moving nothing already in place. */
function setChildren(parent: Element, children: readonly Element[]): void {
  const now = parent.children;
  if (
    now.length !== children.length ||
    children.some((child, i) => now[i] !== child)
  ) {
    parent.replaceChildren(...children);
  }
}

export class Face {
  readonly #events: FaceEvents;
  readonly #panelsBox = html('div', { class: 'face-panels' });
  readonly #tabs = html('div', {
    class: 'face-tabs',
    role: 'tablist',
    'aria-label': 'Panels',
  });
  readonly #frames = new Map<string, Frame>();
  readonly #paneViews = new Map<string, PaneView>();
  readonly #panelViews = new Map<string, PanelView>();
  readonly #scopeGrid = html('div', { class: 'pane-grid' });
  readonly #scopePane = html(
    'section',
    { class: 'pane scope-pane' },
    html(
      'header',
      { class: 'pane-head' },
      html('h3', { class: 'pane-title' }, 'Selection'),
    ),
    this.#scopeGrid,
  );
  readonly #addPanel = tool('+ Panel', 'Add a panel');
  readonly #dropBar = html('div', { class: 'drop-bar', hidden: true });
  readonly #empty = html(
    'div',
    { class: 'face-empty' },
    html('p', {}, 'The panel face is empty.'),
    html(
      'p',
      {},
      'Instruments on the diagram appear here. Right-click an output or a wire and choose Add plot, or add a Plot, Speaker, Control or Readout from the Instruments in the palette.',
    ),
  );
  readonly #modes: Record<Mode, HTMLButtonElement>;
  readonly #arrange = html(
    'button',
    { type: 'button', class: 'small', 'aria-pressed': 'false' },
    'Arrange',
  );
  readonly #run = html('button', { type: 'button', class: 'small run' });
  readonly #time = html('span', {
    class: 'transport-time',
    role: 'timer',
    'aria-label': 'Stream time',
  });
  readonly #speed = html(
    'select',
    { 'aria-label': 'Speed' },
    ...SPEEDS.map(([speed, label]) => html('option', { value: speed }, label)),
  );
  readonly #reset = html(
    'button',
    {
      type: 'button',
      class: 'small',
      title: 'Back to time 0, with everything afresh',
    },
    'Reset',
  );
  /** Each pane's instruments, to lay out again when its size changes. */
  readonly #laid = new WeakMap<
    HTMLElement,
    {
      readonly pieces: readonly Piece[];
      readonly frames: readonly HTMLElement[];
    }
  >();
  /** Lays out each pane's instruments whenever its size changes. */
  readonly #fitter = new ResizeObserver((entries) => {
    for (const entry of entries) {
      this.#fit(entry.target as HTMLElement);
    }
  });
  #scope:
    | { panel: SignalPanel; view: PlotView; at: PortRef | undefined }
    | undefined;
  #view = loadView();
  #arranging = false;
  #drag: Drag | undefined;
  #model: FaceModel | undefined;

  constructor(
    host: HTMLElement,
    events: FaceEvents,
    /** Buttons for the header, after Arrange: where the panel goes. */
    actions: readonly HTMLElement[] = [],
  ) {
    this.#events = events;
    this.#arrange.addEventListener('click', () => {
      this.#arranging = !this.#arranging;
      this.#rerender();
    });
    this.#run.addEventListener('click', () => events.run());
    this.#speed.addEventListener('change', () =>
      events.speed(Number(this.#speed.value)),
    );
    this.#reset.addEventListener('click', () => events.reset());
    this.#addPanel.addEventListener('click', () => {
      const doc = this.#model?.doc;
      if (doc) {
        const [next, id] = addPanel(doc);
        this.#show(id);
        events.change(next, 'commit');
      }
    });

    const mode = (value: Mode, label: string, title: string) => {
      const button = html(
        'button',
        { type: 'button', class: 'small', title },
        label,
      );
      button.addEventListener('click', () => {
        this.#view = { ...this.#view, mode: value };
        this.#saveView();
        this.#rerender();
      });
      return button;
    };

    this.#modes = Object.fromEntries(
      MODES.map(([value, label, title]) => [value, mode(value, label, title)]),
    ) as Record<Mode, HTMLButtonElement>;
    host.append(
      html(
        'header',
        { class: 'face-head' },
        html('h2', { class: 'face-title' }, 'Panel'),
        html(
          'div',
          { class: 'transport', role: 'group', 'aria-label': 'Stream' },
          this.#run,
          this.#time,
          this.#speed,
          this.#reset,
        ),
        html(
          'div',
          {
            class: 'face-modes',
            role: 'group',
            'aria-label': 'How the panels show',
          },
          ...Object.values(this.#modes),
        ),
        this.#arrange,
        ...actions,
      ),
      this.#tabs,
      this.#panelsBox,
    );
    this.#panelsBox.append(this.#dropBar);
    this.#fitter.observe(this.#scopeGrid);
    addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#drag) {
        this.#endDrag(false);
      }
    });
  }

  render(model: FaceModel): void {
    this.#model = model;
    const { doc, widgets } = model;
    const panels = facePanels(doc);
    const tabs = this.#view.mode === 'tabs' && !this.#arranging;
    const tab =
      panels.find((p) => p.id === this.#view.tab)?.id ?? panels[0]?.id;
    const shown = tabs ? panels.filter((p) => p.id === tab) : panels;
    const mode = tabs ? 'tabs' : this.#arranging ? 'tile' : this.#view.mode;
    this.#panelsBox.dataset.mode = mode;
    this.#panelsBox.classList.toggle('arranging', this.#arranging);

    // The tabs, with more than one panel to choose from.
    this.#tabs.hidden = !tabs || panels.length < 2;
    this.#tabs.replaceChildren(
      ...panels.map((panel) => {
        const button = html(
          'button',
          {
            type: 'button',
            class: 'face-tab',
            role: 'tab',
            'aria-selected': String(panel.id === tab),
          },
          panel.title || 'Panel',
        );
        button.addEventListener('click', () => this.#show(panel.id));
        return button;
      }),
    );

    const live = new Set<string>();
    const order: HTMLElement[] = [];
    for (const panel of shown) {
      const view = this.#panelView(panel.id);
      live.add(`panel:${panel.id}`);
      view.title.textContent = panel.title || 'Panel';

      if (document.activeElement !== view.name) {
        view.name.value = panel.title;
      }

      view.head.hidden = !this.#arranging && (tabs || panels.length < 2);
      view.remove.disabled = panels.length < 2;
      const panes = panel.panes.map((pane) =>
        this.#renderPane(pane, model, widgets, live),
      );
      setChildren(
        view.panes,
        panes.map((p) => p.element),
      );
      // Tiled, a panel asks for room for its panes side by side.
      view.element.style.flexBasis =
        mode === 'tile'
          ? `${panes.reduce((sum, p) => sum + p.basis + PANE_GAP, -PANE_GAP) + PANEL_EDGES}px`
          : '';
      view.element.style.flexGrow = String(
        Math.max(STRETCH.knob, ...panes.map((p) => p.give)),
      );
      order.push(view.element);
    }

    if (model.scope) {
      live.add(SCOPE);
      const frame = this.#frame(SCOPE);
      const scope = this.#scopePanel();
      scope.at = model.scope.at;

      if (frame.body.firstChild !== scope.panel.element) {
        frame.body.replaceChildren(scope.panel.element);
      }

      this.#updateScope(model.scope, model.transport.time);
      frame.element.dataset.w = '8';
      frame.element.dataset.h = '5';
      frame.element.classList.add('scope');

      if (frame.element.parentElement !== this.#scopeGrid) {
        this.#scopeGrid.append(frame.element);
      }

      this.#scopePane.style.flexBasis = `${8 * PITCH - GAP + PANE_EDGES}px`;
      this.#laid.set(this.#scopeGrid, {
        pieces: [{ kind: 'screen', w: 8 * PITCH - GAP, h: 5 * PITCH - GAP }],
        frames: [frame.element],
      });

      order.push(this.#scopePane);
    }

    if (this.#arranging) {
      order.push(this.#addPanel);
    }

    const count = panels.reduce(
      (sum, p) => sum + p.panes.reduce((n, q) => n + q.entries.length, 0),
      0,
    );
    this.#empty.hidden = count > 0 || Boolean(model.scope);
    setChildren(this.#panelsBox, [...order, this.#empty, this.#dropBar]);

    for (const grid of this.#panelsBox.querySelectorAll<HTMLElement>(
      '.pane-grid',
    )) {
      this.#fit(grid);
    }

    // What is no longer shown goes.
    for (const [id, frame] of this.#frames) {
      if (!live.has(id)) {
        frame.element.remove();
        this.#frames.delete(id);
      }
    }

    for (const [id, view] of this.#paneViews) {
      if (!live.has(`pane:${id}`)) {
        this.#fitter.unobserve(view.grid);
        this.#paneViews.delete(id);
      }
    }

    for (const id of this.#panelViews.keys()) {
      if (!live.has(`panel:${id}`)) {
        this.#panelViews.delete(id);
      }
    }

    this.#arrange.setAttribute('aria-pressed', String(this.#arranging));
    this.#arrange.textContent = this.#arranging ? 'Done' : 'Arrange';

    for (const [value, button] of Object.entries(this.#modes)) {
      button.setAttribute('aria-pressed', String(value === this.#view.mode));
    }

    this.setTransport(model.transport);
  }

  /** Updates the transport and the selection's screen, as time passes. */
  tick(transport: Transport, scope: ScopeState | undefined): void {
    this.setTransport(transport);

    if (scope && this.#scope) {
      this.#updateScope(scope, transport.time);
    }
  }

  setTransport(transport: Transport): void {
    const { time, running, speed, behind } = transport;
    this.#run.textContent = running ? 'Pause' : 'Run';
    this.#run.setAttribute('aria-pressed', String(running));
    this.#time.textContent = clockTime(time);
    this.#time.classList.toggle('behind', running && behind);
    this.#time.title =
      running && behind
        ? 'The simulation is slower than this speed, so time runs slower.'
        : '';
    this.#speed.value = String(speed);
    this.#reset.disabled = time === 0 && !running;
  }

  /** Lays out a pane and its instruments; returns the width it would like. */
  #renderPane(
    pane: FacePane,
    model: FaceModel,
    widgets: Widgets,
    live: Set<string>,
  ): {
    readonly element: HTMLElement;
    readonly basis: number;
    readonly give: number;
  } {
    const view = this.#paneView(pane.id);
    live.add(`pane:${pane.id}`);
    view.title.textContent = pane.title || 'Pane';

    if (document.activeElement !== view.name) {
      view.name.value = pane.title;
    }

    // A title that only repeats one of its instruments' names says nothing.
    const said = (name: string | undefined) =>
      name?.trim().toLowerCase() === pane.title.trim().toLowerCase();
    view.title.hidden = pane.entries.some((entry) =>
      said(entry.item.block.name),
    );

    const pieces: Piece[] = [];
    const frames = pane.entries.map((entry) => {
      live.add(entry.id);
      const frame = this.#frame(entry.id);
      const element = widgets.get('face', entry.item);
      if (frame.body.firstChild !== element) {
        frame.body.replaceChildren(element);
      }

      const own = this.#sizeOf(model, entry.item);
      pieces.push({
        kind: own.kind,
        w: (entry.w ?? own.w) * PITCH - GAP,
        h: (entry.h ?? own.h) * PITCH - GAP,
      });
      frame.element.dataset.w = String(entry.w ?? own.w);
      frame.element.dataset.h = String(entry.h ?? own.h);
      frame.element.dataset.kind = entry.item.block.kind;
      frame.element.classList.toggle('selected', model.selected.has(entry.id));
      return frame.element;
    });
    setChildren(view.grid, frames);
    this.#laid.set(view.grid, { pieces, frames });
    view.element.classList.toggle('empty', !frames.length);
    const basis = pieces.length
      ? paneWidth(pieces, WIDEST * PITCH - GAP, PITCH) + PANE_EDGES
      : 8 * PITCH;
    view.element.style.flexBasis = `${basis}px`;
    // Spare width goes to what stretches well: screens most, displays some,
    // and a pane of knobs stays thin unless nothing beside it stretches.
    const give = pieces.some((p) => p.kind === 'screen')
      ? STRETCH.screen
      : pieces.some((p) => p.kind === 'display')
        ? STRETCH.display
        : STRETCH.knob;
    view.element.style.flexGrow = String(give);

    return { element: view.element, basis, give };
  }

  /** An instrument's own size in cells, and how it takes to a pane. */
  #sizeOf(
    model: FaceModel,
    item: FaceItem,
  ): { w: number; h: number; kind: PieceKind } {
    const state =
      item.block.kind === CONTROL
        ? controlState(model.doc, model.bindings, item.path, item.block)
        : undefined;
    const knob =
      state !== undefined &&
      !('problem' in state) &&
      state.binding === undefined &&
      state.spec.type === 'number' &&
      item.block.params.style !== 'slider';
    const size = defaultSize(item.block, state !== undefined && !knob);
    const kind: PieceKind =
      item.block.kind === PLOT ||
      item.block.kind === SYMBOLS ||
      item.block.kind === NOTE
        ? 'screen'
        : knob || item.block.kind === SPEAKER
          ? 'knob'
          : 'display';
    return { ...size, kind };
  }

  /**
   * Fits a pane's instruments to its width: as many columns as there is room
   * for, and then no more than they need to stay in as few rows, in the middle
   * of the pane; each instrument across as many as it asks, or as there are.
   */
  #fit(grid: HTMLElement): void {
    const laid = this.#laid.get(grid);
    if (!laid) {
      return;
    }

    const { boxes, height } = layoutPane(
      laid.pieces,
      grid.clientWidth,
      grid.clientHeight,
    );
    grid.style.minHeight = `${Math.ceil(height)}px`;
    laid.frames.forEach((frame, i) => {
      const box = boxes[i]!;
      const style = frame.style;
      style.left = `${Math.round(box.x)}px`;
      style.top = `${Math.round(box.y)}px`;
      style.width = `${Math.round(box.w)}px`;
      style.height = `${Math.round(box.h)}px`;

      // A knob given more room than its own grows into it.
      if (laid.pieces[i]!.kind === 'knob') {
        const size = Math.min(box.w - KNOB_MARGIN.w, box.h - KNOB_MARGIN.h);
        style.setProperty(
          '--knob-size',
          `${Math.round(Math.min(KNOB_LARGEST, Math.max(KNOB_SIZE, size)))}px`,
        );
      }
    });
  }

  #show(panel: string): void {
    this.#view = { ...this.#view, tab: panel };
    this.#saveView();
    this.#rerender();
  }

  #saveView(): void {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(this.#view));
    } catch {
      // Without storage the choice lasts as long as the page.
    }
  }

  #updateScope(scope: ScopeState, time: number): void {
    const panel = this.#scopePanel();
    panel.at = scope.at;
    panel.panel.update({
      title: scope.title,
      trace: scope.trace,
      problem: scope.problem,
      settings: scopeSettings[panel.view],
      color: 'var(--muted)',
      time,
      listening: scope.listening,
    });
  }

  #rerender(): void {
    if (this.#model) {
      this.render(this.#model);
    }
  }

  /** Applies a change to the document, if there is one. */
  #change(edit: (doc: LabDocument) => LabDocument, mode: ChangeMode): void {
    const doc = this.#model?.doc;
    if (doc) {
      this.#events.change(edit(doc), mode);
    }
  }

  #panelView(id: string): PanelView {
    let view = this.#panelViews.get(id);
    if (view) {
      return view;
    }

    const title = html('h3', { class: 'panel-title' });
    const name = html('input', {
      type: 'text',
      class: 'panel-name',
      'aria-label': 'Panel name',
      placeholder: 'Panel',
    });
    name.addEventListener('change', () =>
      this.#change((doc) => retitle(doc, id, name.value), 'commit'),
    );
    const grip = html('span', {
      class: 'grip',
      title: 'Drag to move the panel',
      'aria-hidden': 'true',
    });
    const add = tool('+ Pane', 'Add a pane to this panel');
    add.addEventListener('click', () =>
      this.#change((doc) => addPane(doc, id)[0], 'commit'),
    );
    const remove = tool('×', 'Take this panel away; its panes go to the next');
    remove.addEventListener('click', () =>
      this.#change((doc) => removePanel(doc, id), 'commit'),
    );
    const head = html(
      'header',
      { class: 'panel-head' },
      grip,
      title,
      name,
      html('span', { class: 'panel-tools' }, add, remove),
    );
    const panes = html('div', { class: 'panel-panes' });
    const element = html(
      'section',
      { class: 'face-panel', 'data-panel': id },
      head,
      panes,
    );
    this.#dragFrom(grip, () => ({ kind: 'panel', id, element }));
    view = { element, head, title, name, panes, remove };
    this.#panelViews.set(id, view);
    return view;
  }

  #paneView(id: string): PaneView {
    let view = this.#paneViews.get(id);
    if (view) {
      return view;
    }

    const title = html('h3', { class: 'pane-title' });
    const name = html('input', {
      type: 'text',
      class: 'pane-name',
      'aria-label': 'Pane name',
      placeholder: 'Pane',
    });
    name.addEventListener('change', () =>
      this.#change((doc) => retitle(doc, id, name.value), 'commit'),
    );
    const grip = html('span', {
      class: 'grip',
      title: 'Drag to move the pane',
      'aria-hidden': 'true',
    });
    const remove = tool(
      '×',
      'Take this pane away; its instruments go to the one beside it',
    );
    remove.addEventListener('click', () =>
      this.#change((doc) => removePane(doc, id), 'commit'),
    );
    const grid = html('div', { class: 'pane-grid' });
    const element = html(
      'section',
      { class: 'pane', 'data-pane': id },
      html('header', { class: 'pane-head' }, grip, title, name, remove),
      grid,
    );
    this.#dragFrom(grip, () => ({ kind: 'pane', id, element }));
    this.#fitter.observe(grid);
    view = { element, title, name, grid };
    this.#paneViews.set(id, view);
    return view;
  }

  #frame(id: string): Frame {
    let frame = this.#frames.get(id);
    if (frame) {
      return frame;
    }

    const body = html('div', { class: 'face-body' });
    const grip = html('div', { class: 'face-grip', title: 'Drag to move' });
    const resize = html('div', {
      class: 'face-resize',
      title: 'Drag to resize; double-click for its own size',
    });
    const element = html(
      'div',
      { class: 'face-item', 'data-id': id },
      body,
      grip,
      resize,
    );
    frame = { element, body };
    this.#frames.set(id, frame);

    if (id !== SCOPE) {
      this.#dragFrom(grip, () => ({ kind: 'instrument', id, element }));
      resize.addEventListener('pointerdown', (event) => {
        const before = this.#model?.doc;
        if (!before) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        resize.setPointerCapture(event.pointerId);
        this.#drag = {
          kind: 'resize',
          id,
          x: event.clientX,
          y: event.clientY,
          w: Number(element.dataset.w),
          h: Number(element.dataset.h),
          before,
        };
      });
      resize.addEventListener('pointermove', (event) => {
        const drag = this.#drag;
        if (drag?.kind !== 'resize') {
          return;
        }

        const w = Math.max(
          2,
          drag.w + Math.round((event.clientX - drag.x) / PITCH),
        );
        const h = Math.max(
          2,
          drag.h + Math.round((event.clientY - drag.y) / PITCH),
        );
        this.#change((doc) => resizeInstrument(doc, id, { w, h }), 'preview');
      });

      resize.addEventListener('pointerup', () => this.#endDrag(true));
      resize.addEventListener('pointercancel', () => this.#endDrag(false));
      resize.addEventListener('dblclick', () =>
        this.#change((doc) => resizeInstrument(doc, id, undefined), 'commit'),
      );
    }

    // Clicking an instrument away from its controls shows it on the diagram.
    element.addEventListener('click', (event) => {
      const target = event.target as Element;
      if (
        id !== SCOPE &&
        !this.#arranging &&
        !target.closest('input, select, textarea, button, canvas, [data-live]')
      ) {
        this.#events.reveal(id);
      }
    });
    return frame;
  }

  /**
   * Makes `handle` start a drag of what `start` says, while arranging: a bar
   * shows where it would land, and letting go puts it there.
   */
  #dragFrom(handle: HTMLElement, start: () => Drag): void {
    handle.addEventListener('pointerdown', (event) => {
      if (!this.#arranging || event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      this.#drag = start();

      if (this.#drag.kind !== 'resize') {
        this.#drag.element.classList.add('dragging');
      }
    });
    handle.addEventListener('pointermove', (event) =>
      this.#dragOver(event.clientX, event.clientY),
    );
    handle.addEventListener('pointerup', () => this.#endDrag(true));
    handle.addEventListener('pointercancel', () => this.#endDrag(false));
  }

  /** Works out where what is dragged would land, and shows it. */
  #dragOver(x: number, y: number): void {
    const drag = this.#drag;
    if (!drag || drag.kind === 'resize') {
      return;
    }

    const under = document.elementFromPoint(x, y);
    const others = (box: Element, selector: string) =>
      [...box.querySelectorAll<HTMLElement>(`:scope > ${selector}`)].filter(
        (element) => element !== drag.element,
      );
    let into: string | undefined;
    let box: Element | null | undefined;
    let siblings: HTMLElement[] = [];
    if (drag.kind === 'instrument') {
      const pane = under?.closest<HTMLElement>('.pane[data-pane]');
      box = pane?.querySelector('.pane-grid');
      into = pane?.dataset.pane;
      siblings = box ? others(box, '.face-item') : [];
    } else if (drag.kind === 'pane') {
      const panel = under?.closest<HTMLElement>('.face-panel');
      box = panel?.querySelector('.panel-panes');
      into = panel?.dataset.panel;
      siblings = box ? others(box, '.pane') : [];
    } else {
      box = this.#panelsBox;
      into = '';
      siblings = others(box, '.face-panel');
    }

    if (into === undefined || !box) {
      drag.target = undefined;
      this.#dropBar.hidden = true;
      return;
    }

    // Instruments and panes flow in rows; panels do when tiled.
    const rows =
      drag.kind !== 'panel' || this.#panelsBox.dataset.mode === 'tile';
    const area = box.getBoundingClientRect();
    const near = siblings.length ? nearest(siblings, x, y, rows) : undefined;
    drag.target = {
      into,
      index: near ? near.index + (near.after ? 1 : 0) : 0,
    };

    // A bar beside the one it would go next to, or along the empty box.
    const origin = this.#panelsBox.getBoundingClientRect();
    const across = near ? near.beside : rows;
    const edge = near
      ? across
        ? near.after
          ? near.box.right + 2
          : near.box.left - 5
        : near.after
          ? near.box.bottom + 2
          : near.box.top - 5
      : across
        ? area.left
        : area.top;
    const bar = this.#dropBar.style;
    if (across) {
      bar.left = `${edge - origin.left}px`;
      bar.top = `${(near?.box.top ?? area.top) - origin.top}px`;
      bar.width = '3px';
      bar.height = `${near?.box.height ?? Math.max(32, area.height)}px`;
    } else {
      bar.left = `${(near?.box.left ?? area.left) - origin.left}px`;
      bar.top = `${edge - origin.top}px`;
      bar.width = `${near?.box.width ?? area.width}px`;
      bar.height = '3px';
    }

    this.#dropBar.hidden = false;
  }

  #endDrag(drop: boolean): void {
    const drag = this.#drag;
    this.#drag = undefined;
    this.#dropBar.hidden = true;

    if (!drag) {
      return;
    }

    // A resize shows as it goes; letting go keeps it as one step to undo,
    // and Escape puts back what was there, leaving nothing to undo.
    if (drag.kind === 'resize') {
      this.#change((doc) => (drop ? doc : drag.before), 'commit');
      return;
    }

    drag.element.classList.remove('dragging');
    const target = drag.target;
    if (!drop || !target) {
      return;
    }

    this.#change(
      (doc) =>
        drag.kind === 'instrument'
          ? moveInstrument(doc, drag.id, target.into, target.index)
          : drag.kind === 'pane'
            ? movePane(doc, drag.id, target.into, target.index)
            : movePanel(doc, drag.id, target.index),
      'commit',
    );
  }

  #scopePanel(): {
    panel: SignalPanel;
    view: PlotView;
    at: PortRef | undefined;
  } {
    if (!this.#scope) {
      const add = html(
        'button',
        { type: 'button', class: 'small' },
        'Add plot',
      );
      const scope: {
        panel: SignalPanel;
        view: PlotView;
        at: PortRef | undefined;
      } = {
        view: 'time',
        at: undefined,
        panel: new SignalPanel({
          view: (view) => {
            scope.view = view;
            this.#rerender();
          },
          listen: () => scope.at && this.#events.listen(scope.at),
          extra: [add],
        }),
      };
      add.addEventListener(
        'click',
        () => scope.at && this.#events.addPlot(scope.at),
      );
      this.#scope = scope;
    }

    return this.#scope;
  }
}
