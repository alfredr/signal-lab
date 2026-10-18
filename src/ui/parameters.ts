// Inspector pieces for parameters: a number setting that can be bound to an
// expression, and the editable list of a diagram's parameters.

import type { NumberParam, Unit } from '../engine/params.ts';
import type { Parameter } from '../model/document.ts';
import { isParameterName } from '../model/expressions.ts';
import { parameterSpec } from '../model/instruments.ts';
import {
  formatParam,
  paramControl,
  parseQuantity,
  type ChangeMode,
} from './controls.ts';
import { html } from './dom.ts';
import { showMenu, type MenuItem } from './menu.ts';

/**
 * Adding a Control for a setting or parameter, which puts it on the panel
 * face.
 */
export type PanelHook = {
  /** Whether it has one already. */
  readonly added: () => boolean;
  readonly add: () => void;
};

/** A menu item that adds something, unless it is there already. */
export function addOnce(
  label: string,
  added: boolean,
  add: () => void,
): MenuItem {
  return {
    label,
    ...(added ? { hint: 'there already', disabled: true } : {}),
    run: add,
  };
}

/** How a bindable setting reads and changes its state. */
export type Bindable = {
  readonly spec: NumberParam;
  /** The current state, read again on every sync. */
  read(): {
    readonly value: number;
    readonly binding: string | undefined;
    readonly resolved: number | undefined;
    readonly error: string | undefined;
  };
  setValue(value: number, mode: ChangeMode): void;
  setBinding(expression: string | undefined): void;
  /** Turns the setting into a parameter of its diagram, bound to it. */
  expose?(): void;
  readonly panel?: PanelHook;
};

/**
 * A number setting with an ƒ button. Bound, it shows its expression and the
 * value worked out from it in place of the slider.
 */
export function bindableControl(bindable: Bindable): {
  element: HTMLElement;
  sync(): void;
} {
  const initial = bindable.read();
  const control = paramControl(bindable.spec, initial.value, (value, mode) =>
    bindable.setValue(value as number, mode),
  );
  const expression = html('input', {
    type: 'text',
    class: 'expression',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'an expression, such as fc / 2',
    'aria-label': `${bindable.spec.label} expression`,
  });
  const result = html('span', { class: 'expression-result' });
  const row = html(
    'div',
    { class: 'expression-row', hidden: true },
    html('span', { class: 'expression-sign' }, '='),
    expression,
    result,
  );
  const button = html(
    'button',
    {
      type: 'button',
      class: 'bind-button',
      title: 'Bind to parameters',
      'aria-label': `Bind ${bindable.spec.label}`,
    },
    'ƒ',
  );
  const element = html(
    'div',
    { class: 'bindable' },
    control.element,
    row,
    button,
  );
  /** Showing the expression field before anything is bound. */
  let editing = false;

  const sync = () => {
    const { value, binding, resolved, error } = bindable.read();
    const bound = binding !== undefined || editing;
    element.classList.toggle('bound', bound);
    row.hidden = !bound;

    if (document.activeElement !== expression) {
      expression.value = binding ?? '';
    }

    result.textContent =
      error ??
      (resolved === undefined ? '' : formatParam(resolved, bindable.spec));
    result.classList.toggle('error', error !== undefined);
    control.update(resolved ?? value);
  };

  button.addEventListener('click', () => {
    const { binding } = bindable.read();
    const items: MenuItem[] = [
      {
        label: binding ? 'Edit the expression' : 'Bind to an expression',
        run: () => {
          editing = true;
          sync();
          expression.focus();
        },
      },
    ];
    if (bindable.expose && !binding) {
      items.push({
        label: 'Make a parameter of this',
        run: () => bindable.expose!(),
      });
    }

    if (binding) {
      items.push({
        label: 'Unbind',
        run: () => bindable.setBinding(undefined),
      });
    }

    const { panel } = bindable;
    if (panel) {
      items.push(
        'separator',
        addOnce('Add a control', panel.added(), panel.add),
      );
    }

    const at = button.getBoundingClientRect();
    showMenu(items, { x: at.left, y: at.bottom + 4 });
  });
  expression.addEventListener('change', () => {
    editing = false;
    bindable.setBinding(expression.value);
  });
  expression.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      expression.blur();
    } else if (event.key === 'Escape') {
      editing = false;
      expression.value = bindable.read().binding ?? '';
      expression.blur();
      sync();
    }
  });
  expression.addEventListener('blur', () => {
    if (editing && !expression.value.trim()) {
      editing = false;
      sync();
    }
  });

  sync();
  return { element, sync };
}

export type ParameterListEvents = {
  read(): readonly Parameter[];
  setValue(name: string, value: number, mode: ChangeMode): void;
  add(): void;
  /** Applies an edit, or says why it can't be made. */
  edit(name: string, next: Parameter): string | undefined;
  remove(name: string): void;
  panel(name: string): PanelHook;
};

const UNITS: readonly (Unit | '')[] = ['', 'Hz', 's', 'dB', 'deg', 'V', 'x'];

/** The form for a parameter's name, range, unit and scale. */
function editForm(
  parameter: Parameter,
  apply: (next: Parameter) => string | undefined,
  close: () => void,
): HTMLElement {
  const field = (label: string, input: HTMLElement) =>
    html('label', { class: 'mini-field' }, html('span', {}, label), input);
  const name = html('input', {
    type: 'text',
    value: parameter.name,
    spellcheck: 'false',
  });
  const min = html('input', {
    type: 'text',
    value: String(parameter.min),
    inputmode: 'decimal',
  });
  const max = html('input', {
    type: 'text',
    value: String(parameter.max),
    inputmode: 'decimal',
  });
  const unit = html(
    'select',
    {},
    ...UNITS.map((u) =>
      html(
        'option',
        { value: u, selected: u === (parameter.unit ?? '') },
        u || 'none',
      ),
    ),
  );
  const log = html('input', {
    type: 'checkbox',
    checked: parameter.scale === 'log',
  });
  const problem = html('p', { class: 'control-help error' });
  const ok = html('button', { type: 'button', class: 'small' }, 'Apply');
  const cancel = html('button', { type: 'button', class: 'small' }, 'Cancel');
  ok.addEventListener('click', () => {
    const low = parseQuantity(min.value);
    const high = parseQuantity(max.value);
    if (!isParameterName(name.value)) {
      problem.textContent =
        'A name is letters, digits and _, starting with a letter, and not a function such as sqrt.';
      return;
    }

    if (low === undefined || high === undefined || !(low < high)) {
      problem.textContent =
        'The range needs a lowest value below the highest.';
      return;
    }

    if (log.checked && low <= 0) {
      problem.textContent = 'A log scale needs a range above zero.';
      return;
    }

    const next: Parameter = {
      name: name.value,
      value: Math.min(high, Math.max(low, parameter.value)),
      min: low,
      max: high,
      ...(unit.value ? { unit: unit.value as Unit } : {}),
      ...(log.checked ? { scale: 'log' as const } : {}),
    };
    const error = apply(next);
    if (error) {
      problem.textContent = error;
    } else {
      close();
    }
  });
  cancel.addEventListener('click', close);
  return html(
    'div',
    { class: 'parameter-form' },
    field('Name', name),
    html('div', { class: 'mini-row' }, field('From', min), field('To', max)),
    html(
      'div',
      { class: 'mini-row' },
      field('Unit', unit),
      html(
        'label',
        { class: 'control check' },
        log,
        html('span', {}, 'log scale'),
      ),
    ),
    problem,
    html('div', { class: 'actions' }, ok, cancel),
  );
}

/** A diagram's parameters: a control for each, editable, plus a way to add one. */
export function parameterList(events: ParameterListEvents): {
  element: HTMLElement;
  sync(): void;
} {
  const rows = html('div', { class: 'parameter-list' });
  const add = html(
    'button',
    { type: 'button', class: 'small' },
    'Add parameter',
  );
  add.addEventListener('click', () => events.add());
  const element = html(
    'div',
    { class: 'parameters' },
    html(
      'div',
      { class: 'notes-head' },
      html('span', { class: 'control-label' }, 'Parameters'),
      add,
    ),
    html(
      'p',
      { class: 'control-help' },
      'Names to use in bindings: press ƒ beside any number setting. In a subsystem, they are its settings.',
    ),
    rows,
  );

  let shape = '';
  let controls: { name: string; update(value: number): void }[] = [];
  let editing: string | undefined;

  const build = (parameters: readonly Parameter[]) => {
    controls = [];
    rows.replaceChildren(
      ...parameters.map((parameter) => {
        const control = paramControl(
          parameterSpec(parameter),
          parameter.value,
          (value, mode) =>
            events.setValue(parameter.name, value as number, mode),
        );
        controls.push({
          name: parameter.name,
          update: (value) => control.update(value),
        });
        const more = html(
          'button',
          {
            type: 'button',
            class: 'bind-button',
            'aria-label': `Edit ${parameter.name}`,
            title: 'Edit',
          },
          '⋯',
        );
        const row = html(
          'div',
          { class: 'bindable parameter' },
          control.element,
          more,
        );
        if (editing === parameter.name) {
          row.append(
            editForm(
              parameter,
              (next) => {
                const error = events.edit(parameter.name, next);
                if (!error) {
                  editing = undefined;
                }

                return error;
              },
              () => {
                editing = undefined;
                shape = '';
                sync();
              },
            ),
          );
        }

        more.addEventListener('click', () => {
          const at = more.getBoundingClientRect();
          const panel = events.panel(parameter.name);
          showMenu(
            [
              {
                label: 'Name, range and unit…',
                run: () => {
                  editing = parameter.name;
                  shape = '';
                  sync();
                },
              },
              addOnce('Add a control', panel.added(), panel.add),
              'separator',
              {
                label: 'Delete',
                danger: true,
                run: () => events.remove(parameter.name),
              },
            ],
            { x: at.left, y: at.bottom + 4 },
          );
        });
        return row;
      }),
    );
  };

  function sync(): void {
    const parameters = events.read();
    const next = JSON.stringify([
      parameters.map(({ value: _, ...rest }) => rest),
      editing,
    ]);
    if (next !== shape) {
      shape = next;
      build(parameters);
    }

    for (const control of controls) {
      const parameter = parameters.find((p) => p.name === control.name);
      if (parameter) {
        control.update(parameter.value);
      }
    }
  }

  sync();
  return { element, sync };
}
