// The Markdown used in notes and descriptions: a small, safe subset. Paragraphs, headings
// (#, ##, ###), lists (-, *, 1.), block quotes (>), code (`x` and fenced), rules (---),
// emphasis (*em*, **strong**), links ([text](https://...)) and TeX math ($x$ inline,
// $$x$$ displayed). There is no raw HTML, and links only go to http, https or mailto, so
// text from an imported file can't inject anything into the page.

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'math'; readonly tex: string; readonly display: boolean }
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly children: readonly Inline[];
    };

export type Block =
  | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3;
      readonly content: readonly Inline[];
    }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly kind: 'quote'; readonly blocks: readonly Block[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'math'; readonly tex: string }
  | { readonly kind: 'rule' };

const ESCAPABLE = '\\`*_[]()#+-.!$>';
const SAFE_LINK = /^(https?:|mailto:)/i;
const LIST_ITEM = /^([-*+]|\d+[.)])\s+(.*)$/;
const isWordCharacter = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** Index of the next unescaped `marker` at or after `from`, or -1. */
function closingIndex(text: string, from: number, marker: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text.startsWith(marker, i)) {
      return i;
    }
  }

  return -1;
}

/**
 * Where an emphasis run opened at `start` with `marker` closes. An underscore
 * only counts at a word boundary, so snake_case and f_c stay as they are.
 */
function emphasisEnd(text: string, start: number, marker: string): number {
  if (isSpace(text[start + 1])) {
    return -1;
  }

  if (marker === '_' && isWordCharacter(text[start - 1])) {
    return -1;
  }

  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }

    const closes =
      text[i] === marker &&
      !isSpace(text[i - 1]) &&
      text[i + 1] !== marker &&
      !(marker === '_' && isWordCharacter(text[i + 1]));
    if (closes) {
      return i;
    }
  }

  return -1;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      out.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\\' && next !== undefined && ESCAPABLE.includes(next)) {
      buffer += next;
      i += 2;
      continue;
    }

    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === '$') {
      const marker = text.startsWith('$$', i) ? '$$' : '$';
      const end = closingIndex(text, i + marker.length, marker);
      if (end > i + marker.length) {
        flush();
        const tex = text.slice(i + marker.length, end);
        out.push({ kind: 'math', tex, display: marker === '$$' });
        i = end + marker.length;
        continue;
      }
    }

    if (text.startsWith('**', i)) {
      const end = closingIndex(text, i + 2, '**');
      if (end > i + 2) {
        flush();
        const children = parseInline(text.slice(i + 2, end));
        out.push({ kind: 'strong', children });
        i = end + 2;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      const end = emphasisEnd(text, i, c);
      if (end > i + 1) {
        flush();
        out.push({
          kind: 'em',
          children: parseInline(text.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }

    if (c === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (link && SAFE_LINK.test(link[2])) {
        flush();
        const children = parseInline(link[1]);
        out.push({ kind: 'link', href: link[2], children });
        i += link[0].length;
        continue;
      }
    }

    buffer += c;
    i++;
  }

  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({
        kind: 'paragraph',
        content: parseInline(paragraph.join(' ')),
      });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (trimmed.startsWith('```')) {
      flush();
      const body: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith('```')) {
        body.push(lines[++i]);
      }

      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    // $$ ... $$ on its own, on one line or across several.
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2);
      const close = rest.indexOf('$$');
      if (close >= 0 && rest.slice(close + 2).trim() === '') {
        flush();
        blocks.push({ kind: 'math', tex: rest.slice(0, close).trim() });
        continue;
      }

      const last = lines.findIndex((l, j) => j > i && l.trim().endsWith('$$'));
      if (close < 0 && last > i) {
        flush();
        const middle = lines.slice(i + 1, last).map((l) => l.trim());
        const end = lines[last].trim().slice(0, -2);
        blocks.push({
          kind: 'math',
          tex: [rest, ...middle, end].join('\n').trim(),
        });
        i = last;
        continue;
      }
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({
        kind: 'heading',
        level,
        content: parseInline(heading[2]),
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const item = LIST_ITEM.exec(trimmed);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const items = [item[2]];
      while (i + 1 < lines.length) {
        const following = lines[i + 1];
        const another = LIST_ITEM.exec(following.trim());
        if (another && /\d/.test(another[1]) === ordered) {
          items.push(another[2]);
        } else if (!another && following.trim() && /^\s/.test(following)) {
          // An indented line continues the item above it.
          items[items.length - 1] += ` ${following.trim()}`;
        } else {
          break;
        }

        i++;
      }

      blocks.push({ kind: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      const quoted = [trimmed.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) {
        quoted.push(lines[++i].trim().replace(/^>\s?/, ''));
      }

      blocks.push({ kind: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    paragraph.push(trimmed);
  }

  flush();
  return blocks;
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  eta: 'η',
  mu: 'μ',
  pi: 'π',
  tau: 'τ',
  phi: 'φ',
  varphi: 'φ',
  omega: 'ω',
  pm: '±',
  cdot: '·',
  circ: '°',
  infty: '∞',
  sqrt: '√',
  tfrac12: '½',
};

/** A rough plain-text reading of TeX: \cos 2\pi f_0 t becomes "cos 2π f_0 t". */
function texToPlain(tex: string): string {
  return tex
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\^\\circ/g, '°')
    .replace(
      /\\([a-zA-Z]+[0-9]*)/g,
      (_, name: string) => SYMBOLS[name] ?? name,
    )
    .replace(/\\[,;! ]/g, ' ')
    .replace(/[{}]/g, '');
}

function inlineToPlain(items: readonly Inline[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case 'text':
        case 'code':
          return item.text;
        case 'math':
          return texToPlain(item.tex);
        default:
          return inlineToPlain(item.children);
      }
    })
    .join('');
}

function blocksToPlain(blocks: readonly Block[]): string {
  return blocks
    .map((block): string => {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          return inlineToPlain(block.content);
        case 'list':
          return block.items
            .map((item) => `• ${inlineToPlain(item)}`)
            .join('\n');
        case 'quote':
          return blocksToPlain(block.blocks);
        case 'code':
          return block.text;
        case 'math':
          return texToPlain(block.tex);
        case 'rule':
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * The text without its markup, for places that can't show any, such as
 * tooltips.
 */
export function markdownToPlain(source: string): string {
  return blocksToPlain(parseMarkdown(source));
}
