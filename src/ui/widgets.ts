// Instrument widgets for the diagram and panel face. Both display state at the
// playhead. Cached widgets are rebuilt only when their defining properties
// change, preserving active gestures during document updates.

import {
  BUTTON,
  CONTROL,
  NOTE,
  PLOT,
  READOUT,
  SPEAKER,
  SYMBOLS,
} from '../blocks/instruments.ts';
import type { Reading } from '../engine/block.ts';
import { portKey, type PortRef } from '../engine/circuit.ts';
import { formatReading } from '../engine/format.ts';
import {
  coerceParam,
  type NumberParam,
  type ParamSpec,
  type ParamValue,
} from '../engine/params.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  diagramAt,
  pathId,
  resolveRef,
  setParam,
  updateDiagramAt,
  wireInto,
  type LabDocument,
} from '../model/document.ts';
import type { Bindings } from '../model/flatten.ts';
import {
  controlState,
  symbolSources,
  type ControlState,
  type FaceItem,
  type SymbolSources,
} from '../model/instruments.ts';
import {
  formatParam,
  fromFraction,
  paramControl,
  parseQuantity,
  toFraction,
  type ChangeMode,
  type Control,
} from './controls.ts';
import { html, svg } from './dom.ts';
import { blockLabel } from './labels.ts';
import type { Live } from './live.ts';
import { renderMarkdown } from './markdown.ts';
import {
  plotSettings,
  Screen,
  SignalPanel,
  type ScreenState,
} from './signal-panel.ts';
import { SymbolView } from './symbols.ts';

export type WidgetContext = {
  readonly doc: LabDocument;
  /** Browser-side signal history. */
  readonly live: Live;
  /** Every block's readings at the playhead. */
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
  readonly status: ReadonlyMap<string, BlockStatus>;
  readonly bindings: Bindings;
  /** Keys of the ports being listened to. */
  readonly listening: ReadonlySet<string>;
  /** The playhead's time. */
  readonly time: number;
};

export type WidgetEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  /** Starts or stops listening to a port. */
  listen(at: PortRef): void;
  /** Triggers a block identified by its full id. */
  press(id: string): void;
};

export type Place = 'diagram' | 'face';

type Widget = {
  readonly key: string;
  readonly element: HTMLElement;
  sync(context: WidgetContext): void;
};

/** The output wired into an instrument's input, as a full port reference. */
export function inputOf(
  doc: LabDocument,
  item: FaceItem,
): PortRef | undefined {
  const diagram = diagramAt(doc, item.path);
  const wire = diagram && wireInto(diagram, { block: item.block.id, port: 0 });
  return (
    wire && { block: pathId(item.path, wire.from.block), port: wire.from.port }
  );
}

/** Fetches an instrument's current block after document edits. */
function current(context: WidgetContext, item: FaceItem): FaceItem {
  const block = diagramAt(context.doc, item.path)?.blocks.find(
    (b) => b.id === item.block.id,
  );
  return block ? { ...item, block } : item;
}

/** The angle of a knob's pointer, from -135 degrees at 0 to 135 at 1. */
const angle = (fraction: number) => -135 + 270 * fraction;

/** The radius of a knob's value arc, in a dial 100 across. */
const RIM = 40;

/** The point `radius` out at `degrees`, clockwise from up. */
function polar(degrees: number, radius: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [radius * Math.cos(radians), radius * Math.sin(radians)];
}

/** An arc on the knob's face from `from` to `to` degrees, clockwise from up. */
function arc(from: number, to: number, radius = RIM): string {
  const point = (degrees: number) =>
    polar(degrees, radius)
      .map((n) => n.toFixed(2))
      .join(' ');
  return `M${point(from)} A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${point(to)}`;
}

/**
 * Rotary numeric control with a value display and range labels. Supports
 * dragging, Shift for fine adjustment, scrolling, and keyboard steps.
 * Double-click or Enter enables text entry.
 */
function knob(
  spec: NumberParam,
  value: number,
  onChange: (value: number, mode: ChangeMode) => void,
): Control {
  const fill = svg('path', { class: 'knob-fill' });
  const tip = svg('circle', { class: 'knob-tip', r: 4.5 });
  const dial = html(
    'div',
    {
      class: 'knob',
      role: 'slider',
      tabindex: 0,
      'aria-label': spec.label,
      'data-live': '',
    },
    svg(
      'svg',
      {
        class: 'knob-dial',
        viewBox: '-50 -50 100 100',
        'aria-hidden': 'true',
      },
      svg('path', { class: 'knob-track', d: arc(-135, 135) }),
      fill,
      tip,
    ),
  );
  const text = html('input', {
    class: 'control-value knob-value',
    type: 'text',
    inputmode: 'decimal',
    spellcheck: 'false',
    autocomplete: 'off',
    tabindex: -1,
    'aria-label': `${spec.label} value`,
  });
  const element = html(
    'div',
    { class: 'knob-control' },
    html('span', { class: 'control-label', title: spec.label }, spec.label),
    html('div', { class: 'knob-well' }, dial, text),
    html(
      'div',
      { class: 'knob-range', 'aria-hidden': 'true' },
      html('span', {}, formatParam(spec.min, spec)),
      html('span', {}, formatParam(spec.max, spec)),
    ),
  );

  let shown = value;
  const snap = (v: number) => {
    const presets = spec.presets;
    return presets?.length
      ? presets.reduce((best, p) =>
          Math.abs(p - v) < Math.abs(best - v) ? p : best,
        )
      : v;
  };

  const show = (v: number) => {
    shown = v;
    const t = toFraction(spec, v);
    fill.setAttribute('d', t > 0.002 ? arc(-135, angle(t)) : '');
    const [x, y] = polar(angle(t), RIM);
    tip.setAttribute('cx', x.toFixed(2));
    tip.setAttribute('cy', y.toFixed(2));
    dial.setAttribute('aria-valuenow', String(v));
    dial.setAttribute('aria-valuetext', formatParam(v, spec));

    if (document.activeElement !== text) {
      text.value = formatParam(v, spec);
      // A long value takes a smaller size to fit inside the dial.
      text.classList.toggle('long', text.value.length > 6);
    }
  };

  // Enable text entry in the value field.
  const type = () => {
    element.classList.add('typing');
    text.focus();
    text.select();
  };

  const turn = (fraction: number, mode: ChangeMode) => {
    const v = snap(fromFraction(spec, fraction));
    if (v !== shown || mode === 'commit') {
      show(v);
      onChange(v, mode);
    }
  };

  show(value);

  let drag: { y: number; from: number } | undefined;
  dial.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dial.focus();
    dial.setPointerCapture(event.pointerId);
    drag = { y: event.clientY, from: toFraction(spec, shown) };
  });
  dial.addEventListener('pointermove', (event) => {
    if (drag) {
      const travel = event.shiftKey ? 800 : 200;
      turn(drag.from + (drag.y - event.clientY) / travel, 'preview');
    }
  });

  const release = () => {
    if (drag) {
      drag = undefined;
      onChange(shown, 'commit');
    }
  };

  dial.addEventListener('pointerup', release);
  dial.addEventListener('pointercancel', release);
  dial.addEventListener('dblclick', type);

  let settle: ReturnType<typeof setTimeout> | undefined;
  dial.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      turn(toFraction(spec, shown) - event.deltaY / 1500, 'preview');
      clearTimeout(settle);
      settle = setTimeout(() => onChange(shown, 'commit'), 300);
    },
    { passive: false },
  );
  dial.addEventListener('keydown', (event) => {
    const steps: Record<string, number> = {
      ArrowUp: 0.01,
      ArrowRight: 0.01,
      ArrowDown: -0.01,
      ArrowLeft: -0.01,
      PageUp: 0.1,
      PageDown: -0.1,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      turn(toFraction(spec, shown) + step, 'commit');
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      turn(event.key === 'Home' ? 0 : 1, 'commit');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      type();
    }
  });

  text.addEventListener('change', () => {
    const parsed = parseQuantity(text.value);
    if (parsed === undefined) {
      text.value = formatParam(shown, spec);
      return;
    }

    const v = coerceParam(spec, parsed) as number;
    show(v);
    onChange(v, 'commit');
  });
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      text.blur();
      dial.focus();
    }
  });
  text.addEventListener('blur', () => {
    element.classList.remove('typing');
    show(shown);
  });
  return { element, update: (v) => show(v as number) };
}

/**
 * Text or numeric input styled as an LCD. Numeric fields also support wheel
 * and arrow-key adjustments.
 */
function lcd(
  spec: ParamSpec,
  value: ParamValue,
  onChange: (value: ParamValue, mode: ChangeMode) => void,
): Control {
  const input = html('input', {
    type: 'text',
    class: 'lcd',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': spec.label,
  });
  let shown = value;
  const text = (v: ParamValue) =>
    spec.type === 'number' ? formatParam(v as number, spec) : String(v);
  const show = (v: ParamValue) => {
    shown = v;

    if (document.activeElement !== input) {
      input.value = text(v);
    }
  };

  show(value);
  input.addEventListener('change', () => {
    const parsed =
      spec.type === 'number' ? parseQuantity(input.value) : input.value.trim();
    if (parsed === undefined) {
      input.value = text(shown);
      return;
    }

    shown = coerceParam(spec, parsed);
    onChange(shown, 'commit');
  });
  input.addEventListener('blur', () => (input.value = text(shown)));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
    }
  });

  if (spec.type === 'number') {
    const step = (by: number, mode: ChangeMode) => {
      const v = fromFraction(spec, toFraction(spec, shown as number) + by);
      shown = coerceParam(spec, v);
      input.value = text(shown);
      onChange(shown, mode);
    };

    let settle: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        step(-event.deltaY / 1500, 'preview');
        clearTimeout(settle);
        settle = setTimeout(() => onChange(shown, 'commit'), 300);
      },
      { passive: false },
    );
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        step(event.key === 'ArrowUp' ? 0.01 : -0.01, 'commit');
      }
    });
  }

  return {
    element: html(
      'label',
      { class: 'lcd-control' },
      html('span', { class: 'control-label' }, spec.label),
      input,
    ),
    update: (v) => show(v),
  };
}

/** Control properties that determine whether its widget must be rebuilt. */
function controlShape(state: ControlState | { problem: string }): string {
  return 'problem' in state
    ? state.problem
    : JSON.stringify([
        state.label,
        { ...state.spec, default: undefined },
        state.binding,
      ]);
}

export class Widgets {
  readonly #events: WidgetEvents;
  readonly #instances = new Map<string, Widget>();
  readonly #live = new Set<string>();
  #context: WidgetContext | undefined;

  constructor(events: WidgetEvents) {
    this.#events = events;
  }

  /** Starts a render pass with the latest state. */
  update(context: WidgetContext): void {
    this.#context = context;
    this.#live.clear();
  }

  /**
   * Returns an updated widget, reusing it while its structure remains
   * compatible.
   */
  get(place: Place, item: FaceItem): HTMLElement {
    const context = this.#context!;
    const key = JSON.stringify([
      item.block.kind,
      item.block.name ?? '',
      item.block.params,
      item.block.kind === CONTROL
        ? controlShape(
            controlState(context.doc, context.bindings, item.path, item.block),
          )
        : '',
    ]);
    const id = `${place}:${item.id}`;
    let widget = this.#instances.get(id);
    if (widget?.key !== key) {
      widget = { key, ...this.#build(place, item) };
      this.#instances.set(id, widget);
    }

    this.#live.add(id);
    widget.sync(context);
    return widget.element;
  }

  /** Discards cached widgets unused in this render pass. */
  sweep(): void {
    for (const id of this.#instances.keys()) {
      if (!this.#live.has(id)) {
        this.#instances.delete(id);
      }
    }
  }

  /** Updates plots and readouts for a new playhead time. */
  setTime(
    time: number,
    readings: ReadonlyMap<string, readonly Reading[]>,
  ): void {
    if (!this.#context) {
      return;
    }

    this.#context = { ...this.#context, time, readings };

    for (const id of this.#live) {
      this.#instances.get(id)?.sync(this.#context);
    }
  }

  #change(change: (doc: LabDocument) => LabDocument, mode: ChangeMode): void {
    if (this.#context) {
      this.#events.change(change(this.#context.doc), mode);
    }
  }

  #build(place: Place, item: FaceItem): Omit<Widget, 'key'> {
    switch (item.block.kind) {
      case PLOT:
        return place === 'face' ? this.#screenCard(item) : this.#screen(item);
      case SPEAKER:
        return this.#speaker(place, item);
      case CONTROL:
        return this.#control(place, item);
      case READOUT:
        return this.#readout(item);
      case SYMBOLS:
        return this.#symbols(item);
      case BUTTON:
        return this.#button(place, item);
      case NOTE:
        return {
          element: html(
            'div',
            { class: 'widget-note notes' },
            renderMarkdown(String(item.block.params.text ?? '')),
          ),
          sync: () => {},
        };
      default:
        return { element: html('div', {}), sync: () => {} };
    }
  }

  #screenState(context: WidgetContext, item: FaceItem): ScreenState {
    const at = inputOf(context.doc, item);
    return {
      trace: at && context.live.traces.get(portKey(at)),
      settings: plotSettings(current(context, item).block.params),
      color: 'var(--accent)',
      time: context.time,
      problem: at
        ? problemAt(context.status, at)
        : 'Wire something into this plot.',
    };
  }

  #toggle(context: WidgetContext, item: FaceItem): void {
    const at = inputOf(context.doc, item);
    if (at) {
      this.#events.listen(at);
    }
  }

  /** A small, still plot for the diagram. */
  #screen(item: FaceItem): Omit<Widget, 'key'> {
    const screen = new Screen({ interactive: false });
    const title = html(
      'span',
      { class: 'widget-title' },
      item.block.name || 'Plot',
    );
    return {
      element: html('div', { class: 'widget-plot' }, title, screen.element),
      sync: (context) => screen.update(this.#screenState(context, item)),
    };
  }

  /** A face screen: zooms, switches view and plays. */
  #screenCard(item: FaceItem): Omit<Widget, 'key'> {
    let context: WidgetContext | undefined;
    const panel = new SignalPanel({
      view: (view) =>
        this.#change(
          (doc) =>
            updateDiagramAt(doc, item.path, (d) =>
              setParam(d, item.block.id, 'view', view),
            ),
          'commit',
        ),
      listen: () => context && this.#toggle(context, item),
    });
    return {
      element: panel.element,
      sync: (latest) => {
        context = latest;
        const at = inputOf(latest.doc, item);
        panel.update({
          ...this.#screenState(latest, item),
          title:
            item.block.name ||
            (at ? blockLabel(latest.doc, at.block) : 'Plot'),
          listening: at !== undefined && latest.listening.has(portKey(at)),
        });
      },
    };
  }

  #speaker(place: Place, item: FaceItem): Omit<Widget, 'key'> {
    let context: WidgetContext | undefined;
    const power = html(
      'button',
      { type: 'button', class: 'small play', 'data-live': '' },
      'Off',
    );
    power.addEventListener('click', (event) => {
      event.stopPropagation();

      if (context) {
        this.#toggle(context, item);
      }
    });
    // Align the speaker with knob controls: label above, grille in the center,
    // and power button below. Clicking the grille also toggles playback.
    const grille = html('div', {
      class: 'speaker-grille',
      'aria-hidden': 'true',
      'data-live': '',
    });
    grille.addEventListener('click', (event) => {
      event.stopPropagation();

      if (context && !power.disabled) {
        this.#toggle(context, item);
      }
    });
    const label = html(
      'span',
      { class: 'control-label' },
      item.block.name || 'Speaker',
    );
    const element = html(
      'div',
      { class: `widget-speaker on-${place}` },
      ...(place === 'face' ? [label] : []),
      html('div', { class: 'speaker-well' }, grille),
      power,
    );
    return {
      element,
      sync: (latest) => {
        context = latest;
        const at = inputOf(latest.doc, item);
        const on = at !== undefined && latest.listening.has(portKey(at));
        element.classList.toggle('playing', on);
        power.textContent = on ? 'On' : 'Off';
        power.title = on ? 'Turn this speaker off' : 'Turn this speaker on';
        power.setAttribute('aria-pressed', String(on));
        power.disabled = !at;
      },
    };
  }

  #control(place: Place, item: FaceItem): Omit<Widget, 'key'> {
    const context = this.#context!;
    const state = controlState(
      context.doc,
      context.bindings,
      item.path,
      item.block,
    );
    const label =
      item.block.name || ('problem' in state ? 'Control' : state.label);
    if ('problem' in state) {
      return {
        element: html(
          'div',
          { class: 'widget-control' },
          html('span', { class: 'control-label' }, label),
          html('p', { class: 'control-help' }, state.problem),
        ),
        sync: () => {},
      };
    }

    // Help text belongs in the inspector; a widget has no room for it.
    const spec: ParamSpec = { ...state.spec, label, help: undefined };
    if (state.binding !== undefined) {
      // Bound settings display their expression because direct edits would be
      // overridden.
      const value = html('span', { class: 'widget-value' });
      return {
        element: html(
          'div',
          { class: 'widget-control' },
          html('span', { class: 'control-label' }, label),
          value,
          html('p', { class: 'control-help' }, `= ${state.binding}`),
        ),
        sync: (latest) => {
          const now = controlState(
            latest.doc,
            latest.bindings,
            item.path,
            item.block,
          );
          const bound = 'problem' in now ? undefined : now.bound;
          value.textContent =
            bound === undefined || spec.type !== 'number'
              ? '–'
              : formatParam(bound, spec);
        },
      };
    }

    const set = (value: ParamValue, mode: ChangeMode) =>
      this.#change((doc) => {
        const now = controlState(
          doc,
          this.#context!.bindings,
          item.path,
          item.block,
        );
        return 'problem' in now ? doc : now.set(doc, value);
      }, mode);
    const style = item.block.params.style;
    const control =
      style === 'lcd' && (spec.type === 'number' || spec.type === 'text')
        ? lcd(spec, state.value, set)
        : spec.type === 'number' && style !== 'slider'
          ? knob(spec, state.value as number, set)
          : paramControl(spec, state.value, set);
    return {
      element: html(
        'div',
        { class: `widget-control on-${place}` },
        control.element,
      ),
      sync: (latest) => {
        const now = controlState(
          latest.doc,
          latest.bindings,
          item.path,
          item.block,
        );
        if (!('problem' in now)) {
          control.update(now.value);
        }
      },
    };
  }

  /** A push button: each press sends a pulse from the block. */
  #button(place: Place, item: FaceItem): Omit<Widget, 'key'> {
    const push = html(
      'button',
      { type: 'button', class: 'push', 'data-live': '' },
      item.block.name || 'Push',
    );
    push.addEventListener('pointerdown', (event) => event.stopPropagation());
    push.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#events.press(item.id);
      // Briefly illuminate the button after a press.
      push.classList.add('pressed');
      setTimeout(() => push.classList.remove('pressed'), 150);
    });
    return {
      element: html('div', { class: `widget-button on-${place}` }, push),
      sync: () => {},
    };
  }

  /** Shared Bits to tones widget for the diagram and panel. */
  #symbols(item: FaceItem): Omit<Widget, 'key'> {
    const view = new SymbolView();
    const title = html('span', { class: 'widget-title' });
    // Recompute sources only when the document or statuses change.
    let made:
      | {
          readonly doc: LabDocument;
          readonly status: ReadonlyMap<string, BlockStatus>;
          readonly sources: SymbolSources | { readonly problem: string };
        }
      | undefined;
    return {
      element: html(
        'div',
        { class: 'widget-plot widget-symbols' },
        title,
        view.element,
      ),
      sync: (context) => {
        const now = current(context, item);
        title.textContent = now.block.name || 'Bits to tones';

        if (made?.doc !== context.doc || made.status !== context.status) {
          made = {
            doc: context.doc,
            status: context.status,
            sources: symbolSources(context.doc, now, context),
          };
        }

        const { sources } = made;
        const trace = (at: PortRef | undefined) =>
          at && context.live.traces.get(portKey(at));
        view.update(
          'problem' in sources
            ? {
                time: context.time,
                start: 0,
                span: 0,
                tone: undefined,
                bits: undefined,
                glide: undefined,
                stacked: [],
                problem: sources.problem,
              }
            : {
                time: context.time,
                start: sources.start,
                span: Number(now.block.params.span ?? 2.4),
                tone: trace(sources.tone),
                bits: trace(sources.bits),
                glide: sources.glide && {
                  trace: trace(sources.glide.at),
                  lag: sources.glide.lag,
                },
                stacked: sources.stacked.map((row) => ({
                  name: row.item.block.name || 'Plot',
                  trace: trace(row.at),
                  lag: row.lag,
                })),
                problem: undefined,
              },
        );
      },
    };
  }

  #readout(item: FaceItem): Omit<Widget, 'key'> {
    const label = html('span', { class: 'control-label' });
    const value = html('span', {
      class:
        item.block.params.style === 'lcd'
          ? 'widget-value lcd'
          : 'widget-value',
    });
    // Reserve the line below the value for errors. Source details remain in
    // the tooltip so controls and readouts align.
    const problem = html('span', { class: 'widget-from' });
    const element = html(
      'div',
      { class: 'widget-readout' },
      label,
      value,
      problem,
    );
    return {
      element,
      sync: (context) => {
        const block = String(item.block.params.block ?? '');
        const wanted = String(item.block.params.reading ?? '');
        const id = resolveRef(item.path, block) ?? '';
        const status = context.status.get(id);
        const reading = context.readings
          .get(id)
          ?.find((r) => r.label === wanted);
        label.textContent = item.block.name || wanted || 'Readout';
        value.textContent = reading ? formatReading(reading) : '–';
        value.classList.toggle('error', status?.state === 'error');
        const trouble =
          status?.state === 'error'
            ? status.message
            : block
              ? ''
              : 'Choose a reading in the inspector.';
        problem.textContent = trouble;
        problem.hidden = !trouble;
        element.title = block
          ? `${value.textContent}\n${wanted}, from ${blockLabel(context.doc, id)}`
          : '';
      },
    };
  }
}

/** Returns the diagnostic for an unavailable output signal. */
export function problemAt(
  status: ReadonlyMap<string, BlockStatus>,
  at: PortRef,
): string | undefined {
  const source = status.get(at.block);
  return source?.state === 'error'
    ? `No signal here: ${source.message}`
    : source?.state === 'idle'
      ? `No signal here: ${source.reason}`
      : undefined;
}
