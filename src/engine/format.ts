import type { Reading } from './block.ts';

// Number formatting for labels and readouts, with SI prefixes and the typographic minus sign.

export const MINUS = '−';

const PREFIXES: readonly (readonly [scale: number, prefix: string])[] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
];

/** Up to `digits` significant digits, without trailing zeros: 12.50 -> "12.5". */
export function significant(value: number, digits = 3): string {
  if (value === 0 || !Number.isFinite(value)) {
    return value === 0 ? '0' : String(value);
  }

  const text = Number(value.toPrecision(digits)).toString();
  return text.startsWith('-') ? MINUS + text.slice(1) : text;
}

/**
 * A value with an SI prefix: si(12500, "Hz") is "12.5 kHz", si(2e-5, "s") is
 * "20 µs".
 */
export function si(value: number, unit: string, digits = 3): string {
  const size = Math.abs(value);
  if (size === 0 || !Number.isFinite(size)) {
    return `${significant(value, digits)} ${unit}`;
  }

  const [scale, prefix] =
    PREFIXES.find(([s]) => size >= s * 0.9995) ??
    PREFIXES[PREFIXES.length - 1];
  return `${significant(value / scale, digits)} ${prefix}${unit}`;
}

export function decibels(value: number, digits = 3): string {
  if (value === -Infinity) {
    return `${MINUS}∞ dB`;
  }

  return `${significant(value, digits)} dB`;
}

/** A reading for display: "-3.01 dB", "12.5 kHz", "CQ K1ABC FN42". */
export function formatReading(reading: Reading): string {
  const { value, unit } = reading;
  if (typeof value === 'string') {
    return value;
  }

  switch (unit) {
    case 'dB':
      return decibels(value);
    case 'Hz':
    case 's':
      return si(value, unit, 4);
    case 'x':
      return `\u00d7${significant(value, 4)}`;
    default:
      return significant(value, 4);
  }
}

/** The amplitude ratio for a gain in dB. */
export function amplitudeFromDecibels(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Power ratio in dB, floored so silence reads as a number rather than minus
 * infinity.
 */
export function toDecibels(power: number, floor = -300): number {
  return power > 0 ? Math.max(floor, 10 * Math.log10(power)) : floor;
}
