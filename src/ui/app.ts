// Ties the pieces together: the document history, the simulation worker, and
// the views that show and edit them. The editor shows one diagram at a time,
// the top level or the inside of a subsystem, chosen by `path`; the panel face
// below it shows every instrument in the document. The worker runs the
// document as a stream from time 0. While it runs, the playhead moves on with
// the clock (the audio clock while a speaker plays) and the worker is kept a
// little ahead of it; everything on screen shows the stream as it stood at the
// playhead. Every change re-renders at once and goes to the worker, which
// carries on with it from where it is.

import { blockType, categories } from '../blocks/index.ts';
import {
  CONTROL,
  isInstrument,
  PLOT,
  READOUT,
  SPEAKER,
  SYMBOLS,
} from '../blocks/instruments.ts';
import { RECORDING } from '../blocks/sources.ts';
import { visiblePorts, type Reading } from '../engine/block.ts';
import { portKey, type PortRef } from '../engine/circuit.ts';
import { errorMessage, errorName } from '../engine/errors.ts';
import { significant } from '../engine/format.ts';
import type { StoredParams } from '../engine/params.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  addBlock,
  connect,
  diagramAt,
  duplicate,
  emptyDocument,
  everyBlock,
  isSubsystem,
  pathId,
  pruneRefs,
  readDocument,
  removeBlocks,
  removeWire,
  SUBSYSTEM,
  updateDiagramAt,
  wireInto,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from '../model/document.ts';
import { examples } from '../model/examples.ts';
import { resolveBindings } from '../model/flatten.ts';
import {
  faceItems,
  hasControl,
  plotFrom,
  settables,
  symbolSources,
} from '../model/instruments.ts';
import { template } from '../model/library.ts';
import {
  displayName,
  groupAt,
  typeOf,
  ungroupAt,
} from '../model/subsystems.ts';
import { StreamClient, type Chunk } from '../sim/client.ts';
import { Monitor } from './audio.ts';
import {
  getClip,
  packClip,
  putClip,
  unpackClip,
  type SavedClip,
} from './clips.ts';
import type { ChangeMode } from './controls.ts';
import { html, isTyping } from './dom.ts';
import {
  DiagramEditor,
  NOTHING,
  selectBlocks,
  selectedBlocks,
  type MenuTarget,
  type Selection,
} from './editor.ts';
import {
  clockTime,
  Face,
  speedLabel,
  type ScopeState,
  type Transport,
} from './face.ts';
import { layoutOf, snap, type Point } from './geometry.ts';
import { History } from './history.ts';
import { Inspector } from './inspector.ts';
import { portLabel } from './labels.ts';
import { Live } from './live.ts';
import { showMenu, type MenuItem } from './menu.ts';
import { paletteEntries, renderPalette, TEMPLATE } from './palette.ts';
import { addOnce } from './parameters.ts';
import { inputOf, problemAt, Widgets } from './widgets.ts';

const STORAGE_KEY = 'signal-lab:document';

/** How far ahead of the playhead the stream runs, in seconds of real time. */
const LEAD = 0.3;

/** Milliseconds of the recent past the status line measures over. */
const WINDOW = 2000;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`The page is missing #${id}.`);
  }

  return element as T;
}

/** The diagram saved in this browser, if there is a readable one. */
function loadSaved(): LabDocument | undefined {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? readDocument(JSON.parse(text)) : undefined;
  } catch {
    return undefined;
  }
}

/** A block's footprint on the diagram, for placing new blocks clear of it. */
function footprint(block: LabBlock) {
  const type = typeOf(block);
  const { width, height } = type ? layoutOf(type) : { width: 144, height: 56 };
  return { x: block.x, y: block.y, width, height };
}

export class App {
  readonly #history: History<LabDocument>;
  readonly #client = new StreamClient({
    status: (statuses) => {
      this.#statuses = statuses;
      this.#notice = '';
      this.#render();
    },
    chunk: (chunk) => this.#accept(chunk),
    history: (samples) => {
      for (const run of samples) {
        this.#live.add(run);
      }

      this.#refresh();
    },
    error: (message) => {
      this.#notice = `Simulation failed: ${message}`;
      this.#running = false;
      this.#render();
    },
  });
  readonly #live = new Live();
  readonly #monitor = new Monitor();
  readonly #widgets: Widgets;
  readonly #editor: DiagramEditor;
  readonly #inspector: Inspector;
  readonly #face: Face;
  readonly #status = byId('status');
  readonly #title = byId('doc-title');
  readonly #crumbs = byId('crumbs');
  readonly #undo = byId<HTMLButtonElement>('undo');
  readonly #redo = byId<HTMLButtonElement>('redo');
  #statuses: ReadonlyMap<string, BlockStatus> = new Map();
  /** Every block's readings at the playhead. */
  #readings: ReadonlyMap<string, readonly Reading[]> = new Map();
  #path: Path = [];
  #selection: Selection = NOTHING;
  /** Something to say on the status line instead, until the next run or reset. */
  #notice = '';
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The playhead: the stream time on screen, in seconds. */
  #time = 0;
  #running = false;
  #speed = 1;
  /**
   * Lately, when the worker answered and how many milliseconds it worked for,
   * and where the playhead was when, to say how busy the one is and how fast
   * the other really runs.
   */
  #work: { readonly at: number; readonly elapsed: number }[] = [];
  #progress: { readonly at: number; readonly time: number }[] = [];
  /** Seconds the playhead has been held up waiting for the worker. */
  #waited = 0;
  #frame = 0;
  #lastFrame = 0;

  constructor() {
    this.#history = new History(loadSaved() ?? examples[0]!.build());
    const change = (next: LabDocument, mode: ChangeMode) =>
      this.#change(next, mode);
    const select = (selection: Selection) => {
      this.#selection = selection;
      this.#render();
    };

    const listen = (at: PortRef) => this.#monitor.toggle(portKey(at));
    const addPlot = (at: PortRef) => this.#addPlot(at);

    const press = (id: string) => this.#client.press(id);
    this.#widgets = new Widgets({ change, listen, press });
    this.#editor = new DiagramEditor(byId('canvas'), {
      change: (next, mode) =>
        this.#change(
          updateDiagramAt(this.#doc, this.#path, (d) => ({
            ...d,
            blocks: next.blocks,
            wires: next.wires,
          })),
          mode,
        ),
      select,
      open: (id) => this.#open([...this.#path, id]),
      reveal: (id) => this.#reveal(id),
      add: (key, at) => this.#add(key, at),
      menu: (target, client, at) => this.#menu(target, client, at),
    });
    this.#inspector = new Inspector(byId('inspector'), {
      change,
      select,
      open: (path) => this.#open(path),
      group: (ids) => this.#group(ids),
      ungroup: (id) => this.#ungroup(id),
      addPlot,
      addControl: (path, target) => this.#addControl(path, target),
      addReadout: (path, block, reading) =>
        this.#addReadout(path, block, reading),
      press: (id) => this.#client.press(id),
    });
    this.#face = new Face(byId('face'), {
      change,
      reveal: (id) => this.#reveal(id),
      addPlot,
      listen,
      run: () => this.#run(),
      reset: () => this.#reset(),
      speed: (speed) => {
        this.#speed = speed;
        this.#render();
      },
    });
    renderPalette(byId('palette'), (key) =>
      this.#add(key, this.#editor.center()),
    );

    this.#history.subscribe(() => {
      this.#render();
      this.#scheduleSave();
    });
    this.#monitor.subscribe(() => this.#render());
    this.#bindToolbar();
    addEventListener('keydown', (event) => this.#keydown(event));

    this.#render();
    this.#editor.fit();
  }

  get #doc(): LabDocument {
    return this.#history.present;
  }

  /**
   * The diagram on screen. If the path stopped existing (after an undo, say),
   * back out to one that does.
   */
  get #diagram(): Diagram {
    let diagram = diagramAt(this.#doc, this.#path);
    while (!diagram) {
      this.#path = this.#path.slice(0, -1);
      this.#selection = NOTHING;
      diagram = diagramAt(this.#doc, this.#path);
    }

    return diagram;
  }

  #change(next: LabDocument, mode: ChangeMode): void {
    if (mode === 'preview') {
      this.#history.preview(next);
    } else {
      this.#history.commit(pruneRefs(next));
    }
  }

  #render(): void {
    const doc = this.#doc;
    const diagram = this.#diagram;
    this.#dropStaleSelection(diagram);
    const bindings = resolveBindings(doc);
    this.#readings = this.#live.readingsAt(this.#time);
    this.#widgets.update({
      doc,
      live: this.#live,
      readings: this.#readings,
      status: this.#statuses,
      bindings,
      listening: this.#monitor.listening,
      time: this.#time,
    });
    this.#editor.render({
      doc,
      diagram,
      path: this.#path,
      selection: this.#selection,
      status: this.#statuses,
      readings: this.#readings,
      bound: bindings.values,
      widgets: this.#widgets,
    });
    this.#face.render({
      doc,
      widgets: this.#widgets,
      bindings,
      scope: this.#faceScope(diagram),
      selected: new Set(
        selectedBlocks(this.#selection).map((id) => pathId(this.#path, id)),
      ),
      transport: this.#transport(),
    });
    this.#widgets.sweep();
    this.#inspector.render({
      doc,
      path: this.#path,
      diagram,
      selection: this.#selection,
      status: this.#statuses,
      readings: this.#readings,
      bindings,
    });
    this.#renderCrumbs();
    this.#title.textContent = doc.title;
    this.#undo.disabled = !this.#history.canUndo;
    this.#redo.disabled = !this.#history.canRedo;
    this.#status.textContent = this.#summary();
    this.#sync(diagram);
  }

  /**
   * How the running stream is doing: the speed, and how much of each second
   * the simulation spends working, which says how much faster it could go. If
   * it can't keep up, how fast it really runs instead.
   */
  #runningSummary(): string {
    const now = performance.now();
    const recent = (at: number) => now - at < WINDOW;
    this.#work = this.#work.filter((w) => recent(w.at));
    this.#progress = this.#progress.filter((p) => recent(p.at));
    const speed = speedLabel(this.#speed);
    const first = this.#progress[0];
    const last = this.#progress.at(-1);
    if (this.#waited > 0.25 && first && last && last.at > first.at) {
      const real = (last.time - first.time) / ((last.at - first.at) / 1000);
      return `Can't keep up with ${speed}: running at ${significant(real, 2)}×`;
    }

    const span = first ? Math.max(500, now - first.at) : 0;
    if (!span) {
      return `Running at ${speed}`;
    }

    const busy = this.#work.reduce((sum, w) => sum + w.elapsed, 0) / span;
    return `Running at ${speed} · simulation ${Math.min(100, Math.round(100 * busy))}% busy`;
  }

  /** The status line: how the stream is doing, and any errors. */
  #summary(): string {
    if (this.#notice) {
      return this.#notice;
    }

    const errors = [...this.#statuses.values()].filter(
      (s) => s.state === 'error',
    ).length;
    const state = this.#running
      ? this.#runningSummary()
      : this.#time > 0
        ? `Paused at ${clockTime(this.#time)}`
        : 'Press Run to start';
    return errors
      ? `${state} · ${errors === 1 ? '1 block has' : `${errors} blocks have`} an error`
      : state;
  }

  #renderCrumbs(): void {
    if (this.#path.length === 0) {
      this.#crumbs.hidden = true;
      return;
    }

    this.#crumbs.hidden = false;

    const crumb = (label: string, path: Path, current: boolean) => {
      if (current) {
        return html(
          'span',
          { class: 'crumb current', 'aria-current': 'location' },
          label,
        );
      }

      const button = html('button', { type: 'button', class: 'crumb' }, label);
      button.addEventListener('click', () => this.#open(path));
      return button;
    };

    const items: HTMLElement[] = [crumb('Top', [], false)];
    this.#path.forEach((_, i) => {
      const path = this.#path.slice(0, i + 1);
      const block = diagramAt(this.#doc, path.slice(0, -1))?.blocks.find(
        (b) => b.id === path[path.length - 1],
      );
      items.push(
        html('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'),
        crumb(
          block ? displayName(block) : '?',
          path,
          i === this.#path.length - 1,
        ),
      );
    });
    this.#crumbs.replaceChildren(...items);
  }

  /**
   * The signal the selection points at: a wire's source, or a single block's
   * first output. Instruments point at nothing; they show their own.
   */
  #scopeTarget(diagram: Diagram): PortRef | undefined {
    const selection = this.#selection;
    if (selection.kind === 'wire') {
      const wire = diagram.wires.find((w) => w.id === selection.id);
      return (
        wire && {
          block: pathId(this.#path, wire.from.block),
          port: wire.from.port,
        }
      );
    }

    const ids = selectedBlocks(selection);
    if (ids.length === 1) {
      const block = diagram.blocks.find((b) => b.id === ids[0]);
      const [first] = block ? visiblePorts(typeOf(block)?.outputs ?? []) : [];
      if (block && first && !isInstrument(block.kind)) {
        return { block: pathId(this.#path, block.id), port: first.index };
      }
    }

    return undefined;
  }

  /** The selection's signal for the face, unless a plot already shows it. */
  #faceScope(diagram: Diagram) {
    const at = this.#scopeTarget(diagram);
    if (
      !at ||
      plotFrom(diagram, { block: at.block.split('/').at(-1)!, port: at.port })
    ) {
      return undefined;
    }

    return this.#scopeState(at);
  }

  #scopeState(at: PortRef): ScopeState {
    return {
      at,
      title: portLabel(this.#doc, at),
      trace: this.#live.traces.get(portKey(at)),
      problem: problemAt(this.#statuses, at),
      listening: this.#monitor.listening.has(portKey(at)),
    };
  }

  /** Port keys whose signals are on screen or playing. */
  #wanted(diagram: Diagram): string[] {
    const doc = this.#doc;
    const bindings = resolveBindings(doc);
    const keys = new Set(
      faceItems(doc).flatMap((item) => {
        if (item.block.kind === SYMBOLS) {
          const sources = symbolSources(doc, item, {
            status: this.#statuses,
            bindings,
          });
          return 'problem' in sources
            ? []
            : [sources.tone, sources.bits, sources.glide?.at].flatMap((at) =>
                at ? [portKey(at)] : [],
              );
        }

        const at =
          item.block.kind === PLOT || item.block.kind === SPEAKER
            ? inputOf(doc, item)
            : undefined;
        return at ? [portKey(at)] : [];
      }),
    );
    const scope = this.#scopeTarget(diagram);
    if (scope) {
      keys.add(portKey(scope));
    }

    for (const key of this.#monitor.listening) {
      keys.add(key);
    }

    return [...keys].sort();
  }

  /** Sends the worker the document and the ports to watch, if they changed. */
  #sync(diagram: Diagram): void {
    const wanted = this.#wanted(diagram);
    this.#client.load(this.#doc);
    this.#client.watch(wanted);
    this.#live.keep(new Set(wanted));
    this.#handClips();
  }

  /** The ids of the recordings the document plays. */
  #clipIds(): string[] {
    return [
      ...new Set(
        everyBlock(this.#doc).flatMap(({ block }) =>
          block.kind === RECORDING && typeof block.params.clip === 'string'
            ? [block.params.clip]
            : [],
        ),
      ),
    ].filter(Boolean);
  }

  /** Hands the worker the recordings the document plays that it lacks. */
  #handClips(): void {
    for (const id of this.#clipIds()) {
      if (!this.#client.hasClip(id)) {
        void getClip(id).then((clip) => clip && this.#client.clips([clip]));
      }
    }
  }

  #accept(chunk: Chunk): void {
    for (const run of chunk.samples) {
      this.#live.add(run);
    }

    for (const stamped of chunk.readings) {
      this.#live.stamp(stamped);
    }

    this.#live.time = chunk.time;

    this.#work.push({ at: performance.now(), elapsed: chunk.elapsed });

    if (!this.#running) {
      this.#refresh();
    }
  }

  // The stream's clock.

  #transport(): Transport {
    return {
      time: this.#time,
      running: this.#running,
      speed: this.#speed,
      behind: this.#waited > 0.25,
    };
  }

  /** Starts or pauses the stream. */
  #run(): void {
    this.#running = !this.#running;
    this.#waited = 0;
    this.#work = [];
    this.#progress = [];

    if (this.#running) {
      this.#notice = '';
      this.#ahead();
      this.#animate();
    } else {
      this.#monitor.halt();
    }

    this.#render();
  }

  /** Takes the stream back to time 0, with every block afresh. */
  #reset(): void {
    this.#client.reset();
    this.#live.clear();
    this.#monitor.halt();
    this.#time = 0;
    this.#work = [];
    this.#progress = [];
    this.#notice = '';

    if (this.#running) {
      this.#ahead();
    }

    this.#render();
  }

  /** Keeps the worker a little ahead of the playhead. */
  #ahead(): void {
    const until = this.#time + LEAD * Math.max(1, this.#speed);
    if (this.#live.time < until - 1e-3) {
      this.#client.advance(until);
    }
  }

  /** Shows the stream as it stood at the playhead, without a full render. */
  #refresh(): void {
    this.#readings = this.#live.readingsAt(this.#time);
    this.#widgets.setTime(this.#time, this.#readings);
    this.#editor.setReadings(this.#readings);
    this.#inspector.setReadings(this.#readings);
    const scope = this.#faceScope(this.#diagram);
    this.#face.tick(this.#transport(), scope);
    this.#status.textContent = this.#summary();
  }

  /** Moves the playhead on, one animation frame at a time, while running. */
  #animate(): void {
    if (this.#frame) {
      return;
    }

    this.#lastFrame = performance.now();

    const tick = (now: number) => {
      this.#frame = 0;

      if (!this.#running) {
        return;
      }

      const elapsed = Math.min(0.1, (now - this.#lastFrame) / 1000);
      this.#lastFrame = now;
      // While sound plays, the audio clock keeps time.
      const clock = this.#monitor.clock();
      const wanted = clock ?? this.#time + elapsed * this.#speed;
      const short = wanted > this.#live.time + 0.05;
      this.#waited = short ? this.#waited + elapsed : 0;

      if (clock !== undefined && short) {
        // The sound has run out: start it again from where the stream is.
        this.#monitor.halt();
      }

      this.#time = Math.max(this.#time, Math.min(wanted, this.#live.time));
      this.#progress.push({ at: now, time: this.#time });
      this.#ahead();
      this.#monitor.feed(this.#live.traces, this.#time, true, this.#speed);
      this.#refresh();
      this.#frame = requestAnimationFrame(tick);
    };

    this.#frame = requestAnimationFrame(tick);
  }

  // Navigation and editing.

  #open(path: Path): void {
    if (!diagramAt(this.#doc, path)) {
      return;
    }

    this.#path = path;
    this.#selection = NOTHING;
    this.#render();
    this.#editor.fit();
  }

  /** Shows an instrument on the diagram: opens its diagram and selects it. */
  #reveal(id: string): void {
    const parts = id.split('/');
    const path = parts.slice(0, -1);
    const moved = path.join('/') !== this.#path.join('/');
    this.#path = path;
    this.#selection = selectBlocks([parts[parts.length - 1]!]);
    this.#render();

    if (moved) {
      this.#editor.fit();
    }
  }

  /** A spot near `near` (or the canvas's middle) clear of every block. */
  #spot(diagram: Diagram, kind: string, near: LabBlock | undefined): Point {
    const type = blockType(kind);
    const { width, height } = type
      ? layoutOf(type)
      : { width: 144, height: 56 };
    const start = near
      ? (({ x, y, width: w, height: h }) => ({
          x: x + w + 48,
          y: y + h + 24,
        }))(footprint(near))
      : (({ x, y }) => ({ x: snap(x - width / 2), y: snap(y - height / 2) }))(
          this.#editor.center(),
        );
    const others = diagram.blocks.map(footprint);
    const clear = (x: number, y: number) =>
      others.every(
        (b) =>
          x >= b.x + b.width + 16 ||
          x + width + 16 <= b.x ||
          y >= b.y + b.height + 16 ||
          y + height + 16 <= b.y,
      );
    for (let step = 0; step < 60; step++) {
      const y = snap(start.y + 24 * step);
      if (clear(start.x, y)) {
        return { x: snap(start.x), y };
      }
    }

    return start;
  }

  /**
   * Adds an instrument to the diagram at `path`, near a block, wired from
   * `input` if it has one, and selects it.
   */
  #addInstrument(
    path: Path,
    kind: string,
    params: StoredParams,
    near: string | undefined,
    input?: PortRef,
  ): void {
    const diagram = diagramAt(this.#doc, path);
    if (!diagram) {
      return;
    }

    const at = this.#spot(
      diagram,
      kind,
      diagram.blocks.find((b) => b.id === near),
    );
    let made = '';
    const next = updateDiagramAt(this.#doc, path, (d) => {
      const [added, id] = addBlock(d, kind, at.x, at.y, { params });
      made = id;
      return input ? connect(added, input, { block: id, port: 0 }) : added;
    });
    this.#path = path;
    this.#selection = selectBlocks([made]);
    this.#change(next, 'commit');
  }

  /** Adds a Plot of an output, given by full id, unless one shows it. */
  #addPlot(at: PortRef, kind = PLOT): void {
    const parts = at.block.split('/');
    const local = { block: parts[parts.length - 1]!, port: at.port };
    this.#addInstrument(parts.slice(0, -1), kind, {}, local.block, local);
  }

  #addControl(path: Path, target: string): void {
    const dot = target.lastIndexOf('.');
    this.#addInstrument(
      path,
      CONTROL,
      { target },
      dot > 0 ? target.slice(0, dot).split('/')[0] : undefined,
    );
  }

  #addReadout(path: Path, block: string, reading: string): void {
    this.#addInstrument(
      path,
      READOUT,
      { block, reading },
      block.split('/')[0],
    );
  }

  /**
   * Adds a palette entry centered on `at`, nudged clear of any block already
   * there.
   */
  #add(key: string, at: Point): void {
    const library = key.startsWith(TEMPLATE)
      ? template(key.slice(TEMPLATE.length))
      : undefined;
    if (!library && !blockType(key)) {
      return;
    }

    const inner = library?.build();
    const probe = {
      id: '',
      kind: library ? SUBSYSTEM : key,
      x: 0,
      y: 0,
      params: {},
      ...(inner ? { inner } : {}),
    };
    const type = typeOf(probe);
    if (!type) {
      return;
    }

    const layout = layoutOf(type);
    let x = snap(at.x - layout.width / 2);
    let y = snap(at.y - layout.height / 2);
    const taken = this.#diagram.blocks;
    while (taken.some((block) => block.x === x && block.y === y)) {
      x += 24;
      y += 24;
    }

    let made = '';
    const next = updateDiagramAt(this.#doc, this.#path, (d) => {
      const [added, id] = addBlock(
        d,
        probe.kind,
        x,
        y,
        library ? { name: library.label, ...(inner ? { inner } : {}) } : {},
      );
      made = id;
      return added;
    });
    this.#selection = selectBlocks([made]);
    this.#change(next, 'commit');
  }

  /** Applies an edit to the diagram on screen as one undo step. */
  #edit(change: <T extends Diagram>(diagram: T) => T): void {
    this.#change(updateDiagramAt(this.#doc, this.#path, change), 'commit');
  }

  #duplicate(ids: readonly string[]): void {
    if (!ids.length) {
      return;
    }

    let copies: string[] = [];
    const next = updateDiagramAt(this.#doc, this.#path, (d) => {
      const [result, made] = duplicate(d, new Set(ids), 24, 24, this.#path);
      copies = made;
      return result;
    });
    this.#selection = selectBlocks(copies);
    this.#change(next, 'commit');
  }

  #selectAll(): void {
    this.#selection = selectBlocks(
      this.#diagram.blocks.map((block) => block.id),
    );
    this.#render();
  }

  #toggleListen(ref: PortRef): MenuItem {
    const key = portKey(ref);
    return {
      label: this.#monitor.listening.has(key) ? 'Stop listening' : 'Listen',
      run: () => this.#monitor.toggle(key),
    };
  }

  /** Menu items for watching an output: listen, plot or add a speaker. */
  #outputItems(ref: PortRef, what = ''): MenuItem[] {
    const local = { block: ref.block.split('/').at(-1)!, port: ref.port };
    return [
      this.#toggleListen(ref),
      addOnce(
        `Add plot${what}`,
        plotFrom(this.#diagram, local) !== undefined,
        () => this.#addPlot(ref),
      ),
      { label: `Add speaker${what}`, run: () => this.#addPlot(ref, SPEAKER) },
    ];
  }

  /** The right-click menu for whatever was clicked. */
  #menu(target: MenuTarget, client: Point, at: Point): void {
    const path = this.#path;
    const diagram = this.#diagram;
    const full = (ref: PortRef) => ({
      block: pathId(path, ref.block),
      port: ref.port,
    });
    let items: MenuItem[];
    switch (target.kind) {
      case 'port': {
        if (target.direction === 'out') {
          items = this.#outputItems(full(target.ref));
        } else {
          const wire = wireInto(diagram, target.ref);
          items = [
            {
              label: 'Disconnect',
              disabled: !wire,
              run: () => wire && this.#edit((d) => removeWire(d, wire.id)),
            },
          ];
        }

        break;
      }

      case 'wire': {
        const wire = diagram.wires.find((w) => w.id === target.id);
        if (!wire) {
          return;
        }

        items = [
          ...this.#outputItems(full(wire.from)),
          'separator',
          {
            label: 'Delete wire',
            danger: true,
            hint: '⌫',
            run: () => this.#edit((d) => removeWire(d, wire.id)),
          },
        ];
        break;
      }

      case 'blocks': {
        const { ids } = target;
        const remove: MenuItem = {
          label: ids.length > 1 ? `Delete ${ids.length} blocks` : 'Delete',
          danger: true,
          hint: '⌫',
          run: () => {
            this.#selection = NOTHING;
            this.#edit((d) => removeBlocks(d, new Set(ids)));
          },
        };
        const block =
          ids.length === 1
            ? diagram.blocks.find((b) => b.id === ids[0])
            : undefined;
        if (!block) {
          items = [
            {
              label: `Group ${ids.length} blocks into a subsystem`,
              hint: '⌘G',
              run: () => this.#group(ids),
            },
            {
              label: 'Duplicate',
              hint: '⌘D',
              run: () => this.#duplicate(ids),
            },
            'separator',
            remove,
          ];
          break;
        }

        const outputs = visiblePorts(typeOf(block)?.outputs ?? []);
        items = [
          ...(isSubsystem(block)
            ? [
                {
                  label: 'Open',
                  hint: '↵',
                  run: () => this.#open([...path, block.id]),
                },
                {
                  label: 'Ungroup',
                  hint: '⇧⌘G',
                  run: () => this.#ungroup(block.id),
                },
                'separator' as const,
              ]
            : []),
          ...outputs.flatMap(({ port, index }) =>
            this.#outputItems(
              { block: pathId(path, block.id), port: index },
              outputs.length > 1 ? ` of ${port.name}` : '',
            ),
          ),
          ...(isInstrument(block.kind)
            ? []
            : [
                {
                  label: 'Add a control or readout…',
                  run: () => this.#instrumentMenu(block, client),
                },
              ]),
          'separator',
          { label: 'Duplicate', hint: '⌘D', run: () => this.#duplicate(ids) },
          {
            label: 'Group into subsystem',
            hint: '⌘G',
            run: () => this.#group(ids),
          },
          'separator',
          remove,
        ];
        break;
      }

      case 'canvas':
        items = [
          { label: 'Add block here…', run: () => this.#addMenu(client, at) },
          {
            label: 'Select all',
            hint: '⌘A',
            disabled: !diagram.blocks.length,
            run: () => this.#selectAll(),
          },
          { label: 'Fit diagram', run: () => this.#editor.fit() },
          ...(path.length
            ? [
                {
                  label: 'Up one level',
                  hint: 'Esc',
                  run: () => this.#open(path.slice(0, -1)),
                },
              ]
            : []),
          'separator',
          {
            label: 'Undo',
            hint: '⌘Z',
            disabled: !this.#history.canUndo,
            run: () => this.#history.undo(),
          },
          {
            label: 'Redo',
            hint: '⇧⌘Z',
            disabled: !this.#history.canRedo,
            run: () => this.#history.redo(),
          },
        ];
        break;
    }

    showMenu(items, client);
  }

  /** Controls for a block's settings and readouts for its readings. */
  #instrumentMenu(block: LabBlock, client: Point): void {
    const path = this.#path;
    const diagram = this.#diagram;
    const controls = settables(this.#doc, path)
      .filter(({ target }) => target.startsWith(`${block.id}.`))
      .map(({ target, label }) =>
        addOnce(label.split(' › ').at(-1)!, hasControl(diagram, target), () =>
          this.#addControl(path, target),
        ),
      );
    const readouts = (typeOf(block)?.reports ?? []).map(
      (reading): MenuItem => ({
        label: reading,
        run: () => this.#addReadout(path, block.id, reading),
      }),
    );
    showMenu(
      [
        ...(controls.length ? [{ heading: 'Controls' }, ...controls] : []),
        ...(readouts.length ? [{ heading: 'Readouts' }, ...readouts] : []),
      ],
      client,
    );
  }

  /**
   * Every palette entry, by category, added where the canvas was
   * right-clicked.
   */
  #addMenu(client: Point, at: Point): void {
    showMenu(
      categories.flatMap((category): MenuItem[] => [
        { heading: category },
        ...paletteEntries
          .filter((entry) => entry.category === category)
          .map((entry) => ({
            label: entry.label,
            run: () => this.#add(entry.key, at),
          })),
      ]),
      client,
    );
  }

  #group(ids: readonly string[]): void {
    const result = groupAt(this.#doc, this.#path, new Set(ids));
    if (!result) {
      return;
    }

    this.#selection = selectBlocks([result.id]);
    this.#change(result.doc, 'commit');
  }

  #ungroup(id: string): void {
    this.#selection = NOTHING;
    this.#change(ungroupAt(this.#doc, this.#path, id), 'commit');
  }

  #deleteSelection(): void {
    const selection = this.#selection;
    if (selection.kind === 'none') {
      return;
    }

    this.#selection = NOTHING;
    this.#change(
      updateDiagramAt(this.#doc, this.#path, (d) =>
        selection.kind === 'blocks'
          ? removeBlocks(d, new Set(selection.ids))
          : removeWire(d, selection.id),
      ),
      'commit',
    );
  }

  #dropStaleSelection(diagram: Diagram): void {
    const selection = this.#selection;
    if (selection.kind === 'blocks') {
      const ids = selection.ids.filter((id) =>
        diagram.blocks.some((b) => b.id === id),
      );
      if (ids.length !== selection.ids.length) {
        this.#selection = selectBlocks(ids);
      }
    } else if (
      selection.kind === 'wire' &&
      !diagram.wires.some((w) => w.id === selection.id)
    ) {
      this.#selection = NOTHING;
    }
  }

  #load(doc: LabDocument): void {
    this.#path = [];
    this.#selection = NOTHING;
    this.#monitor.clear();
    this.#running = false;
    this.#history.commit(doc);
    this.#reset();
    requestAnimationFrame(() => this.#editor.fit());
  }

  #scheduleSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#doc));
      } catch {
        // Storage can be full or blocked; the diagram just won't survive a reload.
      }
    }, 400);
  }

  #keydown(event: KeyboardEvent): void {
    if (isTyping(event.target)) {
      return;
    }

    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (command && key === 'z') {
      event.preventDefault();

      if (event.shiftKey) {
        this.#history.redo();
      } else {
        this.#history.undo();
      }
    } else if (command && key === 'y') {
      event.preventDefault();
      this.#history.redo();
    } else if (command && key === 'd') {
      event.preventDefault();
      this.#duplicate(selectedBlocks(this.#selection));
    } else if (command && key === 'a') {
      event.preventDefault();
      this.#selectAll();
    } else if (command && key === 'g') {
      event.preventDefault();

      if (event.shiftKey) {
        const [only] = selectedBlocks(this.#selection);
        if (only) {
          this.#ungroup(only);
        }
      } else {
        this.#group(selectedBlocks(this.#selection));
      }
    } else if (
      !command &&
      (event.key === 'Delete' || event.key === 'Backspace')
    ) {
      event.preventDefault();
      this.#deleteSelection();
    } else if (event.key === ' ' && !command) {
      // Space starts and pauses the stream, as in audio editors.
      if ((event.target as Element | null)?.closest?.('button, [data-live]')) {
        return;
      }

      event.preventDefault();
      this.#run();
    } else if (event.key === 'Enter') {
      const ids = selectedBlocks(this.#selection);
      if (
        ids.length === 1 &&
        this.#diagram.blocks.find((b) => b.id === ids[0])?.kind === SUBSYSTEM
      ) {
        this.#open([...this.#path, ids[0]!]);
      }
    } else if (event.key === 'Escape') {
      if (this.#selection.kind === 'none' && this.#path.length) {
        this.#open(this.#path.slice(0, -1));
      } else {
        this.#selection = NOTHING;
        this.#render();
      }
    }
  }

  #bindToolbar(): void {
    const picker = byId<HTMLSelectElement>('examples');
    picker.append(
      ...examples.map((example, i) =>
        html('option', { value: i }, example.title),
      ),
    );
    picker.addEventListener('change', () => {
      const example = examples[Number(picker.value)];
      picker.value = '';

      if (example) {
        this.#load(example.build());
      }
    });

    byId('new').addEventListener('click', () => this.#load(emptyDocument()));
    this.#undo.addEventListener('click', () => this.#history.undo());
    this.#redo.addEventListener('click', () => this.#history.redo());
    byId('fit').addEventListener('click', () => this.#editor.fit());

    byId('export').addEventListener('click', async () => {
      // The recordings it plays go in the file too, so it keeps its sound.
      const clips: Record<string, SavedClip> = {};
      for (const id of this.#clipIds()) {
        const clip = await getClip(id);
        if (clip) {
          clips[id] = packClip(clip);
        }
      }

      const saved = Object.keys(clips).length
        ? { ...this.#doc, clips }
        : this.#doc;
      const blob = new Blob([JSON.stringify(saved, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = html('a', {
        href: url,
        download: `${this.#doc.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'diagram'}.json`,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const file = byId<HTMLInputElement>('import-file');
    byId('import').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';

      if (!chosen) {
        return;
      }

      try {
        const value: unknown = JSON.parse(await chosen.text());
        const doc = readDocument(value);
        const clips = (value as { clips?: unknown }).clips;
        if (typeof clips === 'object' && clips !== null) {
          for (const [id, saved] of Object.entries(clips)) {
            const clip = unpackClip(id, saved);
            if (clip) {
              await putClip(clip);
            }
          }
        }

        this.#load(doc);
      } catch (error) {
        this.#notice =
          errorName(error) === 'SyntaxError'
            ? "That file isn't valid JSON."
            : errorMessage(error);
        this.#render();
      }
    });
  }
}
