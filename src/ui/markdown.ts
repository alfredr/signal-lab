// Builds DOM from the Markdown tree in model/markdown.ts. Everything is created with DOM
// calls and text nodes, never by parsing HTML.

import {
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from '../model/markdown.ts';
import { html } from './dom.ts';
import { renderMath } from './math.ts';

function inlineNodes(items: readonly Inline[]): Node[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'text':
        return document.createTextNode(item.text);
      case 'code':
        return html('code', {}, item.text);
      case 'math':
        return renderMath(item.tex, item.display);
      case 'strong':
        return html('strong', {}, ...inlineNodes(item.children));
      case 'em':
        return html('em', {}, ...inlineNodes(item.children));
      case 'link':
        return html(
          'a',
          { href: item.href, target: '_blank', rel: 'noopener noreferrer' },
          ...inlineNodes(item.children),
        );
    }
  });
}

function blockNode(block: Block): Node {
  switch (block.kind) {
    case 'paragraph':
      return html('p', {}, ...inlineNodes(block.content));

    case 'heading': {
      const tag = (['h3', 'h4', 'h5'] as const)[block.level - 1];
      return html(tag, { class: 'md-heading' }, ...inlineNodes(block.content));
    }

    case 'list':
      return html(
        block.ordered ? 'ol' : 'ul',
        {},
        ...block.items.map((item) => html('li', {}, ...inlineNodes(item))),
      );
    case 'quote':
      return html('blockquote', {}, ...block.blocks.map(blockNode));
    case 'code':
      return html('pre', {}, html('code', {}, block.text));
    case 'math':
      return html('div', { class: 'md-math' }, renderMath(block.tex, true));
    case 'rule':
      return html('hr', {});
  }
}

/** Markdown with block structure: paragraphs, headings, lists and so on. */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...parseMarkdown(source).map(blockNode));
  return fragment;
}

/** One line of Markdown, for text that sits inside an existing element. */
export function renderInline(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...inlineNodes(parseInline(source)));
  return fragment;
}
