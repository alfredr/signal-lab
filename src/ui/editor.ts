// The block-diagram editor: an SVG canvas that draws one diagram (the document's top level or
// the inside of a subsystem) and turns pointer gestures into edits. It never changes anything
// itself; it reports new versions of the diagram through `change`, as previews while a gesture
// is under way and as a commit when it ends. Instruments draw their own live widgets, which
// stay in place across redraws so a knob keeps turning while the diagram changes under it.

import { isInstrument } from '../blocks/instruments.ts';
import { INPUT_TERMINAL } from '../blocks/terminals.ts';
import type { BlockType, Reading } from '../engine/block.ts';
import { visiblePorts } from '../engine/block.ts';
import type { PortRef } from '../engine/circuit.ts';
import { formatReading } from '../engine/format.ts';
import { resolveParams } from '../engine/params.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  connect,
  isSubsystem,
  moveBlocks,
  pathId,
  removeWire,
  sameRef,
  terminals,
  wireInto,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from '../model/document.ts';
import {
  instrumentLeads,
  reachingIn,
  type Reach,
} from '../model/instruments.ts';
import {
  isTerminal,
  typeOf,
  wiredOutside,
  type Outside,
} from '../model/subsystems.ts';
import { svg } from './dom.ts';
import {
  layoutOf,
  roundedPath,
  route,
  snap,
  type BlockLayout,
  type Point,
  type PortPlace,
} from './geometry.ts';
import { rateLabel } from './labels.ts';
import type { Widgets } from './widgets.ts';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'blocks'; readonly ids: readonly string[] }
  | { readonly kind: 'wire'; readonly id: string };

export const NOTHING: Selection = { kind: 'none' };

export function selectBlocks(ids: readonly string[]): Selection {
  return ids.length ? { kind: 'blocks', ids } : NOTHING;
}

export function selectedBlocks(selection: Selection): readonly string[] {
  return selection.kind === 'blocks' ? selection.ids : [];
}

export type EditorModel = {
  readonly doc: LabDocument;
  readonly diagram: Diagram;
  /** Where the diagram sits in the document; statuses are keyed by full id. */
  readonly path: Path;
  readonly selection: Selection;
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** Draws the instruments. */
  readonly widgets: Widgets;
  /** What measuring blocks found, by full id. */
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
  /** Settings worked out from bindings, by full block id. */
  readonly bound: ReadonlyMap<string, Readonly<Record<string, number>>>;
};

/** What a right-click landed on. Port refs are local to the diagram on screen. */
export type MenuTarget =
  | { readonly kind: 'canvas' }
  | { readonly kind: 'blocks'; readonly ids: readonly string[] }
  | { readonly kind: 'wire'; readonly id: string }
  | {
      readonly kind: 'port';
      readonly direction: 'in' | 'out';
      readonly ref: PortRef;
    };

export type EditorEvents = {
  change(next: Diagram, mode: 'preview' | 'commit'): void;
  select(selection: Selection): void;
  /** Open a subsystem to edit what is inside. */
  open(id: string): void;
  /** Show a block, by full id, in its own diagram. */
  reveal(id: string): void;
  /** Add a palette entry dropped on the canvas, centered on `at`. */
  add(key: string, at: Point): void;
  /**
   * A right-click (or long press): `client` is where to show a menu, `at` the
   * diagram point.
   */
  menu(target: MenuTarget, client: Point, at: Point): void;
};

/** Two presses on a block closer together than this are a double-click. */
const DOUBLE_CLICK_MS = 450;

/** Data type the palette puts on drag-and-drop transfers. */
export const BLOCK_DRAG_TYPE = 'application/x-signal-lab-block';

type View = {
  readonly x: number;
  readonly y: number;
  /** Screen pixels per diagram unit. */
  readonly scale: number;
};

type Drag =
  | {
      readonly kind: 'pan';
      readonly origin: Point;
      readonly view: View;
      moved: boolean;
    }
  | {
      readonly kind: 'pinch';
      readonly scale: number;
      readonly distance: number;
      readonly anchor: Point;
    }
  | {
      readonly kind: 'move';
      readonly ids: ReadonlySet<string>;
      readonly origin: Point;
      readonly base: Diagram;
      readonly only: string | undefined;
      moved: boolean;
    }
  | {
      readonly kind: 'marquee';
      readonly origin: Point;
      pointer: Point;
      readonly keep: readonly string[];
    }
  | {
      readonly kind: 'wire';
      readonly from: PortRef;
      readonly base: Diagram;
      readonly detached: boolean;
      pointer: Point;
      target: PortRef | undefined;
    };

const UNKNOWN: BlockLayout = {
  width: 144,
  height: 56,
  inputs: [],
  outputs: [],
};

function layoutFor(block: LabBlock): BlockLayout {
  const type = typeOf(block);
  return type ? layoutOf(type) : UNKNOWN;
}

function place(
  block: LabBlock,
  direction: 'in' | 'out',
  port: number,
): PortPlace | undefined {
  const layout = layoutFor(block);
  const local = (direction === 'in' ? layout.inputs : layout.outputs)[port];
  return (
    local && { x: block.x + local.x, y: block.y + local.y, side: local.side }
  );
}

const classes = (...names: (string | false | undefined)[]) =>
  names.filter(Boolean).join(' ');

/**
 * What a block's readings say, in a line: the ones its type picks for a
 * glance, or else the first.
 */
function readingSummary(
  readings: readonly Reading[],
  glance: BlockType['glance'],
): string | undefined {
  const picked = glance
    ? glance.labels.flatMap((label) =>
        readings.filter((reading) => reading.label === label),
      )
    : [];
  if (picked.length && glance?.together) {
    return picked.map((reading) => formatReading(reading)).join(' · ');
  }

  const [first] = picked.length ? picked : readings;
  if (!first) {
    return undefined;
  }

  return typeof first.value === 'string'
    ? formatReading(first)
    : `${first.label} ${formatReading(first)}`;
}

/** An instrument's place on the diagram, kept between redraws. */
type InstrumentNode = {
  readonly group: SVGGElement;
  readonly body: SVGRectElement;
  readonly face: SVGForeignObjectElement;
  readonly ports: SVGGElement;
};

export class DiagramEditor {
  readonly element: SVGSVGElement;
  readonly #events: EditorEvents;
  readonly #grid: SVGRectElement;
  readonly #leads: SVGGElement;
  readonly #wires: SVGGElement;
  readonly #blocks: SVGGElement;
  /** Inside a subsystem, what its terminals are wired to outside. */
  readonly #outside: SVGGElement;
  readonly #instruments: SVGGElement;
  readonly #overlay: SVGGElement;
  /** Instrument nodes by full id. */
  readonly #nodes = new Map<string, InstrumentNode>();
  /**
   * Summaries of blocks that report readings, by full block id, with what each
   * says without any.
   */
  readonly #reporting = new Map<
    string,
    {
      readonly text: SVGTextElement;
      readonly settings: string;
      readonly glance: BlockType['glance'];
    }
  >();
  #model: EditorModel | undefined;
  #view: View = { x: -40, y: -40, scale: 1 };
  #drag: Drag | undefined;
  /** Pointers currently down, in client coordinates; two of them make a pinch. */
  readonly #pointers = new Map<number, Point>();
  /**
   * The last press on a block. Double-clicks are spotted from two presses
   * rather than the browser's dblclick event, which never fires here: the
   * first press selects the block, and redrawing replaces the element under
   * the pointer before the second.
   */
  #lastPress:
    | { readonly id: string; readonly time: number; readonly at: Point }
    | undefined;

  constructor(host: HTMLElement, events: EditorEvents) {
    this.#events = events;
    this.#grid = svg('rect', { class: 'grid', fill: 'url(#grid-dots)' });
    this.#leads = svg('g', { class: 'leads' });
    this.#wires = svg('g', { class: 'wires' });
    this.#blocks = svg('g', { class: 'blocks' });
    this.#outside = svg('g', { class: 'outside' });
    this.#instruments = svg('g', { class: 'instruments' });
    this.#overlay = svg('g', { class: 'overlay' });
    this.element = svg(
      'svg',
      {
        class: 'diagram',
        role: 'application',
        'aria-label': 'Block diagram',
        tabindex: 0,
      },
      svg(
        'defs',
        {},
        svg(
          'pattern',
          {
            id: 'grid-dots',
            width: 24,
            height: 24,
            patternUnits: 'userSpaceOnUse',
          },
          svg('circle', { cx: 0.5, cy: 0.5, r: 1, class: 'grid-dot' }),
        ),
        svg(
          'marker',
          {
            id: 'arrow',
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 6,
            markerHeight: 6,
            orient: 'auto-start-reverse',
          },
          svg('path', { d: 'M0,1 L9,5 L0,9 z', fill: 'context-stroke' }),
        ),
      ),
      this.#grid,
      this.#leads,
      this.#wires,
      this.#blocks,
      this.#outside,
      this.#instruments,
      this.#overlay,
    );
    host.append(this.element);

    this.element.addEventListener('pointerdown', (event) =>
      this.#pointerDown(event),
    );
    this.element.addEventListener('pointermove', (event) =>
      this.#pointerMove(event),
    );
    this.element.addEventListener('pointerup', (event) =>
      this.#pointerUp(event),
    );
    this.element.addEventListener('pointercancel', (event) => {
      this.#pointers.delete(event.pointerId);
      this.#cancelDrag();
    });
    this.element.addEventListener('contextmenu', (event) =>
      this.#contextMenu(event),
    );
    this.element.addEventListener('wheel', (event) => this.#wheel(event), {
      passive: false,
    });
    this.element.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes(BLOCK_DRAG_TYPE)) {
        event.preventDefault();
      }
    });
    this.element.addEventListener('drop', (event) => {
      const key = event.dataTransfer?.getData(BLOCK_DRAG_TYPE);
      if (!key) {
        return;
      }

      event.preventDefault();
      this.#events.add(key, this.#toDiagram(event.clientX, event.clientY));
    });
    new ResizeObserver(() => this.#applyView()).observe(this.element);
  }

  render(model: EditorModel): void {
    this.#model = model;
    const { diagram, path, selection } = model;
    const blocks = new Map(diagram.blocks.map((block) => [block.id, block]));
    this.#wires.replaceChildren(
      ...diagram.wires.flatMap((wire) => {
        const from = blocks.get(wire.from.block);
        const to = blocks.get(wire.to.block);
        const start = from && place(from, 'out', wire.from.port);
        const end = to && place(to, 'in', wire.to.port);
        if (!start || !end) {
          return [];
        }

        const d = roundedPath(route(start, end));
        const rate = rateLabel(
          model.status.get(pathId(path, wire.from.block)),
          wire.from.port,
        );
        const selected = selection.kind === 'wire' && selection.id === wire.id;
        return [
          svg(
            'g',
            {
              class: classes(
                'wire',
                selected && 'selected',
                isInstrument(to.kind) && 'to-instrument',
              ),
              'data-wire': wire.id,
            },
            svg('path', { class: 'wire-hit', d }),
            svg('path', {
              class: 'wire-line',
              d,
              'marker-end': 'url(#arrow)',
            }),
            rate === undefined
              ? null
              : svg('title', {}, `${rate} sample rate`),
          ),
        ];
      }),
    );
    const terminalNumbers = new Map<string, string>();
    const { inputs, outputs } = terminals(diagram);
    inputs.forEach((t, i) => terminalNumbers.set(t.id, `in ${i + 1}`));
    outputs.forEach((t, i) => terminalNumbers.set(t.id, `out ${i + 1}`));
    this.#reporting.clear();
    this.#blocks.replaceChildren(
      ...diagram.blocks
        .filter((block) => !isInstrument(block.kind))
        .map((block) =>
          this.#drawBlock(block, model, terminalNumbers.get(block.id)),
        ),
    );
    this.#outside.replaceChildren(
      ...(path.length
        ? diagram.blocks
            .filter(isTerminal)
            .map((block) =>
              this.#drawOutside(block, wiredOutside(model.doc, path, block)),
            )
        : []),
      ...[
        ...Map.groupBy(reachingIn(model.doc, path), (reach) => reach.block),
      ].flatMap(([id, reaches]) => {
        const block = blocks.get(id);
        return block ? [this.#drawReaches(block, reaches)] : [];
      }),
    );
    this.#drawInstruments(model);
    this.#drawOverlay();
  }

  /** Shows the readings at the playhead on the blocks that report them. */
  setReadings(readings: ReadonlyMap<string, readonly Reading[]>): void {
    for (const [id, { text, settings, glance }] of this.#reporting) {
      const summary =
        readingSummary(readings.get(id) ?? [], glance) ?? settings;
      if (text.textContent !== summary) {
        text.textContent = summary;
      }
    }
  }

  /**
   * Instruments, each a frame holding its widget, plus dashed leads to what
   * they set or read. The nodes persist, so a widget being used stays put.
   */
  #drawInstruments(model: EditorModel): void {
    const { diagram, path, selection } = model;
    const selected = selectedBlocks(selection);
    const blocks = new Map(diagram.blocks.map((block) => [block.id, block]));
    const center = (block: LabBlock) => {
      const { width, height } = layoutFor(block);
      return { x: block.x + width / 2, y: block.y + height / 2 };
    };

    const live = new Set<string>();
    const leads: SVGElement[] = [];
    for (const block of diagram.blocks) {
      if (!isInstrument(block.kind)) {
        continue;
      }

      const id = pathId(path, block.id);
      live.add(id);
      const node = this.#node(id);
      const layout = layoutFor(block);
      node.group.dataset.block = block.id;
      node.group.setAttribute('transform', `translate(${block.x},${block.y})`);
      node.group.setAttribute(
        'class',
        classes(
          'block',
          'instrument',
          `instrument-${block.kind}`,
          selected.includes(block.id) && 'selected',
        ),
      );

      for (const element of [node.body, node.face]) {
        element.setAttribute('width', String(layout.width));
        element.setAttribute('height', String(layout.height));
      }

      const widget = model.widgets.get('diagram', { id, path, block });
      if (node.face.firstChild !== widget) {
        node.face.replaceChildren(widget);
      }

      node.ports.replaceChildren(...this.#instrumentPorts(block, layout));

      const from = center(block);
      for (const target of instrumentLeads(diagram, block)) {
        const other = blocks.get(target);
        if (other) {
          const to = center(other);
          leads.push(
            svg('line', {
              class: classes(
                'lead',
                (selected.includes(block.id) || selected.includes(target)) &&
                  'selected',
              ),
              x1: from.x,
              y1: from.y,
              x2: to.x,
              y2: to.y,
            }),
          );
        }
      }
    }

    for (const [id, node] of this.#nodes) {
      if (!live.has(id)) {
        node.group.remove();
        this.#nodes.delete(id);
      }
    }

    this.#leads.replaceChildren(...leads);
  }

  #node(id: string): InstrumentNode {
    let node = this.#nodes.get(id);
    if (!node) {
      const body = svg('rect', { class: 'body', rx: 8 });
      const face = svg('foreignObject', { class: 'instrument-face' });
      const ports = svg('g', { class: 'ports' });
      const group = svg('g', {}, body, face, ports);
      node = { group, body, face, ports };
      this.#nodes.set(id, node);
      this.#instruments.append(group);
    }

    return node;
  }

  /** Input ports drawn on a block, with their hit areas and names. */
  /** An instrument's ports: inputs for what it shows, an output for a Button. */
  #instrumentPorts(block: LabBlock, layout: BlockLayout): SVGElement[] {
    const type = typeOf(block);
    const port = (
      side: 'in' | 'out',
      i: number,
      name: string,
      at: { readonly x: number; readonly y: number },
    ) => {
      const target =
        side === 'in' &&
        this.#drag?.kind === 'wire' &&
        this.#drag.target &&
        sameRef(this.#drag.target, { block: block.id, port: i });
      return [
        svg('circle', {
          class: classes('port', side, target && 'target'),
          cx: at.x,
          cy: at.y,
          r: 4.5,
        }),
        svg(
          'circle',
          {
            class: 'port-hit',
            cx: at.x,
            cy: at.y,
            r: 11,
            'data-port': `${side}:${i}`,
          },
          svg('title', {}, `${side === 'in' ? 'input' : 'output'} ${name}`),
        ),
      ];
    };

    return [
      ...(type?.inputs ?? []).flatMap((spec, i) => {
        const at = layout.inputs[i];
        return at ? port('in', i, spec.name, at) : [];
      }),
      ...(type?.outputs ?? []).flatMap((spec, i) => {
        const at = layout.outputs[i];
        return at ? port('out', i, spec.name, at) : [];
      }),
    ];
  }

  /** Zooms and pans so the whole diagram fits. */
  fit(): void {
    const blocks = this.#model?.diagram.blocks ?? [];
    const { width, height } = this.element.getBoundingClientRect();
    if (!width || !height) {
      return;
    }

    if (!blocks.length) {
      this.#view = { x: -40, y: -40, scale: 1 };
    } else {
      let [left, top, right, bottom] = [
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
      ];
      for (const block of blocks) {
        const layout = layoutFor(block);
        left = Math.min(left, block.x);
        top = Math.min(top, block.y - 24);
        right = Math.max(right, block.x + layout.width);
        bottom = Math.max(bottom, block.y + layout.height + 32);
      }

      if (this.#outside.childElementCount) {
        const box = this.#outside.getBBox();
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width);
        bottom = Math.max(bottom, box.y + box.height);
      }

      const margin = 56;
      const scale = Math.min(
        width / (right - left + 2 * margin),
        height / (bottom - top + 2 * margin),
        1.25,
      );
      this.#view = {
        x: (left + right) / 2 - width / scale / 2,
        y: (top + bottom) / 2 - height / scale / 2,
        scale,
      };
    }

    this.#applyView();
  }

  /** The diagram point at the middle of the visible area, where new blocks go. */
  center(): Point {
    const { width, height } = this.element.getBoundingClientRect();
    return {
      x: this.#view.x + width / this.#view.scale / 2,
      y: this.#view.y + height / this.#view.scale / 2,
    };
  }

  /**
   * A dashed lead off a terminal's outer side, to or from what it is wired to
   * outside, each named and a click away.
   */
  #drawOutside(block: LabBlock, ends: readonly Outside[]): SVGGElement {
    const { width, height } = layoutFor(block);
    const input = block.kind === INPUT_TERMINAL;
    const y = block.y + height / 2;
    const edge = input ? block.x - 4 : block.x + width + 4;
    const far = input ? edge - 28 : edge + 28;
    const x = input ? far - 6 : far + 6;
    const anchor = input ? 'anchor-end' : 'anchor-start';
    const shown = ends.length > 3 ? ends.slice(0, 2) : ends;
    const line = (i: number, count: number) =>
      y + 1 + (i - (count - 1) / 2) * 15;
    const count = shown.length + (shown.length < ends.length ? 1 : 0);
    return svg(
      'g',
      { class: classes('outside-end', !ends.length && 'unwired') },
      svg('path', {
        class: 'outside-lead',
        d: input ? `M${far},${y} H${edge}` : `M${edge},${y} H${far}`,
        'marker-end': 'url(#arrow)',
      }),
      ...(ends.length
        ? shown.map((end, i) =>
            svg(
              'text',
              {
                class: `outside-label ${anchor}`,
                x,
                y: line(i, count),
                'data-outside': end.id,
              },
              svg('tspan', { class: 'outside-word' }, input ? 'from ' : 'to '),
              end.label,
              svg(
                'title',
                {},
                `${input ? 'From' : 'To'} ${end.label}, outside this subsystem. Click to go there.`,
              ),
            ),
          )
        : [
            svg(
              'text',
              { class: `outside-label ${anchor}`, x, y: y + 1 },
              'not wired outside',
            ),
          ]),
      shown.length < ends.length
        ? svg(
            'text',
            {
              class: `outside-label more ${anchor}`,
              x,
              y: line(shown.length, count),
            },
            `and ${ends.length - shown.length} more`,
          )
        : null,
    );
  }

  /**
   * A dotted lead up from a block to the instruments outside that set or read
   * it, each named and a click away.
   */
  #drawReaches(block: LabBlock, reaches: readonly Reach[]): SVGGElement {
    const { width } = layoutFor(block);
    const shape = typeOf(block)?.shape?.kind;
    // Clear of a name drawn above the block.
    const named = block.name && (shape === 'circle' || shape === 'triangle');
    const x = block.x + width / 2;
    const top = block.y - (named ? 22 : 4);
    const lines = [
      ['set by ', reaches.filter((r) => r.sets)],
      ['read by ', reaches.filter((r) => !r.sets)],
    ] as const;
    return svg(
      'g',
      { class: 'reaches' },
      svg('path', { class: 'lead', d: `M${x},${top} V${top - 14}` }),
      ...lines
        .filter(([, list]) => list.length)
        .map(([word, list], i) =>
          svg(
            'text',
            { class: 'outside-label reach', x, y: top - 23 - 15 * i },
            svg('tspan', { class: 'outside-word' }, word),
            ...list.flatMap((reach, k) => [
              k ? ', ' : '',
              svg(
                'tspan',
                { class: 'outside-name', 'data-outside': reach.id },
                reach.label,
              ),
            ]),
            svg(
              'title',
              {},
              `${list.map((r) => r.label).join(', ')}, on the panel outside this subsystem. Click a name to go to it.`,
            ),
          ),
        ),
    );
  }

  #drawBlock(
    block: LabBlock,
    model: EditorModel,
    terminalNumber: string | undefined,
  ): SVGGElement {
    const type = typeOf(block);
    const id = pathId(model.path, block.id);
    const status = model.status.get(id);
    const selected = selectedBlocks(model.selection).includes(block.id);
    const state = status?.state ?? 'idle';
    const transform = `translate(${block.x},${block.y})`;
    if (!type) {
      return svg(
        'g',
        {
          class: classes('block', 'error', selected && 'selected'),
          'data-block': block.id,
          transform,
        },
        svg('rect', { class: 'body', width: 144, height: 56, rx: 8 }),
        svg(
          'text',
          { class: 'title', x: 72, y: 28 },
          `Unknown: ${block.kind}`,
        ),
      );
    }

    const layout = layoutOf(type);
    const { width: w, height: h } = layout;
    const shape = type.shape ?? { kind: 'box' };
    const subsystem = isSubsystem(block);
    // A block that reports readings shows what they say at the playhead where
    // others show their settings.
    const settings = subsystem
      ? `${block.inner.blocks.length} blocks inside`
      : (type.summary?.(
          resolveParams(type.params, {
            ...block.params,
            ...model.bound.get(id),
          }),
        ) ?? '');
    const summary =
      (!subsystem &&
        readingSummary(model.readings.get(id) ?? [], type.glance)) ||
      settings;
    const group = svg('g', {
      class: classes(
        'block',
        `shape-${subsystem ? 'subsystem' : shape.kind}`,
        selected && 'selected',
        state !== 'ok' && state,
      ),
      'data-block': block.id,
      transform,
    });

    switch (shape.kind) {
      case 'circle': {
        group.append(
          svg('circle', { class: 'body', cx: w / 2, cy: h / 2, r: w / 2 - 1 }),
          svg(
            'text',
            { class: 'symbol', x: w / 2, y: h / 2 + 1 },
            shape.symbol,
          ),
        );

        if (block.name) {
          // Centered above, unless a top input claims that spot; then up and to the right.
          const topInput = visiblePorts(type.inputs).some(
            ({ port }) => port.side === 'top',
          );
          group.append(
            topInput
              ? svg(
                  'text',
                  { class: 'label anchor-start', x: w + 2, y: -2 },
                  block.name,
                )
              : svg('text', { class: 'label', x: w / 2, y: -10 }, block.name),
          );
        }

        if (summary) {
          group.append(
            svg('text', { class: 'summary', x: w / 2, y: h + 16 }, summary),
          );
        }

        break;
      }

      case 'triangle':
        group.append(
          svg('path', {
            class: 'body',
            d: `M1,1 L${w - 1},${h / 2} L1,${h - 1} Z`,
          }),
          svg(
            'text',
            { class: 'summary inside', x: w * 0.36, y: h / 2 + 1 },
            summary,
          ),
        );

        if (block.name) {
          group.append(
            svg('text', { class: 'label', x: w / 2, y: -8 }, block.name),
          );
        }

        break;

      case 'antenna': {
        // Waves going out on the right if it radiates, coming in on the left if it hears.
        const transmit = model.diagram.wires.some(
          (wire) => wire.to.block === block.id,
        );
        const receive = model.diagram.wires.some(
          (wire) => wire.from.block === block.id,
        );
        const foot = 56;
        group.append(
          // A hit area, since the antenna itself is just lines.
          svg('rect', { class: 'hit', x: 0, y: 0, width: w, height: h }),
          svg('path', {
            class: 'antenna',
            d: `M${w / 2},${foot} V16 M10,2 L${w / 2},16 L${w - 10},2 M0,${foot} H${w}`,
          }),
          svg('path', {
            class: 'waves',
            d: [
              transmit || !receive
                ? `M${w - 6},8 a10,10 0 0 1 0,14 M${w - 1},4 a16,16 0 0 1 0,22`
                : '',
              receive || !transmit
                ? `M6,8 a10,10 0 0 0 0,14 M1,4 a16,16 0 0 0 0,22`
                : '',
            ].join(' '),
          }),
          svg(
            'text',
            { class: 'label', x: w / 2, y: h + 14 },
            block.name ||
              (transmit && !receive
                ? 'Transmit'
                : receive && !transmit
                  ? 'Receive'
                  : 'Antenna'),
          ),
        );

        // The summary is its band noise, which only matters if it hears.
        if (summary && receive) {
          group.append(
            svg('text', { class: 'summary', x: w / 2, y: h + 28 }, summary),
          );
        }

        break;
      }

      case 'terminal':
        group.append(
          svg('rect', { class: 'body', width: w, height: h, rx: h / 2 }),
          svg(
            'text',
            { class: 'title', x: w / 2, y: h / 2 + 1 },
            block.name || terminalNumber || type.label,
          ),
        );
        break;

      default:
        if (subsystem) {
          group.append(
            svg('rect', {
              class: 'body stack',
              x: 5,
              y: 5,
              width: w,
              height: h,
              rx: 8,
            }),
          );
        }

        // With its ports named along its sides, the summary goes below,
        // where a long one has room.
        const below =
          visiblePorts(type.inputs).length > 1 ||
          visiblePorts(type.outputs).length > 1;
        const inside = summary && !below;
        group.append(
          svg('rect', { class: 'body', width: w, height: h, rx: 8 }),
          svg(
            'text',
            { class: 'title', x: w / 2, y: inside ? h / 2 - 8 : h / 2 + 1 },
            block.name || type.label,
          ),
        );

        if (summary) {
          group.append(
            svg(
              'text',
              {
                class: 'summary',
                x: w / 2,
                y: below ? h + 14 : h / 2 + 11,
              },
              summary,
            ),
          );
        }
    }

    const named = (ports: BlockType['inputs']) =>
      shape.kind === 'box' && visiblePorts(ports).length > 1;
    type.inputs.forEach((port, i) => {
      const p = layout.inputs[i];
      if (!p) {
        return;
      }

      const target =
        this.#drag?.kind === 'wire' &&
        this.#drag.target &&
        sameRef(this.#drag.target, { block: block.id, port: i });
      group.append(
        svg('circle', {
          class: classes('port', 'in', target && 'target'),
          cx: p.x,
          cy: p.y,
          r: 4.5,
        }),
        svg(
          'circle',
          {
            class: 'port-hit',
            cx: p.x,
            cy: p.y,
            r: 11,
            'data-port': `in:${i}`,
          },
          svg('title', {}, `input ${port.name}`),
        ),
      );

      if (named(type.inputs) && p.side === 'left') {
        group.append(
          svg(
            'text',
            {
              class: 'port-name anchor-start',
              x: p.x + 12,
              y: p.y + 1,
            },
            port.name,
          ),
        );
      }
    });
    type.outputs.forEach((port, i) => {
      const p = layout.outputs[i];
      if (!p) {
        return;
      }

      group.append(
        svg('circle', {
          class: classes('port', 'out'),
          cx: p.x,
          cy: p.y,
          r: 4.5,
        }),
        svg(
          'circle',
          {
            class: 'port-hit',
            cx: p.x,
            cy: p.y,
            r: 11,
            'data-port': `out:${i}`,
          },
          svg('title', {}, `output ${port.name}`),
        ),
      );

      if (named(type.outputs)) {
        group.append(
          svg(
            'text',
            {
              class: 'port-name anchor-end',
              x: p.x - 12,
              y: p.y + 1,
            },
            port.name,
          ),
        );
      }
    });

    if (status?.state === 'error') {
      group.append(
        svg(
          'g',
          { class: 'badge' },
          svg('circle', { cx: w - 4, cy: 4, r: 8 }),
          svg('text', { x: w - 4, y: 5 }, '!'),
          svg('title', {}, status.message),
        ),
      );
    } else if (status?.state === 'idle') {
      group.append(svg('title', {}, status.reason));
    }

    const text = group.querySelector<SVGTextElement>('text.summary');
    if (text && !subsystem && type.reports?.length) {
      this.#reporting.set(id, { text, settings, glance: type.glance });
    }

    return group;
  }

  #drawOverlay(): void {
    const drag = this.#drag;
    const diagram = this.#model?.diagram;
    if (drag?.kind === 'marquee') {
      const { x, y, width, height } = rectangle(drag.origin, drag.pointer);
      this.#overlay.replaceChildren(
        svg('rect', { class: 'marquee', x, y, width, height }),
      );
      return;
    }

    if (drag?.kind !== 'wire' || !diagram) {
      this.#overlay.replaceChildren();
      return;
    }

    const source = diagram.blocks.find((b) => b.id === drag.from.block);
    const start = source && place(source, 'out', drag.from.port);
    if (!start) {
      return;
    }

    const targetBlock =
      drag.target && diagram.blocks.find((b) => b.id === drag.target!.block);
    const end = (targetBlock &&
      drag.target &&
      place(targetBlock, 'in', drag.target.port)) || {
      ...drag.pointer,
      side: 'left' as const,
    };
    this.#overlay.replaceChildren(
      svg('path', {
        class: 'wire-line dragging',
        d: roundedPath(route(start, end)),
      }),
    );
  }

  #toDiagram(clientX: number, clientY: number): Point {
    const rect = this.element.getBoundingClientRect();
    return {
      x: this.#view.x + (clientX - rect.left) / this.#view.scale,
      y: this.#view.y + (clientY - rect.top) / this.#view.scale,
    };
  }

  #applyView(): void {
    const { width, height } = this.element.getBoundingClientRect();
    const { x, y, scale } = this.#view;
    const box = { x, y, width: width / scale, height: height / scale };
    this.element.setAttribute(
      'viewBox',
      `${box.x} ${box.y} ${box.width} ${box.height}`,
    );

    for (const [name, value] of Object.entries(box)) {
      this.#grid.setAttribute(name, String(value));
    }
  }

  #inputUnder(clientX: number, clientY: number): PortRef | undefined {
    const hit = document
      .elementFromPoint(clientX, clientY)
      ?.closest<SVGElement>("[data-port^='in:']");
    const block = hit?.closest<SVGElement>('[data-block]')?.dataset.block;
    return hit && block
      ? { block, port: Number(hit.dataset.port!.slice(3)) }
      : undefined;
  }

  #pinchState(): { middle: Point; distance: number } {
    const [a, b] = [...this.#pointers.values()];
    return {
      middle: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
      distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
    };
  }

  #pointerDown(event: PointerEvent): void {
    const model = this.#model;
    if (!model || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }

    this.#pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (this.#pointers.size === 2) {
      // A second finger turns whatever the first one started into a pinch.
      this.#cancelDrag();
      const { middle, distance } = this.#pinchState();
      this.#drag = {
        kind: 'pinch',
        scale: this.#view.scale,
        distance,
        anchor: this.#toDiagram(middle.x, middle.y),
      };
      this.element.setPointerCapture(event.pointerId);
      return;
    }

    const target = event.target as Element;
    if (target.closest('input, select, textarea, button, [data-live]')) {
      this.#pointers.delete(event.pointerId);
      return;
    }

    const outside = target.closest<SVGElement>('[data-outside]');
    if (outside) {
      this.#pointers.delete(event.pointerId);
      this.#events.reveal(outside.dataset.outside!);
      return;
    }

    this.element.focus({ preventScroll: true });
    const port = target.closest<SVGElement>('[data-port]');
    const blockId = target.closest<SVGElement>('[data-block]')?.dataset.block;
    const wireId = target.closest<SVGElement>('[data-wire]')?.dataset.wire;
    const pointer = this.#toDiagram(event.clientX, event.clientY);
    const selected = selectedBlocks(model.selection);

    if (port && blockId) {
      const [direction, index] = port.dataset.port!.split(':');
      const ref = { block: blockId, port: Number(index) };
      if (direction === 'out') {
        this.#drag = {
          kind: 'wire',
          from: ref,
          base: model.diagram,
          detached: false,
          pointer,
          target: undefined,
        };
      } else {
        // Grabbing a connected input picks up the wire's loose end.
        const wire = wireInto(model.diagram, ref);
        if (!wire) {
          return;
        }

        const base = removeWire(model.diagram, wire.id);
        this.#drag = {
          kind: 'wire',
          from: wire.from,
          base,
          detached: true,
          pointer,
          target: ref,
        };
        this.#events.change(base, 'preview');
      }
    } else if (blockId) {
      const press = {
        id: blockId,
        time: event.timeStamp,
        at: { x: event.clientX, y: event.clientY },
      };
      const last = this.#lastPress;
      this.#lastPress = press;
      const twice =
        last?.id === blockId &&
        press.time - last.time < DOUBLE_CLICK_MS &&
        Math.hypot(press.at.x - last.at.x, press.at.y - last.at.y) < 6;
      const block = model.diagram.blocks.find((b) => b.id === blockId);
      if (twice && !event.shiftKey && block && isSubsystem(block)) {
        this.#lastPress = undefined;
        this.#events.open(blockId);
        return;
      }

      let ids: readonly string[];
      if (event.shiftKey) {
        ids = selected.includes(blockId)
          ? selected.filter((id) => id !== blockId)
          : [...selected, blockId];
      } else {
        ids = selected.includes(blockId) ? selected : [blockId];
      }

      this.#events.select(selectBlocks(ids));

      if (!ids.includes(blockId)) {
        return;
      }

      // A plain click on one block of a larger selection narrows it to that block, unless it turns into a drag.
      const only = !event.shiftKey && ids.length > 1 ? blockId : undefined;
      this.#drag = {
        kind: 'move',
        ids: new Set(ids),
        origin: pointer,
        base: model.diagram,
        only,
        moved: false,
      };
    } else if (wireId) {
      this.#events.select({ kind: 'wire', id: wireId });
      return;
    } else if (event.shiftKey) {
      this.#drag = {
        kind: 'marquee',
        origin: pointer,
        pointer,
        keep: selected,
      };
    } else {
      this.#drag = {
        kind: 'pan',
        origin: { x: event.clientX, y: event.clientY },
        view: this.#view,
        moved: false,
      };
    }

    this.element.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #contextMenu(event: MouseEvent): void {
    const model = this.#model;
    if (!model) {
      return;
    }

    event.preventDefault();
    this.#cancelDrag();
    const target = event.target as Element;
    const port = target.closest<SVGElement>('[data-port]');
    const blockId = target.closest<SVGElement>('[data-block]')?.dataset.block;
    const wireId = target.closest<SVGElement>('[data-wire]')?.dataset.wire;
    let hit: MenuTarget = { kind: 'canvas' };
    if (port && blockId) {
      const [direction, index] = port.dataset.port!.split(':');
      hit = {
        kind: 'port',
        direction: direction === 'in' ? 'in' : 'out',
        ref: { block: blockId, port: Number(index) },
      };
    } else if (blockId) {
      // Right-clicking outside the selection selects what was clicked, as in most editors.
      const selected = selectedBlocks(model.selection);
      const ids = selected.includes(blockId) ? selected : [blockId];
      if (ids !== selected) {
        this.#events.select(selectBlocks(ids));
      }

      hit = { kind: 'blocks', ids };
    } else if (wireId) {
      this.#events.select({ kind: 'wire', id: wireId });
      hit = { kind: 'wire', id: wireId };
    }

    this.#events.menu(
      hit,
      { x: event.clientX, y: event.clientY },
      this.#toDiagram(event.clientX, event.clientY),
    );
  }

  #pointerMove(event: PointerEvent): void {
    if (this.#pointers.has(event.pointerId)) {
      this.#pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    }

    const drag = this.#drag;
    const model = this.#model;
    if (!drag || !model) {
      return;
    }

    switch (drag.kind) {
      case 'pinch': {
        if (this.#pointers.size < 2) {
          break;
        }

        const { middle, distance } = this.#pinchState();
        const scale = Math.min(
          3,
          Math.max(0.2, (drag.scale * distance) / drag.distance),
        );
        const rect = this.element.getBoundingClientRect();
        // Keep the diagram point that started under the fingers under them.
        this.#view = {
          x: drag.anchor.x - (middle.x - rect.left) / scale,
          y: drag.anchor.y - (middle.y - rect.top) / scale,
          scale,
        };
        this.#applyView();
        break;
      }

      case 'pan': {
        const dx = event.clientX - drag.origin.x;
        const dy = event.clientY - drag.origin.y;
        drag.moved ||= Math.hypot(dx, dy) > 3;
        this.#view = {
          ...drag.view,
          x: drag.view.x - dx / drag.view.scale,
          y: drag.view.y - dy / drag.view.scale,
        };
        this.#applyView();
        break;
      }

      case 'move': {
        const pointer = this.#toDiagram(event.clientX, event.clientY);
        const dx = snap(pointer.x - drag.origin.x);
        const dy = snap(pointer.y - drag.origin.y);
        if (dx || dy || drag.moved) {
          drag.moved = true;
          this.#events.change(
            moveBlocks(drag.base, drag.ids, dx, dy),
            'preview',
          );
        }

        break;
      }

      case 'marquee': {
        drag.pointer = this.#toDiagram(event.clientX, event.clientY);
        const box = rectangle(drag.origin, drag.pointer);
        const inside = model.diagram.blocks
          .filter((block) => {
            const { width, height } = layoutFor(block);
            return (
              block.x < box.x + box.width &&
              block.x + width > box.x &&
              block.y < box.y + box.height &&
              block.y + height > box.y
            );
          })
          .map((block) => block.id);
        this.#events.select(
          selectBlocks([...new Set([...drag.keep, ...inside])]),
        );
        break;
      }

      case 'wire':
        drag.pointer = this.#toDiagram(event.clientX, event.clientY);
        drag.target = this.#inputUnder(event.clientX, event.clientY);
        this.render(model);
        break;
    }
  }

  #pointerUp(event: PointerEvent): void {
    this.#pointers.delete(event.pointerId);
    const drag = this.#drag;
    const model = this.#model;
    this.#drag = undefined;

    if (!drag || !model) {
      return;
    }

    switch (drag.kind) {
      case 'pinch':
        break;
      case 'pan':
        if (!drag.moved) {
          this.#events.select(NOTHING);
        }

        break;
      case 'move':
        if (drag.moved) {
          this.#events.change(model.diagram, 'commit');
        } else if (drag.only) {
          this.#events.select(selectBlocks([drag.only]));
        }

        break;
      case 'marquee':
        this.render(model);
        break;

      case 'wire': {
        const target = this.#inputUnder(event.clientX, event.clientY);
        if (target && target.block !== drag.from.block) {
          this.#events.change(connect(drag.base, drag.from, target), 'commit');
        } else if (drag.detached) {
          this.#events.change(drag.base, 'commit');
        } else {
          this.render(model);
        }

        break;
      }
    }
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;

    if (drag?.kind === 'move' && drag.moved && this.#model) {
      this.#events.change(this.#model.diagram, 'commit');
    }

    if (drag?.kind === 'wire' && drag.detached) {
      this.#events.change(drag.base, 'commit');
    }

    if (this.#model) {
      this.render(this.#model);
    }
  }

  #wheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y, scale } = this.#view;
    const pinch = event.ctrlKey || event.metaKey;
    const notches = pinch ? undefined : wheelNotches(event);
    if ((pinch || notches !== undefined) && !event.shiftKey) {
      // A mouse wheel zooms 15% a notch around the pointer; a pinch (or
      // ctrl+wheel) sends small steps and zooms smoothly.
      const pointer = this.#toDiagram(event.clientX, event.clientY);
      const factor =
        notches === undefined
          ? Math.exp(-event.deltaY * 0.01)
          : 1.15 ** -notches;
      const next = Math.min(3, Math.max(0.2, scale * factor));
      this.#view = {
        x: pointer.x - ((pointer.x - x) * scale) / next,
        y: pointer.y - ((pointer.y - y) * scale) / next,
        scale: next,
      };
    } else {
      // Two fingers on a trackpad, or shift+wheel, pans.
      const sideways = event.shiftKey && !event.deltaX;
      this.#view = {
        x: x + (sideways ? event.deltaY : event.deltaX) / scale,
        y: y + (sideways ? 0 : event.deltaY) / scale,
        scale,
      };
    }

    this.#applyView();
  }
}

/**
 * How many notches a mouse wheel turned, down being positive, or undefined if
 * the event comes from two fingers on a trackpad. Firefox counts a wheel in
 * lines, three a notch. Chrome and Safari also give the old wheelDeltaY: 120 a
 * notch from a wheel, and exactly -3 deltaY from a trackpad. Failing both, a
 * wheel moves straight up or down by whole steps of 50 pixels or more.
 */
function wheelNotches(event: WheelEvent): number | undefined {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY / 3;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY;
  }

  const legacy = (event as WheelEvent & { readonly wheelDeltaY?: number })
    .wheelDeltaY;
  if (legacy) {
    return legacy % 120 === 0 && legacy !== -3 * event.deltaY
      ? -legacy / 120
      : undefined;
  }

  return event.deltaX === 0 &&
    Number.isInteger(event.deltaY) &&
    Math.abs(event.deltaY) >= 50
    ? event.deltaY / 100
    : undefined;
}

function rectangle(
  a: Point,
  b: Point,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
