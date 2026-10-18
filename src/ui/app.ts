// Ties the pieces together: the document history, the simulator, and the views that show and
// edit them. The editor shows one diagram at a time, the top level or the inside of a
// subsystem, chosen by `path`. Every change re-renders at once and schedules a simulation of
// the flattened document for the next frame; the simulator's cache keeps that cheap.

import { blockType, categories } from '../blocks/index.ts';
import { visiblePorts } from '../engine/block.ts';
import { portKey, type PortRef } from '../engine/circuit.ts';
import { errorMessage, errorName } from '../engine/errors.ts';
import { si } from '../engine/format.ts';
import type { Signal } from '../engine/signal.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import { Simulator } from '../engine/simulator.ts';
import {
  addBlock,
  diagramAt,
  duplicate,
  emptyDocument,
  isSubsystem,
  pathId,
  probeAt,
  pruneProbes,
  readDocument,
  removeBlocks,
  removeWire,
  SUBSYSTEM,
  toggleProbe,
  updateDiagramAt,
  wireInto,
  type Diagram,
  type LabDocument,
  type Path,
} from '../model/document.ts';
import { examples } from '../model/examples.ts';
import {
  blockStatuses,
  flatten,
  signalsWithAliases,
} from '../model/flatten.ts';
import { template } from '../model/library.ts';
import {
  displayName,
  groupAt,
  typeOf,
  ungroupAt,
} from '../model/subsystems.ts';
import { Player } from './audio.ts';
import { Bench } from './bench.ts';
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
import { layoutOf, snap, type Point } from './geometry.ts';
import { History } from './history.ts';
import { Inspector } from './inspector.ts';
import { showMenu, type MenuItem } from './menu.ts';
import { paletteEntries, renderPalette, TEMPLATE } from './palette.ts';

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

export class App {
  readonly #history: History<LabDocument>;
  readonly #simulator = new Simulator(blockType);
  readonly #player = new Player();
  readonly #editor: DiagramEditor;
  readonly #inspector: Inspector;
  readonly #bench: Bench;
  readonly #status = byId('status');
  readonly #title = byId('doc-title');
  readonly #crumbs = byId('crumbs');
  readonly #undo = byId<HTMLButtonElement>('undo');
  readonly #redo = byId<HTMLButtonElement>('redo');
  #statuses: ReadonlyMap<string, BlockStatus> = new Map();
  #signals: ReadonlyMap<string, Signal> = new Map();
  #simulated: LabDocument | undefined;
  #path: Path = [];
  #selection: Selection = NOTHING;
  #summary = '';
  #frame = 0;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.#history = new History(loadSaved() ?? examples[0]!.build());
    const change = (next: LabDocument, mode: ChangeMode) =>
      this.#change(next, mode);
    const select = (selection: Selection) => {
      this.#selection = selection;
      this.#render();
    };

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
    });
    this.#bench = new Bench(byId('bench'), {
      change,
      play: (at) => this.#play(at),
      stop: () => this.#player.stop(),
    });
    renderPalette(byId('palette'), (key) =>
      this.#add(key, this.#editor.center()),
    );

    this.#history.subscribe(() => {
      this.#render();
      this.#scheduleRun();
      this.#scheduleSave();
    });
    this.#player.subscribe(() => this.#render());
    this.#bindToolbar();
    addEventListener('keydown', (event) => this.#keydown(event));

    this.#render();
    this.#editor.fit();
    this.#scheduleRun();
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
      this.#history.commit(pruneProbes(next));
    }
  }

  #render(): void {
    const doc = this.#doc;
    const diagram = this.#diagram;
    this.#dropStaleSelection(diagram);
    const probes = new Map(
      doc.probes.map((probe, i) => [portKey(probe.at), i + 1]),
    );
    this.#editor.render({
      diagram,
      path: this.#path,
      selection: this.#selection,
      status: this.#statuses,
      probes,
    });
    this.#inspector.render({
      doc,
      path: this.#path,
      diagram,
      selection: this.#selection,
      status: this.#statuses,
    });
    this.#bench.render({
      doc,
      signals: this.#signals,
      scope: this.#scopeTarget(diagram),
      playing: this.#player.playing,
    });
    this.#renderCrumbs();
    this.#title.textContent = doc.title;
    this.#undo.disabled = !this.#history.canUndo;
    this.#redo.disabled = !this.#history.canRedo;
    this.#status.textContent = this.#summary;
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
   * first output.
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
      if (block && first) {
        return { block: pathId(this.#path, block.id), port: first.index };
      }
    }

    return undefined;
  }

  #scheduleRun(): void {
    if (this.#frame) {
      return;
    }

    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#run();
    });
  }

  #run(): void {
    const doc = this.#doc;
    if (doc === this.#simulated) {
      return;
    }

    const started = performance.now();
    const flat = flatten(doc);
    const result = this.#simulator.run(flat.circuit);
    const elapsed = performance.now() - started;
    this.#simulated = doc;
    this.#statuses = blockStatuses(doc, flat, result.status);
    this.#signals = signalsWithAliases(result.signals, flat.aliases);

    if (result.recomputed > 0) {
      const blocks =
        result.recomputed === 1 ? '1 block' : `${result.recomputed} blocks`;
      this.#summary = `Simulated ${si(doc.duration, 's')} in ${Math.max(1, Math.round(elapsed))} ms (${blocks})`;
    }

    const errors = [...result.status.values()].filter(
      (status) => status.state === 'error',
    ).length;
    this.#summary = this.#summary.replace(/ · .*$/, '');

    if (errors) {
      this.#summary += ` · ${errors === 1 ? '1 block has' : `${errors} blocks have`} an error`;
    }

    const playing = this.#player.playing;
    if (playing) {
      this.#player.refresh(this.#signals.get(playing));
    }

    this.#render();
  }

  #play(at: PortRef): void {
    const signal = this.#signals.get(portKey(at));
    if (signal) {
      this.#player.play(portKey(at), signal);
    }
  }

  #open(path: Path): void {
    if (!diagramAt(this.#doc, path)) {
      return;
    }

    this.#path = path;
    this.#selection = NOTHING;
    this.#render();
    this.#editor.fit();
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

  #togglePin(ref: PortRef, what: string): MenuItem {
    return {
      label: probeAt(this.#doc, ref)
        ? `Unpin ${what}`
        : `Pin ${what} to bench`,
      run: () => this.#change(toggleProbe(this.#doc, ref), 'commit'),
    };
  }

  #toggleListen(ref: PortRef): MenuItem {
    const key = portKey(ref);
    const playing = this.#player.playing === key;
    return {
      label: playing ? 'Stop listening' : 'Listen',
      disabled: !playing && !this.#signals.has(key),
      run: () => (playing ? this.#player.stop() : this.#play(ref)),
    };
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
          items = [
            this.#togglePin(full(target.ref), 'this output'),
            this.#toggleListen(full(target.ref)),
          ];
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
          this.#togglePin(full(wire.from), 'signal'),
          this.#toggleListen(full(wire.from)),
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
        const ref = (index: number) => ({
          block: pathId(path, block.id),
          port: index,
        });
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
          ...outputs.map(({ port, index }) =>
            this.#togglePin(
              ref(index),
              outputs.length > 1 ? `output ${port.name}` : 'output',
            ),
          ),
          ...(outputs[0]
            ? [this.#toggleListen(ref(outputs[0].index)), 'separator' as const]
            : []),
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
