// The color theme: the system's, or light or dark whatever the system says.
// A button in the top bar steps through the three, and this browser keeps
// the choice. The stylesheet does the rest from `data-theme` on the root;
// canvases, which take their colors when they draw, draw again.

import { html, svg } from './dom.ts';

type Theme = 'system' | 'light' | 'dark';

const KEY = 'signal-lab:theme';
const CHANGE = 'signal-lab:theme';
const NEXT: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const NAMES: Record<Theme, string> = {
  system: 'as the system is',
  light: 'light',
  dark: 'dark',
};

function stored(): Theme {
  try {
    const theme = localStorage.getItem(KEY);
    return theme === 'light' || theme === 'dark' ? theme : 'system';
  } catch {
    return 'system';
  }
}

function apply(theme: Theme): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }

  dispatchEvent(new Event(CHANGE));
}

/** A circle half filled for the system's, a sun for light, a moon for dark. */
function icon(theme: Theme): SVGSVGElement {
  const parts = {
    system: [
      svg('circle', { cx: 8, cy: 8, r: 5.5 }),
      svg('path', { class: 'fill', d: 'M8 2.5a5.5 5.5 0 0 1 0 11z' }),
    ],
    light: [
      svg('circle', { cx: 8, cy: 8, r: 3 }),
      svg('path', {
        d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
      }),
    ],
    dark: [
      svg('path', {
        d: 'M12.5 10A5.5 5.5 0 0 1 6 3.5a5.5 5.5 0 1 0 6.5 6.5z',
      }),
    ],
  }[theme];
  return svg(
    'svg',
    { class: 'theme-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    ...parts,
  );
}

/** Sets the theme this browser chose, and returns the button that changes it. */
export function themeButton(): HTMLButtonElement {
  let theme = stored();
  const button = html('button', { type: 'button', class: 'layout-toggle' });
  const show = () => {
    button.replaceChildren(icon(theme));
    button.title = `Colors: ${NAMES[theme]}. Click for ${NAMES[NEXT[theme]]}.`;
    button.setAttribute('aria-label', `Colors: ${NAMES[theme]}`);
  };

  button.addEventListener('click', () => {
    theme = NEXT[theme];

    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Without storage the choice lasts as long as the page.
    }

    apply(theme);
    show();
  });
  // Following the system, a change there changes the colors here.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'system') {
      dispatchEvent(new Event(CHANGE));
    }
  });
  apply(theme);
  show();
  return button;
}

/**
 * What to call when the colors change, held weakly: a canvas keeps its own
 * redraw, and when the canvas is gone and collected, so is its entry. One
 * taken off the page for a while, as a panel behind a tab is, stays listed.
 */
const redraws = new Set<WeakRef<() => void>>();

addEventListener(CHANGE, () => {
  for (const ref of redraws) {
    const redraw = ref.deref();
    if (redraw) {
      redraw();
    } else {
      redraws.delete(ref);
    }
  }
});

/**
 * Calls `redraw` whenever the colors change, for as long as whoever passed it
 * keeps a hold of it.
 */
export function onThemeChange(redraw: () => void): void {
  redraws.add(new WeakRef(redraw));
}
