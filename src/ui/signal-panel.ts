// Screens that plot one signal: over time, as a spectrum or as a waterfall,
// following the playhead if the plot asks to. A face screen sits in a card
// with a title, view buttons and Play; its wheel zooms, dragging pans and a
// double-click resets. A diagram screen is small and still.

import { plot, type PlotView } from '../blocks/instruments.ts';
import { decibels, si, significant, toDecibels } from '../engine/format.ts';
import { resolveParams, type StoredParams } from '../engine/params.ts';
import { peak, power, type Signal } from '../engine/signal.ts';
import { html } from './dom.ts';
import {
  drawSpectrum,
  drawTime,
  drawWaterfall,
  MARGIN,
  readTheme,
  timeSpan,
  type Range,
} from './plot.ts';

/** How a Plot block shows its signal. */
export type PlotSettings = {
  readonly view: PlotView;
  /** Seconds around the playhead to show, or undefined for the whole run. */
  readonly follow: number | undefined;
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
      follow: p.follow ? p.span : undefined,
      low: p.low,
      high: p.high,
    };
    settingsCache.set(params, settings);
  }

  return settings;
}

export type ScreenState = {
  readonly signal: Signal | undefined;
  readonly settings: PlotSettings;
  /** CSS color for the trace. */
  readonly color: string;
  /** The playhead's time, if it is out. */
  readonly time: number | undefined;
};

/** Canvas can't take var(--name) colors, so look them up. */
function resolveColor(element: Element, color: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(color)?.[1];
  return name
    ? getComputedStyle(element).getPropertyValue(name).trim()
    : color;
}

const stats = new WeakMap<Float32Array, { power: number; peak: number }>();
function statsOf(data: Float32Array) {
  let cached = stats.get(data);
  if (!cached) {
    stats.set(data, (cached = { power: power(data), peak: peak(data) }));
  }

  return cached;
}

/** The stretch of time a following plot shows around the playhead. */
function followWindow(state: ScreenState): Range | undefined {
  const { follow } = state.settings;
  return follow === undefined || state.time === undefined
    ? undefined
    : { start: state.time - follow / 2, end: state.time + follow / 2 };
}

/** The part of a signal inside `range`, padded with silence outside it. */
function slice(signal: Signal, range: Range): Signal {
  const first = Math.round(range.start * signal.rate);
  const data = new Float32Array(
    Math.max(1, Math.round((range.end - range.start) * signal.rate)),
  );
  const from = Math.max(0, first);
  const to = Math.min(signal.data.length, first + data.length);
  if (to > from) {
    data.set(signal.data.subarray(from, to), from - first);
  }

  return { rate: signal.rate, data };
}

/** The x axis a screen shows before any zoom. */
function fullRange(state: ScreenState): Range | undefined {
  const { signal, settings } = state;
  if (!signal) {
    return undefined;
  }

  if (settings.view === 'time') {
    return followWindow(state) ?? timeSpan(signal);
  }

  const nyquist = signal.rate / 2;
  const high = settings.high > 0 ? Math.min(settings.high, nyquist) : nyquist;
  const low = Math.min(settings.low, high * 0.99);
  return { start: low, end: high };
}

/** Whether the screen needs redrawing when only the playhead moved. */
const followsTime = (state: ScreenState): boolean =>
  state.settings.view !== 'spectrum' || state.settings.follow !== undefined;

/** A canvas plotting one signal. */
export class Screen {
  readonly element: HTMLElement;
  readonly #canvas = html('canvas', { class: 'plot' });
  readonly #empty = html('p', { class: 'panel-empty' });
  readonly #interactive: boolean;
  #state: ScreenState | undefined;
  #ranges: Record<PlotView, Range | undefined> = {
    time: undefined,
    spectrum: undefined,
    waterfall: undefined,
  };
  /** What the zoom was set against, to tell when it no longer applies. */
  #extent = '';
  /** Pointer position over the plot, in canvas pixels. */
  #hover: { x: number; y: number } | undefined;
  #frame = 0;

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
  }

  update(state: ScreenState): void {
    const previous = this.#state;
    this.#state = state;
    const redraw =
      !previous ||
      previous.signal !== state.signal ||
      previous.settings !== state.settings ||
      previous.color !== state.color ||
      (previous.time !== state.time && followsTime(state));
    const full = fullRange(state);
    const extent = `${state.signal?.rate}|${state.signal?.data.length}|${state.settings.view}|${state.settings.low}|${state.settings.high}|${state.settings.follow}`;
    if (extent !== this.#extent) {
      this.#extent = extent;
      this.#ranges = {
        time: undefined,
        spectrum: undefined,
        waterfall: undefined,
      };
    }

    this.#empty.textContent = state.signal
      ? ''
      : 'No signal here yet. Wire something into this plot, or check the block it comes from for errors.';
    this.#empty.hidden = Boolean(state.signal);
    this.#canvas.hidden = !state.signal || !full;

    if (redraw) {
      this.#schedule();
    }
  }

  /** The axis range on screen: the zoom, unless following the playhead. */
  #range(): Range | undefined {
    const state = this.#state;
    if (!state) {
      return undefined;
    }

    const following =
      state.settings.view === 'time' && followWindow(state) !== undefined;
    return (
      (following ? undefined : this.#ranges[state.settings.view]) ??
      fullRange(state)
    );
  }

  #setRange(range: Range): void {
    const state = this.#state;
    const full = state && fullRange(state);
    if (!state?.signal || !full) {
      return;
    }

    const span = range.end - range.start;
    const fullSpan = full.end - full.start;
    // No closer than a few samples (or bins) across the plot, no wider than everything.
    const smallest =
      state.settings.view === 'time' ? 8 / state.signal.rate : fullSpan / 1e5;
    const width = Math.min(fullSpan, Math.max(smallest, span));
    const start = Math.min(
      full.end - width,
      Math.max(full.start, range.start + (span - width) / 2),
    );
    this.#ranges[state.settings.view] = { start, end: start + width };
    this.#schedule();
  }

  #listen(): void {
    const canvas = this.#canvas;
    const position = (event: MouseEvent) =>
      event.clientX - canvas.getBoundingClientRect().left;
    const plotWidth = () =>
      Math.max(1, canvas.clientWidth - MARGIN.left - MARGIN.right);
    const plotFraction = (x: number) => (x - MARGIN.left) / plotWidth();

    canvas.addEventListener(
      'wheel',
      (event) => {
        const range = this.#range();
        if (!range) {
          return;
        }

        event.preventDefault();
        const span = range.end - range.start;
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          const shift = (event.deltaX / plotWidth()) * span;
          this.#setRange({
            start: range.start + shift,
            end: range.end + shift,
          });
          return;
        }

        const at =
          range.start +
          Math.min(1, Math.max(0, plotFraction(position(event)))) * span;
        const factor = Math.exp(event.deltaY * 0.002);
        this.#setRange({
          start: at - (at - range.start) * factor,
          end: at + (range.end - at) * factor,
        });
      },
      { passive: false },
    );

    let drag: { x: number; range: Range } | undefined;
    canvas.addEventListener('pointerdown', (event) => {
      const range = this.#range();
      if (!range) {
        return;
      }

      drag = { x: event.clientX, range };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      this.#hover = {
        x: position(event),
        y: event.clientY - canvas.getBoundingClientRect().top,
      };

      if (drag) {
        const span = drag.range.end - drag.range.start;
        const shift = (-(event.clientX - drag.x) / plotWidth()) * span;
        this.#setRange({
          start: drag.range.start + shift,
          end: drag.range.end + shift,
        });
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
      if (this.#state) {
        this.#ranges[this.#state.settings.view] = undefined;
      }

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
    const range = this.#range();
    if (!state?.signal || !range) {
      return;
    }

    const theme = readTheme(this.element);
    const color = resolveColor(this.element, state.color);
    const hover = this.#interactive ? this.#hover : undefined;
    const shown = followWindow(state);
    switch (state.settings.view) {
      case 'time':
        drawTime(
          this.#canvas,
          theme,
          state.signal,
          range,
          color,
          hover?.x,
          state.time,
        );
        break;

      case 'waterfall':
        drawWaterfall(
          this.#canvas,
          theme,
          state.signal,
          range,
          hover?.x,
          hover?.y,
          { window: shown, cursor: state.time },
        );
        break;

      case 'spectrum':
        drawSpectrum(
          this.#canvas,
          theme,
          shown ? slice(state.signal, shown) : state.signal,
          range,
          color,
          hover?.x,
        );
    }
  }
}

export type PanelState = ScreenState & {
  readonly title: string;
  readonly playing: boolean;
};

/** A screen in a card: title, measurements, view buttons and Play. */
export class SignalPanel {
  readonly element: HTMLElement;
  readonly #screen = new Screen({ interactive: true });
  readonly #title = html('span', { class: 'signal-title' });
  readonly #meta = html('span', { class: 'signal-meta' });
  readonly #swatch = html('span', { class: 'swatch', 'aria-hidden': 'true' });
  readonly #viewButtons: Record<PlotView, HTMLButtonElement>;
  readonly #play = html(
    'button',
    { type: 'button', class: 'small play' },
    'Play',
  );

  constructor(actions: {
    view(view: PlotView): void;
    play(): void;
    /** More buttons for the header, after Play. */
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
    this.#play.addEventListener('click', () => actions.play());
    this.element = html(
      'section',
      { class: 'signal-panel' },
      html(
        'header',
        { class: 'signal-head' },
        this.#swatch,
        html('div', { class: 'signal-name' }, this.#title, this.#meta),
        html(
          'div',
          { class: 'segmented-buttons', role: 'group', 'aria-label': 'View' },
          this.#viewButtons.time,
          this.#viewButtons.spectrum,
          this.#viewButtons.waterfall,
        ),
        this.#play,
        ...(actions.extra ?? []),
      ),
      this.#screen.element,
    );
  }

  update(state: PanelState): void {
    const { signal } = state;
    this.#title.textContent = state.title;
    this.#swatch.style.background = state.color;

    for (const [view, button] of Object.entries(this.#viewButtons)) {
      button.setAttribute(
        'aria-pressed',
        String(view === state.settings.view),
      );
    }

    this.#play.textContent = state.playing ? 'Stop' : 'Play';
    this.#play.setAttribute('aria-pressed', String(state.playing));
    this.#play.disabled = !signal;

    if (signal) {
      const { power: p, peak: max } = statsOf(signal.data);
      this.#meta.textContent = `${si(signal.rate, 'Hz')} · power ${decibels(toDecibels(p, -200))} · peak ${significant(max)}`;
    } else {
      this.#meta.textContent = 'no signal';
    }

    this.#screen.update(state);
  }
}
