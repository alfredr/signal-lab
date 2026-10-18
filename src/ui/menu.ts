// A context menu: commands listed at the pointer. Choosing one, clicking elsewhere, scrolling
// or pressing Escape closes it; arrow keys move between commands.

import { html } from './dom.ts';

export type MenuItem =
  | {
      readonly label: string;
      readonly run: () => void;
      readonly disabled?: boolean;
      readonly danger?: boolean;
      /** A keyboard shortcut to show beside the label. */
      readonly hint?: string;
    }
  | { readonly heading: string }
  | 'separator';

let current:
  | { readonly element: HTMLElement; readonly close: () => void }
  | undefined;

function closeMenu(): void {
  current?.close();
}

/** Shows `items` at a point in client coordinates. */
export function showMenu(
  items: readonly MenuItem[],
  at: { readonly x: number; readonly y: number },
): void {
  closeMenu();
  const commands: HTMLButtonElement[] = [];
  const element = html('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item === 'separator') {
      element.append(
        html('div', { class: 'menu-separator', role: 'separator' }),
      );
    } else if ('heading' in item) {
      element.append(html('div', { class: 'menu-heading' }, item.heading));
    } else {
      const button = html(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: item.danger ? 'menu-item danger' : 'menu-item',
          disabled: item.disabled,
        },
        html('span', {}, item.label),
        item.hint ? html('span', { class: 'menu-hint' }, item.hint) : null,
      );
      button.addEventListener('click', () => {
        close();
        item.run();
      });

      if (!item.disabled) {
        commands.push(button);
      }

      element.append(button);
    }
  }

  if (!commands.length) {
    return;
  }

  document.body.append(element);

  // Open at the pointer, flipped back inside the window if it would spill over an edge.
  const { width, height } = element.getBoundingClientRect();
  element.style.left = `${Math.max(4, Math.min(at.x, innerWidth - width - 4))}px`;
  element.style.top = `${Math.max(4, Math.min(at.y, innerHeight - height - 4))}px`;

  const keydown = (event: KeyboardEvent) => {
    const index = commands.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === 'Escape') {
      close();
    } else if (event.key === 'ArrowDown') {
      commands[(index + 1) % commands.length].focus();
    } else if (event.key === 'ArrowUp') {
      commands[(index - 1 + commands.length) % commands.length].focus();
    } else if (event.key === 'Home') {
      commands[0].focus();
    } else if (event.key === 'End') {
      commands[commands.length - 1].focus();
    } else {
      // Enter and Space press the focused command; keep them from reaching the app's shortcuts.
      if (event.key === 'Enter' || event.key === ' ') {
        event.stopPropagation();
      }

      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  // Clicks and scrolling anywhere but the menu itself (the long Add list scrolls) close it.
  const outside = (event: Event) => {
    if (!element.contains(event.target as Node)) {
      close();
    }
  };

  const restore = document.activeElement as HTMLElement | null;
  function close(): void {
    if (current?.element !== element) {
      return;
    }

    current = undefined;
    element.remove();
    removeEventListener('keydown', keydown, true);
    removeEventListener('pointerdown', outside, true);
    removeEventListener('scroll', outside, true);
    removeEventListener('resize', close);
    removeEventListener('blur', close);
    restore?.focus({ preventScroll: true });
  }

  addEventListener('keydown', keydown, true);
  addEventListener('pointerdown', outside, true);
  addEventListener('scroll', outside, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
  current = { element, close };
  commands[0].focus({ preventScroll: true });
}
