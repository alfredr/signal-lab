// Canvas rendering for time traces, spectra, and waterfalls. Dense traces are
// reduced to pixel-level summaries to keep large signals practical to display.

import { fft, floorPowerOfTwo } from '../dsp/fft.ts';
import { welch, type Spectrum } from '../dsp/spectrum.ts';
import { decibels, si, significant, toDecibels } from '../engine/format.ts';
import type { Signal } from '../engine/signal.ts';
import type { Trace } from './live.ts';

export type Theme = {
  readonly surface: string;
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
  /** Where y has data, if not all of it: ticks outside are left off. */
  yData: Range = y,
): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const px = (v: number) =>
    left + ((v - x.start) / (x.end - x.start)) * plotWidth;
  const py = (v: number) =>
    top + plotHeight - ((v - y.start) / (y.end - y.start)) * plotHeight;

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
    if (v < yData.start || v > yData.end) {
      continue;
    }

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

/** The most pixel steps spent joining samples up in one phosphor frame. */
const PHOSPHOR_BUDGET = 3_000_000;

/**
 * Accumulates sample and segment density per pixel. Brightness reflects how
 * often the trace crosses each pixel, preserving carrier envelopes and noise
 * structure when many samples share a column.
 */
function drawPhosphor(
  frame: Frame,
  slice: Slice,
  view: Range,
  y: Range,
  color: string,
): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { data, rate, first } = slice;
  const width = Math.max(1, Math.round(plotWidth));
  const height = Math.max(1, Math.round(plotHeight));
  const glow = new Float32Array(width * height);
  const span = view.end - view.start;
  const x = (i: number) => ((first + i) / rate - view.start) / span;
  const row = (v: number) =>
    Math.min(
      height - 1,
      Math.max(0, ((y.end - v) / (y.end - y.start)) * height),
    );
  const i0 = Math.max(0, Math.floor(view.start * rate) - first);
  const i1 = Math.min(data.length, Math.ceil(view.end * rate) - first + 1);
  let budget = PHOSPHOR_BUDGET;
  let last: number | undefined;
  for (let i = i0; i < i1; i++) {
    const column = Math.floor(x(i) * width);
    const r = row(data[i]);
    if (column >= 0 && column < width) {
      // The line from the last sample, spread over the rows it crosses.
      const from = last ?? r;
      const low = Math.floor(Math.min(from, r));
      const high = Math.floor(Math.max(from, r));
      if (high > low && budget > 0) {
        const share = 1 / (high - low + 1);
        for (let k = low; k <= high; k++) {
          glow[k * width + column] += share;
        }

        budget -= high - low;
      } else {
        glow[Math.floor(r) * width + column] += 1;
      }
    }

    last = r;
  }

  let brightest = 0;
  for (let k = 0; k < glow.length; k++) {
    brightest = Math.max(brightest, glow[k]);
  }

  // The color as numbers: a canvas reads any CSS color back as hex or rgba().
  ctx.fillStyle = color;
  const parsed = ctx.fillStyle;
  const hex = /^#([0-9a-f]{6})$/i.exec(parsed)?.[1];
  const rgb = hex
    ? [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16))
    : (/(\d+)\D+(\d+)\D+(\d+)/.exec(parsed)?.slice(1, 4).map(Number) ?? [
        128, 128, 128,
      ]);
  const image = new ImageData(width, height);
  const scale = Math.log1p(brightest);
  for (let k = 0; k < glow.length; k++) {
    if (glow[k] > 0) {
      image.data[4 * k] = rgb[0];
      image.data[4 * k + 1] = rgb[1];
      image.data[4 * k + 2] = rgb[2];
      image.data[4 * k + 3] =
        255 * Math.min(1, 0.18 + (0.82 * Math.log1p(glow[k])) / scale);
    }
  }

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  offscreen.getContext('2d')?.putImageData(image, 0, 0);
  ctx.drawImage(offscreen, left, top, plotWidth, plotHeight);
}

/** A stretch of a stream's samples: `data[0]` is sample number `first`. */
export type Slice = Signal & { readonly first: number };

/** The vertical range for samples: their extent, taking in 0, with a margin. */
function fit(data: Float32Array): Range {
  let { start: low, end: high } = extent(data);
  low = Math.min(low, 0);
  high = Math.max(high, 0);

  if (high - low < 1e-12) {
    [low, high] = [low - 1, high + 1];
  }

  const pad = (high - low) * 0.08;
  return { start: low - pad, end: high + pad };
}

/**
 * Draws samples over `view` in seconds, with optional vertical `bounds` and
 * cursor position `hoverX`. Axis labels are relative to `origin` so triggering
 * can stabilize them independently of sample time.
 */
export function drawTime(
  canvas: HTMLCanvasElement,
  theme: Theme,
  slice: Slice,
  view: Range,
  color: string,
  hoverX?: number,
  bounds?: Range,
  origin = 0,
): void {
  const frame = prepare(canvas);
  if (!frame) {
    return;
  }

  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { data, rate, first: offset } = slice;
  const y = bounds ?? fit(data);
  drawAxes(
    frame,
    theme,
    { start: view.start - origin, end: view.end - origin },
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
    drawPhosphor(frame, slice, view, y, color);
  } else {
    const first = Math.max(0, Math.floor(view.start * rate) - offset - 1);
    const last = Math.min(
      data.length - 1,
      Math.ceil(view.end * rate) - offset + 1,
    );
    const at = (i: number) => px((i + offset) / rate);
    ctx.beginPath();

    for (let i = first; i <= last; i++) {
      if (i === first) {
        ctx.moveTo(at(i), py(data[i]));
      } else {
        ctx.lineTo(at(i), py(data[i]));
      }
    }

    ctx.stroke();

    // Zoomed in far enough, show the samples themselves.
    if (perPixel < 0.12) {
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(at(i), py(data[i]), 2.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  ctx.restore();

  if (hoverX !== undefined && hoverX >= left && hoverX <= left + plotWidth) {
    const t =
      view.start + ((hoverX - left) / plotWidth) * (view.end - view.start);
    const i = Math.min(
      data.length - 1,
      Math.max(0, Math.round(t * rate) - offset),
    );
    drawReadout(
      frame,
      theme,
      `${si((i + offset) / rate, 's', 4)}   ${significant(data[i], 4)}`,
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

/**
 * Draws a sine-calibrated spectrum over `view` in Hz, with levels in dB; see
 * welch. The upper bound rounds the peak up to a 10 dB step with a margin,
 * optionally stabilized by `hold`.
 */
export function drawSpectrum(
  canvas: HTMLCanvasElement,
  theme: Theme,
  signal: Signal,
  view: Range,
  color: string,
  hoverX?: number,
  hold?: (natural: number) => number,
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

  const natural = Math.ceil((toDecibels(loudest, -200) + 5) / 10) * 10;
  const ceiling = hold ? hold(natural) : natural;
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

/**
 * The narrowest and widest range of levels a waterfall spreads its colors
 * over, in dB.
 */
const WATERFALL_RANGE = { least: 20, most: 100 } as const;

/**
 * Chooses waterfall color limits from visible data. The lower limit suppresses
 * background noise and window leakage; the upper limit follows the peak.
 * Excludes silence before the stream began.
 */
function colorRange(lines: readonly (Float32Array | null)[]): {
  readonly low: number;
  readonly high: number;
} {
  const levels: number[] = [];
  let high = -Infinity;
  for (const row of lines) {
    for (let column = 0; row && column < row.length; column++) {
      const db = row[column];
      high = Math.max(high, db);

      if (db > -250 && column % 3 === 0) {
        levels.push(db);
      }
    }
  }

  if (!levels.length) {
    return { low: high - WATERFALL_RANGE.least, high };
  }

  levels.sort((a, b) => a - b);
  const floor = levels[Math.floor(levels.length * 0.3)];
  const low = Math.min(
    high - WATERFALL_RANGE.least,
    Math.max(high - WATERFALL_RANGE.most, floor),
  );
  return { low, high };
}

/** Rows of one waterfall, by row number in the stream, for one set of settings. */
type Rows = Map<number, Float32Array | null>;

const waterfalls = new WeakMap<Trace, Map<string, Rows>>();

/**
 * Maps a windowed FFT to `columns` over the frequency range `view`. Each
 * column retains its maximum bin level in dB to preserve narrow peaks.
 */
function spectrumRow(
  data: Float32Array,
  rate: number,
  view: Range,
  columns: number,
): Float32Array {
  const size = data.length;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = data[i] * w;
    windowSum += w;
  }

  fft(re, im);
  const scale = 2 / (windowSum * windowSum);
  const binWidth = rate / size;
  const binAt = (column: number) =>
    (view.start + ((view.end - view.start) * column) / columns) / binWidth;
  const levels = new Float32Array(columns);
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

    levels[column] = toDecibels(best, -300);
  }

  return levels;
}

/**
 * Draws a waterfall over frequency `view` and time `shown`, ending at the
 * playhead. New rows appear at the top. Each row uses samples preceding its
 * timestamp and is shown only after that time has passed.
 */
export function drawWaterfall(
  canvas: HTMLCanvasElement,
  theme: Theme,
  trace: Trace,
  view: Range,
  shown: Range,
  hoverX?: number,
  hoverY?: number,
): void {
  const frame = prepare(canvas);
  if (!frame) {
    return;
  }

  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { rate } = trace;
  const span = Math.max(1e-6, shown.end - shown.start);
  const rows = Math.max(1, Math.floor(plotHeight));
  const columns = Math.max(1, Math.floor(plotWidth));
  const hop = span / rows;
  // Fine enough in frequency for the zoom, short enough to follow changes from line to line.
  const size = Math.min(
    2 **
      Math.ceil(
        Math.log2(
          rate / Math.max(1e-9, (2 * (view.end - view.start)) / columns),
        ),
      ),
    floorPowerOfTwo(Math.max(256, rate * Math.max(4 * hop, 0.2))),
    1 << 16,
  );
  const key = `${size} ${columns} ${view.start} ${view.end} ${hop}`;
  let byKey = waterfalls.get(trace);
  if (!byKey) {
    waterfalls.set(trace, (byKey = new Map()));
  }

  let cache = byKey.get(key);
  if (!cache) {
    byKey.clear();
    byKey.set(key, (cache = new Map()));
  }

  // Line k covers [k hop, (k + 1) hop); the top one is the latest that has ended.
  const newest = Math.floor(shown.end / hop + 1e-9) - 1;
  const line = (k: number): Float32Array | null => {
    if (k < 0) {
      return null;
    }

    let levels = cache.get(k);
    if (levels === undefined) {
      const end = Math.round((k + 1) * hop * rate);
      if (end > trace.end) {
        return null;
      }

      levels =
        end <= trace.start
          ? null
          : spectrumRow(trace.read(end - size, end), rate, view, columns);
      cache.set(k, levels);
    }

    return levels;
  };

  for (const k of cache.keys()) {
    if (k < newest - rows - 8 || k > newest + 8) {
      cache.delete(k);
    }
  }

  const lines = Array.from({ length: rows }, (_, row) => line(newest - row));
  const { low, high } = colorRange(lines);

  const image = new ImageData(columns, rows);
  lines.forEach((levels, row) => {
    for (let column = 0; column < columns; column++) {
      const i = row * columns + column;
      const [r, g, b] = levels
        ? inferno((levels[column] - low) / (high - low))
        : [0, 0, 4];
      image.data[4 * i] = r;
      image.data[4 * i + 1] = g;
      image.data[4 * i + 2] = b;
      image.data[4 * i + 3] = 255;
    }
  });

  const offscreen = document.createElement('canvas');
  offscreen.width = columns;
  offscreen.height = rows;
  offscreen.getContext('2d')?.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, left, top, plotWidth, plotHeight);

  // Time counts back from now, so the labels stay put as the lines slide down.
  drawAxes(
    frame,
    theme,
    view,
    { start: shown.start - shown.end, end: 0 },
    (v) => si(v, 'Hz'),
    (v) => si(v, 's'),
    { start: -shown.end, end: 0 },
  );

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
    const levels = lines[row];
    const frequency =
      view.start + ((column + 0.5) / columns) * (view.end - view.start);
    const time = (newest - row + 1) * hop;
    drawReadout(
      frame,
      theme,
      `${si(frequency, 'Hz', 4)}   ${si(time, 's', 3)}${levels ? `   ${decibels(levels[column]!, 3)}` : ''}`,
      hoverX,
    );
  }
}
