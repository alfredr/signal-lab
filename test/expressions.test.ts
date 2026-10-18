import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  evaluate,
  isParameterName,
  namesIn,
  parseExpression,
} from '../src/model/expressions.ts';

const scope = new Map([
  ['fc', 100e3],
  ['snr', -15],
  ['L', 1e-3],
  ['C', 1e-9],
]);
const value = (text: string) => {
  const result = evaluate(text, (name) => scope.get(name));
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
};

describe('expressions', () => {
  test('follow the usual precedence', () => {
    assert.equal(value('1 + 2 * 3'), 7);
    assert.equal(value('(1 + 2) * 3'), 9);
    assert.equal(value('2 ^ 3 ^ 2'), 512);
    assert.equal(value('-2 ^ 2'), -4);
    assert.equal(value('10 - 4 - 3'), 3);
    assert.equal(value('1.5e3 / .5'), 3000);
  });

  test('use parameters, constants and functions', () => {
    assert.equal(value('-3 - snr'), 12);
    assert.equal(value('fc / 1000'), 100);
    assert.ok(
      Math.abs(value('1 / (2 * pi * sqrt(L * C))') - 159154.94) < 0.01,
    );
    assert.ok(Math.abs(value('db(2)') - 3.0103) < 1e-4);
    assert.ok(Math.abs(value('fromdb(-3)') - 0.5012) < 1e-4);
    assert.equal(value('max(1, fc, 3)'), 100e3);
  });

  test('explain what is wrong', () => {
    const problems: [string, RegExp][] = [
      ['fc +', /ends too soon/],
      ['f0 * 2', /No parameter is called "f0"/],
      ['sqrt(2', /Expected \)/],
      ['nope(1)', /no function "nope"/],
      ['1 / 0', /not a finite number/],
      ['2 3', /Unexpected/],
    ];
    for (const [text, reason] of problems) {
      const result = evaluate(text, (name) => scope.get(name));
      assert.ok(
        !result.ok && reason.test(result.error),
        `${text}: ${JSON.stringify(result)}`,
      );
    }
  });

  test('list the names they use', () => {
    const parsed = parseExpression('a * cos(2 * pi * f) + b');
    assert.ok(parsed.ok);
    assert.deepEqual(namesIn(parsed.value), ['a', 'f', 'b']);
  });

  test('reserve function and constant names', () => {
    assert.ok(isParameterName('fc'));
    assert.ok(!isParameterName('pi'));
    assert.ok(!isParameterName('sqrt'));
    assert.ok(!isParameterName('2x'));
  });
});
