import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bitCell, decode, encode, synthesize } from '../src/dsp/ft8/ft8.ts';
import {
  packMessage,
  partialMessage,
  unpackMessage,
} from '../src/dsp/ft8/message.ts';
import { diagram } from '../src/model/build.ts';
import { FORMAT, type LabDocument } from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import { template } from '../src/model/library.ts';
import { gaussianNoise, simulateDocument } from './helpers.ts';

/** Tone sequences printed by ft8_lib's gen_ft8 (commit 9fec6ca). */
const GOLDEN = {
  'CQ K1ABC FN42':
    '3140652000000001005476704606021533433140652736011047517007334745455133543140652',
  'K1ABC W9XYZ -12':
    '3140652032247523504061147017461437073140652634637751301315206613617017543140652',
};

const RATE = 12000;
const SLOT = 15 * RATE;

/** A unit-amplitude FT8 signal plus white noise giving `snr` dB in 2500 Hz. */
function received(message: string, snr: number, seed = 5): Float32Array {
  const encoded = encode(message);
  assert.ok(encoded.ok);
  const audio = synthesize(encoded.tones, RATE, 1500, 0.5, SLOT);
  // Signal power 0.5 against noise spread over RATE / 2.
  const sigma = Math.sqrt((0.5 / 10 ** (snr / 10)) * (RATE / 2 / 2500));
  const noise = gaussianNoise(SLOT, seed);
  return audio.map((v, i) => v + sigma * noise[i]);
}

describe('FT8 encoding', () => {
  for (const [message, tones] of Object.entries(GOLDEN)) {
    test(`"${message}" gives ft8_lib's tones`, () => {
      const encoded = encode(message);
      assert.ok(encoded.ok);
      assert.equal(encoded.tones.join(''), tones);
    });
  }

  test('messages survive packing and unpacking', () => {
    for (const message of [
      'CQ K1ABC FN42',
      'K1ABC W9XYZ -12',
      'W9XYZ K1ABC R+05',
      'K1ABC W9XYZ RR73',
      'CQ G4ABC IO91',
    ]) {
      const packed = packMessage(message);
      assert.ok(packed.ok, message);
      assert.equal(unpackMessage(packed.bits), message);
    }
  });

  test('says why a message cannot be sent', () => {
    for (const [message, reason] of [
      ['HELLO', /form/],
      ['CQ K1ABC ZZ99', /grid/],
      ['CQ ABCDEFG FN42', /callsign/],
      ['K1ABC W9XYZ -45', /reports/],
    ] as const) {
      const encoded = encode(message);
      assert.ok(!encoded.ok && reason.test(encoded.error), message);
    }
  });
});

describe('FT8 decoding', () => {
  test('decodes a clean signal and finds its time and frequency', () => {
    const result = decode(received('CQ K1ABC FN42', 20), RATE);
    assert.equal(result.text, 'CQ K1ABC FN42');
    assert.ok(
      Math.abs(result.frequency - 1500) <= 3.125,
      `${result.frequency}`,
    );
    assert.ok(Math.abs(result.start - 0.5) <= 0.02, `${result.start}`);
  });

  test('decodes at -18 dB but not at -26 dB, and estimates SNR', () => {
    const weak = decode(received('K1ABC W9XYZ -12', -18), RATE);
    assert.equal(weak.text, 'K1ABC W9XYZ -12');
    assert.equal(
      decode(received('K1ABC W9XYZ -12', -26), RATE).text,
      undefined,
    );
    const moderate = decode(received('K1ABC W9XYZ -12', -10), RATE);
    assert.ok(Math.abs(moderate.snr + 10) < 3, `estimated ${moderate.snr} dB`);
  });

  test('decodes from other sample rates', () => {
    const encoded = encode('CQ K1ABC FN42');
    assert.ok(encoded.ok);
    const audio = synthesize(encoded.tones, 48000, 1200, 1, 15 * 48000);
    assert.equal(decode(audio, 48000).text, 'CQ K1ABC FN42');
  });
});

describe('FT8 over SSB', () => {
  test('the example decodes its message through the whole radio as the slot ends', () => {
    const example = examples.find((e) => e.title === 'FT8 over SSB');
    assert.ok(example);
    // Before the slot ends it has heard the message tone by tone, but not decoded it.
    const early = simulateDocument(example.build(), 14.9).readings.get(
      'decoder',
    );
    assert.equal(
      early?.find((r) => r.label === 'Message'),
      undefined,
    );
    assert.equal(
      early?.find((r) => r.label === 'Heard')?.value,
      'CQ K1ABC FN42',
    );
    assert.equal(
      early?.find((r) => r.label === 'Bits heard')?.value,
      '174 of 174',
    );
    const { readings, status } = simulateDocument(example.build(), 15.05);
    const found = readings.get('decoder') ?? [];
    assert.equal(
      found.find((r) => r.label === 'Message')?.value,
      'CQ K1ABC FN42',
      JSON.stringify(found),
    );
    const snr = found.find((r) => r.label === 'SNR')?.value;
    assert.ok(typeof snr === 'number' && Math.abs(snr + 10) < 3, `SNR ${snr}`);
    assert.equal(status.get('decoder')?.state, 'ok');
  });
});

describe('FT8 message packing', () => {
  const fields = (message: string) => {
    const packed = packMessage(message);
    assert.ok(packed.ok, message);
    assert.equal(
      packed.fields.flatMap((f) => f.bits).join(''),
      packed.bits.join(''),
    );
    return packed.fields;
  };

  test('a message packs field by field into the 77 bits', () => {
    assert.deepEqual(
      fields('CQ K1ABC FN42').map((f) => [
        f.name,
        f.text,
        f.value,
        f.bits.length,
      ]),
      [
        ['Call 1', 'CQ', 2, 28],
        ['Call 1 /R', 'no', 0, 1],
        ['Call 2', 'K1ABC', 10_214_965, 28],
        ['Call 2 /R', 'no', 0, 1],
        ['R', 'no', 0, 1],
        ['Grid', 'FN42', 10_342, 15],
        ['Type', 'standard', 1, 3],
      ],
    );
    assert.deepEqual(
      fields('K1ABC W9XYZ R-12')
        .slice(4)
        .map((f) => [f.name, f.text, f.value]),
      [
        ['R', 'yes', 1],
        ['Report', '-12', 32_400 + 35 - 12],
        ['Type', 'standard', 1],
      ],
    );
    assert.deepEqual(
      fields('K1ABC W9XYZ RR73')
        .slice(5, 6)
        .map((f) => [f.name, f.text, f.value]),
      [['Reply', 'RR73', 32_403]],
    );
  });

  test('a callsign or grid is a number whose digits are its characters', () => {
    const [, , call, , , grid] = fields('CQ K1ABC FN42');
    // A one-letter prefix gets a space in front, to put the digit third.
    assert.deepEqual(
      call!.places!.map((p) => `${p.char}${p.index}/${p.of}`),
      [' 0/37', 'K20/36', '11/10', 'A1/27', 'B2/27', 'C3/27'],
    );
    assert.equal(
      call!.offset! + ((((0 * 36 + 20) * 10 + 1) * 27 + 1) * 27 + 2) * 27 + 3,
      call!.value,
    );
    assert.deepEqual(
      grid!.places!.map((p) => `${p.char}${p.index}/${p.of}`),
      ['F5/18', 'N13/18', '44/10', '22/10'],
    );
    assert.equal(((5 * 18 + 13) * 10 + 4) * 10 + 2, grid!.value);
  });
});

describe('FT8 as it arrives', () => {
  test('a message reads from the left as its bits come in', () => {
    const encoded = encode('K1ABC W9XYZ -12');
    assert.ok(encoded.ok);
    const at = (bits: number) =>
      partialMessage(encoded.codeword.slice(0, bits));
    assert.equal(at(0), '······ ······ ····');
    assert.equal(at(21), 'K1A·· ······ ····');
    assert.equal(at(57), 'K1ABC W9XYZ ····');
    assert.equal(at(77), 'K1ABC W9XYZ -12');
  });

  test('the transmitter subsystem builds the audio from its steps, and it decodes', () => {
    const doc: LabDocument = {
      format: FORMAT,
      title: 'test',
      notes: '',
      ...diagram(
        {
          ft8: {
            kind: 'subsystem',
            x: 0,
            y: 0,
            inner: template('ft8-transmitter')!.build(),
          },
          meter: { kind: 'meter', x: 200, y: 0 },
        },
        [['ft8', 'meter']],
      ),
    };
    const { signals, status } = simulateDocument(doc, 15);
    assert.equal(status.get('ft8')?.state, 'ok');
    const result = decode(signals.get('ft8:0')!.data, RATE);
    assert.equal(result.text, 'CQ K1ABC FN42');
    assert.ok(
      Math.abs(result.frequency - 1500) <= 3.125,
      `${result.frequency}`,
    );
    // Tone k adds k cycles a symbol, so the phase ends at the sum of the tones.
    const encoded = encode('CQ K1ABC FN42');
    assert.ok(encoded.ok);
    const phase = signals.get('ft8/vco:1')!.data;
    const total = encoded.tones.reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(phase[14 * RATE] - total) < 0.05,
      `${phase[14 * RATE]}`,
    );
  });
});

describe('FT8 bits to tones, stage by stage', () => {
  test("each stage's bits match the encoder's, and the mapper's tones its tones", () => {
    const message = 'K1ABC W9XYZ -12';
    const encoded = encode(message);
    assert.ok(encoded.ok);
    const start = 0.5;
    const doc: LabDocument = {
      format: FORMAT,
      title: 'stages',
      notes: '',
      ...diagram(
        {
          message: {
            kind: 'ft8-message',
            x: 0,
            y: 0,
            params: { message, start, rate: RATE },
          },
          crc: { kind: 'crc14', x: 0, y: 0, params: { start } },
          ldpc: { kind: 'ldpc', x: 0, y: 0, params: { start } },
          mapper: { kind: 'ft8-mapper', x: 0, y: 0, params: { start } },
          meter: { kind: 'meter', x: 0, y: 0 },
        },
        [
          ['message', 'crc'],
          ['crc', 'ldpc'],
          ['ldpc', 'mapper'],
          ['mapper', 'meter'],
        ],
      ),
    };
    const { signals } = simulateDocument(doc, 14);
    // Read each bit in the middle of its cell.
    const read = (key: string, count: number) => {
      const data = signals.get(key)!.data;
      return Array.from({ length: count }, (_, k) => {
        const { from, to } = bitCell(k);
        return data[Math.floor((start + (from + to) / 2) * RATE)]! > 0 ? 1 : 0;
      });
    };

    const codeword = encoded.codeword;
    assert.deepEqual(read('message:0', 77), codeword.slice(0, 77));
    assert.deepEqual(read('crc:0', 91), codeword.slice(0, 91));
    assert.deepEqual(read('ldpc:0', 174), codeword);
    const tones = signals.get('mapper:0')!.data;
    const heard = encoded.tones.map(
      (_, s) => tones[Math.floor((start + (s + 0.5) * 0.16) * RATE)],
    );
    assert.deepEqual(heard, encoded.tones);
  });
});
