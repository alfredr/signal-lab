// Canvas plots of a signal over time and of its spectrum. Both draw millions of samples by
// reducing each pixel column to the range of values it covers.

import { welch, type Spectrum } from "../dsp/spectrum.ts";
import { floorPowerOfTwo } from "../dsp/fft.ts";
import { decibels, si, significant, toDecibels } from "../engine/format.ts";
import type { Signal } from "../engine/signal.ts";

export interface Theme {
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly rule: string;
  readonly grid: string;
  readonly mono: string;
}

export function readTheme(element: Element): Theme {
  const style = getComputedStyle(element);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return { surface: get("--surface"), ink: get("--ink"), muted: get("--muted"), rule: get("--rule"), grid: get("--grid"), mono: get("--font-mono") };
}

/** A visible span of the x axis: seconds for time plots, hertz for spectra. */
export interface Range {
  readonly start: number;
  readonly end: number;
}

interface Frame {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** The data area inside the axes. */
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
}

/** Space around the data area for axis labels, in CSS pixels. */
export const MARGIN = { left: 58, right: 12, top: 10, bottom: 24 } as const;

/** Sizes the canvas for the screen and returns its drawing context, or nothing if hidden. */
function prepare(canvas: HTMLCanvasElement): Frame | undefined {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return undefined;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
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
export function ticks(low: number, high: number, count: number): number[] {
  const raw = (high - low) / Math.max(1, count);
  if (!(raw > 0)) return [low];
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const r = raw / magnitude;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * magnitude;
  const values: number[] = [];
  for (let v = Math.ceil(low / step - 1e-9) * step; v <= high + step * 1e-9; v += step) values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return values;
}

function drawAxes(frame: Frame, theme: Theme, x: Range, y: Range, xLabel: (v: number) => string, yLabel: (v: number) => string): void {
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const px = (v: number) => left + ((v - x.start) / (x.end - x.start)) * plotWidth;
  const py = (v: number) => top + plotHeight - ((v - y.start) / (y.end - y.start)) * plotHeight;
  ctx.lineWidth = 1;
  ctx.font = `400 11px ${theme.mono}`;
  ctx.fillStyle = theme.muted;

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const v of ticks(x.start, x.end, Math.max(2, Math.floor(plotWidth / 110)))) {
    const at = Math.round(px(v)) + 0.5;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(at, top);
    ctx.lineTo(at, top + plotHeight);
    ctx.stroke();
    ctx.fillText(xLabel(v), at, top + plotHeight + 6);
  }

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of ticks(y.start, y.end, Math.max(2, Math.floor(plotHeight / 36)))) {
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

function drawReadout(frame: Frame, theme: Theme, text: string, hoverX: number): void {
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
  const x = Math.min(Math.max(hoverX + 8, left + 4), left + plotWidth - width - 4);
  ctx.fillStyle = theme.surface;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(x, top + 4, width, 20);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
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
      if (data[i] < low) low = data[i];
      if (data[i] > high) high = data[i];
    }
    cached = data.length ? { start: low, end: high } : { start: -1, end: 1 };
    extents.set(data, cached);
  }
  return cached;
}

export function timeSpan(signal: Signal): Range {
  return { start: 0, end: Math.max(signal.data.length, 1) / signal.rate };
}

/** Draws the signal over `view` (seconds); `hoverX` is a canvas x position to read out. */
export function drawTime(canvas: HTMLCanvasElement, theme: Theme, signal: Signal, view: Range, color: string, hoverX?: number): void {
  const frame = prepare(canvas);
  if (!frame) return;
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const { data, rate } = signal;

  let { start: low, end: high } = extent(data);
  if (low > 0) low = 0;
  if (high < 0) high = 0;
  if (high - low < 1e-12) [low, high] = [low - 1, high + 1];
  const pad = (high - low) * 0.08;
  const y = { start: low - pad, end: high + pad };
  drawAxes(frame, theme, view, y, (v) => si(v, "s"), (v) => significant(v));

  const px = (t: number) => left + ((t - view.start) / (view.end - view.start)) * plotWidth;
  const py = (v: number) => top + plotHeight - ((v - y.start) / (y.end - y.start)) * plotHeight;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotWidth, plotHeight);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";

  const perPixel = ((view.end - view.start) * rate) / plotWidth;
  if (perPixel > 2) {
    // Each pixel column becomes a bar from its lowest to its highest sample.
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (let column = 0; column < plotWidth; column++) {
      const i0 = Math.max(0, Math.floor((view.start + ((view.end - view.start) * column) / plotWidth) * rate));
      const i1 = Math.min(data.length, Math.floor((view.start + ((view.end - view.start) * (column + 1)) / plotWidth) * rate));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i < Math.max(i1, i0 + 1) && i < data.length; i++) {
        if (data[i] < lo) lo = data[i];
        if (data[i] > hi) hi = data[i];
      }
      tops.push(hi === -Infinity ? NaN : py(hi));
      bottoms.push(lo === Infinity ? NaN : py(lo));
    }
    ctx.beginPath();
    for (let column = 0; column < plotWidth; column++) {
      if (Number.isNaN(tops[column])) continue;
      ctx.rect(left + column, tops[column], 1, Math.max(1, bottoms[column] - tops[column]));
    }
    ctx.fill();
  } else {
    const first = Math.max(0, Math.floor(view.start * rate) - 1);
    const last = Math.min(data.length - 1, Math.ceil(view.end * rate) + 1);
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      if (i === first) ctx.moveTo(px(i / rate), py(data[i]));
      else ctx.lineTo(px(i / rate), py(data[i]));
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

  if (hoverX !== undefined && hoverX >= left && hoverX <= left + plotWidth) {
    const t = view.start + ((hoverX - left) / plotWidth) * (view.end - view.start);
    const i = Math.min(data.length - 1, Math.max(0, Math.round(t * rate)));
    drawReadout(frame, theme, `${si(i / rate, "s", 4)}   ${significant(data[i], 4)}`, hoverX);
  }
}

const spectra = new WeakMap<Float32Array, Map<number, Spectrum>>();

/**
 * FFT size for showing `view` (Hz) across `pixels`: fine enough to resolve what the zoom level
 * can show, within what the signal's length allows.
 */
export function spectrumSize(signal: Signal, view: Range, pixels: number): number {
  const wanted = (2 * (view.end - view.start)) / Math.max(pixels, 1);
  const size = 2 ** Math.ceil(Math.log2(signal.rate / Math.max(wanted, 1e-9)));
  const longest = signal.data.length >= 256 ? floorPowerOfTwo(signal.data.length) : 256;
  return Math.max(256, Math.min(size, longest, 1 << 18));
}

export function spectrumOf(signal: Signal, size: number): Spectrum {
  let bySize = spectra.get(signal.data);
  if (!bySize) spectra.set(signal.data, (bySize = new Map()));
  let spectrum = bySize.get(size);
  if (!spectrum) bySize.set(size, (spectrum = welch(signal.data, signal.rate, size)));
  return spectrum;
}

export function frequencySpan(signal: Signal): Range {
  return { start: 0, end: signal.rate / 2 };
}

/** Draws the spectrum over `view` (Hz) in dB, sine-calibrated (see welch). */
export function drawSpectrum(canvas: HTMLCanvasElement, theme: Theme, signal: Signal, view: Range, color: string, hoverX?: number): void {
  const frame = prepare(canvas);
  if (!frame) return;
  const { ctx, left, top, plotWidth, plotHeight } = frame;
  const spectrum = spectrumOf(signal, spectrumSize(signal, view, plotWidth));
  const { binWidth, power } = spectrum;

  let loudest = -Infinity;
  for (let k = 0; k < power.length; k++) loudest = Math.max(loudest, power[k]);
  const ceiling = Math.ceil((toDecibels(loudest, -200) + 5) / 10) * 10;
  const y = { start: ceiling - 110, end: ceiling };
  drawAxes(frame, theme, view, y, (v) => si(v, "Hz"), (v) => significant(v));

  const py = (db: number) => top + plotHeight - ((db - y.start) / (y.end - y.start)) * plotHeight;
  const binAt = (column: number) => (view.start + ((view.end - view.start) * column) / plotWidth) / binWidth;

  // Peak-hold per column, so narrow lines survive when many bins share a pixel.
  const levels: number[] = [];
  for (let column = 0; column < plotWidth; column++) {
    const k0 = Math.max(0, Math.round(binAt(column)));
    const k1 = Math.min(power.length - 1, Math.max(k0, Math.round(binAt(column + 1)) - 1));
    let best = 0;
    for (let k = k0; k <= k1; k++) best = Math.max(best, power[k]);
    levels.push(k0 < power.length ? toDecibels(best, y.start - 10) : NaN);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotWidth, plotHeight);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(left, top + plotHeight);
  levels.forEach((db, column) => ctx.lineTo(left + column, Number.isNaN(db) ? top + plotHeight : py(db)));
  ctx.lineTo(left + plotWidth, top + plotHeight);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.14;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  levels.forEach((db, column) => (column === 0 ? ctx.moveTo(left, py(db)) : ctx.lineTo(left + column, py(db))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = `400 11px ${theme.mono}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`dB per ${si(binWidth, "Hz")} bin`, left + plotWidth - 6, top + plotHeight - 4);
  ctx.restore();

  if (hoverX !== undefined && hoverX >= left && hoverX < left + plotWidth) {
    const column = Math.floor(hoverX - left);
    const k0 = Math.max(0, Math.round(binAt(column)));
    const k1 = Math.min(power.length - 1, Math.max(k0, Math.round(binAt(column + 1)) - 1));
    let peak = k0;
    for (let k = k0; k <= k1; k++) if (power[k] > power[peak]) peak = k;
    drawReadout(frame, theme, `${si(peak * binWidth, "Hz", 4)}   ${decibels(toDecibels(power[peak]), 3)}`, hoverX);
  }
}
