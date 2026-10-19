// The Bits to tones view: an FT8 symbol mapper's last few symbols side by
// side, a column each. A row of what each symbol carries (its three coded bits
// and the tone the Gray code picks for them), the mapper's tone out, the glide
// the Gaussian filter after it makes of the steps, and any time plots stacked
// under it. It scrolls with the playhead, now at the right, and each label
// rides along in its column, kept in view as the column comes and goes.

import {
  bitCell,
  dataBit,
  isSync,
  SLOT_SECONDS,
  SYMBOL_SECONDS,
  SYMBOLS,
} from '../dsp/ft8/ft8.ts';
import { si } from '../engine/format.ts';
import { html } from './dom.ts';
import type { Trace } from './live.ts';
import { Held } from './signal-panel.ts';
import { onThemeChange } from './theme.ts';

/** A signal drawn as a row, and how far it runs behind the mapper's tone. */
type Lagged = {
  readonly trace: Trace | undefined;
  readonly lag: number;
};

export type SymbolViewState = {
  /** The playhead's time. */
  readonly time: number;
  /** Where the transmission starts in each slot, in seconds. */
  readonly start: number;
  /** How many seconds across, up to the playhead. */
  readonly span: number;
  readonly tone: Trace | undefined;
  readonly bits: Trace | undefined;
  readonly glide: Lagged | undefined;
  readonly stacked: readonly (Lagged & { readonly name: string })[];
  readonly problem: string | undefined;
};

/** A symbol in view: its slot's transmission, its number there, its time. */
type Column = {
  /** When its slot's transmission starts, in stream seconds. */
  readonly base: number;
  readonly s: number;
  readonly from: number;
  readonly to: number;
};

/** The symbols that start before `t1` and end after `t0`, across slots. */
function columnsIn(t0: number, t1: number, start: number): Column[] {
  const columns: Column[] = [];
  for (
    let slot = Math.floor(t0 / SLOT_SECONDS) - 1;
    slot * SLOT_SECONDS <= t1;
    slot++
  ) {
    const base = slot * SLOT_SECONDS + start;
    const first = Math.max(0, Math.floor((t0 - base) / SYMBOL_SECONDS));
    const last = Math.min(
      SYMBOLS - 1,
      Math.ceil((t1 - base) / SYMBOL_SECONDS - 1e-9) - 1,
    );
    for (let s = first; s <= last; s++) {
      const from = base + s * SYMBOL_SECONDS;
      columns.push({ base, s, from, to: from + SYMBOL_SECONDS });
    }
  }

  return columns.filter((c) => c.to > t0 && c.from < t1);
}

/** The sample of `trace` at `t`, if it holds one there. */
function sampleAt(trace: Trace | undefined, t: number): number | undefined {
  if (!trace) {
    return undefined;
  }

  const n = Math.floor(t * trace.rate + 1e-6);
  return n >= trace.start && n < trace.end
    ? trace.read(n, n + 1)[0]
    : undefined;
}

/**
 * What a symbol carries, as its column says it: its three bits, or that it is
 * sync, over its tone.
 */
function carries(
  state: SymbolViewState,
  { base, s, from }: Column,
): { readonly bits: string; readonly tone: string; readonly text: string } {
  const middle = Math.min(from + SYMBOL_SECONDS / 2, state.time);
  const level = sampleAt(state.tone, Math.max(from, middle - 1e-4));
  const tone = level === undefined ? '·' : String(Math.round(level));
  if (isSync(s)) {
    return { bits: 'sync', tone, text: `Costas ${tone}` };
  }

  const k = dataBit(s)!;
  const bits = [0, 1, 2]
    .map((j) => {
      const cell = bitCell(k + j);
      const bit = sampleAt(state.bits, base + (cell.from + cell.to) / 2);
      return bit === undefined ? '·' : bit > 0 ? '1' : '0';
    })
    .join('');
  return { bits, tone, text: `${bits} → ${tone}` };
}

type Colors = {
  readonly ink: string;
  readonly muted: string;
  readonly grid: string;
  readonly rule: string;
  readonly accent: string;
  readonly sync: string;
  readonly syncSoft: string;
  readonly mono: string;
};

function colors(element: Element): Colors {
  const style = getComputedStyle(element);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    ink: get('--ink'),
    muted: get('--muted'),
    grid: get('--grid'),
    rule: get('--rule'),
    accent: get('--accent'),
    sync: get('--sync'),
    syncSoft: get('--sync-soft'),
    mono: get('--font-mono'),
  };
}

/** Room for the row names on the left, and the symbol numbers on top. */
const GUTTER = 58;
const HEADER = 16;
const CARRIES = 30;
/** Room for the time axis along the bottom. */
const AXIS = 16;

export class SymbolView {
  readonly element: HTMLElement;
  readonly #canvas = html('canvas', { class: 'plot symbol-view' });
  readonly #empty = html('p', { class: 'panel-empty' });
  #state: SymbolViewState | undefined;
  #frame = 0;
  /** Each stacked row's height above and below 0, by name. */
  readonly #peaks = new Map<string, Held>();
  #shown = '';

  /** Drawn again when the colors change; theme.ts holds it only weakly. */
  readonly #redraw = () => this.#schedule();

  constructor() {
    this.element = html(
      'div',
      { class: 'plot-wrap' },
      this.#canvas,
      this.#empty,
    );
    new ResizeObserver(() => this.#schedule()).observe(this.#canvas);
    onThemeChange(this.#redraw);
  }

  update(state: SymbolViewState): void {
    this.#state = state;
    const message =
      state.problem ??
      (state.tone ? '' : 'Nothing yet. Press Run to start the stream.');
    this.#empty.textContent = message;
    this.#empty.hidden = !message;
    this.#canvas.hidden = Boolean(message);
    this.#schedule();
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
    const canvas = this.#canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!state || state.problem || !state.tone || !width || !height) {
      return;
    }

    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const c = colors(canvas);
    // The last `span` seconds, up to the playhead at the right.
    const t1 = state.time;
    const t0 = t1 - state.span;
    const right = width - 6;
    const across = right - GUTTER;
    const x = (t: number) => GUTTER + ((t - t0) / (t1 - t0)) * across;
    const columns = columnsIn(t0, t1, state.start);

    // The rows under the carries share what's left.
    const rows: { name: string; kind: 'tone' | 'glide' | 'stacked' }[] = [
      { name: 'Tone', kind: 'tone' },
      ...(state.glide ? [{ name: 'Glide', kind: 'glide' as const }] : []),
      ...state.stacked.map((row) => ({
        name: row.name,
        kind: 'stacked' as const,
      })),
    ];
    const rowHeight = Math.max(
      24,
      (height - HEADER - CARRIES - AXIS - 2) / rows.length,
    );
    const top = (i: number) => HEADER + CARRIES + i * rowHeight;

    // A column's visible stretch.
    const seen = (column: Column) => ({
      left: Math.max(GUTTER, x(column.from)),
      right: Math.min(right, x(column.to)),
    });

    // Text in a column, centred, but kept inside the part in view as the
    // column scrolls in or out; the short form, or nothing, where it won't fit.
    const label = (
      column: Column,
      texts: readonly string[],
      y: number,
    ): string | undefined => {
      const { left, right: end } = seen(column);
      const text = texts.find(
        (t) => ctx.measureText(t).width + 6 <= end - left,
      );
      if (text === undefined) {
        return undefined;
      }

      const half = ctx.measureText(text).width / 2;
      const middle = (x(column.from) + x(column.to)) / 2;
      ctx.fillText(
        text,
        Math.min(Math.max(middle, left + half + 3), end - half - 3),
        y,
      );
      return text;
    };

    // Sync columns, symbol numbers and boundaries.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `500 10px ${c.mono}`;

    for (const column of columns) {
      const { left, right: end } = seen(column);
      if (isSync(column.s)) {
        ctx.fillStyle = c.syncSoft;
        ctx.fillRect(left, HEADER - 2, end - left, height - AXIS - HEADER + 2);
      }

      ctx.fillStyle = isSync(column.s) ? c.sync : c.muted;
      label(column, [String(column.s)], HEADER / 2);
    }

    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (const column of columns) {
      const at = Math.round(x(column.from)) + 0.5;
      if (at > GUTTER && at < right) {
        ctx.moveTo(at, HEADER - 2);
        ctx.lineTo(at, height - AXIS);
      }
    }

    for (let i = 0; i <= rows.length; i++) {
      const at = Math.round(top(i)) + 0.5;
      ctx.moveTo(GUTTER, at);
      ctx.lineTo(right, at);
    }

    ctx.stroke();

    // Row names.
    ctx.textAlign = 'left';
    ctx.fillStyle = c.muted;
    ctx.font = `600 10px ${c.mono}`;
    ctx.fillText('CARRIES', 0, HEADER + CARRIES / 2);
    rows.forEach((row, i) =>
      ctx.fillText(
        row.name.toUpperCase().slice(0, 9),
        0,
        top(i) + rowHeight / 2,
      ),
    );

    // What each symbol carries: its bits over the tone they pick.
    const said: string[] = [];
    ctx.textAlign = 'center';
    ctx.font = `600 11px ${c.mono}`;

    // Each run of seven sync symbols gets one label across it.
    const runs = new Map<string, { left: number; right: number }>();
    for (const column of columns) {
      const what = carries(state, column);
      said.push(`${column.s} ${what.text}`);

      if (isSync(column.s)) {
        const key = `${column.base}|${Math.floor(column.s / 36)}`;
        const { left, right: end } = seen(column);
        const run = runs.get(key);
        runs.set(key, { left: run?.left ?? left, right: end });
      } else {
        ctx.fillStyle = c.ink;
        label(column, [what.bits], HEADER + 8);
      }

      ctx.fillStyle = isSync(column.s) ? c.sync : c.accent;
      label(column, [`→ ${what.tone}`, what.tone], HEADER + 21);
    }

    ctx.fillStyle = c.sync;

    for (const run of runs.values()) {
      const text = ['Costas sync', 'sync'].find(
        (t) => ctx.measureText(t).width + 6 <= run.right - run.left,
      );
      if (text) {
        const half = ctx.measureText(text).width / 2;
        ctx.fillText(
          text,
          Math.min(
            Math.max((run.left + run.right) / 2, run.left + half + 3),
            run.right - half - 3,
          ),
          HEADER + 8,
        );
      }
    }

    const shown = `The last ${si(state.span, 's')}: ${said.join(', ')}`;
    if (shown !== this.#shown) {
      this.#shown = shown;
      canvas.setAttribute('aria-label', shown);
      canvas.dataset.columns = said.join('|');
    }

    // A signal across the view, `lag` taken out, as the range of values in
    // each pixel column.
    const trace = (signal: Lagged | undefined) => {
      const source = signal?.trace;
      if (!source) {
        return undefined;
      }

      const sampleOf = (px: number) =>
        Math.floor(
          (t0 + ((px - GUTTER) / across) * (t1 - t0) + signal.lag) *
            source.rate,
        );
      const from = Math.max(source.start, sampleOf(GUTTER));
      const to = Math.min(source.end, sampleOf(right) + 1);
      if (to <= from) {
        return undefined;
      }

      const data = source.read(from, to);
      const out: { x: number; low: number; high: number }[] = [];
      for (let px = GUTTER; px < right; px++) {
        const a = sampleOf(px) - from;
        const b = Math.max(a + 1, sampleOf(px + 1) - from);
        if (b <= 0 || a >= data.length) {
          continue;
        }

        let low = Infinity;
        let high = -Infinity;
        for (let i = Math.max(0, a); i < Math.min(data.length, b); i++) {
          low = Math.min(low, data[i]);
          high = Math.max(high, data[i]);
        }

        out.push({ x: px, low, high });
      }

      return out;
    };

    const draw = (
      columns: { x: number; low: number; high: number }[] | undefined,
      y: (v: number) => number,
      color: string,
      width: number,
      dash: number[] = [],
    ) => {
      if (!columns?.length) {
        return;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let previous: { x: number; low: number; high: number } | undefined;
      for (const col of columns) {
        if (!previous) {
          ctx.moveTo(col.x, y(col.high));
        } else {
          // Join from the last column, then cover this one's range.
          ctx.lineTo(
            col.x,
            y(Math.min(Math.max(previous.high, col.low), col.high)),
          );
        }

        ctx.lineTo(col.x, y(col.high));
        ctx.lineTo(col.x, y(col.low));
        previous = col;
      }

      ctx.stroke();
      ctx.setLineDash([]);
    };

    // Tones 0 to 7, with faint lines at each.
    const toneScale = (i: number) => (v: number) =>
      top(i) + rowHeight - 5 - (v / 7) * (rowHeight - 10);
    const toneGrid = (i: number) => {
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();

      for (let v = 0; v <= 7; v++) {
        const at = Math.round(toneScale(i)(v)) + 0.5;
        ctx.moveTo(GUTTER, at);
        ctx.lineTo(right, at);
      }

      ctx.stroke();
    };

    const tones = trace({ trace: state.tone, lag: 0 });
    const firstStacked = rows.findIndex((r) => r.kind === 'stacked');
    rows.forEach((row, i) => {
      if (row.kind === 'tone') {
        toneGrid(i);
        draw(tones, toneScale(i), c.accent, 2);
      } else if (row.kind === 'glide') {
        toneGrid(i);
        draw(tones, toneScale(i), c.muted, 1, [4, 4]);
        draw(trace(state.glide), toneScale(i), c.accent, 2);
      } else {
        const signal = trace(state.stacked[i - firstStacked]);
        let most = 0;
        for (const col of signal ?? []) {
          most = Math.max(most, Math.abs(col.low), Math.abs(col.high));
        }

        let held = this.#peaks.get(row.name);
        if (!held) {
          this.#peaks.set(row.name, (held = new Held()));
        }

        const peak = held.next(most);
        const middle = top(i) + rowHeight / 2;
        const half = rowHeight / 2 - 4;
        draw(
          signal,
          (v) => middle - (peak > 0 ? v / peak : 0) * half,
          c.ink,
          1.2,
        );
      }
    });

    // Seconds before now along the bottom, as on a time plot.
    const step = state.span > 5 ? 2 : state.span >= 1.5 ? 1 : 0.5;
    const axis = height - AXIS / 2;
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.rule;
    ctx.font = `400 10px ${c.mono}`;
    ctx.beginPath();

    for (let v = 0; v >= -state.span + 1e-9; v -= step) {
      const at = x(t1 + v);
      const text = si(v, 's');
      const half = ctx.measureText(text).width / 2;
      ctx.fillText(
        text,
        Math.min(Math.max(at, GUTTER + half), right - half),
        axis,
      );
      ctx.moveTo(Math.round(at) + 0.5, height - AXIS);
      ctx.lineTo(Math.round(at) + 0.5, height - AXIS + 3);
    }

    ctx.stroke();

    // Now, at the right.
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(right + 0.5, HEADER - 2);
    ctx.lineTo(right + 0.5, height - AXIS);
    ctx.stroke();
  }
}
