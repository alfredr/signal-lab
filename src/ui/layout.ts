// Manages workspace sidebars and the dockable instrument panel. Supports
// visibility toggles, resizing, docking, and panel maximization. Layout
// preferences are stored in this browser.

import { html, isTyping, svg } from './dom.ts';

type Area = 'blocks' | 'inspector' | 'panel';
type Position = 'bottom' | 'right';

type State = {
  readonly blocks: { readonly open: boolean; readonly width: number };
  readonly inspector: { readonly open: boolean; readonly width: number };
  readonly panel: {
    readonly open: boolean;
    /** Height under the diagram, or width beside it. */
    readonly size: number;
    readonly position: Position;
    readonly maximized: boolean;
  };
};

const DEFAULTS: State = {
  blocks: { open: true, width: 208 },
  inspector: { open: true, width: 300 },
  panel: { open: true, size: 380, position: 'bottom', maximized: false },
};

/** Minimum sizes and thresholds below which dragging closes an area. */
const LIMITS = {
  blocks: { min: 140, max: 420, close: 90 },
  inspector: { min: 240, max: 640, close: 150 },
  panel: { min: 140, close: 70 },
} as const;

/** Minimum diagram space retained while resizing the panel. */
const DIAGRAM_MIN = 160;

const KEY = 'signal-lab:layout';

const clamp = (v: number, low: number, high: number) =>
  Math.min(high, Math.max(low, v));

function load(): State {
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEY) ?? 'null',
    ) as Partial<State> | null;
    if (!saved || typeof saved !== 'object') {
      return DEFAULTS;
    }

    return {
      blocks: { ...DEFAULTS.blocks, ...saved.blocks },
      inspector: { ...DEFAULTS.inspector, ...saved.inspector },
      panel: { ...DEFAULTS.panel, ...saved.panel },
    };
  } catch {
    return DEFAULTS;
  }
}

function save(state: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Keep the layout for this session if storage is unavailable.
  }
}

/** A chevron, up or down, or a cross, for the panel's buttons. */
function glyph(kind: 'up' | 'down' | 'close'): SVGSVGElement {
  const d = {
    up: 'M4 10 8 6 12 10',
    down: 'M4 6 8 10 12 6',
    close: 'M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5',
  }[kind];
  return svg(
    'svg',
    {
      class: 'layout-icon glyph',
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
    },
    svg('path', { d }),
  );
}

/** A small icon of the layout with one part filled in. */
function icon(part: 'left' | 'right' | 'bottom'): SVGSVGElement {
  const filled = {
    left: { x: 2.5, y: 2.5, width: 4, height: 11 },
    right: { x: 9.5, y: 2.5, width: 4, height: 11 },
    bottom: { x: 2.5, y: 9, width: 11, height: 4.5 },
  }[part];
  return svg(
    'svg',
    { class: 'layout-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    svg('rect', {
      class: 'frame',
      x: 1.5,
      y: 1.5,
      width: 13,
      height: 13,
      rx: 2,
    }),
    svg('rect', { class: 'part', ...filled, rx: 0.5 }),
  );
}

const LABELS: Record<Area, { name: string; keys: string }> = {
  blocks: { name: 'Blocks', keys: '⌘B' },
  inspector: { name: 'Inspector', keys: '⌥⌘B' },
  panel: { name: 'Panel', keys: '⌘J' },
};

export class Layout {
  readonly #workspace: HTMLElement;
  readonly #center: HTMLElement;
  readonly #toggles: Record<Area, HTMLButtonElement>;
  readonly #maximize: HTMLButtonElement;
  readonly #move: HTMLButtonElement;
  readonly #close: HTMLButtonElement;
  /** Docking preview for the current drag target. */
  readonly #preview = html('div', { class: 'dock-preview', hidden: true });
  #state = load();

  constructor(workspace: HTMLElement, center: HTMLElement, bar: HTMLElement) {
    this.#workspace = workspace;
    this.#center = center;

    const toggle = (area: Area, part: 'left' | 'right' | 'bottom') => {
      const button = html(
        'button',
        {
          type: 'button',
          class: 'layout-toggle',
          title: `${LABELS[area].name} (${LABELS[area].keys})`,
          'aria-label': LABELS[area].name,
        },
        icon(part),
      );
      button.addEventListener('click', () => this.toggle(area));
      return button;
    };

    this.#toggles = {
      blocks: toggle('blocks', 'left'),
      panel: toggle('panel', 'bottom'),
      inspector: toggle('inspector', 'right'),
    };
    bar.append(
      this.#toggles.blocks,
      this.#toggles.panel,
      this.#toggles.inspector,
    );

    for (const [area, id] of [
      ['blocks', 'blocks-area'],
      ['inspector', 'inspector-area'],
    ] as const) {
      const close = html(
        'button',
        {
          type: 'button',
          class: 'area-close',
          title: `Close ${LABELS[area].name} (${LABELS[area].keys})`,
          'aria-label': `Close ${LABELS[area].name}`,
        },
        '×',
      );
      close.addEventListener('click', () => this.toggle(area));
      document.querySelector(`#${id} .area-head`)?.append(close);
    }

    const button = (label: string) =>
      html('button', {
        type: 'button',
        class: 'small icon-button',
        'aria-label': label,
      });
    this.#maximize = button('Maximize the panel');
    this.#maximize.addEventListener('click', () =>
      this.#set({
        panel: {
          ...this.#state.panel,
          maximized: !this.#state.panel.maximized,
        },
      }),
    );
    this.#move = button('Move the panel');
    this.#move.addEventListener('click', () =>
      this.#dock(this.#state.panel.position === 'bottom' ? 'right' : 'bottom'),
    );
    this.#close = button('Close the panel');
    this.#close.title = `Close the panel (${LABELS.panel.keys})`;
    this.#close.append(glyph('close'));
    this.#close.addEventListener('click', () => this.toggle('panel'));
    center.append(this.#preview);

    this.#sash('blocks', (event, box) => event.clientX - box.left);
    this.#sash('inspector', (event, box) => box.right - event.clientX);
    this.#sash('panel', (event, box) =>
      this.#state.panel.position === 'bottom'
        ? box.bottom - event.clientY
        : box.right - event.clientX,
    );

    addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey) || isTyping(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const area: Area | undefined =
        key === 'j'
          ? 'panel'
          : key === 'b' || event.code === 'KeyB'
            ? event.altKey
              ? 'inspector'
              : 'blocks'
            : undefined;
      if (area && !event.shiftKey) {
        event.preventDefault();
        this.toggle(area);
      }
    });

    this.#apply();
  }

  /** Buttons for the panel's own header: move, maximize and close. */
  get panelActions(): readonly HTMLButtonElement[] {
    return [this.#move, this.#maximize, this.#close];
  }

  /**
   * Enables panel docking by dragging its title. A preview shows the target
   * edge; releasing docks the panel and Escape cancels.
   */
  dockHandle(handle: HTMLElement): void {
    handle.classList.add('dock-handle');
    handle.title = 'Drag to dock the panel under the diagram or beside it';
    let drag: { x: number; y: number; moved: boolean } | undefined;
    let target: Position | undefined;
    const finish = (dock: boolean) => {
      if (drag?.moved && dock && target) {
        this.#dock(target);
      }

      drag = undefined;
      target = undefined;
      this.#preview.hidden = true;
      this.#workspace.classList.remove('docking');
    };

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, moved: false };
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) {
        return;
      }

      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6
      ) {
        return;
      }

      drag.moved = true;
      this.#workspace.classList.add('docking');
      // Choose the nearest edge using normalized distances.
      const box = this.#center.getBoundingClientRect();
      const across = (box.right - event.clientX) / box.width;
      const down = (box.bottom - event.clientY) / box.height;
      target = across < down ? 'right' : 'bottom';
      this.#preview.hidden = false;
      this.#preview.dataset.position = target;
    });
    handle.addEventListener('pointerup', () => finish(true));
    handle.addEventListener('pointercancel', () => finish(false));
    handle.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        finish(false);
      }
    });
    addEventListener('keydown', (event) => {
      if (drag && event.key === 'Escape') {
        finish(false);
      }
    });
  }

  #dock(position: Position): void {
    this.#set({
      panel: { ...this.#state.panel, open: true, position, maximized: false },
    });
  }

  toggle(area: Area): void {
    const now = this.#state[area];
    this.#set({
      [area]: {
        ...now,
        open: !now.open,
        // Restore a usable size when reopening an area collapsed by dragging.
        ...('width' in now && now.width < LIMITS[area].min
          ? { width: DEFAULTS[area as 'blocks'].width }
          : {}),
        ...('size' in now && now.size < LIMITS.panel.min
          ? { size: DEFAULTS.panel.size, maximized: false }
          : {}),
      },
    });
  }

  #set(change: Partial<State>): void {
    this.#state = { ...this.#state, ...change };
    save(this.#state);
    this.#apply();
  }

  #apply(): void {
    const { blocks, inspector, panel } = this.#state;
    const style = this.#workspace.style;
    style.setProperty('--blocks-width', `${blocks.width}px`);
    style.setProperty('--inspector-width', `${inspector.width}px`);
    style.setProperty('--panel-size', `${panel.size}px`);
    const classes = this.#workspace.classList;
    classes.toggle('no-blocks', !blocks.open);
    classes.toggle('no-inspector', !inspector.open);
    classes.toggle('no-panel', !panel.open);
    classes.toggle('panel-right', panel.position === 'right');
    classes.toggle('panel-max', panel.open && panel.maximized);

    for (const area of ['blocks', 'inspector', 'panel'] as const) {
      this.#toggles[area].setAttribute(
        'aria-pressed',
        String(this.#state[area].open),
      );
    }

    this.#toggles.panel.replaceChildren(
      icon(panel.position === 'bottom' ? 'bottom' : 'right'),
    );
    this.#maximize.replaceChildren(glyph(panel.maximized ? 'down' : 'up'));
    this.#maximize.title = panel.maximized
      ? 'Restore the panel'
      : 'Maximize the panel';
    this.#maximize.setAttribute('aria-pressed', String(panel.maximized));
    // The move icon indicates the destination edge.
    this.#move.replaceChildren(
      icon(panel.position === 'bottom' ? 'right' : 'bottom'),
    );
    this.#move.title =
      panel.position === 'bottom'
        ? 'Move the panel beside the diagram'
        : 'Move the panel under the diagram';
  }

  /**
   * Adds a resize handle. `measure` converts pointer coordinates to the
   * requested size. Dragging below the close threshold hides the area;
   * double-clicking restores defaults.
   */
  #sash(
    area: Area,
    measure: (event: PointerEvent, box: DOMRect) => number,
  ): void {
    const sash = html('div', {
      class: `sash sash-${area}`,
      role: 'separator',
      'aria-label': `Resize ${LABELS[area].name}`,
    });
    this.#center.append(sash);
    let dragging = false;
    sash.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      sash.setPointerCapture(event.pointerId);
      dragging = true;
      sash.classList.add('active');
    });
    sash.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }

      const box = (
        area === 'panel' ? this.#center : this.#workspace
      ).getBoundingClientRect();
      const wanted = measure(event, box);
      const limit = LIMITS[area];
      if (wanted < limit.close) {
        this.#set({ [area]: { ...this.#state[area], open: false } });
        return;
      }

      if (area === 'panel') {
        const room =
          (this.#state.panel.position === 'bottom' ? box.height : box.width) -
          DIAGRAM_MIN;
        this.#set({
          panel: {
            ...this.#state.panel,
            open: true,
            maximized: false,
            size: Math.round(
              clamp(wanted, limit.min, Math.max(limit.min, room)),
            ),
          },
        });
      } else {
        const { max } = LIMITS[area];
        this.#set({
          [area]: {
            open: true,
            width: Math.round(clamp(wanted, limit.min, max)),
          },
        });
      }
    });

    const end = () => {
      dragging = false;
      sash.classList.remove('active');
    };

    sash.addEventListener('pointerup', end);
    sash.addEventListener('pointercancel', end);
    sash.addEventListener('dblclick', () =>
      this.#set({ [area]: { ...DEFAULTS[area], open: true } }),
    );
  }
}
