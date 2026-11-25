type Cell = readonly [number, number];

/** The settings variants one floor is drawn with (GitHub issue #1040): the global settings, plus one entry per distinct
 *  set of settings a zone produces for some drawn element. An element draws with the variant of the cell that owns it, so
 *  each layer is rendered once per variant, over the elements of that variant only. Variant 0 is always the global one. */
export class ZoneVariants<S> {
  private readonly all: S[];
  private readonly index = new Map<S, number>();

  constructor(base: S, private readonly settingsAt: (cells: readonly Cell[]) => S) {
    this.all = [base];
    this.index.set(base, 0);
  }

  /** Every variant seen so far, the global one first. Final only once every element has been assigned. */
  get list(): readonly S[] {
    return this.all;
  }

  /** The variant of the settings that apply to `cells` (an element belongs to the cells it touches). No cells means the global settings. */
  of(cells: readonly Cell[]): number {
    const settings = cells.length === 0 ? this.all[0] : this.settingsAt(cells);
    let found = this.index.get(settings);
    if (found === undefined) {
      found = this.all.length;
      this.all.push(settings);
      this.index.set(settings, found);
    }
    return found;
  }

  /** `items` split by variant, keyed by the cells `cellsOf` names for each item. */
  partition<T>(items: readonly T[], cellsOf: (item: T) => readonly Cell[]): T[][] {
    const out: T[][] = [];
    for (const item of items) {
      const variant = this.of(cellsOf(item));
      (out[variant] ??= []).push(item);
    }
    return out;
  }
}

/** One instance of a layer's renderer per variant, created on demand. A variant that no longer exists keeps its instance
 *  (drawn empty) so the instance is reused when it comes back. */
export class VariantPool<R extends { destroy(): void }> {
  private readonly items: R[] = [];

  constructor(private readonly make: () => R) {}

  /** Runs `draw` for every instance: with its variant while that variant exists, and with `null` to empty a surplus one. */
  drawAll(count: number, draw: (renderer: R, variant: number | null) => void): void {
    for (let i = 0; i < count; i++) {
      while (this.items.length <= i) this.items.push(this.make());
    }
    this.items.forEach((renderer, i) => draw(renderer, i < count ? i : null));
  }

  get renderers(): readonly R[] {
    return this.items;
  }

  destroy(): void {
    this.items.forEach((renderer) => renderer.destroy());
    this.items.length = 0;
  }
}
