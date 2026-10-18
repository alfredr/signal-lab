// Canvas plots of a signal over time and of its spectrum. Both draw millions of samples by
// reducing each pixel column to the range of values it covers.

import { fft, floorPowerOfTwo } from '../dsp/fft.ts';
import { welch, type Spectrum } from '../dsp/spectrum.ts';
import { decibels, si, significant, toDecibels } from '../engine/format.ts';
import type { Signal } from '../engine/signal.ts';

export type Theme = {
  readonly surface: string;
  readonly accent: string;
  readonly ink: string;
  readonly muted: string;
  readonly rule: string;
  readonly grid: string;
  readonly mono: string;
};

export function readTheme(element: Element): Theme {
  const style = getComputedStyle(element);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    surface: get('--surface'),
    accent: get('--accent'),
    ink: get('--ink'),
    muted: get('--muted'),
    rule: get('--rule'),
    grid: get('--grid'),
    mono: get('--font-mono'),
  };
}

/** A visible span of the x axis: seconds for time plots, hertz for spectra. */
export type Range = {
  readonly start: number;
  readonly end: number;
};

type Frame = {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** The data area inside the axes. */
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
};

/** Space around the data area for axis labels, in CSS pixels. */
export const MARGIN = { left: 58, right: 12, top: 10, bottom: 24 } as const;

/**
 * Sizes the canvas for the screen and returns its drawing context, or nothing
 * if hidden.
 */
function prepare(canvas: HTMLCanvasElement): Frame | undefined {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) {
    return undefined;
  }

  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return undefined;
  }

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return {
    ctx,
    width,
    height,
    left: MARGIN.left,
    top: MARGIN.top,
    plotWidth: width - MARGIN.left - MARGIN.right,
    plotHeight: height - MARGIN.top - MARGIN.bottom,
  };
}

/** About `count` round values covering [low, high]. */
function ticks(low: number, high: number, count: number): number[] {
  const raw = (high - low) / Math.max(1, count);
  if (!(raw > 0)) {
    return [low];
  }

  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const r = raw / magnitude;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * magnitude;
  const values: number[] = [];
  for (
    let v = Math.ceil(low / step - 1e-9) * step;
    v <= high + step * 1e-9;
    v += step
  ) {
    values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }

  return values;
}

function drawAxes(
  frame: Frame,
  theme: Theme,
  x: Range,
  y: Range,
  xLabel: (v: number) => string,
  yLabel: (v: number) => string,
  /** Put y.start at the top, as a waterfall does with time. */
  downward = false,
): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const px = (v: number) =>
    left + ((v - x.start) / (x.end - x.start)) * plotWidth;
  const py = (v: number) => {
    const t = (v - y.start) / (y.end - y.start);
    return downward ? top + t * plotHeight : top + plotHeight - t * plotHeight;
  };

  ctx.lineWidth = 1;
  ctx.font = `400 11px ${theme.mono}`;
  ctx.fillStyle = theme.muted;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const v of ticks(
    x.start,
    x.end,
    Math.max(2, Math.floor(plotWidth / 110)),
  )) {
    const at = Math.round(px(v)) + 0.5;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(at, top);
    ctx.lineTo(at, top + plotHeight);
    ctx.stroke();
    ctx.fillText(xLabel(v), at, top + plotHeight + 6);
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const v of ticks(
    y.start,
    y.end,
    Math.max(2, Math.floor(plotHeight / 36)),
  )) {
    const at = Math.round(py(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? theme.rule : theme.grid;
    ctx.beginPath();
    ctx.moveTo(left, at);
    ctx.lineTo(left + plotWidth, at);
    ctx.stroke();
    ctx.fillText(yLabel(v), left - 6, at);
  }

  ctx.strokeStyle = theme.rule;
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth - 1, plotHeight - 1);
}

/** The playhead: a line across the plot at `at` along one axis. */
function drawCursor(
  frame: Frame,
  theme: Theme,
  axis: 'x' | 'y',
  at: number,
): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const inside =
    axis === 'x'
      ? at >= left && at <= left + plotWidth
      : at >= top && at <= top + plotHeight;
  if (!inside) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  if (axis === 'x') {
    ctx.moveTo(Math.round(at) + 0.5, top);
    ctx.lineTo(Math.round(at) + 0.5, top + plotHeight);
  } else {
    ctx.moveTo(left, Math.round(at) + 0.5);
    ctx.lineTo(left + plotWidth, Math.round(at) + 0.5);
  }

  ctx.stroke();
  ctx.restore();
}

function drawReadout(
  frame: Frame,
  theme: Theme,
  text: string,
  hoverX: number,
): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  ctx.strokeStyle = theme.muted;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(hoverX) + 0.5, top);
  ctx.lineTo(Math.round(hoverX) + 0.5, top + plotHeight);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `500 11px ${theme.mono}`;
  const width = ctx.measureText(text).width + 12;
  const x = Math.min(
    Math.max(hoverX + 8, left + 4),
    left + plotWidth - width - 4,
  );
  ctx.fillStyle = theme.surface;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(x, top + 4, width, 20);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, top + 14);
}

const extents = new WeakMap<Float32Array, Range>();

/** Smallest and largest sample, cached per array. */
function extent(data: Float32Array): Range {
  let cached = extents.get(data);
  if (!cached) {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < low) {
        low = data[i];
      }

      if (data[i] > high) {
        high = data[i];
      }
    }

    cached = data.length ? { start: low, end: high } : { start: -1, end: 1 };
    extents.set(data, cached);
  }

  return cached;
}

export function timeSpan(signal: Signal): Range {
  return { start: 0, end: Math.max(signal.data.length, 1) / signal.rate };
}

/**
 * Draws the signal over `view` (seconds); `hoverX` is a canvas x position to
 * read out, and `cursor` the playhead's time.
 */
export function drawTime(
  canvas: HTMLCanvasElement,
  theme: Theme,
  signal: Signal,
  view: Range,
  color: string,
  hoverX?: number,
  cursor?: number,
): void {
  const frame = prepare(canvas);
  if (!frame) {
    return;
  }

  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { data, rate } = signal;

  let { start: low, end: high } = extent(data);
  if (low > 0) {
    low = 0;
  }

  if (high < 0) {
    high = 0;
  }

  if (high - low < 1e-12) {
    [low, high] = [low - 1, high + 1];
  }

  const pad = (high - low) * 0.08;
  const y = { start: low - pad, end: high + pad };
  drawAxes(
    frame,
    theme,
    view,
    y,
    (v) => si(v, 's'),
    (v) => significant(v),
  );

  const px = (t: number) =>
    left + ((t - view.start) / (view.end - view.start)) * plotWidth;
  const py = (v: number) =>
    top + plotHeight - ((v - y.start) / (y.end - y.start)) * plotHeight;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotWidth, plotHeight);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';

  const perPixel = ((view.end - view.start) * rate) / plotWidth;
  if (perPixel > 2) {
    // Each pixel column becomes a bar from its lowest to its highest sample.
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (let column = 0; column < plotWidth; column++) {
      const i0 = Math.max(
        0,
        Math.floor(
          (view.start + ((view.end - view.start) * column) / plotWidth) * rate,
        ),
      );
      const i1 = Math.min(
        data.length,
        Math.floor(
          (view.start + ((view.end - view.start) * (column + 1)) / plotWidth) *
            rate,
        ),
      );
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i < Math.max(i1, i0 + 1) && i < data.length; i++) {
        if (data[i] < lo) {
          lo = data[i];
        }

        if (data[i] > hi) {
          hi = data[i];
        }
      }

      tops.push(hi === -Infinity ? NaN : py(hi));
      bottoms.push(lo === Infinity ? NaN : py(lo));
    }

    ctx.beginPath();

    for (let column = 0; column < plotWidth; column++) {
      if (Number.isNaN(tops[column])) {
        continue;
      }

      ctx.rect(
        left + column,
        tops[column],
        1,
        Math.max(1, bottoms[column] - tops[column]),
      );
    }

    ctx.fill();
  } else {
    const first = Math.max(0, Math.floor(view.start * rate) - 1);
    const last = Math.min(data.length - 1, Math.ceil(view.end * rate) + 1);
    ctx.beginPath();

    for (let i = first; i <= last; i++) {
      if (i === first) {
        ctx.moveTo(px(i / rate), py(data[i]));
      } else {
        ctx.lineTo(px(i / rate), py(data[i]));
      }
    }

    ctx.stroke();

    // Zoomed in far enough, show the samples themselves.
    if (perPixel < 0.12) {
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(px(i / rate), py(data[i]), 2.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  ctx.restore();

  if (cursor !== undefined) {
    drawCursor(frame, theme, 'x', px(cursor));
  }

  if (hoverX !== undefined && hoverX >= left && hoverX <= left + plotWidth) {
    const t =
      view.start + ((hoverX - left) / plotWidth) * (view.end - view.start);
    const i = Math.min(data.length - 1, Math.max(0, Math.round(t * rate)));
    drawReadout(
      frame,
      theme,
      `${si(i / rate, 's', 4)}   ${significant(data[i], 4)}`,
      hoverX,
    );
  }
}

const spectra = new WeakMap<Float32Array, Map<number, Spectrum>>();

/**
 * FFT size for showing `view` (Hz) across `pixels`: fine enough to resolve
 * what the zoom level can show, within what the signal's length allows.
 */
function spectrumSize(signal: Signal, view: Range, pixels: number): number {
  const wanted = (2 * (view.end - view.start)) / Math.max(pixels, 1);
  const size = 2 ** Math.ceil(Math.log2(signal.rate / Math.max(wanted, 1e-9)));
  const longest =
    signal.data.length >= 256 ? floorPowerOfTwo(signal.data.length) : 256;
  return Math.max(256, Math.min(size, longest, 1 << 18));
}

function spectrumOf(signal: Signal, size: number): Spectrum {
  let bySize = spectra.get(signal.data);
  if (!bySize) {
    spectra.set(signal.data, (bySize = new Map()));
  }

  let spectrum = bySize.get(size);
  if (!spectrum) {
    bySize.set(size, (spectrum = welch(signal.data, signal.rate, size)));
  }

  return spectrum;
}

/** Draws the spectrum over `view` (Hz) in dB, sine-calibrated (see welch). */
export function drawSpectrum(
  canvas: HTMLCanvasElement,
  theme: Theme,
  signal: Signal,
  view: Range,
  color: string,
  hoverX?: number,
): void {
  const frame = prepare(canvas);
  if (!frame) {
    return;
  }

  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const spectrum = spectrumOf(signal, spectrumSize(signal, view, plotWidth));
  const { binWidth, power } = spectrum;

  let loudest = -Infinity;
  for (let k = 0; k < power.length; k++) {
    loudest = Math.max(loudest, power[k]);
  }

  const ceiling = Math.ceil((toDecibels(loudest, -200) + 5) / 10) * 10;
  const y = { start: ceiling - 110, end: ceiling };
  drawAxes(
    frame,
    theme,
    view,
    y,
    (v) => si(v, 'Hz'),
    (v) => significant(v),
  );

  const py = (db: number) =>
    top + plotHeight - ((db - y.start) / (y.end - y.start)) * plotHeight;
  const binAt = (column: number) =>
    (view.start + ((view.end - view.start) * column) / plotWidth) / binWidth;

  // Peak-hold per column, so narrow lines survive when many bins share a pixel.
  const levels: number[] = [];
  for (let column = 0; column < plotWidth; column++) {
    const k0 = Math.max(0, Math.round(binAt(column)));
    const k1 = Math.min(
      power.length - 1,
      Math.max(k0, Math.round(binAt(column + 1)) - 1),
    );
    let best = 0;
    for (let k = k0; k <= k1; k++) {
      best = Math.max(best, power[k]);
    }

    levels.push(k0 < power.length ? toDecibels(best, y.start - 10) : NaN);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotWidth, plotHeight);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(left, top + plotHeight);
  levels.forEach((db, column) =>
    ctx.lineTo(left + column, Number.isNaN(db) ? top + plotHeight : py(db)),
  );
  ctx.lineTo(left + plotWidth, top + plotHeight);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.14;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  levels.forEach((db, column) =>
    column === 0
      ? ctx.moveTo(left, py(db))
      : ctx.lineTo(left + column, py(db)),
  );
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = `400 11px ${theme.mono}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(
    `dB per ${si(binWidth, 'Hz')} bin`,
    left + plotWidth - 6,
    top + plotHeight - 4,
  );
  ctx.restore();

  if (hoverX !== undefined && hoverX >= left && hoverX < left + plotWidth) {
    const column = Math.floor(hoverX - left);
    const k0 = Math.max(0, Math.round(binAt(column)));
    const k1 = Math.min(
      power.length - 1,
      Math.max(k0, Math.round(binAt(column + 1)) - 1),
    );
    let peak = k0;
    for (let k = k0; k <= k1; k++) {
      if (power[k] > power[peak]) {
        peak = k;
      }
    }

    drawReadout(
      frame,
      theme,
      `${si(peak * binWidth, 'Hz', 4)}   ${decibels(toDecibels(power[peak]), 3)}`,
      hoverX,
    );
  }
}

/**
 * Stops of the waterfall's color map, dark to bright (after matplotlib's
 * inferno).
 */
const INFERNO: readonly (readonly [number, number, number])[] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];

function inferno(t: number): readonly [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [INFERNO[i]!, INFERNO[i + 1]!];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

/** Dynamic range shown on a waterfall, below its loudest point. */
const WATERFALL_RANGE = 80;

type Spectrogram = {
  /** Level in dB of each row (time) and column (frequency). */
  readonly levels: Float32Array;
  readonly rows: number;
  readonly loudest: number;
  /** Sample at which each row's FFT starts, and the FFT size. */
  readonly rowStart: (row: number) => number;
  readonly size: number;
};

const spectrograms = new WeakMap<Float32Array, Map<string, Spectrogram>>();

/**
 * `rows` windowed FFTs spaced evenly through the signal, reduced to `columns`
 * across `view` (Hz), each column keeping the loudest bin it covers so narrow
 * lines show. Cached, since a playing waterfall redraws every frame.
 */
function spectrogram(
  signal: Signal,
  view: Range,
  size: number,
  rows: number,
  columns: number,
): Spectrogram {
  const key = `${size} ${rows} ${columns} ${view.start} ${view.end}`;
  let cache = spectrograms.get(signal.data);
  const cached = cache?.get(key);
  if (cached) {
    return cached;
  }

  const { data, rate } = signal;
  const binWidth = rate / size;
  const window = new Float64Array(size);
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    windowSum += window[i];
  }

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const levels = new Float32Array(rows * columns);
  const scale = 2 / (windowSum * windowSum);
  const binAt = (column: number) =>
    (view.start + ((view.end - view.start) * column) / columns) / binWidth;
  const rowStart = (row: number) =>
    rows > 1
      ? Math.round((row * Math.max(0, data.length - size)) / (rows - 1))
      : 0;
  let loudest = -Infinity;
  for (let row = 0; row < rows; row++) {
    const start = rowStart(row);
    for (let i = 0; i < size; i++) {
      re[i] = start + i < data.length ? data[start + i] * window[i] : 0;
      im[i] = 0;
    }

    fft(re, im);

    for (let column = 0; column < columns; column++) {
      const k0 = Math.max(0, Math.round(binAt(column)));
      const k1 = Math.min(
        size / 2,
        Math.max(k0, Math.round(binAt(column + 1)) - 1),
      );
      let best = 0;
      for (let k = k0; k <= k1; k++) {
        best = Math.max(best, (re[k] * re[k] + im[k] * im[k]) * scale);
      }

      const db = toDecibels(best, -300);
      levels[row * columns + column] = db;
      loudest = Math.max(loudest, db);
    }
  }

  const result = { levels, rows, loudest, rowStart, size };
  if (!cache || cache.size > 4) {
    spectrograms.set(signal.data, (cache = new Map()));
  }

  cache.set(key, result);
  return result;
}

export type WaterfallOptions = {
  /** The stretch of time to show, in seconds; all of it by default. */
  readonly window?: Range;
  /** The playhead's time. */
  readonly cursor?: number;
};

/**
 * A waterfall: the spectrum over `view` (Hz) across, time running down, level
 * as color.
 */
export function drawWaterfall(
  canvas: HTMLCanvasElement,
  theme: Theme,
  signal: Signal,
  view: Range,
  hoverX?: number,
  hoverY?: number,
  { window, cursor }: WaterfallOptions = {},
): void {
  const frame = prepare(canvas);
  if (!frame) {
    return;
  }

  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { data, rate } = signal;
  const duration = data.length / rate;
  const shown = window ?? { start: 0, end: duration };
  const span = Math.max(1e-6, shown.end - shown.start);
  const size = Math.min(
    spectrumSize(signal, view, plotWidth),
    floorPowerOfTwo(Math.max(256, data.length)),
  );
  const rows = Math.max(1, Math.floor(plotHeight));
  const columns = Math.max(1, Math.floor(plotWidth));
  // A window shows a slice of a taller spectrogram of the whole signal.
  const total = window
    ? Math.min(8000, Math.ceil((rows * duration) / span))
    : rows;
  const grid = spectrogram(signal, view, size, total, columns);
  const spacing =
    grid.rows > 1 ? Math.max(0, data.length - size) / (grid.rows - 1) : 1;
  const rowAt = (row: number) => {
    if (!window) {
      return row;
    }

    const t = shown.start + ((row + 0.5) / rows) * span;
    const r = Math.round((t * rate - size / 2) / spacing);
    return r >= 0 && r < grid.rows && t >= 0 && t <= duration ? r : -1;
  };

  const image = new ImageData(columns, rows);
  for (let row = 0; row < rows; row++) {
    const source = rowAt(row);
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column;
      const [r, g, b] =
        source < 0
          ? [0, 0, 4]
          : inferno(
              (grid.levels[source * columns + column] -
                grid.loudest +
                WATERFALL_RANGE) /
                WATERFALL_RANGE,
            );
      image.data[4 * i] = r;
      image.data[4 * i + 1] = g;
      image.data[4 * i + 2] = b;
      image.data[4 * i + 3] = 255;
    }
  }

  const offscreen = document.createElement('canvas');
  offscreen.width = columns;
  offscreen.height = rows;
  offscreen.getContext('2d')?.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, left, top, plotWidth, plotHeight);

  drawAxes(
    frame,
    theme,
    view,
    shown,
    (v) => si(v, 'Hz'),
    (v) => si(v, 's'),
    true,
  );

  if (cursor !== undefined) {
    drawCursor(
      frame,
      theme,
      'y',
      top + ((cursor - shown.start) / span) * plotHeight,
    );
  }

  if (
    hoverX !== undefined &&
    hoverY !== undefined &&
    hoverX >= left &&
    hoverX < left + plotWidth &&
    hoverY >= top &&
    hoverY < top + plotHeight
  ) {
    const column = Math.floor(((hoverX - left) / plotWidth) * columns);
    const row = Math.floor(((hoverY - top) / plotHeight) * rows);
    const source = rowAt(row);
    const frequency =
      view.start + ((column + 0.5) / columns) * (view.end - view.start);
    const time = shown.start + ((row + 0.5) / rows) * span;
    drawReadout(
      frame,
      theme,
      `${si(frequency, 'Hz', 4)}   ${si(time, 's', 3)}${source < 0 ? '' : `   ${decibels(grid.levels[source * columns + column]!, 3)}`}`,
      hoverX,
    );
  }
}
