import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decode, encode, synthesize } from '../src/dsp/ft8/ft8.ts';
import { packMessage, unpackMessage } from '../src/dsp/ft8/message.ts';
import { examples } from '../src/model/examples.ts';
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
  test('the example decodes its message through the whole radio', () => {
    const example = examples.find((e) => e.title === 'FT8 over SSB');
    assert.ok(example);
    const { readings, status } = simulateDocument(example.build());
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
