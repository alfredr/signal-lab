// How the panel face is organized: panels, each a device of panes, each pane
// some instruments that belong together. The document keeps the panels it has
// been given; an instrument in none of them gets a pane of its own kind, or of
// the subsystem it is in, so a new plot or knob shows at once. Every edit here
// starts from the face as it shows, panes made up for the instruments
// included, so what was shown is what gets moved.

import { CONTROL, NOTE, BUTTON, READOUT } from '../blocks/instruments.ts';
import {
  blockAt,
  MOST_CELLS,
  pathId,
  type LabDocument,
  type PaneItem,
  type Panel,
} from './document.ts';
import { faceCards, type FaceItem } from './instruments.ts';
import { displayName } from './subsystems.ts';

/** An instrument on the face, and the size it was given, if any. */
type FaceEntry = PaneItem & { readonly item: FaceItem };

export type FacePane = {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly FaceEntry[];
};

export type FacePanel = {
  readonly id: string;
  readonly title: string;
  readonly panes: readonly FacePane[];
};

/** The kind of pane an instrument in none goes to, at the top level. */
function kindOf(item: FaceItem): {
  readonly key: string;
  readonly title: string;
} {
  switch (item.block.kind) {
    case CONTROL:
    case BUTTON:
      return { key: 'controls', title: 'Controls' };
    case READOUT:
      return { key: 'readouts', title: 'Readouts' };
    case NOTE:
      return { key: 'notes', title: 'Notes' };
    default:
      return { key: 'screens', title: 'Screens' };
  }
}

/** `base`, or `base` with a number after it, whichever `taken` lacks. */
function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) {
    id = `${base}${n}`;
  }

  taken.add(id);
  return id;
}

/**
 * The face as it shows: the document's panels with the instruments that are
 * still there, each once, and after them panes for the instruments in none:
 * one for each subsystem they are in, and at the top level one for each kind.
 * With no panels of its own, the document gets one to hold them.
 */
export function facePanels(doc: LabDocument): FacePanel[] {
  const cards = new Map(faceCards(doc).map((item) => [item.id, item]));
  const placed = new Set<string>();
  const taken = new Set(
    (doc.panels ?? []).flatMap((panel) => [
      panel.id,
      ...panel.panes.map((pane) => pane.id),
    ]),
  );
  const panels: FacePanel[] = (doc.panels ?? []).map((panel) => ({
    id: panel.id,
    title: panel.title,
    panes: panel.panes.map((pane) => ({
      id: pane.id,
      title: pane.title,
      entries: pane.items.flatMap((entry) => {
        const item = cards.get(entry.id);
        if (!item || placed.has(entry.id)) {
          return [];
        }

        placed.add(entry.id);
        return [{ ...entry, item }];
      }),
    })),
  }));

  // The rest, by subsystem or by kind, in the order they come in.
  const extra = new Map<string, { title: string; entries: FaceEntry[] }>();
  for (const item of cards.values()) {
    if (placed.has(item.id)) {
      continue;
    }

    const group = item.path.length
      ? {
          key: `in ${item.path.join('/')}`,
          title: item.path
            .map((_, depth) => {
              const block = blockAt(
                doc,
                pathId(item.path.slice(0, depth), item.path[depth]!),
              );
              return block ? displayName(block) : item.path[depth]!;
            })
            .join(' › '),
        }
      : kindOf(item);
    const pane = extra.get(group.key) ?? { title: group.title, entries: [] };
    pane.entries.push({ id: item.id, item });
    extra.set(group.key, pane);
  }

  const made = [...extra].map(([key, pane]) => ({
    id: unique(
      key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pane',
      taken,
    ),
    title: pane.title,
    entries: pane.entries,
  }));
  if (!made.length) {
    return panels;
  }

  const [first, ...rest] = panels;
  return first
    ? [{ ...first, panes: [...first.panes, ...made] }, ...rest]
    : [{ id: unique('panel', taken), title: '', panes: made }];
}

/**
 * The face as it shows, as the document would keep it. A pane of the
 * document's own keeps the instruments in it that the face leaves out for now,
 * such as a note taken off the face or a plot stacked under a view, with their
 * sizes, so arranging the rest doesn't lose them.
 */
function organized(doc: LabDocument): Panel[] {
  const own = new Map(
    (doc.panels ?? []).flatMap((p) => p.panes).map((q) => [q.id, q.items]),
  );
  const listed = new Set<string>();
  return facePanels(doc).map((panel) => ({
    id: panel.id,
    title: panel.title,
    panes: panel.panes.map((pane) => {
      const items = (
        own.get(pane.id) ?? pane.entries.map(({ item: _, ...entry }) => entry)
      ).filter((entry) => blockAt(doc, entry.id) && !listed.has(entry.id));
      for (const entry of items) {
        listed.add(entry.id);
      }

      return { id: pane.id, title: pane.title, items };
    }),
  }));
}

function withPanels(doc: LabDocument, panels: readonly Panel[]): LabDocument {
  return { ...doc, panels };
}

const ids = (panels: readonly Panel[]) =>
  new Set(panels.flatMap((p) => [p.id, ...p.panes.map((q) => q.id)]));

/**
 * Moves an instrument to `index` among the instruments the pane `to` shows,
 * counted without it; those it doesn't show keep their places.
 */
export function moveInstrument(
  doc: LabDocument,
  id: string,
  to: string,
  index: number,
): LabDocument {
  const panels = organized(doc);
  const entry = panels
    .flatMap((p) => p.panes)
    .flatMap((q) => q.items)
    .find((item) => item.id === id);
  if (!entry || !panels.some((p) => p.panes.some((q) => q.id === to))) {
    return doc;
  }

  const shown = new Set(faceCards(doc).map((item) => item.id));
  return withPanels(
    doc,
    panels.map((panel) => ({
      ...panel,
      panes: panel.panes.map((pane) => {
        const items = pane.items.filter((item) => item.id !== id);
        if (pane.id !== to) {
          return { ...pane, items };
        }

        // Before the one shown at `index`, or after them all.
        const next = items.filter((item) => shown.has(item.id))[index];
        const at = next ? items.indexOf(next) : items.length;
        return { ...pane, items: items.toSpliced(at, 0, entry) };
      }),
    })),
  );
}

/**
 * Moves a pane to `index` among the panes of the panel `to`, counted without
 * it.
 */
export function movePane(
  doc: LabDocument,
  id: string,
  to: string,
  index: number,
): LabDocument {
  const panels = organized(doc);
  const pane = panels.flatMap((p) => p.panes).find((q) => q.id === id);
  if (!pane || !panels.some((p) => p.id === to)) {
    return doc;
  }

  return withPanels(
    doc,
    panels.map((panel) => {
      const panes = panel.panes.filter((q) => q.id !== id);
      return panel.id === to
        ? { ...panel, panes: panes.toSpliced(index, 0, pane) }
        : { ...panel, panes };
    }),
  );
}

/** Adds an empty pane at the end of the panel `to`; returns its id too. */
export function addPane(
  doc: LabDocument,
  to: string,
): [LabDocument, string | undefined] {
  const panels = organized(doc);
  if (!panels.some((p) => p.id === to)) {
    return [doc, undefined];
  }

  const id = unique('pane', ids(panels));
  return [
    withPanels(
      doc,
      panels.map((panel) =>
        panel.id === to
          ? {
              ...panel,
              panes: [...panel.panes, { id, title: 'Pane', items: [] }],
            }
          : panel,
      ),
    ),
    id,
  ];
}

/** Adds a panel with one empty pane at the end; returns its id too. */
export function addPanel(doc: LabDocument): [LabDocument, string] {
  const panels = organized(doc);
  const taken = ids(panels);
  const id = unique('panel', taken);
  const pane = unique('pane', taken);
  return [
    withPanels(doc, [
      ...panels,
      { id, title: 'Panel', panes: [{ id: pane, title: 'Pane', items: [] }] },
    ]),
    id,
  ];
}

/** Names a panel or a pane. */
export function retitle(
  doc: LabDocument,
  id: string,
  title: string,
): LabDocument {
  const name = title.trim();
  return withPanels(
    doc,
    organized(doc).map((panel) => ({
      ...panel,
      title: panel.id === id ? name : panel.title,
      panes: panel.panes.map((pane) =>
        pane.id === id ? { ...pane, title: name } : pane,
      ),
    })),
  );
}

/**
 * Takes a pane away, its instruments going to the pane before it in its panel,
 * or after it; with no other pane there, they get panes of their own again.
 */
export function removePane(doc: LabDocument, id: string): LabDocument {
  const panels = organized(doc);
  return withPanels(
    doc,
    panels.map((panel) => {
      const at = panel.panes.findIndex((q) => q.id === id);
      if (at < 0) {
        return panel;
      }

      const gone = panel.panes[at]!;
      const heir = panel.panes[at - 1] ?? panel.panes[at + 1];
      return {
        ...panel,
        panes: panel.panes.flatMap((pane) =>
          pane === gone
            ? []
            : pane === heir
              ? [{ ...pane, items: [...pane.items, ...gone.items] }]
              : [pane],
        ),
      };
    }),
  );
}

/**
 * Takes a panel away, its panes going to the end of the panel before it, or
 * the start of the one after, all but those with nothing in them; the last
 * panel stays.
 */
export function removePanel(doc: LabDocument, id: string): LabDocument {
  const panels = organized(doc);
  const at = panels.findIndex((p) => p.id === id);
  if (at < 0 || panels.length < 2) {
    return doc;
  }

  const gone = panels[at]!.panes.filter((pane) => pane.items.length);
  const heir = at > 0 ? at - 1 : 1;
  return withPanels(
    doc,
    panels.flatMap((panel, k) =>
      k === at
        ? []
        : k === heir
          ? [
              {
                ...panel,
                panes:
                  heir < at
                    ? [...panel.panes, ...gone]
                    : [...gone, ...panel.panes],
              },
            ]
          : [panel],
    ),
  );
}

/** A size in whole grid cells, within what a document keeps. */
const cells = (n: number) => Math.min(MOST_CELLS, Math.max(1, Math.round(n)));

/** Gives an instrument a size in grid cells, or with none, its own size back. */
export function resizeInstrument(
  doc: LabDocument,
  id: string,
  size: { readonly w: number; readonly h: number } | undefined,
): LabDocument {
  return withPanels(
    doc,
    organized(doc).map((panel) => ({
      ...panel,
      panes: panel.panes.map((pane) => ({
        ...pane,
        items: pane.items.map((item) =>
          item.id === id
            ? { id, ...(size ? { w: cells(size.w), h: cells(size.h) } : {}) }
            : item,
        ),
      })),
    })),
  );
}

/** Moves a panel to `index` among the panels, counted without it. */
export function movePanel(
  doc: LabDocument,
  id: string,
  index: number,
): LabDocument {
  const panels = organized(doc);
  const panel = panels.find((p) => p.id === id);
  return panel
    ? withPanels(
        doc,
        panels.filter((p) => p.id !== id).toSpliced(index, 0, panel),
      )
    : doc;
}

// Laying out a pane. Its instruments fall in two kinds: screens (plots, views
// and notes), which can take any size, and controls (knobs, buttons and
// speakers, and the LCDs and readouts), which have their own. Screens go on
// top and controls under them, or controls beside them when that makes the
// pane shorter, as on the front of a radio. Each kind is laid out in rows, as
// even as they can be, and each row fills the width: screens and displays
// grow, and knobs spread out evenly rather than huddle in the middle.

/** How an instrument takes to a pane: a screen, a display or a knob. */
export type PieceKind = 'screen' | 'display' | 'knob';

/** An instrument to lay out, at its own size in pixels. */
export type Piece = {
  readonly kind: PieceKind;
  readonly w: number;
  readonly h: number;
};

/** Where an instrument goes in its pane, in pixels from the top left. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** The gap between instruments, and between screens and controls. */
const GAP = 8;
const ZONE_GAP = 14;
/** The most a display grows across, against its own width. */
const DISPLAY_GROWTH = 2;
/** How much taller a row of knobs can grow, against its own height. */
const KNOB_GROWTH = 0.5;
/** How far a screen can be stretched across before it looks wrong. */
const SCREEN_STRETCH = 2.2;

/**
 * Rows of `widths`, in order, none wider than `width` unless one alone is,
 * with as little room left over in each as can be: the sum of the squares of
 * what is left, so two half rows beat a full one and a lonely one. Of even
 * ways, the fuller rows come first.
 */
function rows(widths: readonly number[], width: number): number[][] {
  const n = widths.length;
  const cost = new Array<number>(n + 1).fill(Infinity);
  const next = new Array<number>(n + 1).fill(n);
  cost[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    let used = -GAP;
    for (let j = i + 1; j <= n; j++) {
      used += widths[j - 1]! + GAP;

      if (used > width && j > i + 1) {
        break;
      }

      const total = Math.max(0, width - used) ** 2 + cost[j]!;
      if (total <= cost[i]!) {
        cost[i] = total;
        next[i] = j;
      }
    }
  }

  const found: number[][] = [];
  for (let i = 0; i < n; i = next[i]!) {
    found.push([...Array(next[i]! - i).keys()].map((k) => i + k));
  }

  return found;
}

/**
 * Widths for a row that fill `width`: each grows in proportion to its own.
 * Beside knobs, a display grows to no more than twice its own, and what nobody
 * can take spreads the knobs out; a row of displays and screens alone fills
 * the width, so its edges line up with the rows around it. Too wide to fit,
 * they shrink in proportion.
 */
function justify(
  pieces: readonly Piece[],
  width: number,
): { readonly widths: number[]; readonly gap: number } {
  const room = width - GAP * (pieces.length - 1);
  const own = pieces.reduce((sum, p) => sum + p.w, 0);
  if (own >= room) {
    return { widths: pieces.map((p) => (p.w * room) / own), gap: GAP };
  }

  const widths = pieces.map((p) => p.w);
  const growing = new Set(pieces.keys());
  const knobs = pieces.some((p) => p.kind === 'knob');
  let extra = room - own;
  while (extra > 0.5 && growing.size) {
    const weight = [...growing].reduce((sum, i) => sum + pieces[i]!.w, 0);
    let capped = false;
    for (const i of [...growing]) {
      const piece = pieces[i]!;
      const wanted = widths[i]! + (extra * piece.w) / weight;
      const most =
        knobs && piece.kind === 'display'
          ? piece.w * DISPLAY_GROWTH
          : Infinity;
      if (wanted > most) {
        extra -= most - widths[i]!;
        widths[i] = most;
        growing.delete(i);
        capped = true;
      }
    }

    if (!capped) {
      for (const i of growing) {
        widths[i] = widths[i]! + (extra * pieces[i]!.w) / weight;
      }

      extra = 0;
    }
  }

  return {
    widths,
    gap: pieces.length > 1 ? GAP + extra / (pieces.length - 1) : GAP,
  };
}

/** Pieces laid out in a zone `width` across: boxes from its top left. */
type Zone = {
  readonly boxes: readonly Box[];
  /** Each row's top and height, to spread them out later. */
  readonly rows: readonly {
    readonly top: number;
    readonly height: number;
    readonly members: readonly number[];
  }[];
  readonly height: number;
  /** How much the screens are stretched across, past what looks right. */
  readonly strain: number;
};

function zone(pieces: readonly Piece[], width: number): Zone {
  const boxes: Box[] = [];
  const laid: { top: number; height: number; members: number[] }[] = [];
  let top = 0;
  let strain = 0;
  for (const row of rows(
    pieces.map((p) => p.w),
    width,
  )) {
    const members = row.map((i) => pieces[i]!);
    const { widths, gap } = justify(members, width);
    const height = Math.max(...members.map((p) => p.h));
    let x = 0;
    row.forEach((i, k) => {
      const piece = pieces[i]!;
      const w = widths[k]!;
      // Screens take the row's height; the others sit on its floor.
      const h = piece.kind === 'screen' ? height : piece.h;
      boxes[i] = { x, y: top + height - h, w, h };
      x += w + gap;

      if (piece.kind === 'screen') {
        strain += Math.max(0, w / piece.w - SCREEN_STRETCH) * piece.h;
      }
    });
    laid.push({ top, height, members: row });
    top += height + GAP;
  }

  return { boxes, rows: laid, height: Math.max(0, top - GAP), strain };
}

/**
 * A zone made `height` tall. Screens grow to take the extra, shared by row.
 * Without screens, rows of knobs grow first, by up to half again, so a pane
 * with room has bigger knobs rather than gaps; whatever is left spreads the
 * rows out evenly, with space above and below them too.
 */
function stretch(laid: Zone, pieces: readonly Piece[], height: number): Box[] {
  const extra = height - laid.height;
  const boxes = [...laid.boxes];
  if (extra <= 0.5 || !laid.rows.length) {
    return boxes;
  }

  const screens = pieces.some((p) => p.kind === 'screen');
  const room = laid.rows.map((row) =>
    screens
      ? (extra * row.height) / laid.height
      : row.members.some((i) => pieces[i]!.kind === 'knob')
        ? row.height * KNOB_GROWTH
        : 0,
  );
  const possible = room.reduce((sum, r) => sum + r, 0);
  const share = possible ? Math.min(1, extra / possible) : 0;
  const spacing = screens
    ? 0
    : (extra - possible * share) / (laid.rows.length + 1);
  let shift = spacing;
  laid.rows.forEach((row, r) => {
    const grow = room[r]! * share;
    for (const i of row.members) {
      const box = boxes[i]!;
      const kind = pieces[i]!.kind;
      boxes[i] =
        kind === (screens ? 'screen' : 'knob')
          ? { ...box, y: box.y + shift, h: box.h + grow }
          : { ...box, y: box.y + shift + grow };
    }

    shift += grow + spacing;
  });
  return boxes;
}

/**
 * Lays out a pane's instruments `width` across, and at least `height` tall.
 * Returns where each goes, in the order given, and the height it needs.
 */
export function layoutPane(
  pieces: readonly Piece[],
  width: number,
  height = 0,
): { readonly boxes: Box[]; readonly height: number } {
  const screens = [...pieces.keys()].filter(
    (i) => pieces[i]!.kind === 'screen',
  );
  const controls = [...pieces.keys()].filter(
    (i) => pieces[i]!.kind !== 'screen',
  );
  const of = (indices: readonly number[]) => indices.map((i) => pieces[i]!);
  const placeAll = (
    parts: readonly {
      readonly indices: readonly number[];
      readonly laid: Zone;
      readonly x: number;
      readonly y: number;
      readonly height: number;
    }[],
  ) => {
    const boxes: Box[] = [];
    for (const part of parts) {
      const stretched = stretch(part.laid, of(part.indices), part.height);
      part.indices.forEach((i, k) => {
        const box = stretched[k]!;
        boxes[i] = { ...box, x: box.x + part.x, y: box.y + part.y };
      });
    }

    return boxes;
  };

  type Candidate = {
    readonly score: number;
    readonly natural: number;
    readonly place: (height: number) => Box[];
  };
  const candidates: Candidate[] = [];

  // Screens on top, controls under them.
  {
    const top = zone(of(screens), width);
    const bottom = zone(of(controls), width);
    const between = screens.length && controls.length ? ZONE_GAP : 0;
    const natural = top.height + between + bottom.height;
    candidates.push({
      score: natural + top.strain,
      natural,
      place: (total) => {
        // The screens take any height to spare, or the controls spread out.
        const spare = Math.max(0, total - natural);
        const screensHeight = top.height + (screens.length ? spare : 0);
        return placeAll([
          { indices: screens, laid: top, x: 0, y: 0, height: screensHeight },
          {
            indices: controls,
            laid: bottom,
            x: 0,
            y: screensHeight + between,
            height: bottom.height + (screens.length ? 0 : spare),
          },
        ]);
      },
    });
  }

  // Controls beside the screens, as many to a row as each width allows.
  if (screens.length && controls.length) {
    // Beside controls, a screen keeps at least its own width; squeezed
    // narrower, as on a phone, the controls go under it instead.
    const narrowest = Math.max(...of(screens).map((p) => p.w));
    let across = -GAP;
    const tried = new Set<number>();
    for (const i of controls) {
      across += pieces[i]!.w + GAP;
      const wide = Math.max(across, ...of(controls).map((p) => p.w));
      const left = width - wide - ZONE_GAP;
      if (tried.has(wide) || left < narrowest) {
        continue;
      }

      tried.add(wide);
      const side = zone(of(controls), wide);
      const main = zone(of(screens), left);
      const natural = Math.max(side.height, main.height);
      candidates.push({
        score: natural + main.strain,
        natural,
        place: (total) => {
          const tall = Math.max(total, natural);
          return placeAll([
            { indices: screens, laid: main, x: 0, y: 0, height: tall },
            {
              indices: controls,
              laid: side,
              x: left + ZONE_GAP,
              y: 0,
              height: tall,
            },
          ]);
        },
      });
    }
  }

  const best = candidates.reduce((a, b) => (b.score < a.score ? b : a));
  return {
    boxes: best.place(Math.max(height, best.natural)),
    height: best.natural,
  };
}

/**
 * How wide a pane would like to be, between its widest instrument and
 * `widest`: the width that leaves least of it empty, without its being much
 * taller than wide.
 */
export function paneWidth(
  pieces: readonly Piece[],
  widest: number,
  step: number,
): number {
  const least = Math.max(1, ...pieces.map((p) => p.w));
  const used = pieces.reduce((sum, p) => sum + p.w * p.h, 0);
  let best = { width: least, score: Infinity };
  for (let width = least; width <= Math.max(least, widest); width += step) {
    const { height } = layoutPane(pieces, width);
    const score = width * height - used + Math.max(0, height - width) * width;
    if (score < best.score) {
      best = { width, score };
    }
  }

  return best.width;
}
