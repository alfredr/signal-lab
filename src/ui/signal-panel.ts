// Screens that plot one port of the running stream: its latest stretch over
// time, the spectrum of that stretch, or a waterfall that grows at the top as
// time passes. Everything ends at the playhead. A face screen sits in a card
// with a title, view buttons and Listen; its wheel zooms, dragging pans and a
// double-click resets. A diagram screen is small and still.

import { plot, type PlotView } from '../blocks/instruments.ts';
import { decibels, si, significant, toDecibels } from '../engine/format.ts';
import { resolveParams, type StoredParams } from '../engine/params.ts';
import { peak, power } from '../engine/signal.ts';
import { html } from './dom.ts';
import type { Trace } from './live.ts';
import {
  drawSpectrum,
  drawTime,
  drawWaterfall,
  MARGIN,
  readTheme,
  type Range,
} from './plot.ts';
import { onThemeChange } from './theme.ts';

/** How much of the stream each view shows when a plot doesn't say. */
const SPANS: Record<PlotView, number> = {
  time: 0.05,
  spectrum: 0.25,
  waterfall: 10,
};

/** How a Plot block shows its signal. */
export type PlotSettings = {
  readonly view: PlotView;
  /**
   * Seconds of the latest signal it shows: across a time plot, averaged in a
   * spectrum, down a waterfall.
   */
  readonly span: number;
  /** Frequency range for spectra and waterfalls; 0 for high means Nyquist. */
  readonly low: number;
  readonly high: number;
};

const settingsCache = new WeakMap<StoredParams, PlotSettings>();

/** A Plot block's settings, the same object for the same stored values. */
export function plotSettings(params: StoredParams): PlotSettings {
  let settings = settingsCache.get(params);
  if (!settings) {
    const p = resolveParams(plot.params, params);
    settings = {
      view: p.view,
      span: p.span > 0 ? p.span : SPANS[p.view],
      low: p.low,
      high: p.high,
    };
    settingsCache.set(params, settings);
  }

  return settings;
}

/** Settings for a view of the selection's signal, which has no Plot block. */
export const defaultSettings = (view: PlotView): PlotSettings => ({
  view,
  span: SPANS[view],
  low: 0,
  high: 0,
});

export type ScreenState = {
  /** The port's latest samples, once the stream has sent any. */
  readonly trace: Trace | undefined;
  readonly settings: PlotSettings;
  /** CSS color for the trace. */
  readonly color: string;
  /** The playhead's time. */
  readonly time: number;
  /** Why the port carries nothing, if it doesn't. */
  readonly problem?: string;
};

/** Canvas can't take var(--name) colors, so look them up. */
function resolveColor(element: Element, color: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  return name
    ? getComputedStyle(element).getPropertyValue(name).trim()
    : color;
}

/** The latest `span` seconds before `time`, as samples. */
function latest(trace: Trace, time: number, span: number): Float32Array {
  const end = Math.floor(time * trace.rate);
  return trace.read(end - Math.max(1, Math.round(span * trace.rate)), end);
}

/** The frequencies a screen shows before any zoom. */
function band(state: ScreenState, rate: number): Range {
  const nyquist = rate / 2;
  const { low, high } = state.settings;
  const top = high > 0 ? Math.min(high, nyquist) : nyquist;
  return { start: Math.min(low, top * 0.99), end: top };
}

/**
 * Where a time plot's zoom puts it: `width` seconds, ending `back` before the
 * playhead.
 */
type Window = { readonly width: number; readonly back: number };

/**
 * The longest time plot that is triggered like an oscilloscope; anything
 * longer scrolls by as a strip chart.
 */
const TRIGGERED = 0.25;
/** Where the trigger sits across a triggered plot. */
const PRE = 0.1;
/** Points a triggered trace is compared at, to keep it lined up frame to frame. */
const SHAPE = 128;
/** How long a scale holds before it shrinks to fit, in milliseconds. */
const HOLD = 2500;

/**
 * The smallest of 1, 1.5, 2, 3, 4, 5, 6 and 8 times a power of ten that is at
 * least `x`.
 */
function roundUp(x: number): number {
  if (!(x > 0)) {
    return 0;
  }

  const power = 10 ** Math.floor(Math.log10(x));
  const step = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find(
    (m) => m * power >= x * (1 - 1e-9),
  );
  return (step ?? 10) * power;
}

/**
 * A scale that grows at once to take in more and shrinks only once what it
 * shows has stayed smaller for a while, so axes don't jump about.
 */
export class Held {
  #value: number | undefined;
  #until = 0;

  next(wanted: number, now = performance.now()): number {
    if (
      this.#value === undefined ||
      wanted >= this.#value ||
      now > this.#until
    ) {
      this.#value = wanted;
      this.#until = now + HOLD;
    }

    return this.#value;
  }

  clear(): void {
    this.#value = undefined;
  }
}

/** A time plot's visible seconds, and the time its axis counts from. */
type TimeView = { readonly range: Range; readonly origin: number };

/** A canvas plotting one port. */
export class Screen {
  readonly element: HTMLElement;
  readonly #canvas = html('canvas', { class: 'plot' });
  readonly #empty = html('p', { class: 'panel-empty' });
  readonly #interactive: boolean;
  #state: ScreenState | undefined;
  /** A time plot's zoom, and a spectrum's or waterfall's frequency range. */
  #window: Window | undefined;
  #band: Range | undefined;
  /** What the zoom was set against, to tell when it no longer applies. */
  #extent = '';
  /** A time plot's vertical scale, above and below 0, and a spectrum's top. */
  readonly #high = new Held();
  readonly #low = new Held();
  readonly #ceiling = new Held();
  /** The triggered trace last shown, normalized, to line the next one up with. */
  #shape: Float64Array | undefined;
  /** Pointer position over the plot, in canvas pixels. */
  #hover: { x: number; y: number } | undefined;
  #frame = 0;

  /** Drawn again when the colors change; theme.ts holds it only weakly. */
  readonly #redraw = () => this.#schedule();

  constructor({ interactive }: { readonly interactive: boolean }) {
    this.#interactive = interactive;
    this.element = html(
      'div',
      { class: 'plot-wrap' },
      this.#canvas,
      this.#empty,
    );

    if (interactive) {
      this.#listen();
    }

    new ResizeObserver(() => this.#schedule()).observe(this.#canvas);
    onThemeChange(this.#redraw);
  }

  update(state: ScreenState): void {
    const previous = this.#state;
    this.#state = state;
    const extent = `${state.trace?.rate}|${state.settings.view}|${state.settings.span}|${state.settings.low}|${state.settings.high}`;
    if (extent !== this.#extent) {
      this.#extent = extent;
      this.#window = undefined;
      this.#band = undefined;
      this.#high.clear();
      this.#low.clear();
      this.#ceiling.clear();
      this.#shape = undefined;
    }

    const message =
      state.problem ??
      (state.trace ? '' : 'Nothing yet. Press Run to start the stream.');
    this.#empty.textContent = message;
    this.#empty.hidden = !message;
    this.#canvas.hidden = Boolean(message);

    if (
      !previous ||
      previous.trace !== state.trace ||
      previous.settings !== state.settings ||
      previous.color !== state.color ||
      previous.time !== state.time
    ) {
      this.#schedule();
    }
  }

  /**
   * A time plot's zoom: seconds across and how far before the playhead it
   * ends.
   */
  #zoom(state: ScreenState): Window {
    return this.#window ?? { width: state.settings.span, back: 0 };
  }

  /**
   * Whether a time plot is triggered, rather than a strip chart or panned
   * back.
   */
  #triggered(state: ScreenState): boolean {
    const { width, back } = this.#zoom(state);
    return back === 0 && width <= TRIGGERED;
  }

  /**
   * What a time plot shows. A short one is triggered like an oscilloscope: it
   * waits for a rising crossing and starts there, so a repeating waveform
   * stands still, and its axis counts from that crossing. A long one, or one
   * panned back, ends where it is put and counts back from the playhead.
   */
  #timeView(state: ScreenState, trace: Trace): TimeView {
    const { width, back } = this.#zoom(state);
    const t = state.time;
    if (!this.#triggered(state)) {
      return { range: { start: t - back - width, end: t - back }, origin: t };
    }

    // With nothing to trigger on, it runs free on the same timebase, as a
    // scope's auto trigger does, so the axis doesn't change under the trace.
    const at = this.#trigger(trace, t, width) ?? t - (1 - PRE) * width;
    return {
      range: { start: at - PRE * width, end: at + (1 - PRE) * width },
      origin: at,
    };
  }

  /**
   * The time of a rising crossing to start a triggered trace from: one late
   * enough to be recent and early enough for the trace to fit before `t`. The
   * level is halfway between the extremes, with some hysteresis against noise.
   * Of the crossings, the one whose trace looks most like the last one shown
   * wins, so a waveform that crosses several times a period doesn't hop
   * between them. Undefined if nothing crosses, and the plot runs free.
   */
  #trigger(trace: Trace, t: number, width: number): number | undefined {
    const { rate } = trace;
    const latest = t - (1 - PRE) * width;
    const earliest = latest - Math.max(width, 0.03);
    const first = Math.floor((earliest - PRE * width) * rate) - 1;
    const data = trace.read(first, Math.ceil(t * rate) + 1);
    const from = Math.max(1, Math.floor(earliest * rate) - first);
    const to = Math.min(data.length - 1, Math.floor(latest * rate) - first);
    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i < data.length; i++) {
      low = Math.min(low, data[i]);
      high = Math.max(high, data[i]);
    }

    if (!(high - low > 1e-9) || to <= from) {
      return undefined;
    }

    const level = (low + high) / 2;
    const margin = 0.1 * (high - low);
    const crossings: number[] = [];
    let armed = false;
    for (let i = 1; i <= to; i++) {
      if (data[i] < level - margin) {
        armed = true;
      } else if (armed && data[i - 1] < level && data[i] >= level) {
        armed = false;

        if (i >= from) {
          crossings.push(
            i - 1 + (level - data[i - 1]) / (data[i] - data[i - 1]),
          );
        }
      }
    }

    if (!crossings.length) {
      return undefined;
    }

    // The trace from crossing `c` at SHAPE points, its mean taken out, scaled to 1.
    const shapeAt = (c: number): Float64Array => {
      const shape = new Float64Array(SHAPE);
      let mean = 0;
      for (let j = 0; j < SHAPE; j++) {
        const p = c + (-PRE + j / (SHAPE - 1)) * width * rate;
        const i = Math.max(0, Math.min(data.length - 2, Math.floor(p)));
        const f = Math.min(1, Math.max(0, p - i));
        shape[j] = data[i] + f * (data[i + 1] - data[i]);
        mean += shape[j] / SHAPE;
      }

      let norm = 0;
      for (let j = 0; j < SHAPE; j++) {
        shape[j] -= mean;
        norm += shape[j] * shape[j];
      }

      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      return shape.map((v) => v * scale);
    };

    const last = this.#shape;
    let best = crossings.length - 1;
    let bestShape = shapeAt(crossings[best]);
    if (last) {
      const likeness = (shape: Float64Array) =>
        shape.reduce((sum, v, j) => sum + v * last[j], 0);
      let bestScore = likeness(bestShape);
      // Newest first; an older crossing has to match clearly better to win.
      for (
        let k = crossings.length - 2;
        k >= Math.max(0, crossings.length - 16);
        k--
      ) {
        const shape = shapeAt(crossings[k]);
        const score = likeness(shape);
        if (score > bestScore + 0.02) {
          [best, bestShape, bestScore] = [k, shape, score];
        }
      }
    }

    this.#shape = bestShape;
    return (first + crossings[best]) / rate;
  }

  #setWindow(window: Window): void {
    const state = this.#state;
    const trace = state?.trace;
    if (!trace) {
      return;
    }

    // No closer than a few samples across, no wider or further back than it holds.
    const held = (trace.end - trace.start) / trace.rate;
    const width = Math.min(held, Math.max(8 / trace.rate, window.width));
    const back = Math.min(Math.max(0, held - width), Math.max(0, window.back));
    this.#window = { width, back };
    this.#schedule();
  }

  #setBand(range: Range): void {
    const trace = this.#state?.trace;
    if (!trace || !this.#state) {
      return;
    }

    const full = band(this.#state, trace.rate);
    const span = range.end - range.start;
    const fullSpan = full.end - full.start;
    const width = Math.min(fullSpan, Math.max(fullSpan / 1e5, span));
    const start = Math.min(
      full.end - width,
      Math.max(full.start, range.start + (span - width) / 2),
    );
    this.#band = { start, end: start + width };
    this.#schedule();
  }

  #listen(): void {
    const canvas = this.#canvas;
    const position = (event: MouseEvent) =>
      event.clientX - canvas.getBoundingClientRect().left;
    const plotWidth = () =>
      Math.max(1, canvas.clientWidth - MARGIN.left - MARGIN.right);
    const plotFraction = (x: number) =>
      Math.min(1, Math.max(0, (x - MARGIN.left) / plotWidth()));

    // Zooming about a point and panning, for whichever axis the view has.
    const zoom = (fraction: number, factor: number) => {
      const state = this.#state;
      if (!state?.trace) {
        return;
      }

      if (state.settings.view === 'time') {
        const { width, back } = this.#zoom(state);
        if (this.#triggered(state)) {
          // A triggered trace stays lined up on its crossing; only its width changes.
          this.#setWindow({ width: width * factor, back: 0 });
          return;
        }

        const at = state.time - back - width + fraction * width;
        const wider = width * factor;
        this.#setWindow({
          width: wider,
          back: state.time - (at + (1 - fraction) * wider),
        });
      } else {
        const range = this.#band ?? band(state, state.trace.rate);
        const at = range.start + fraction * (range.end - range.start);
        this.#setBand({
          start: at - (at - range.start) * factor,
          end: at + (range.end - at) * factor,
        });
      }
    };

    const pan = (from: { window?: Window; band?: Range }, shift: number) => {
      const state = this.#state;
      if (!state?.trace) {
        return;
      }

      if (state.settings.view === 'time') {
        const window = from.window ?? { width: state.settings.span, back: 0 };
        this.#setWindow({
          width: window.width,
          back: window.back - shift * window.width,
        });
      } else {
        const range = from.band ?? band(state, state.trace.rate);
        const span = range.end - range.start;
        this.#setBand({
          start: range.start + shift * span,
          end: range.end + shift * span,
        });
      }
    };

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.#state?.trace) {
          return;
        }

        event.preventDefault();

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          pan(
            { window: this.#window, band: this.#band },
            event.deltaX / plotWidth(),
          );
        } else {
          zoom(plotFraction(position(event)), Math.exp(event.deltaY * 0.002));
        }
      },
      { passive: false },
    );

    let drag: { x: number; window?: Window; band?: Range } | undefined;
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.#state?.trace) {
        return;
      }

      drag = { x: event.clientX, window: this.#window, band: this.#band };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      this.#hover = {
        x: position(event),
        y: event.clientY - canvas.getBoundingClientRect().top,
      };

      if (drag) {
        pan(drag, -(event.clientX - drag.x) / plotWidth());
      } else {
        this.#schedule();
      }
    });
    canvas.addEventListener('pointerup', () => (drag = undefined));
    canvas.addEventListener('pointerleave', () => {
      this.#hover = undefined;
      this.#schedule();
    });
    canvas.addEventListener('dblclick', () => {
      this.#window = undefined;
      this.#band = undefined;
      this.#schedule();
    });
  }

  #schedule(): void {
    if (this.#frame) {
      return;
    }

    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #draw(): void {
    const state = this.#state;
    const trace = state?.trace;
    if (!state || !trace || state.problem) {
      return;
    }

    const theme = readTheme(this.element);
    const color = resolveColor(this.element, state.color);
    const hover = this.#interactive ? this.#hover : undefined;
    const { rate } = trace;
    const { settings, time } = state;
    switch (settings.view) {
      case 'time': {
        const { range, origin } = this.#timeView(state, trace);
        const first = Math.floor(range.start * rate) - 1;
        const data = trace.read(first, Math.ceil(range.end * rate) + 2);
        drawTime(
          this.#canvas,
          theme,
          { rate, data, first },
          range,
          color,
          hover?.x,
          this.#scale(data),
          origin,
        );
        break;
      }

      case 'waterfall':
        drawWaterfall(
          this.#canvas,
          theme,
          trace,
          this.#band ?? band(state, rate),
          { start: time - settings.span, end: time },
          hover?.x,
          hover?.y,
        );
        break;

      case 'spectrum':
        drawSpectrum(
          this.#canvas,
          theme,
          { rate, data: latest(trace, time, settings.span) },
          this.#band ?? band(state, rate),
          color,
          hover?.x,
          (natural) => this.#ceiling.next(natural),
        );
    }
  }

  /**
   * The vertical range for the samples on screen: round numbers above and
   * below 0, each growing at once and shrinking only after a while.
   */
  #scale(data: Float32Array): Range {
    let low = 0;
    let high = 0;
    for (let i = 0; i < data.length; i++) {
      low = Math.min(low, data[i]);
      high = Math.max(high, data[i]);
    }

    const above = this.#high.next(roundUp(high * 1.05));
    const below = this.#low.next(roundUp(-low * 1.05));
    return above + below > 0
      ? { start: -below, end: above }
      : { start: -1, end: 1 };
  }
}

export type PanelState = ScreenState & {
  readonly title: string;
  readonly listening: boolean;
};

/** A screen in a card: title, measurements, view buttons and Listen. */
export class SignalPanel {
  readonly element: HTMLElement;
  readonly #screen = new Screen({ interactive: true });
  readonly #title = html('span', { class: 'signal-title' });
  readonly #meta = html('span', { class: 'signal-meta' });
  readonly #swatch = html('span', { class: 'swatch', 'aria-hidden': 'true' });
  readonly #viewButtons: Record<PlotView, HTMLButtonElement>;
  readonly #listen = html(
    'button',
    { type: 'button', class: 'small play' },
    'Listen',
  );
  /**
   * When the measurements were last written, so they change slowly enough to
   * read.
   */
  #measured = {
    at: 0,
    time: Number.NaN,
    trace: undefined as Trace | undefined,
  };

  constructor(actions: {
    view(view: PlotView): void;
    listen(): void;
    /** More buttons for the header, after Listen. */
    extra?: readonly HTMLButtonElement[];
  }) {
    const viewButton = (view: PlotView, label: string) => {
      const button = html(
        'button',
        { type: 'button', class: 'segment-button' },
        label,
      );
      button.addEventListener('click', () => actions.view(view));
      return button;
    };

    this.#viewButtons = {
      time: viewButton('time', 'Time'),
      spectrum: viewButton('spectrum', 'Spectrum'),
      waterfall: viewButton('waterfall', 'Waterfall'),
    };
    this.#listen.addEventListener('click', () => actions.listen());
    // A header with the name and Listen, over a screen with its views and
    // measurements along the top.
    this.element = html(
      'section',
      { class: 'signal-panel' },
      html(
        'header',
        { class: 'signal-head' },
        this.#swatch,
        html('div', { class: 'signal-name' }, this.#title),
        this.#listen,
        ...(actions.extra ?? []),
      ),
      html(
        'div',
        { class: 'signal-display' },
        html(
          'div',
          { class: 'signal-bar' },
          html(
            'div',
            {
              class: 'segmented-buttons',
              role: 'group',
              'aria-label': 'View',
            },
            this.#viewButtons.time,
            this.#viewButtons.spectrum,
            this.#viewButtons.waterfall,
          ),
          this.#meta,
        ),
        this.#screen.element,
      ),
    );
  }

  update(state: PanelState): void {
    const { trace } = state;
    this.#title.textContent = state.title;
    this.#swatch.style.background = state.color;

    for (const [view, button] of Object.entries(this.#viewButtons)) {
      button.setAttribute(
        'aria-pressed',
        String(view === state.settings.view),
      );
    }

    this.#listen.textContent = state.listening ? 'Mute' : 'Listen';
    this.#listen.setAttribute('aria-pressed', String(state.listening));
    this.#listen.disabled = Boolean(state.problem);

    const now = performance.now();
    const due =
      trace !== this.#measured.trace ||
      (state.time !== this.#measured.time && now - this.#measured.at > 250);
    if (trace && due) {
      this.#measured = { at: now, time: state.time, trace };
      const data = latest(trace, state.time, state.settings.span);
      this.#meta.textContent = `${si(trace.rate, 'Hz')} · ${decibels(toDecibels(power(data), -200))} · peak ${significant(peak(data))}`;
      this.#meta.title = 'Sample rate, power and peak of what is shown';
    } else if (!trace) {
      this.#measured = { at: now, time: Number.NaN, trace };
      this.#meta.textContent = state.problem ? 'no signal' : 'waiting';
    }

    this.#screen.update(state);
  }
}
