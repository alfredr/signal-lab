// The side panel: settings for what is selected, or for the document when nothing is. It
// rebuilds only when the selection changes; otherwise it updates the existing controls in
// place, so a slider being dragged is never replaced under the pointer.

import { FT8_MESSAGE } from '../blocks/ft8.ts';
import { CONTROL, PLOT, READOUT, SYMBOLS } from '../blocks/instruments.ts';
import { RECORDING } from '../blocks/sources.ts';
import { packMessage, type Place } from '../dsp/ft8/message.ts';
import {
  visiblePorts,
  type BlockType,
  type Reading,
} from '../engine/block.ts';
import type { PortRef } from '../engine/circuit.ts';
import { errorMessage, errorName } from '../engine/errors.ts';
import { formatReading } from '../engine/format.ts';
import {
  resolveParams,
  type NumberParam,
  type ParamValue,
} from '../engine/params.ts';
import type { BlockStatus } from '../engine/simulator.ts';
import {
  addParameter,
  blockAt,
  diagramAt,
  freeParameterName,
  removeParameter,
  renameParameterAt,
  renameProblem,
  setBinding,
  updateParameter,
  type Parameter,
  isSubsystem,
  pathId,
  removeBlocks,
  removeWire,
  renameBlock,
  resolveRef,
  setNotes,
  setParam,
  setSettings,
  updateDiagramAt,
  type Diagram,
  type LabBlock,
  type LabDocument,
  type Path,
} from '../model/document.ts';
import type { Bindings } from '../model/flatten.ts';
import {
  controlState,
  hasControl,
  mappers,
  parameterSpec,
  plotFrom,
  readables,
  settables,
  stackHosts,
} from '../model/instruments.ts';
import { displayName, typeOf } from '../model/subsystems.ts';
import {
  cachedClip,
  decodeClip,
  getClip,
  LONGEST,
  putClip,
  recordMicrophone,
  type Clip,
  type Recorder,
} from './clips.ts';
import { paramControl, type ChangeMode, type Control } from './controls.ts';
import { html } from './dom.ts';
import {
  NOTHING,
  selectBlocks,
  selectedBlocks,
  type Selection,
} from './editor.ts';
import { portLabel, rateLabel } from './labels.ts';
import { renderMarkdown } from './markdown.ts';
import {
  bindableControl,
  parameterList,
  type PanelHook,
} from './parameters.ts';

export type InspectorModel = {
  readonly doc: LabDocument;
  /** The diagram being edited, and where it sits in the document. */
  readonly path: Path;
  readonly diagram: Diagram;
  readonly selection: Selection;
  /** Block statuses by full id. */
  readonly status: ReadonlyMap<string, BlockStatus>;
  /** What measuring blocks report at the playhead, by full id. */
  readonly readings: ReadonlyMap<string, readonly Reading[]>;
  /** Every binding, worked out. */
  readonly bindings: Bindings;
};

export type InspectorEvents = {
  change(next: LabDocument, mode: ChangeMode): void;
  select(selection: Selection): void;
  open(path: Path): void;
  group(ids: readonly string[]): void;
  ungroup(id: string): void;
  /** Adds a plot of an output, given by full id. */
  addPlot(at: PortRef): void;
  /** Adds a control for `target` to the diagram at `path`. */
  addControl(path: Path, target: string): void;
  addReadout(path: Path, block: string, reading: string): void;
  /** Pushes a block, by full id, as a Button does. */
  press(id: string): void;
};

/** Status text for a block, empty when it is running. */
function statusText(status: BlockStatus | undefined): string {
  return status?.state === 'error'
    ? status.message
    : status?.state === 'idle'
      ? status.reason
      : '';
}

export class Inspector {
  readonly #host: HTMLElement;
  readonly #events: InspectorEvents;
  #model: InspectorModel | undefined;
  /** Identifies what the panel was built for; a change means rebuilding it. */
  #builtFor = '';
  /** Brings the built panel up to date with a new model. */
  #sync: (model: InspectorModel) => void = () => {};
  /** Shows new readings, as the playhead moves. */
  #showReadings: (readings: ReadonlyMap<string, readonly Reading[]>) => void =
    () => {};

  constructor(host: HTMLElement, events: InspectorEvents) {
    this.#host = host;
    this.#events = events;
  }

  render(model: InspectorModel): void {
    this.#model = model;
    const { selection, diagram, path } = model;
    const ids = selectedBlocks(selection);
    const block =
      ids.length === 1
        ? diagram.blocks.find((b) => b.id === ids[0])
        : undefined;
    const wire =
      selection.kind === 'wire'
        ? diagram.wires.find((w) => w.id === selection.id)
        : undefined;
    const key = block
      ? `block:${pathId(path, block.id)}:${block.kind}`
      : ids.length > 1
        ? `blocks:${path.join('/')}`
        : wire
          ? `wire:${path.join('/')}:${wire.id}`
          : `diagram:${path.join('/')}`;
    if (key !== this.#builtFor) {
      this.#builtFor = key;
      this.#showReadings = () => {};
      const type = block && typeOf(block);
      let panel: HTMLElement;
      if (block && type && isSubsystem(block)) {
        panel = this.#subsystemPanel(block, type);
      } else if (block && type) {
        panel = this.#blockPanel(block, type);
      } else if (ids.length > 1) {
        panel = this.#selectionPanel();
      } else if (wire) {
        panel = this.#wirePanel(wire.id);
      } else if (path.length) {
        panel = this.#insidePanel();
      } else {
        panel = this.#documentPanel();
      }

      this.#host.replaceChildren(panel);
    }

    this.#sync(model);
  }

  /** Shows the readings at the playhead, as it moves. */
  setReadings(readings: ReadonlyMap<string, readonly Reading[]>): void {
    this.#showReadings(readings);
  }

  get #now(): InspectorModel {
    return this.#model!;
  }

  /** Applies an edit to the diagram on screen. */
  #edit(change: <T extends Diagram>(diagram: T) => T, mode: ChangeMode): void {
    const { doc, path } = this.#now;
    this.#events.change(updateDiagramAt(doc, path, change), mode);
  }

  #nameField(
    block: LabBlock,
    type: BlockType,
  ): { element: HTMLElement; sync(block: LabBlock): void } {
    const input = html('input', {
      type: 'text',
      placeholder: type.label,
      value: block.name ?? '',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    input.addEventListener('change', () =>
      this.#edit((d) => renameBlock(d, block.id, input.value), 'commit'),
    );
    return {
      element: html(
        'div',
        { class: 'control' },
        html('label', { class: 'control-label' }, 'Name', input),
      ),
      sync: (current) => {
        if (document.activeElement !== input) {
          input.value = current.name ?? '';
        }
      },
    };
  }

  /**
   * Rows for a block's outputs: sample rate and a button to pin each to the
   * bench.
   */
  #outputRows(
    fullId: string,
    type: BlockType,
  ): { element: HTMLElement | null; sync(model: InspectorModel): void } {
    const outputs = visiblePorts(type.outputs);
    const rows = outputs.map(({ port, index }) => {
      const rate = html('span', { class: 'port-rate' });
      const pin = html('button', { type: 'button', class: 'small' });
      pin.addEventListener('click', () =>
        this.#events.addPlot({ block: fullId, port: index }),
      );
      return {
        index,
        rate,
        pin,
        row: html(
          'div',
          { class: 'port-row' },
          html(
            'span',
            { class: 'port-label' },
            outputs.length > 1 ? `Output ${port.name}` : 'Output',
          ),
          rate,
          pin,
        ),
      };
    });
    return {
      element: rows.length
        ? html('div', { class: 'ports' }, ...rows.map((r) => r.row))
        : null,
      sync: (model) => {
        const status = model.status.get(fullId);
        for (const row of rows) {
          row.rate.textContent = rateLabel(status, row.index) ?? 'no signal';
          const plotted =
            plotFrom(model.diagram, {
              block: fullId.split('/').at(-1)!,
              port: row.index,
            }) !== undefined;
          row.pin.textContent = plotted ? 'Plotted' : 'Add plot';
          row.pin.disabled = plotted;
        }
      },
    };
  }

  /**
   * Controls for one block's parameters, editing it wherever it sits in the
   * document.
   */
  /**
   * A Recording's sound: its name and length, a file to load, the microphone
   * to record from, and Play to hear it from the start.
   */
  #clipPicker(fullId: string, choose: (id: string) => void): Control {
    const about = html('span', { class: 'clip-name' });
    const status = html('span', { class: 'clip-status', role: 'status' });
    const file = html('input', {
      type: 'file',
      accept: 'audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac',
      hidden: '',
    });
    const load = html(
      'button',
      { type: 'button', class: 'small' },
      'Load file…',
    );
    const record = html(
      'button',
      { type: 'button', class: 'small' },
      'Record',
    );
    const play = html('button', { type: 'button', class: 'small' }, 'Play');
    // The recording described, undefined until the first sync.
    let shown: string | undefined;
    let recorder: Recorder | undefined;
    let ticking: ReturnType<typeof setInterval> | undefined;
    const describe = (id: string) => {
      shown = id;
      const clip = id ? cachedClip(id) : undefined;
      about.textContent = clip
        ? `${clip.name}, ${(clip.data.length / clip.rate).toFixed(1)} s`
        : id
          ? 'A recording not loaded yet'
          : 'No recording yet';

      if (id && !clip) {
        void getClip(id).then((found) => {
          if (found && shown === id) {
            describe(id);
          }
        });
      }
    };

    const take = async (made: Promise<Clip>) => {
      status.textContent = 'Decoding…';

      try {
        const clip = await made;
        await putClip(clip);
        status.textContent = '';
        choose(clip.id);
        describe(clip.id);
      } catch (error) {
        status.textContent =
          errorName(error) === 'EncodingError'
            ? "That file isn't audio this browser can read."
            : errorMessage(error);
      }
    };

    load.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';

      if (chosen) {
        void take(
          chosen.arrayBuffer().then((b) => decodeClip(b, chosen.name)),
        );
      }
    });
    record.addEventListener('click', async () => {
      if (recorder) {
        const stopping = recorder;
        recorder = undefined;
        clearInterval(ticking);
        record.textContent = 'Record';
        record.setAttribute('aria-pressed', 'false');
        void take(stopping.stop());
        return;
      }

      try {
        recorder = await recordMicrophone();
      } catch (error) {
        status.textContent =
          errorName(error) === 'NotAllowedError'
            ? 'The microphone is blocked; allow it in the browser to record.'
            : errorMessage(error);
        return;
      }

      const began = performance.now();
      record.textContent = 'Stop';
      record.setAttribute('aria-pressed', 'true');
      status.textContent = 'Recording… 0 s';
      ticking = setInterval(() => {
        const seconds = (performance.now() - began) / 1000;
        status.textContent = `Recording… ${Math.floor(seconds)} s of ${LONGEST}`;

        if (seconds >= LONGEST && recorder) {
          record.click();
        }
      }, 250);
    });
    play.addEventListener('click', () => this.#events.press(fullId));
    return {
      element: html(
        'div',
        { class: 'control clip-picker' },
        html('span', { class: 'control-label' }, 'Recording'),
        about,
        html('div', { class: 'clip-buttons' }, load, record, play, file),
        status,
      ),
      update: (value) => {
        if (String(value) !== shown) {
          describe(String(value));
        }
      },
    };
  }

  #paramControls(
    path: Path,
    block: LabBlock,
    type: BlockType,
  ): { element: HTMLElement; sync(block: LabBlock): void } {
    const controls = new Map<string, Control>();
    const bindables: { sync(): void }[] = [];
    const values = resolveParams(type.params, block.params);
    const element = html('div', { class: 'params' });
    const fullId = pathId(path, block.id);
    const current = () =>
      diagramAt(this.#now.doc, path)?.blocks.find((b) => b.id === block.id) ??
      block;
    for (const [param, spec] of Object.entries(type.params)) {
      const setValue = (value: ParamValue, mode: ChangeMode) =>
        this.#events.change(
          updateDiagramAt(this.#now.doc, path, (d) =>
            setParam(d, block.id, param, value),
          ),
          mode,
        );

      // A recording is loaded or recorded, not typed in.
      if (block.kind === RECORDING && param === 'clip') {
        const picker = this.#clipPicker(fullId, (id) =>
          setValue(id, 'commit'),
        );
        controls.set(param, picker);
        element.append(picker.element);
        continue;
      }

      // Instruments choose what they act on from lists, not typed ids.
      if (block.kind === SYMBOLS && param === 'block') {
        const picker = this.#picker(
          spec.label,
          () =>
            mappers(this.#now.doc, path).map(
              (m) => [m.block, m.label] as const,
            ),
          () => String(current().params.block ?? ''),
          (value) => setValue(value, 'commit'),
          (ref) => this.#nameOf(path, ref),
        );
        controls.set(param, picker);
        element.append(picker.element);
        continue;
      }

      if (block.kind === PLOT && param === 'stack') {
        const picker = this.#picker(
          spec.label,
          () => [
            ['none', 'Not stacked: a screen of its own'] as const,
            ...stackHosts(this.#now.doc).map(
              (host) => [host.id, host.label] as const,
            ),
          ],
          () => String(current().params.stack ?? '') || 'none',
          (value) => setValue(value === 'none' ? '' : value, 'commit'),
        );
        controls.set(param, picker);
        element.append(picker.element);
        continue;
      }

      if (block.kind === CONTROL && param === 'target') {
        const picker = this.#picker(
          spec.label,
          () =>
            settables(this.#now.doc, path).map(
              (s) => [s.target, s.label] as const,
            ),
          () => String(current().params.target ?? ''),
          (value) => setValue(value, 'commit'),
          (target) => {
            const { doc, bindings } = this.#now;
            const block = current();
            const state = controlState(doc, bindings, path, {
              ...block,
              params: { ...block.params, target },
            });
            return 'problem' in state ? undefined : state.label;
          },
        );
        controls.set(param, picker);
        element.append(picker.element);
        continue;
      }

      if (block.kind === READOUT && param === 'reading') {
        continue;
      }

      if (block.kind === READOUT && param === 'block') {
        const picker = this.#picker(
          'Shows',
          () =>
            readables(this.#now.doc, path).map(
              (r) => [JSON.stringify([r.block, r.reading]), r.label] as const,
            ),
          () => {
            const { params } = current();
            return params.block
              ? JSON.stringify([params.block, params.reading ?? ''])
              : '';
          },
          (value) => {
            const [chosen, reading] = JSON.parse(value) as [string, string];
            this.#events.change(
              updateDiagramAt(this.#now.doc, path, (d) =>
                setParam(
                  setParam(d, block.id, 'block', chosen),
                  block.id,
                  'reading',
                  reading,
                ),
              ),
              'commit',
            );
          },
          (value) => {
            const [ref, reading] = JSON.parse(value) as [string, string];
            const name = this.#nameOf(path, ref);
            return name && `${name} › ${reading}`;
          },
        );
        controls.set(param, picker);
        element.append(picker.element);
        continue;
      }

      if (spec.type !== 'number') {
        const control = paramControl(spec, values[param], setValue);
        controls.set(param, control);
        element.append(control.element);
        continue;
      }

      // Number settings can be bound to parameters.
      const bindable = bindableControl({
        spec,
        read: () => {
          const now = current();
          const binding = now.bindings?.[param];
          return {
            value: resolveParams(type.params, now.params)[param] as number,
            binding,
            resolved: this.#now.bindings.values.get(fullId)?.[param],
            error:
              binding === undefined
                ? undefined
                : this.#now.bindings.errors.get(fullId),
          };
        },
        setValue,
        setBinding: (expression) =>
          this.#events.change(
            updateDiagramAt(this.#now.doc, path, (d) =>
              setBinding(d, block.id, param, expression),
            ),
            'commit',
          ),
        expose: () =>
          this.#expose(
            path,
            block.id,
            param,
            spec,
            resolveParams(type.params, current().params)[param] as number,
          ),
        panel: this.#controlHook(path, `${block.id}.${param}`),
      });
      bindables.push(bindable);
      element.append(bindable.element);
    }

    return {
      element,
      sync: (latest) => {
        const now = resolveParams(type.params, latest.params);
        for (const [param, control] of controls) {
          control.update(now[param]);
        }

        for (const bindable of bindables) {
          bindable.sync();
        }
      },
    };
  }

  /**
   * Makes a parameter of a block's setting, in the block's own diagram, and
   * binds the setting to it. Inside a subsystem, that makes it one of the
   * subsystem's settings.
   */
  #expose(
    path: Path,
    id: string,
    setting: string,
    spec: NumberParam,
    value: number,
  ): void {
    const doc = this.#now.doc;
    const diagram = diagramAt(doc, path);
    if (!diagram) {
      return;
    }

    const name = freeParameterName(diagram, setting);
    const presets = spec.presets ?? [];
    const parameter: Parameter = {
      name,
      value,
      min: presets.length ? Math.min(...presets) : spec.min,
      max: presets.length ? Math.max(...presets) : spec.max,
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(spec.scale === 'log' ? { scale: 'log' as const } : {}),
    };
    this.#events.change(
      updateDiagramAt(doc, path, (d) =>
        setBinding(addParameter(d, parameter), id, setting, name),
      ),
      'commit',
    );
  }

  /** The parameter list of the diagram at `path`. */
  #parameters(path: Path): { element: HTMLElement; sync(): void } {
    const at = (
      change: <T extends Diagram>(diagram: T) => T,
      mode: ChangeMode = 'commit',
    ) =>
      this.#events.change(updateDiagramAt(this.#now.doc, path, change), mode);
    return parameterList({
      read: () => diagramAt(this.#now.doc, path)?.parameters ?? [],
      setValue: (name, value, mode) =>
        at((d) => updateParameter(d, name, { value }), mode),
      add: () => {
        const diagram = diagramAt(this.#now.doc, path);
        if (diagram) {
          const name = freeParameterName(diagram, 'p');
          at((d) => addParameter(d, { name, value: 1, min: 0, max: 10 }));
        }
      },
      edit: (name, next) => {
        const problem = renameProblem(this.#now.doc, path, name, next.name);
        if (problem) {
          return problem;
        }

        const renamed =
          next.name === name
            ? this.#now.doc
            : renameParameterAt(this.#now.doc, path, name, next.name);
        this.#events.change(
          updateDiagramAt(renamed, path, (d) =>
            updateParameter(d, next.name, next),
          ),
          'commit',
        );
        return undefined;
      },
      remove: (name) => at((d) => removeParameter(d, name)),
      panel: (name) => this.#controlHook(path, name),
      ...(path.length
        ? {
            outside: (name: string) => {
              const id = path.join('/');
              const expression = blockAt(this.#now.doc, id)?.bindings?.[name];
              if (expression === undefined) {
                return undefined;
              }

              const value = this.#now.bindings.values.get(id)?.[name];
              return {
                expression,
                value,
                error:
                  value === undefined
                    ? (this.#now.bindings.errors.get(id) ??
                      'can not be worked out')
                    : undefined,
              };
            },
            showOutside: () => {
              this.#events.open(path.slice(0, -1));
              this.#events.select(selectBlocks([path[path.length - 1]!]));
            },
          }
        : {}),
    });
  }

  /** A menu of what an instrument can act on, refilled as the document changes. */
  /** The name of the block `ref` refers to from the diagram at `path`. */
  #nameOf(path: Path, ref: string): string | undefined {
    const id = resolveRef(path, ref);
    const block = id === undefined ? undefined : blockAt(this.#now.doc, id);
    return block && displayName(block);
  }

  #picker(
    label: string,
    options: () => readonly (readonly [value: string, label: string])[],
    value: () => string,
    choose: (value: string) => void,
    // What a value not on the list is, such as something outside this subsystem.
    name: (value: string) => string | undefined = () => undefined,
  ): Control {
    const select = html('select', { 'aria-label': label });
    const fill = () => {
      if (document.activeElement === select) {
        return;
      }

      const chosen = value();
      const list = options();
      const known = list.some(([v]) => v === chosen);
      select.replaceChildren(
        html(
          'option',
          { value: '', disabled: true, selected: !chosen },
          'Choose…',
        ),
        ...(chosen && !known
          ? [
              html(
                'option',
                { value: chosen, selected: true },
                name(chosen) ?? 'Missing',
              ),
            ]
          : []),
        ...list.map(([v, text]) =>
          html('option', { value: v, selected: v === chosen }, text),
        ),
      );
    };

    select.addEventListener('change', () => choose(select.value));
    fill();
    return {
      element: html(
        'label',
        { class: 'control' },
        html('span', { class: 'control-label' }, label),
        select,
      ),
      update: fill,
    };
  }

  #controlHook(path: Path, target: string): PanelHook {
    return {
      added: () => {
        const diagram = diagramAt(this.#now.doc, path);
        return diagram !== undefined && hasControl(diagram, target);
      },
      add: () => this.#events.addControl(path, target),
    };
  }

  #deleteButton(ids: readonly string[], label: string): HTMLButtonElement {
    const button = html('button', { type: 'button', class: 'danger' }, label);
    button.addEventListener('click', () => {
      this.#edit((d) => removeBlocks(d, new Set(ids)), 'commit');
      this.#events.select(NOTHING);
    });
    return button;
  }

  #blockPanel(block: LabBlock, type: BlockType): HTMLElement {
    const { path } = this.#now;
    const fullId = pathId(path, block.id);
    const name = this.#nameField(block, type);
    const params = this.#paramControls(path, block, type);
    const outputs = this.#outputRows(fullId, type);
    const status = html('p', { class: 'status-note', role: 'status' });
    // What the block reports, each with its value at the playhead, if it has one.
    const values = new Map<string, HTMLElement>();
    const readings = html(
      'dl',
      { class: 'readings' },
      ...(type.reports ?? []).flatMap((label) => {
        const add = html(
          'button',
          {
            type: 'button',
            class: 'small icon',
            title: 'Add a readout of this to the diagram',
            'aria-label': `Add a readout of ${label}`,
          },
          '+',
        );
        add.addEventListener('click', () =>
          this.#events.addReadout(this.#now.path, block.id, label),
        );
        const value = html('dd', {}, '–');
        values.set(label, value);
        return [
          html('dt', {}, label),
          value,
          html('dd', { class: 'reading-add' }, add),
        ];
      }),
    );
    const packing = block.kind === FT8_MESSAGE ? this.#packing() : undefined;
    this.#showReadings = (now) => {
      const reported = now.get(fullId) ?? [];
      for (const [label, value] of values) {
        const reading = reported.find((r) => r.label === label);
        const text = reading ? formatReading(reading) : '–';
        if (value.textContent !== text) {
          value.textContent = text;
        }
      }

      packing?.show(reported);
    };

    this.#sync = (model) => {
      const current = model.diagram.blocks.find((b) => b.id === block.id);
      if (!current) {
        return;
      }

      name.sync(current);
      params.sync(current);
      packing?.sync(current);
      outputs.sync(model);
      this.#showReadings(model.readings);
      const state = model.status.get(fullId);
      status.textContent = statusText(state);
      status.dataset.state = state?.state ?? 'idle';
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, type.category),
      html('h2', {}, type.label),
      html('div', { class: 'description' }, renderMarkdown(type.description)),
      name.element,
      params.element,
      readings,
      packing?.element,
      status,
      outputs.element,
      html(
        'div',
        { class: 'actions' },
        this.#deleteButton([block.id], 'Delete block'),
      ),
    );
  }

  /**
   * How an FT8 message block's text packs into its 77 bits, field by field,
   * with the bits lit as they go out.
   */
  #packing(): {
    element: HTMLElement;
    sync(block: LabBlock): void;
    show(readings: readonly Reading[]): void;
  } {
    const fields = html('div', { class: 'pack-fields' });
    const element = html(
      'div',
      { class: 'packing' },
      html('span', { class: 'control-label' }, 'Packing'),
      html(
        'p',
        { class: 'control-help' },
        "Each field is one number, sent as a fixed count of bits, most significant first. A callsign or grid is written in a mixed base: each character's place in the alphabet for its position is a digit.",
      ),
      fields,
    );
    let shown: string | undefined;
    let bits: HTMLElement[] = [];
    let lit = -1;

    const light = (next: number) => {
      if (next === lit) {
        return;
      }

      lit = next;
      bits.forEach((bit, i) => {
        bit.classList.toggle('sent', i < lit);
        bit.classList.toggle('now', i === lit);
      });
    };

    const placesTable = (places: readonly Place[]) =>
      html(
        'table',
        { class: 'pack-places' },
        ...(
          [
            ['', (p: Place) => (p.char === ' ' ? '␣' : p.char)],
            ['place', (p: Place) => String(p.index)],
            ['of', (p: Place) => String(p.of)],
          ] as const
        ).map(([label, cell]) =>
          html(
            'tr',
            {},
            html('th', {}, label),
            ...places.map((p) => html('td', {}, cell(p))),
          ),
        ),
      );

    // ((a×36 + b)×10 + c)…: each place in units of the alphabets after it.
    const formula = (places: readonly Place[]) =>
      places.reduce(
        (expression, p, i) =>
          i === 0
            ? String(p.index)
            : `${i > 1 ? `(${expression})` : expression}×${p.of} + ${p.index}`,
        '',
      );

    return {
      element,
      sync: (block) => {
        const text = String(block.params.message ?? '');
        if (text === shown) {
          return;
        }

        shown = text;
        const packed = packMessage(text);
        if (!packed.ok) {
          bits = [];
          fields.replaceChildren(
            html('p', { class: 'pack-error' }, packed.error),
          );
          return;
        }

        bits = [];
        fields.replaceChildren(
          ...packed.fields.map((field) => {
            const own = field.bits.map((bit) => html('span', {}, String(bit)));
            bits.push(...own);
            const how = field.places
              ? `${formula(field.places)}${field.offset ? ` + ${field.offset}` : ''}`
              : field.how;
            return html(
              'div',
              { class: 'pack-field' },
              html(
                'div',
                { class: 'pack-head' },
                html('span', { class: 'pack-name' }, field.name),
                html('span', { class: 'pack-text' }, field.text || 'blank'),
                html('span', { class: 'pack-value' }, String(field.value)),
              ),
              field.places ? placesTable(field.places) : null,
              how ? html('p', { class: 'pack-how' }, how) : null,
              html(
                'p',
                {
                  class: 'pack-bits',
                  title: `${field.bits.length} bit${field.bits.length > 1 ? 's' : ''}`,
                },
                ...own,
              ),
            );
          }),
        );
        lit = -2;
        light(-1);
      },
      show: (readings) => {
        const bit = readings.find((r) => r.label === 'Bit');
        const sent = readings.find((r) => r.label === 'Sent');
        if (bit) {
          light(Number.parseInt(String(bit.value), 10) - 1);
        } else if (!readings.some((r) => r.label === 'Field')) {
          // Not between two bits of the message: before it, or after.
          light(sent && !String(sent.value).includes('·') ? bits.length : -1);
        }
      },
    };
  }

  #subsystemPanel(
    block: LabBlock & { inner: Diagram },
    type: BlockType,
  ): HTMLElement {
    const { path } = this.#now;
    const inside = [...path, block.id];
    const fullId = pathId(path, block.id);
    const name = this.#nameField(block, type);
    const outputs = this.#outputRows(fullId, type);
    const notes = this.#notes(inside);
    const status = html('p', { class: 'status-note', role: 'status' });

    // The subsystem's own settings: the parameters declared inside it, which
    // can also be bound to parameters out here.
    const settingsBox = html('div', { class: 'params' });
    const settingsBlock = html(
      'div',
      { class: 'settings' },
      html('span', { class: 'control-label' }, 'Settings'),
      settingsBox,
    );
    let settingsShape = '';
    let settings: { element: HTMLElement; sync(): void }[] = [];
    const parameterIn = (name: string) =>
      diagramAt(this.#now.doc, inside)?.parameters?.find(
        (p) => p.name === name,
      );
    const buildSettings = (parameters: readonly Parameter[]) => {
      settings = parameters.map((parameter) =>
        bindableControl({
          spec: parameterSpec(parameter),
          read: () => {
            const holder = diagramAt(this.#now.doc, path)?.blocks.find(
              (b) => b.id === block.id,
            );
            const binding = holder?.bindings?.[parameter.name];
            return {
              value: parameterIn(parameter.name)?.value ?? parameter.value,
              binding,
              resolved:
                this.#now.bindings.values.get(fullId)?.[parameter.name],
              error:
                binding === undefined
                  ? undefined
                  : this.#now.bindings.errors.get(fullId),
            };
          },
          setValue: (value, mode) =>
            this.#events.change(
              updateDiagramAt(this.#now.doc, inside, (d) =>
                updateParameter(d, parameter.name, { value }),
              ),
              mode,
            ),
          setBinding: (expression) =>
            this.#events.change(
              updateDiagramAt(this.#now.doc, path, (d) =>
                setBinding(d, block.id, parameter.name, expression),
              ),
              'commit',
            ),
          expose: () =>
            this.#expose(
              path,
              block.id,
              parameter.name,
              parameterSpec(parameter),
              parameterIn(parameter.name)?.value ?? parameter.value,
            ),
          panel: this.#controlHook(path, `${block.id}.${parameter.name}`),
        }),
      );
      settingsBox.replaceChildren(
        ...settings.map((setting) => setting.element),
      );
      settingsBlock.hidden = parameters.length === 0;
    };

    // The parameters of everything inside, one group per block, so a ready-made subsystem can
    // be adjusted without opening it.
    const groups = block.inner.blocks.flatMap(
      (
        inner,
      ): {
        id: string;
        element: HTMLElement;
        sync(block: LabBlock): void;
      }[] => {
        const innerType = typeOf(inner);
        if (!innerType) {
          return [];
        }

        if (isSubsystem(inner)) {
          const open = html(
            'button',
            { type: 'button', class: 'small' },
            'Open',
          );
          open.addEventListener('click', () =>
            this.#events.open([...inside, inner.id]),
          );
          return [
            {
              id: inner.id,
              element: html(
                'div',
                { class: 'inner-block' },
                html('span', { class: 'inner-name' }, displayName(inner)),
                open,
              ),
              sync: () => {},
            },
          ];
        }

        if (Object.keys(innerType.params).length === 0) {
          return [];
        }

        const controls = this.#paramControls(inside, inner, innerType);
        return [
          {
            id: inner.id,
            element: html(
              'fieldset',
              { class: 'inner-params' },
              html('legend', {}, displayName(inner)),
              controls.element,
            ),
            sync: controls.sync,
          },
        ];
      },
    );

    const open = html('button', { type: 'button' }, 'Open');
    open.addEventListener('click', () => this.#events.open(inside));
    const ungroup = html('button', { type: 'button' }, 'Ungroup');
    ungroup.addEventListener('click', () => this.#events.ungroup(block.id));

    this.#sync = (model) => {
      const current = model.diagram.blocks.find((b) => b.id === block.id);
      if (!current) {
        return;
      }

      name.sync(current);
      outputs.sync(model);
      notes.sync(model);
      const innerNow = diagramAt(model.doc, inside);
      const parameters = innerNow?.parameters ?? [];
      const shape = JSON.stringify(
        parameters.map(({ value: _, ...rest }) => rest),
      );
      if (shape !== settingsShape) {
        settingsShape = shape;
        buildSettings(parameters);
      }

      for (const setting of settings) {
        setting.sync();
      }

      for (const group of groups) {
        const innerBlock = innerNow?.blocks.find((b) => b.id === group.id);
        if (innerBlock) {
          group.sync(innerBlock);
        }
      }

      const state = model.status.get(fullId);
      status.textContent = statusText(state);
      status.dataset.state = state?.state ?? 'idle';
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, 'Subsystem'),
      html('h2', {}, block.name || 'Subsystem'),
      html(
        'p',
        { class: 'description' },
        `${block.inner.blocks.length} blocks inside. Double-click it, or press Open, to see and edit them. Its ports are the Input and Output terminals inside.`,
      ),
      name.element,
      html('div', { class: 'actions' }, open, ungroup),
      settingsBlock,
      notes.element,
      groups.length
        ? html(
            'details',
            { class: 'inside', open: !block.inner.parameters?.length },
            html('summary', { class: 'control-label' }, 'Everything inside'),
            html('div', { class: 'params' }, ...groups.map((g) => g.element)),
          )
        : null,
      status,
      outputs.element,
      html(
        'div',
        { class: 'actions' },
        this.#deleteButton([block.id], 'Delete subsystem'),
      ),
    );
  }

  #selectionPanel(): HTMLElement {
    const count = html('h2', {});
    const group = html('button', { type: 'button' }, 'Group into subsystem');
    group.addEventListener('click', () =>
      this.#events.group(selectedBlocks(this.#now.selection)),
    );
    const remove = html(
      'button',
      { type: 'button', class: 'danger' },
      'Delete blocks',
    );
    remove.addEventListener('click', () => {
      const ids = new Set(selectedBlocks(this.#now.selection));
      this.#edit((d) => removeBlocks(d, ids), 'commit');
      this.#events.select(NOTHING);
    });

    this.#sync = (model) => {
      count.textContent = `${selectedBlocks(model.selection).length} blocks`;
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, 'Selection'),
      count,
      html(
        'p',
        { class: 'description' },
        "Group them into a subsystem to tidy the diagram or treat them as one block. Wires crossing the edge of the selection become the subsystem's inputs and outputs.",
      ),
      html('div', { class: 'actions' }, group, remove),
    );
  }

  #wirePanel(id: string): HTMLElement {
    const description = html('p', { class: 'description' });
    const rate = html('p', { class: 'port-rate' });
    const pin = html('button', { type: 'button', class: 'small' });
    const remove = html(
      'button',
      { type: 'button', class: 'danger' },
      'Delete wire',
    );
    const source = () => {
      const { diagram, path } = this.#now;
      const wire = diagram.wires.find((w) => w.id === id);
      return (
        wire && { block: pathId(path, wire.from.block), port: wire.from.port }
      );
    };

    pin.addEventListener('click', () => {
      const at = source();
      if (at) {
        this.#events.addPlot(at);
      }
    });
    remove.addEventListener('click', () => {
      this.#edit((d) => removeWire(d, id), 'commit');
      this.#events.select(NOTHING);
    });

    this.#sync = (model) => {
      const wire = model.diagram.wires.find((w) => w.id === id);
      const at = source();
      if (!wire || !at) {
        return;
      }

      const to = {
        block: pathId(model.path, wire.to.block),
        port: wire.to.port,
      };
      description.textContent = `From ${portLabel(model.doc, at)} to ${portLabel(model.doc, to, 'in')}.`;
      const value = rateLabel(model.status.get(at.block), at.port);
      rate.textContent = value ? `${value} sample rate` : 'No signal';
      const plotted = plotFrom(model.diagram, wire.from) !== undefined;
      pin.textContent = plotted ? 'Plotted' : 'Add plot';
      pin.disabled = plotted;
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, 'Wire'),
      html('h2', {}, 'Signal'),
      description,
      rate,
      html('div', { class: 'actions' }, pin, remove),
    );
  }

  /** A diagram's notes, shown as Markdown, with a button to edit the source. */
  #notes(path: Path): {
    element: HTMLElement;
    sync(model: InspectorModel): void;
  } {
    const view = html('div', { class: 'notes' });
    const source = html('textarea', {
      rows: 10,
      spellcheck: 'true',
      hidden: true,
      'aria-label': 'Notes',
    });
    const hint = html(
      'p',
      { class: 'control-help', hidden: true },
      'Markdown: **bold**, *italic*, `code`, [link](https://...), - lists, # headings, > quotes. Math: $...$ inline, $$...$$ on its own line.',
    );
    const toggle = html('button', { type: 'button', class: 'small' }, 'Edit');
    toggle.addEventListener('click', () => {
      const editing = source.hidden;
      source.hidden = !editing;
      hint.hidden = !editing;
      view.hidden = editing;
      toggle.textContent = editing ? 'Done' : 'Edit';

      if (editing) {
        source.focus();
      }
    });
    source.addEventListener('change', () =>
      this.#events.change(
        setNotes(this.#now.doc, path, source.value),
        'commit',
      ),
    );
    let shown: string | undefined;

    return {
      element: html(
        'div',
        { class: 'notes-block' },
        html(
          'div',
          { class: 'notes-head' },
          html('span', { class: 'control-label' }, 'Notes'),
          toggle,
        ),
        view,
        source,
        hint,
      ),
      sync: (model) => {
        const notes = diagramAt(model.doc, path)?.notes ?? '';
        if (document.activeElement !== source) {
          source.value = notes;
        }

        if (notes !== shown) {
          shown = notes;
          view.replaceChildren(
            notes.trim()
              ? renderMarkdown(notes)
              : html('p', { class: 'muted' }, 'No notes yet.'),
          );
        }
      },
    };
  }

  /**
   * What shows inside a subsystem when nothing is selected: its name and
   * notes.
   */
  #insidePanel(): HTMLElement {
    const { path } = this.#now;
    const parent = path.slice(0, -1);
    const id = path[path.length - 1]!;
    const title = html('h2', {});
    const name = html('input', {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Subsystem',
    });
    name.addEventListener('change', () =>
      this.#events.change(
        updateDiagramAt(this.#now.doc, parent, (d) =>
          renameBlock(d, id, name.value),
        ),
        'commit',
      ),
    );
    const notes = this.#notes(path);
    const parameters = this.#parameters(path);
    const up = html('button', { type: 'button' }, 'Up a level');
    up.addEventListener('click', () => this.#events.open(parent));

    this.#sync = (model) => {
      const block = diagramAt(model.doc, parent)?.blocks.find(
        (b) => b.id === id,
      );
      title.textContent = block?.name || 'Subsystem';

      if (document.activeElement !== name) {
        name.value = block?.name ?? '';
      }

      parameters.sync();
      notes.sync(model);
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, 'Inside subsystem'),
      title,
      html(
        'div',
        { class: 'description' },
        renderMarkdown(
          "The Input and Output terminals here are the subsystem's ports. Beside each is what it is wired to outside, in this copy, and above a block are the controls and readouts outside that set or read it; click a name to go there. Its notes go wherever it is copied.",
        ),
      ),
      html(
        'div',
        { class: 'control' },
        html('label', { class: 'control-label' }, 'Name', name),
      ),
      parameters.element,
      notes.element,
      html('div', { class: 'actions' }, up),
    );
  }

  #documentPanel(): HTMLElement {
    const title = html('input', {
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    title.addEventListener('change', () =>
      this.#events.change(
        setSettings(this.#now.doc, {
          title: title.value.trim() || 'Untitled',
        }),
        'commit',
      ),
    );
    const notes = this.#notes([]);
    const parameters = this.#parameters([]);

    this.#sync = (model) => {
      if (document.activeElement !== title) {
        title.value = model.doc.title;
      }

      parameters.sync();
      notes.sync(model);
    };

    return html(
      'div',
      { class: 'panel' },
      html('p', { class: 'kicker' }, 'Diagram'),
      html(
        'div',
        { class: 'control' },
        html('label', { class: 'control-label' }, 'Title', title),
      ),
      parameters.element,
      notes.element,
      html(
        'div',
        { class: 'help' },
        html('p', { class: 'control-label' }, 'How it works'),
        html(
          'ul',
          {},
          html(
            'li',
            {},
            'Drag blocks in from the palette, or click one to add it.',
          ),
          html(
            'li',
            {},
            "Drag from an output (right side) to an input to wire them. Drag a wire's end off an input to remove it.",
          ),
          html(
            'li',
            {},
            'Press Run to start the stream; time runs on until you pause it, and Reset takes it back to 0. Turning a knob changes what happens from then on.',
          ),
          html(
            'li',
            {},
            'Click a wire or block to see its signal on the panel, and Add plot to keep it there. Turn a speaker on to listen.',
          ),
          html(
            'li',
            {},
            'Shift-click or shift-drag to select several blocks, then group them into a subsystem. Double-click a subsystem to open it.',
          ),
          html(
            'li',
            {},
            'The mouse wheel or a pinch zooms; drag the background, or scroll with two fingers, to pan. Delete removes the selection, ⌘Z undoes, Esc steps out of a subsystem.',
          ),
          html(
            'li',
            {},
            'Notes take Markdown and TeX math between dollar signs. Subsystems have notes of their own.',
          ),
        ),
      ),
    );
  }
}
