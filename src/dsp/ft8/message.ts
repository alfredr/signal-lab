// Packing FT8 standard messages ("CQ K1ABC FN42", "K1ABC W9XYZ -12",
// "K1ABC W9XYZ RR73") into 77 bits and back, as the FT8 protocol defines them.

const CH1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CH2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CH3 = '0123456789';
const CH4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FIELDS = 'ABCDEFGHIJKLMNOPQR';
const TOKENS = 2063592;
const HASHES = 4194304;
const GRIDS = 32400;

export const PAYLOAD_BITS = 77;

export function bitsOf(value: number, count: number): number[] {
  const bits: number[] = [];
  for (let j = count - 1; j >= 0; j--) {
    bits.push(Math.floor(value / 2 ** j) % 2);
  }

  return bits;
}

export function valueOf(
  bits: readonly number[],
  start: number,
  end: number,
): number {
  let value = 0;
  for (let i = start; i < end; i++) {
    value = value * 2 + bits[i];
  }

  return value;
}

/**
 * A character of a callsign or grid, and its place in the alphabet for its
 * position.
 */
export type Place = {
  readonly char: string;
  readonly index: number;
  /** How many characters that position's alphabet has. */
  readonly of: number;
};

/** What a field says, and the number that packs it. */
type Packing = {
  readonly text: string;
  /**
   * A callsign's or grid's characters, the digits of its number in a mixed
   * base: each place counts in units of all the alphabets after it.
   */
  readonly places?: readonly Place[];
  /** Added to a callsign's digits: the numbers below are kept for tokens. */
  readonly offset?: number;
  /** How the number comes about, for a field without places. */
  readonly how?: string;
  readonly value: number;
};

/** One field of the 77 bits. */
export type Field = Packing & {
  readonly name: string;
  readonly bits: readonly number[];
};

function places(
  text: string,
  alphabets: readonly string[],
): Place[] | undefined {
  const found = [...text].map((char, i) => ({
    char,
    index: alphabets[i]!.indexOf(char),
    of: alphabets[i]!.length,
  }));
  return found.every((p) => p.index >= 0) ? found : undefined;
}

/** The number whose digits are `digits`, most significant first. */
const fold = (digits: readonly Place[]) =>
  digits.reduce((value, p) => value * p.of + p.index, 0);

/** A 28-bit callsign field; the first field may also be CQ, DE or QRZ. */
function packCall(call: string, first: boolean): Packing | undefined {
  if (first) {
    const token = ['DE', 'QRZ', 'CQ'].indexOf(call);
    if (token >= 0) {
      return { text: call, how: 'DE, QRZ, CQ are 0, 1, 2', value: token };
    }
  }

  if (!/^[A-Z0-9]{3,6}$/.test(call) || !/[A-Z]/.test(call)) {
    return undefined;
  }

  // The digit of a standard call sits third; one-letter prefixes get a space in front.
  let padded = call;
  if (!/[0-9]/.test(padded[2] ?? '')) {
    if (!/[0-9]/.test(padded[1])) {
      return undefined;
    }

    padded = ` ${padded}`;
  }

  if (padded.length > 6) {
    return undefined;
  }

  padded = padded.padEnd(6, ' ');

  if (/ [A-Z]/.test(padded.slice(3))) {
    return undefined;
  }

  const digits = places(padded, [CH1, CH2, CH3, CH4, CH4, CH4]);
  if (!digits) {
    return undefined;
  }

  const offset = TOKENS + HASHES;
  return { text: call, places: digits, offset, value: offset + fold(digits) };
}

function unpackCall(value: number): string {
  if (value < TOKENS) {
    return ['DE', 'QRZ', 'CQ'][value] ?? '<token>';
  }

  let v = value - TOKENS - HASHES;
  if (v < 0) {
    return '<hash>';
  }

  const f = v % 27;
  v = Math.floor(v / 27);
  const e = v % 27;
  v = Math.floor(v / 27);
  const d = v % 27;
  v = Math.floor(v / 27);
  const c = v % 10;
  v = Math.floor(v / 10);
  const b = v % 36;
  v = Math.floor(v / 36);

  if (v >= CH1.length) {
    return '<?>';
  }

  return (CH1[v] + CH2[b] + CH3[c] + CH4[d] + CH4[e] + CH4[f]).trim();
}

/** A 15-bit locator field: a 4-character grid, or blank, RRR, RR73 or 73. */
function packGrid(grid: string): Packing | undefined {
  const special = ['', 'RRR', 'RR73', '73'].indexOf(grid);
  if (special >= 0) {
    return {
      text: grid,
      how: `after the ${GRIDS} grids, blank, RRR, RR73, 73`,
      value: GRIDS + 1 + special,
    };
  }

  const digits = /^[A-R][A-R][0-9][0-9]$/.test(grid)
    ? places(grid, [FIELDS, FIELDS, CH3, CH3])
    : undefined;
  return digits && { text: grid, places: digits, value: fold(digits) };
}

function unpackGrid(value: number): string {
  if (value < GRIDS) {
    const digits = value % 100;
    const letters = Math.floor(value / 100);
    return (
      String.fromCharCode(65 + Math.floor(letters / 18), 65 + (letters % 18)) +
      String(Math.floor(digits / 10)) +
      String(digits % 10)
    );
  }

  const index = value - GRIDS;
  if (index <= 4) {
    return ['', '', 'RRR', 'RR73', '73'][index] ?? '';
  }

  const report = index - 35;
  return `${report < 0 ? '-' : '+'}${String(Math.abs(report)).padStart(2, '0')}`;
}

export type Packed =
  | {
      readonly ok: true;
      readonly text: string;
      readonly bits: readonly number[];
      /** The fields the bits are made of, in the order they go out. */
      readonly fields: readonly Field[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * The 77 payload bits of a standard message (type i3 = 1), or why it can't be
 * one.
 */
export function packMessage(message: string): Packed {
  const words = message.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) {
    return {
      ok: false,
      error:
        'Use the form CQ K1ABC FN42, K1ABC W9XYZ -12 or K1ABC W9XYZ RR73.',
    };
  }

  const [first, second, third = ''] = words as [string, string, string?];
  const call1 = packCall(first, true);
  if (call1 === undefined) {
    return {
      ok: false,
      error: `"${first}" is not CQ, DE, QRZ or a standard callsign.`,
    };
  }

  const call2 = packCall(second, false);
  if (call2 === undefined) {
    return { ok: false, error: `"${second}" is not a standard callsign.` };
  }

  const report = /^(R?)([+-])(\d{2})$/.exec(third);
  let locator = packGrid(third);
  let roger = false;
  if (report) {
    const db = (report[2] === '-' ? -1 : 1) * Number(report[3]);
    if (db < -30 || db > 30) {
      return { ok: false, error: 'Signal reports run from -30 to +30 dB.' };
    }

    locator = {
      text: third.replace(/^R/, ''),
      how: `after the ${GRIDS} grids, 35 + report`,
      value: GRIDS + 35 + db,
    };
    roger = Boolean(report[1]);
  }

  if (locator === undefined) {
    return {
      ok: false,
      error: `"${third}" is not a 4-character grid (such as FN42), a report (-12, R+05), RRR, RR73 or 73.`,
    };
  }

  const field = (name: string, packing: Packing, count: number): Field => ({
    name,
    ...packing,
    bits: bitsOf(packing.value, count),
  });
  const flag = (name: string, on: boolean) =>
    field(name, { text: on ? 'yes' : 'no', value: on ? 1 : 0 }, 1);
  const fields = [
    field('Call 1', call1, 28),
    flag('Call 1 /R', false),
    field('Call 2', call2, 28),
    flag('Call 2 /R', false),
    flag('R', roger),
    field(
      report ? 'Report' : locator.places || !third ? 'Grid' : 'Reply',
      locator,
      15,
    ),
    field('Type', { text: 'standard', value: 1 }, 3),
  ];
  return {
    ok: true,
    text: words.join(' '),
    bits: fields.flatMap((f) => f.bits),
    fields,
  };
}

export function unpackMessage(bits: readonly number[]): string {
  if (valueOf(bits, 74, 77) !== 1) {
    return '(not a standard message)';
  }

  const locator = valueOf(bits, 59, 74);
  const roger = locator > GRIDS + 4 && bits[58] ? 'R' : '';
  return [
    unpackCall(valueOf(bits, 0, 28)),
    unpackCall(valueOf(bits, 29, 57)),
    roger + unpackGrid(locator),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Shown for a character the bits so far don't settle. */
const UNKNOWN = '·';

/** The values an `n`-bit field can still take, given its first bits. */
function range(
  bits: readonly number[],
  start: number,
  n: number,
): { readonly low: number; readonly high: number } {
  const known = Math.max(0, Math.min(n, bits.length - start));
  const prefix = valueOf(bits, start, start + known);
  const rest = 2 ** (n - known);
  return { low: prefix * rest, high: prefix * rest + rest - 1 };
}

/**
 * The characters of a mixed-radix field (most significant first) that every
 * value from `low` to `high` agrees on, and the unknown mark for the rest.
 */
function digits(
  low: number,
  high: number,
  alphabets: readonly string[],
): string {
  let weight = alphabets.reduce((w, a) => w * a.length, 1);
  return alphabets
    .map((alphabet) => {
      weight /= alphabet.length;
      const a = Math.floor(low / weight);
      return a === Math.floor(high / weight)
        ? alphabet[a % alphabet.length]
        : UNKNOWN;
    })
    .join('');
}

/** As much of a callsign field as its first bits settle. */
function partialCall(bits: readonly number[], start: number): string {
  const { low, high } = range(bits, start, 28);
  if (low === high) {
    return unpackCall(low);
  }

  const base = TOKENS + HASHES;
  if (low < base) {
    return UNKNOWN.repeat(high < base ? 2 : 6);
  }

  const call = digits(low - base, high - base, [CH1, CH2, CH3, CH4, CH4, CH4]);
  // Spaces pad a call; drop the ones that are settled at either end.
  return call.replace(/^ /, '').replace(/ +$/, '');
}

/** As much of the locator field as its first bits settle. */
function partialGrid(bits: readonly number[]): string {
  const { low, high } = range(bits, 59, 15);
  if (low === high) {
    const roger = low > GRIDS + 4 && bits[58] ? 'R' : '';
    return roger + unpackGrid(low);
  }

  return high < GRIDS
    ? digits(low, high, ['ABCDEFGHIJKLMNOPQR', 'ABCDEFGHIJKLMNOPQR', CH3, CH3])
    : UNKNOWN.repeat(4);
}

/**
 * A standard message from however many of its 77 bits are in, the ones still
 * missing shown as `UNKNOWN`: the bits go out most significant first, so each
 * field fills in from the left as they arrive. It reads the fields as a
 * standard message whatever the last three bits say, since bits heard without
 * correction may say otherwise.
 */
export function partialMessage(bits: readonly number[]): string {
  return [partialCall(bits, 0), partialCall(bits, 29), partialGrid(bits)]
    .filter(Boolean)
    .join(' ');
}
