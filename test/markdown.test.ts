import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { diagramAt, readDocument, setNotes } from '../src/model/document.ts';
import { examples } from '../src/model/examples.ts';
import {
  markdownToPlain,
  parseInline,
  parseMarkdown,
} from '../src/model/markdown.ts';

describe('markdown', () => {
  test('reads block structure', () => {
    const blocks = parseMarkdown(
      '# Title\n\nA paragraph\nthat wraps.\n\n- one\n- two\n  continued\n\n1. first\n\n> quoted\n\n---\n\n```\ncode **not bold**\n```',
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'code'],
    );
    const list = blocks[2];
    assert.ok(list?.kind === 'list' && !list.ordered);
    assert.deepEqual(list.items[1], [{ kind: 'text', text: 'two continued' }]);
    const code = blocks[6];
    assert.ok(code?.kind === 'code' && code.text === 'code **not bold**');
  });

  test('reads emphasis, code, links and math inline', () => {
    assert.deepEqual(parseInline('**bold** and *em* and `x*y`'), [
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'em' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'x*y' },
    ]);
    assert.deepEqual(parseInline('a $x_1 * y$ b'), [
      { kind: 'text', text: 'a ' },
      { kind: 'math', tex: 'x_1 * y', display: false },
      { kind: 'text', text: ' b' },
    ]);
    assert.deepEqual(parseInline('[site](https://example.com)'), [
      {
        kind: 'link',
        href: 'https://example.com',
        children: [{ kind: 'text', text: 'site' }],
      },
    ]);
  });

  test('leaves snake_case, lone asterisks and escapes alone', () => {
    assert.deepEqual(parseInline('snake_case_name and 2 * 3 * 4'), [
      { kind: 'text', text: 'snake_case_name and 2 * 3 * 4' },
    ]);
    assert.deepEqual(parseInline('costs \\$5 and \\*not em\\*'), [
      { kind: 'text', text: 'costs $5 and *not em*' },
    ]);
  });

  test('refuses links that are not http, https or mailto', () => {
    const [only] = parseInline('[click](javascript:alert(1))');
    assert.equal(only?.kind, 'text');
  });

  test('reads display math on one line or several', () => {
    assert.deepEqual(parseMarkdown('$$a + b$$'), [
      { kind: 'math', tex: 'a + b' },
    ]);
    assert.deepEqual(parseMarkdown('$$\na\n+ b\n$$'), [
      { kind: 'math', tex: 'a\n+ b' },
    ]);
  });

  test('turns into plain text for tooltips', () => {
    assert.equal(
      markdownToPlain(String.raw`A **cosine**, $A\cos(2\pi f t)$.`),
      'A cosine, Acos(2π f t).',
    );
  });
});

describe('notes', () => {
  test('a subsystem keeps its own notes, through saving and loading', () => {
    const doc = examples[0]!.build();
    const noted = setNotes(doc, ['detector'], '**Peak** detector');
    assert.equal(diagramAt(noted, ['detector'])?.notes, '**Peak** detector');
    assert.equal(noted.notes, doc.notes);
    const reloaded = readDocument(JSON.parse(JSON.stringify(noted)));
    assert.equal(
      diagramAt(reloaded, ['detector'])?.notes,
      '**Peak** detector',
    );
  });

  test('every example and library note parses without leftover markers', () => {
    for (const example of examples) {
      const doc = example.build();
      const plain = markdownToPlain(doc.notes);
      assert.ok(!/\*\*|\$\$/.test(plain), example.title);
    }
  });
});
