// Block parameters: the knobs each block type exposes, with ranges and defaults. The specs
// drive both the simulation (resolved values) and the inspector (generated controls).

export type ParamValue = number | string | boolean;
export type StoredParams = { readonly [name: string]: ParamValue };

/** Units the inspector knows how to format. */
type Unit = 'Hz' | 's' | 'dB' | 'deg' | 'V' | 'x';

type ParamBase = {
  readonly label: string;
  /** A short note shown with the control. */
  readonly help?: string;
};

export type NumberParam = ParamBase & {
  readonly type: 'number';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Values snap to multiples of this; omit for a continuous value. */
  readonly step?: number;
  readonly unit?: Unit;
  /**
   * "log" spaces the slider by ratio, which suits frequencies and time
   * constants.
   */
  readonly scale?: 'linear' | 'log';
  /** When present, the control is a menu of these values instead of a slider. */
  readonly presets?: readonly number[];
};

export type ChoiceOption<T extends string = string> = {
  readonly value: T;
  readonly label: string;
};

export type ChoiceParam<T extends string = string> = ParamBase & {
  readonly type: 'choice';
  readonly default: T;
  readonly options: readonly ChoiceOption<T>[];
};

type BooleanParam = ParamBase & {
  readonly type: 'boolean';
  readonly default: boolean;
};

export type ParamSpec = NumberParam | ChoiceParam | BooleanParam;
export type ParamSpecs = { readonly [name: string]: ParamSpec };

type ParamValueOf<S> = S extends NumberParam
  ? number
  : S extends ChoiceParam<infer T>
    ? T
    : S extends BooleanParam
      ? boolean
      : never;

export type ParamValues<S extends ParamSpecs> = {
  readonly [K in keyof S]: ParamValueOf<S[K]>;
};

export function number(spec: Omit<NumberParam, 'type'>): NumberParam {
  return { type: 'number', ...spec };
}

export function choice<const T extends string>(spec: {
  readonly label: string;
  readonly help?: string;
  readonly default: NoInfer<T>;
  readonly options: readonly ChoiceOption<T>[];
}): ChoiceParam<T> {
  return { type: 'choice', ...spec };
}

/**
 * Brings a stored value into range, falling back to the default when it
 * doesn't fit the spec.
 */
export function coerceParam(
  spec: ParamSpec,
  value: ParamValue | undefined,
): ParamValue {
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return spec.default;
      }

      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      return spec.step
        ? Number((Math.round(clamped / spec.step) * spec.step).toFixed(12))
        : clamped;
    }

    case 'choice':
      return spec.options.some((option) => option.value === value)
        ? (value as string)
        : spec.default;
    case 'boolean':
      return typeof value === 'boolean' ? value : spec.default;
  }
}

/**
 * A block's parameters with defaults filled in and every value valid for its
 * spec.
 */
export function resolveParams<S extends ParamSpecs>(
  specs: S,
  stored: StoredParams,
): ParamValues<S> {
  const values: Record<string, ParamValue> = {};
  for (const [name, spec] of Object.entries(specs)) {
    values[name] = coerceParam(spec, stored[name]);
  }

  return values as ParamValues<S>;
}
