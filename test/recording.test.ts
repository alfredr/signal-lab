import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addClip } from '../src/blocks/clips.ts';
import { output, plain, run, stream } from './helpers.ts';

// A tenth of a second at 8 kHz that counts up, so where it is shows.
const RATE = 8000;
const clip = Float32Array.from({ length: 800 }, (_, i) => (i + 1) / 800);
addClip('ramp', { rate: RATE, data: clip });

const recording = (params: Record<string, string | number | boolean>) => ({
  clip: 'ramp',
  rate: RATE,
  ...params,
});

describe('recordings', () => {
  test('a looping recording plays over and over', () => {
    const out = output(
      run({
        seconds: 0.25,
        circuit: plain([['rec', 'recording', recording({ loop: true })]], []),
      }),
      'rec',
    ).data;
    assert.equal(out.length, 2000);
    assert.equal(out[0], clip[0]);
    assert.equal(out[799], clip[799]);
    assert.equal(out[800], clip[0]);
    assert.equal(out[1999], clip[399]);
  });

  test('otherwise it waits for its trigger, and plays once from a Button', () => {
    const circuit = plain(
      [
        ['rec', 'recording', recording({})],
        ['push', 'button', { rate: 1000 }],
      ],
      [['push', 'rec:0']],
    );
    const s = stream();
    assert.equal(s.load(circuit).status.get('rec')?.state, 'ok');
    const heard: number[] = [];
    const take = (until: number) =>
      s.advance(until, (chunk) =>
        heard.push(...chunk.signals.get('rec:0')!.data),
      );
    take(0.05);
    assert.ok(
      heard.every((v) => v === 0),
      'silent before the press',
    );
    s.press('push');
    take(0.3);
    const first = heard.findIndex((v) => v !== 0);
    assert.ok(first >= 400 && first < 420, `starts at sample ${first}`);
    assert.equal(heard[first], clip[0]);
    assert.equal(heard[first + 799], clip[799]);
    assert.ok(
      heard.slice(first + 800).every((v) => v === 0),
      'and stops at the end',
    );
  });

  test('Play in the inspector starts it from the beginning', () => {
    const s = stream();
    s.load(plain([['rec', 'recording', recording({})]], []));
    const heard: number[] = [];
    s.advance(0.01);
    s.press('rec');
    s.advance(0.02, (chunk) =>
      heard.push(...chunk.signals.get('rec:0')!.data),
    );
    assert.equal(heard[0], clip[0]);
  });

  test('plays at its own rate whatever the rate of the recording', () => {
    const out = output(
      run({
        seconds: 0.1,
        circuit: plain(
          [['rec', 'recording', recording({ loop: true, rate: 16000 })]],
          [],
        ),
      }),
      'rec',
    ).data;
    // Twice the rate, so the ramp takes twice as many samples.
    assert.ok(Math.abs(out[400] - clip[200]) < 0.01, `${out[400]}`);
  });

  test('says when it has nothing to play', () => {
    const { status } = run({
      seconds: 0.01,
      circuit: plain([['rec', 'recording', recording({ clip: 'gone' })]], []),
    });
    const rec = status.get('rec');
    assert.equal(rec?.state, 'error');
    assert.match(
      rec.state === 'error' ? rec.message : '',
      /isn't in this browser/,
    );
  });

  test('in a feedback loop it starts once per rise, however the loop is stepped', () => {
    // Its own output comes back round to its trigger through a 2 ms delay, so
    // the loop is stepped two samples at a time. Four samples, all below 0.5.
    addClip('four', {
      rate: 1000,
      data: Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    });
    const s = stream();
    s.load(
      plain(
        [
          ['push', 'button', { rate: 1000 }],
          ['sum', 'adder'],
          ['rec', 'recording', { clip: 'four', rate: 1000 }],
          ['back', 'delay', { time: 0.002 }],
        ],
        [
          ['push', 'sum:0'],
          ['back', 'sum:1'],
          ['sum', 'rec:0'],
          ['rec', 'back'],
        ],
      ),
    );
    const heard: number[] = [];
    s.advance(0.05);
    s.press('push');
    s.advance(0.2, (chunk) => heard.push(...chunk.signals.get('rec:0')!.data));
    const first = heard.findIndex((v) => v !== 0);
    assert.deepEqual(
      heard.slice(first, first + 5).map((v) => Math.round(v * 10) / 10),
      [0.1, 0.2, 0.3, 0.4, 0],
    );
    assert.ok(
      heard.slice(first + 4).every((v) => v === 0),
      'plays once',
    );
  });
});
