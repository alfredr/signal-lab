// The panel face: the front of the instrument, built from the instruments on
// the diagram. Every plot is a screen, every control a knob, switch or field,
// every readout a display and every speaker a grille with Play; notes marked
// for the face become labels. Arrange moves and resizes them on a grid, and
// the layout is saved with the document. The transport runs the stream, and
// the selection's signal gets a screen at the end, to look at before adding a
// plot for it.

import type { PlotView } from '../blocks/instruments.ts';
import { CONTROL } from '../blocks/instruments.ts';
import type { PortRef } from '../engine/circuit.ts';
import {
  setFaceSpot,
  type FaceSpot,
  type LabDocument,
} from '../model/document.ts';
import type { Bindings } from '../model/flatten.ts';
import {
  controlState,
  defaultSize,
  faceCards,
  layoutFace,
  type FaceItem,
} from '../model/instruments.ts';
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

type Frame = {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
};

const SCOPE = '@scope';
const scopeSettings: Record<PlotView, ReturnType<typeof defaultSettings>> = {
  time: defaultSettings('time'),
  spectrum: defaultSettings('spectrum'),
  waterfall: defaultSettings('waterfall'),
};

const place = (element: HTMLElement, spot: FaceSpot) => {
  element.style.gridColumn = `${spot.x + 1} / span ${spot.w}`;
  element.style.gridRow = `${spot.y + 1} / span ${spot.h}`;
};

export class Face {
  readonly #events: FaceEvents;
  readonly #grid = html('div', { class: 'face-grid' });
  readonly #frames = new Map<string, Frame>();
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
  #scope:
    | { panel: SignalPanel; view: PlotView; at: PortRef | undefined }
    | undefined;
  #arranging = false;
  #columns = 20;
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
        this.#arrange,
        ...actions,
      ),
      this.#grid,
    );
    new ResizeObserver(() => {
      const columns = Math.max(
        8,
        Math.floor((this.#grid.clientWidth + GAP) / PITCH),
      );
      if (columns !== this.#columns) {
        this.#columns = columns;
        this.#rerender();
      }
    }).observe(this.#grid);
  }

  render(model: FaceModel): void {
    this.#model = model;
    const { doc, widgets } = model;
    // A plot stacked under a view draws there instead.
    const items = faceCards(doc);
    const sizeOf = (item: FaceItem) => {
      if (item.id === SCOPE) {
        return { w: 8, h: 5 };
      }

      const state =
        item.block.kind === CONTROL
          ? controlState(doc, model.bindings, item.path, item.block)
          : undefined;
      const knob =
        state !== undefined &&
        !('problem' in state) &&
        state.binding === undefined &&
        state.spec.type === 'number' &&
        item.block.params.style !== 'slider';
      return defaultSize(item.block, state !== undefined && !knob);
    };

    const scopeItem: FaceItem | undefined = model.scope && {
      id: SCOPE,
      path: [],
      block: { id: SCOPE, kind: 'plot', x: 0, y: 0, params: {} },
    };
    const layout = layoutFace(
      scopeItem ? [...items, scopeItem] : items,
      doc.face,
      this.#columns,
      sizeOf,
    );

    const live = new Set<string>();
    for (const item of items) {
      live.add(item.id);
      const frame = this.#frame(item.id);
      const element = widgets.get('face', item);
      if (frame.body.firstChild !== element) {
        frame.body.replaceChildren(element);
      }

      place(frame.element, layout.get(item.id)!);
      frame.element.classList.toggle('selected', model.selected.has(item.id));
      frame.element.dataset.kind = item.block.kind;
    }

    if (model.scope && scopeItem) {
      live.add(SCOPE);
      const frame = this.#frame(SCOPE);
      const scope = this.#scopePanel();
      scope.at = model.scope.at;

      if (frame.body.firstChild !== scope.panel.element) {
        frame.body.replaceChildren(scope.panel.element);
      }

      this.#updateScope(model.scope, model.transport.time);
      place(frame.element, layout.get(SCOPE)!);
      frame.element.classList.add('scope');
    }

    for (const [id, frame] of this.#frames) {
      if (!live.has(id)) {
        frame.element.remove();
        this.#frames.delete(id);
      }
    }

    this.#empty.hidden = live.size > 0;

    if (!this.#empty.isConnected) {
      this.#grid.append(this.#empty);
    }

    this.#grid.classList.toggle('arranging', this.#arranging);
    this.#arrange.setAttribute('aria-pressed', String(this.#arranging));
    this.#arrange.textContent = this.#arranging ? 'Done' : 'Arrange';
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

  #frame(id: string): Frame {
    let frame = this.#frames.get(id);
    if (frame) {
      return frame;
    }

    const body = html('div', { class: 'face-body' });
    const grip = html('div', { class: 'face-grip', title: 'Drag to move' });
    const resize = html('div', {
      class: 'face-resize',
      title: 'Drag to resize',
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
    this.#grid.append(element);

    this.#gesture(id, grip, (spot, dx, dy) => ({
      ...spot,
      x: Math.max(0, spot.x + dx),
      y: Math.max(0, spot.y + dy),
    }));
    this.#gesture(id, resize, (spot, dx, dy) => ({
      ...spot,
      w: Math.max(2, spot.w + dx),
      h: Math.max(2, spot.h + dy),
    }));

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

  /** Dragging a handle moves or resizes an instrument, in whole cells. */
  #gesture(
    id: string,
    handle: HTMLElement,
    reshape: (spot: FaceSpot, dx: number, dy: number) => FaceSpot,
  ): void {
    let drag: { x: number; y: number; spot: FaceSpot } | undefined;
    const spotOf = (): FaceSpot | undefined => {
      const element = this.#frames.get(id)?.element;
      const column = element?.style.gridColumn.match(/(\d+) \/ span (\d+)/);
      const row = element?.style.gridRow.match(/(\d+) \/ span (\d+)/);
      return column && row
        ? {
            x: Number(column[1]) - 1,
            y: Number(row[1]) - 1,
            w: Number(column[2]),
            h: Number(row[2]),
          }
        : undefined;
    };

    handle.addEventListener('pointerdown', (event) => {
      const spot = spotOf();
      if (!spot || id === SCOPE) {
        return;
      }

      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, spot };
    });
    handle.addEventListener('pointermove', (event) => {
      const doc = this.#model?.doc;
      if (!drag || !doc) {
        return;
      }

      const dx = Math.round((event.clientX - drag.x) / PITCH);
      const dy = Math.round((event.clientY - drag.y) / PITCH);
      this.#events.change(
        setFaceSpot(doc, id, reshape(drag.spot, dx, dy)),
        'preview',
      );
    });

    const end = () => {
      const doc = this.#model?.doc;
      if (drag && doc) {
        drag = undefined;
        this.#events.change(doc, 'commit');
      }
    };

    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
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
