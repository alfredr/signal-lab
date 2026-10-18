// Packing FT8 standard messages ("CQ K1ABC FN42", "K1ABC W9XYZ -12",
// "K1ABC W9XYZ RR73") into 77 bits and back, as the FT8 protocol defines them.

const CH1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CH2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CH3 = '0123456789';
const CH4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
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

/** A 28-bit callsign field; the first field may also be CQ, DE or QRZ. */
function packCall(call: string, first: boolean): number | undefined {
  if (first) {
    const token = ['DE', 'QRZ', 'CQ'].indexOf(call);
    if (token >= 0) {
      return token;
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

  const indices = [
    CH1.indexOf(padded[0]),
    CH2.indexOf(padded[1]),
    CH3.indexOf(padded[2]),
    CH4.indexOf(padded[3]),
    CH4.indexOf(padded[4]),
    CH4.indexOf(padded[5]),
  ];
  if (indices.some((i) => i < 0)) {
    return undefined;
  }

  const [a, b, c, d, e, f] = indices as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    TOKENS + HASHES + ((((a * 36 + b) * 10 + c) * 27 + d) * 27 + e) * 27 + f
  );
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
function packGrid(grid: string): number | undefined {
  const special = ['', 'RRR', 'RR73', '73'].indexOf(grid);
  if (special >= 0) {
    return GRIDS + 1 + special;
  }

  if (!/^[A-R][A-R][0-9][0-9]$/.test(grid)) {
    return undefined;
  }

  return (
    ((grid.charCodeAt(0) - 65) * 18 + (grid.charCodeAt(1) - 65)) * 100 +
    Number(grid[2]) * 10 +
    Number(grid[3])
  );
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
  let roger = 0;
  if (report) {
    const db = (report[2] === '-' ? -1 : 1) * Number(report[3]);
    if (db < -30 || db > 30) {
      return { ok: false, error: 'Signal reports run from -30 to +30 dB.' };
    }

    locator = GRIDS + 35 + db;
    roger = report[1] ? 1 : 0;
  }

  if (locator === undefined) {
    return {
      ok: false,
      error: `"${third}" is not a 4-character grid (such as FN42), a report (-12, R+05), RRR, RR73 or 73.`,
    };
  }

  const bits = [
    ...bitsOf(call1, 28),
    0,
    ...bitsOf(call2, 28),
    0,
    roger,
    ...bitsOf(locator, 15),
    ...bitsOf(1, 3),
  ];
  return { ok: true, text: words.join(' '), bits };
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
