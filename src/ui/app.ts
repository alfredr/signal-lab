// Ties the pieces together: the document history, the simulation worker, and
// the views that show and edit them. The editor shows one diagram at a time,
// the top level or the inside of a subsystem, chosen by `path`; the panel face
// below it shows every instrument in the document. Every change re-renders at
// once and asks the worker for a new run, which comes back with the statuses,
// readings and the signals on screen. The playhead runs on animation frames,
// following the audio while something plays.

import { blockType, categories } from '../blocks/index.ts';
import {
  CONTROL,
  isInstrument,
  PLOT,
  READOUT,
  SPEAKER,
} from '../blocks/instruments.ts';
import { visiblePorts, type Reading } from '../engine/block.ts';
import { portKey, type PortRef } from '../engine/circuit.ts';
import { errorMessage, errorName } from '../engine/errors.ts';
import { si } from '../engine/format.ts';
import type { StoredParams } from '../engine/params.ts';
import type { Signal } from '../engine/signal.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  addBlock,
  connect,
  diagramAt,
  duplicate,
  emptyDocument,
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
} from '../model/instruments.ts';
import { template } from '../model/library.ts';
import {
  displayName,
  groupAt,
  typeOf,
  ungroupAt,
} from '../model/subsystems.ts';
import { SimulationClient, type Simulation } from '../sim/client.ts';
import { Player } from './audio.ts';
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
import { Face, type Transport } from './face.ts';
import { layoutOf, snap, type Point } from './geometry.ts';
import { History } from './history.ts';
import { Inspector } from './inspector.ts';
import { portLabel } from './labels.ts';
import { showMenu, type MenuItem } from './menu.ts';
import { paletteEntries, renderPalette, TEMPLATE } from './palette.ts';
import { addOnce } from './parameters.ts';
import { inputOf, Widgets } from './widgets.ts';

const STORAGE_KEY = 'signal-lab:document';

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
  readonly #client = new SimulationClient(
    (simulation) => this.#accept(simulation),
    (message) => {
      this.#summary = `Simulation failed: ${message}`;
      this.#render();
    },
  );
  readonly #player = new Player();
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
  #readings: ReadonlyMap<string, readonly Reading[]> = new Map();
  #signals: ReadonlyMap<string, Signal> = new Map();
  /** What was last sent to the worker, so unchanged renders don't resend it. */
  #requested:
    | { readonly doc: LabDocument; readonly wanted: string }
    | undefined;
  /** A signal to play as soon as the worker sends it. */
  #pendingPlay: string | undefined;
  #slowTimer: ReturnType<typeof setTimeout> | undefined;
  #path: Path = [];
  #selection: Selection = NOTHING;
  #summary = '';
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The playhead's time in seconds, if it is out. */
  #time: number | undefined;
  /** Whether the playhead is moving on its own, without audio. */
  #running = false;
  #speed = 1;
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

    const play = (at: PortRef) => this.#play(at);
    const stop = () => this.#player.stop();
    const addPlot = (at: PortRef) => this.#addPlot(at);

    this.#widgets = new Widgets({ change, play, stop });
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
    });
    this.#face = new Face(byId('face'), {
      change,
      reveal: (id) => this.#reveal(id),
      addPlot,
      play,
      stop,
      run: () => this.#run(),
      seek: (time) => this.#seek(time),
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
    this.#player.subscribe(() => {
      this.#render();
      this.#animate();
    });
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
    this.#widgets.update({
      doc,
      signals: this.#signals,
      readings: this.#readings,
      status: this.#statuses,
      bindings,
      playing: this.#player.playing,
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
      time: this.#time,
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
    this.#status.textContent = this.#summary;
    this.#request(diagram);
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

    return {
      at,
      title: portLabel(this.#doc, at),
      signal: this.#signals.get(portKey(at)),
      playing: this.#player.playing === portKey(at),
    };
  }

  /** Port keys whose signals are on screen or playing. */
  #wanted(diagram: Diagram): string[] {
    const doc = this.#doc;
    const keys = new Set(
      faceItems(doc).flatMap((item) => {
        const at =
          item.block.kind === PLOT || item.block.kind === SPEAKER
            ? inputOf(doc, item)
            : undefined;
        return at ? [portKey(at)] : [];
      }),
    );
    const scope = this.#scopeTarget(diagram);
    for (const key of [
      scope && portKey(scope),
      this.#player.playing,
      this.#pendingPlay,
    ]) {
      if (key) {
        keys.add(key);
      }
    }

    return [...keys].sort();
  }

  /** Asks the worker for a run if the document or the signals wanted changed. */
  #request(diagram: Diagram): void {
    const doc = this.#doc;
    const wanted = this.#wanted(diagram);
    const signature = wanted.join('\n');
    if (this.#requested?.doc === doc && this.#requested.wanted === signature) {
      return;
    }

    this.#requested = { doc, wanted: signature };
    this.#client.request(doc, wanted);
    // Say so if a run takes long enough to notice.
    clearTimeout(this.#slowTimer);
    this.#slowTimer = setTimeout(() => {
      if (this.#client.busy) {
        this.#status.textContent = 'Simulating…';
      }
    }, 250);
  }

  #accept(simulation: Simulation): void {
    this.#statuses = simulation.statuses;
    this.#readings = simulation.readings;
    this.#signals = simulation.signals;

    if (simulation.recomputed > 0) {
      const blocks =
        simulation.recomputed === 1
          ? '1 block'
          : `${simulation.recomputed} blocks`;
      this.#summary = `Simulated ${si(simulation.doc.duration, 's')} in ${Math.max(1, Math.round(simulation.elapsed))} ms (${blocks})`;
    }

    this.#summary = this.#summary.replace(/ · .*$/, '');

    if (simulation.errors) {
      this.#summary += ` · ${simulation.errors === 1 ? '1 block has' : `${simulation.errors} blocks have`} an error`;
    }

    const playing = this.#player.playing;
    if (playing) {
      this.#player.refresh(this.#signals.get(playing));
    }

    const pending = this.#pendingPlay;
    const signal = pending ? this.#signals.get(pending) : undefined;
    if (pending && signal) {
      this.#pendingPlay = undefined;
      this.#player.play(pending, signal);
    }

    this.#render();
  }

  #play(at: PortRef): void {
    const key = portKey(at);
    const signal = this.#signals.get(key);
    if (signal) {
      this.#player.play(key, signal);
    } else {
      // Not on the page yet: ask the worker for it, and play it when it comes.
      this.#pendingPlay = key;
      this.#render();
    }
  }

  // The playhead.

  #transport(): Transport {
    return {
      time: this.#time,
      duration: this.#doc.duration,
      running: this.#running || this.#player.playing !== undefined,
      speed: this.#speed,
    };
  }

  /** Starts or stops the playhead; stopping also stops the sound. */
  #run(): void {
    if (this.#running || this.#player.playing) {
      this.#running = false;
      this.#player.stop();
    } else {
      this.#running = true;
      this.#time ??= 0;
      this.#animate();
    }

    this.#render();
  }

  /** Puts the playhead at `time`, or away if undefined. */
  #seek(time: number | undefined): void {
    this.#player.stop();
    this.#running = false;
    this.#time = time;
    this.#render();
  }

  /** Keeps the playhead moving, one animation frame at a time. */
  #animate(): void {
    if (this.#frame) {
      return;
    }

    this.#lastFrame = performance.now();

    const tick = (now: number) => {
      this.#frame = 0;
      const position = this.#player.position();
      const elapsed = Math.min(0.1, (now - this.#lastFrame) / 1000);
      this.#lastFrame = now;

      if (position !== undefined) {
        this.#time = position;
      } else if (this.#running) {
        const duration = this.#doc.duration;
        this.#time = ((this.#time ?? 0) + elapsed * this.#speed) % duration;
      } else {
        return;
      }

      this.#widgets.setTime(this.#time);
      this.#editor.setTime(this.#time);
      this.#face.setTransport(this.#transport());
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
      const [result, made] = duplicate(d, new Set(ids));
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
    const playing = this.#player.playing === key;
    return {
      label: playing ? 'Stop listening' : 'Listen',
      run: () => (playing ? this.#player.stop() : this.#play(ref)),
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
    const readouts = (this.#readings.get(pathId(path, block.id)) ?? []).map(
      (reading): MenuItem => ({
        label: reading.label,
        run: () => this.#addReadout(path, block.id, reading.label),
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
    this.#player.stop();
    this.#running = false;
    this.#time = undefined;
    this.#history.commit(doc);
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
      // Space starts and stops the playhead, as in audio editors.
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

    byId('export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.#doc, null, 2)], {
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
        this.#load(readDocument(JSON.parse(await chosen.text())));
      } catch (error) {
        this.#summary =
          errorName(error) === 'SyntaxError'
            ? "That file isn't valid JSON."
            : errorMessage(error);
        this.#render();
      }
    });
  }
}
