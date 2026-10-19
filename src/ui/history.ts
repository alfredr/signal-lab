/**
 * Undo and redo history. Continuous edits call preview() during the gesture
 * and commit() at completion, producing one undo step.
 */
export class History<T> {
  static readonly LIMIT = 200;

  #present: T;
  #past: T[] = [];
  #future: T[] = [];
  /** Snapshot before the active preview gesture. */
  #anchor: { readonly value: T } | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#present = initial;
  }

  get present(): T {
    return this.#present;
  }

  get canUndo(): boolean {
    return this.#past.length > 0 || this.#anchor !== undefined;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  preview(next: T): void {
    this.#anchor ??= { value: this.#present };
    this.#present = next;
    this.#notify();
  }

  commit(next: T): void {
    const before = this.#anchor ? this.#anchor.value : this.#present;
    this.#anchor = undefined;

    if (next !== before) {
      this.#past.push(before);

      if (this.#past.length > History.LIMIT) {
        this.#past.shift();
      }

      this.#future = [];
    }

    this.#present = next;
    this.#notify();
  }

  undo(): void {
    if (this.#anchor) {
      this.#present = this.#anchor.value;
      this.#anchor = undefined;
    } else {
      const previous = this.#past.pop();
      if (previous === undefined) {
        return;
      }

      this.#future.push(this.#present);
      this.#present = previous;
    }

    this.#notify();
  }

  redo(): void {
    const next = this.#future.pop();
    if (next === undefined) {
      return;
    }

    this.#past.push(this.#present);
    this.#present = next;
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
