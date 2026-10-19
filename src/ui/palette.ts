import { blockTypes, categories } from '../blocks/index.ts';
import type { Category } from '../engine/block.ts';
import { templates } from '../model/library.ts';
import { markdownToPlain } from '../model/markdown.ts';
import { html } from './dom.ts';
import { BLOCK_DRAG_TYPE } from './editor.ts';
import { blockIcon } from './icons.ts';

/**
 * Prefix that marks a palette key as a library subsystem rather than a block
 * kind.
 */
export const TEMPLATE = 'template:';

export type Entry = {
  readonly key: string;
  readonly label: string;
  readonly category: Category;
  readonly description: string;
};

/** Everything the palette offers: block types, then library subsystems. */
export const paletteEntries: readonly Entry[] = [
  ...blockTypes.map((type) => ({
    key: type.kind,
    label: type.label,
    category: type.category,
    description: type.description,
  })),
  ...templates.map((t) => ({
    key: `${TEMPLATE}${t.key}`,
    label: t.label,
    category: t.category,
    description: t.description,
  })),
];

/** The categories this browser has folded away. */
const FOLDED_KEY = 'signal-lab:palette';

function loadFolded(): Set<string> {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(FOLDED_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(saved) ? saved.filter((c) => typeof c === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * The palette: a tile for each entry, with a drawing of what it does, in
 * categories that fold away; a filter at the top narrows them by name or
 * category. Click a tile to add it, or drag it onto the diagram; in the
 * filter, Enter adds the first that matches.
 */
export function renderPalette(
  host: HTMLElement,
  add: (key: string) => void,
): void {
  const folded = loadFolded();
  const tiles: {
    readonly element: HTMLElement;
    readonly text: string;
    readonly key: string;
  }[] = [];
  const groups = categories.map((category) => {
    const grid = html('div', { class: 'palette-grid' });
    const toggle = html(
      'button',
      {
        type: 'button',
        class: 'palette-heading',
        'aria-expanded': String(!folded.has(category)),
      },
      category,
    );
    const group = html('section', { class: 'palette-group' }, toggle, grid);
    group.classList.toggle('folded', folded.has(category));
    toggle.addEventListener('click', () => {
      const fold = !group.classList.contains('folded');
      group.classList.toggle('folded', fold);
      toggle.setAttribute('aria-expanded', String(!fold));

      if (fold) {
        folded.add(category);
      } else {
        folded.delete(category);
      }

      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
      } catch {
        // Without storage the folds last as long as the page.
      }
    });

    for (const entry of paletteEntries.filter(
      (e) => e.category === category,
    )) {
      const description = markdownToPlain(entry.description);
      const button = html(
        'button',
        {
          type: 'button',
          class: `palette-item${entry.key.startsWith(TEMPLATE) ? ' composite' : ''}`,
          draggable: 'true',
          title: `${entry.label}: ${description}`,
        },
        blockIcon(entry.key),
        html('span', { class: 'palette-label' }, entry.label),
      );
      button.addEventListener('click', () => add(entry.key));
      button.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(BLOCK_DRAG_TYPE, entry.key);

        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'copy';
        }
      });
      grid.append(button);
      tiles.push({
        element: button,
        text: `${entry.label} ${category}`.toLowerCase(),
        key: entry.key,
      });
    }

    return group;
  });

  const filter = html('input', {
    type: 'search',
    class: 'palette-filter',
    placeholder: 'Filter blocks',
    'aria-label': 'Filter blocks',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const narrow = () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    host.classList.toggle('filtering', words.length > 0);

    for (const tile of tiles) {
      tile.element.hidden = !words.every((word) => tile.text.includes(word));
    }

    for (const group of groups) {
      group.hidden = ![...group.querySelectorAll('.palette-item')].some(
        (item) => !(item as HTMLElement).hidden,
      );
    }
  };

  filter.addEventListener('input', narrow);
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = tiles.find((tile) => !tile.element.hidden);
      if (first && filter.value.trim()) {
        add(first.key);
      }
    } else if (event.key === 'Escape') {
      filter.value = '';
      narrow();
    }
  });
  host.replaceChildren(
    html('div', { class: 'palette-search' }, filter),
    ...groups,
  );
}
