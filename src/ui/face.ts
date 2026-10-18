// The panel face: the front of the instrument, built from the instruments on
// the diagram. Every plot is a screen, every control a knob, switch or field,
// every readout a display and every speaker a grille with Play; notes marked
// for the face become labels. Arrange moves and resizes them on a grid, and
// the layout is saved with the document. The transport drives the playhead
// that animates them, and the selection's signal gets a screen at the end, to
// look at before adding a plot for it.

import type { PlotView } from '../blocks/instruments.ts';
import { CONTROL } from '../blocks/instruments.ts';
import type { PortRef } from '../engine/circuit.ts';
import { si } from '../engine/format.ts';
import type { Signal } from '../engine/signal.ts';
import {
  setFaceSpot,
  type FaceSpot,
  type LabDocument,
} from '../model/document.ts';
import type { Bindings } from '../model/flatten.ts';
import {
  controlState,
  defaultSize,
  faceItems,
  layoutFace,
  type FaceItem,
} from '../model/instruments.ts';
import type { ChangeMode } from './controls.ts';
import { html } from './dom.ts';
import { SignalPanel, type PlotSettings } from './signal-panel.ts';
import type { Widgets } from './widgets.ts';

/** Grid cell size and the gap between cells, in CSS pixels. */
const CELL = 32;
const GAP = 8;
const PITCH = CELL + GAP;

/** Playback speeds for the playhead. */
const SPEEDS: readonly (readonly [number, string])[] = [
  [1, '1×'],
  [0.5, '½×'],
  [0.25, '¼×'],
  [0.125, '⅛×'],
  [1 / 16, '1/16×'],
];

export type Transport = {
  /** The playhead's time, if it is out. */
  readonly time: number | undefined;
  readonly duration: number;
  /** Whether the playhead is moving. */
  readonly running: boolean;
  readonly speed: number;
};

export type FaceModel = {
  readonly doc: LabDocument;
  readonly widgets: Widgets;
  readonly bindings: Bindings;
  /** The signal the selection points at, unless a plot already shows it. */
  readonly scope:
    | {
        readonly at: PortRef;
        readonly title: string;
        readonly signal: Signal | undefined;
        readonly playing: boolean;
      }
    | undefined;
  /** Full ids of the selected instruments, to highlight. */
  readonly selected: ReadonlySet<string>;
  readonly transport: Transport;
};

export type FaceEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  /** Shows an instrument on the diagram. */
  reveal(id: string): void;
  addPlot(at: PortRef): void;
  play(at: PortRef): void;
  stop(): void;
  /** Starts or stops the playhead. */
  run(): void;
  seek(time: number | undefined): void;
  speed(speed: number): void;
};

type Frame = {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
};

const SCOPE = '@scope';
const scopeSettings: Record<PlotView, PlotSettings> = {
  time: { view: 'time', follow: undefined, low: 0, high: 0 },
  spectrum: { view: 'spectrum', follow: undefined, low: 0, high: 0 },
  waterfall: { view: 'waterfall', follow: undefined, low: 0, high: 0 },
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
  readonly #scrub = html('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 'any',
    value: 0,
    'aria-label': 'Playhead',
  });
  readonly #time = html('span', { class: 'transport-time' });
  readonly #speed = html(
    'select',
    { 'aria-label': 'Playhead speed' },
    ...SPEEDS.map(([speed, label]) => html('option', { value: speed }, label)),
  );
  readonly #hide = html(
    'button',
    {
      type: 'button',
      class: 'small icon',
      title: 'Put the playhead away',
      'aria-label': 'Put the playhead away',
    },
    '×',
  );
  #scope:
    | { panel: SignalPanel; view: PlotView; at: PortRef | undefined }
    | undefined;
  #arranging = false;
  #columns = 20;
  #model: FaceModel | undefined;

  constructor(host: HTMLElement, events: FaceEvents) {
    this.#events = events;
    this.#arrange.addEventListener('click', () => {
      this.#arranging = !this.#arranging;
      this.#rerender();
    });
    this.#run.addEventListener('click', () => events.run());
    this.#scrub.addEventListener('input', () =>
      events.seek(Number(this.#scrub.value)),
    );
    this.#speed.addEventListener('change', () =>
      events.speed(Number(this.#speed.value)),
    );
    this.#hide.addEventListener('click', () => events.seek(undefined));
    host.append(
      html(
        'header',
        { class: 'face-head' },
        html('h2', { class: 'face-title' }, 'Panel'),
        html(
          'div',
          { class: 'transport', role: 'group', 'aria-label': 'Playhead' },
          this.#run,
          this.#scrub,
          this.#time,
          this.#speed,
          this.#hide,
        ),
        this.#arrange,
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
    const items = faceItems(doc);
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

      scope.panel.update({
        title: model.scope.title,
        signal: model.scope.signal,
        settings: scopeSettings[scope.view],
        color: 'var(--muted)',
        time: model.transport.time,
        playing: model.scope.playing,
      });
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

  /** Updates the transport alone, as the playhead moves. */
  setTransport(transport: Transport): void {
    const { time, duration, running, speed } = transport;
    this.#run.textContent = running ? '❚❚ Pause' : '▶ Animate';
    this.#run.setAttribute('aria-pressed', String(running));
    this.#scrub.max = String(duration);

    if (document.activeElement !== this.#scrub) {
      this.#scrub.value = String(time ?? 0);
    }

    this.#time.textContent = time === undefined ? '–' : si(time, 's', 3);
    this.#hide.hidden = time === undefined;
    this.#speed.value = String(speed);
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
          play: () => {
            const model = this.#model;
            if (!scope.at || !model?.scope) {
              return;
            }

            if (model.scope.playing) {
              this.#events.stop();
            } else {
              this.#events.play(scope.at);
            }
          },
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
