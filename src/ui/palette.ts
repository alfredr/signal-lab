import { blockTypes, categories } from '../blocks/index.ts';
import type { Category } from '../engine/block.ts';
import { templates } from '../model/library.ts';
import { markdownToPlain } from '../model/markdown.ts';
import { html } from './dom.ts';
import { BLOCK_DRAG_TYPE } from './editor.ts';

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

/** The palette: click an entry to add it, or drag it onto the diagram. */
export function renderPalette(
  host: HTMLElement,
  add: (key: string) => void,
): void {
  host.replaceChildren(
    ...categories.map((category) =>
      html(
        'section',
        { class: 'palette-group' },
        html('h2', { class: 'palette-heading' }, category),
        ...paletteEntries
          .filter((entry) => entry.category === category)
          .map((entry) => {
            const button = html(
              'button',
              {
                type: 'button',
                class: `palette-item${entry.key.startsWith(TEMPLATE) ? ' composite' : ''}`,
                draggable: 'true',
                title: markdownToPlain(entry.description),
              },
              entry.label,
            );
            button.addEventListener('click', () => add(entry.key));
            button.addEventListener('dragstart', (event) => {
              event.dataTransfer?.setData(BLOCK_DRAG_TYPE, entry.key);

              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'copy';
              }
            });
            return button;
          }),
      ),
    ),
  );
}
