// Interval math for `size_threshold_region_merge`'s nested candidates (GitHub issue #91). Entry
// `i` covers region sizes `lo..=hi`: `lo` is the previous entry's `hi + 1` (1 for the first),
// `hi` is the entry's own `max_size`, and the last entry has no `hi` (everything above). Order in
// the list is the only thing that defines the intervals, so they can never overlap or leave gaps.

/** `param_overrides` key holding a candidate's upper bound (maze-core `PARAM_MAX_SIZE`). */
export const MAX_SIZE_PARAM_ID = "max_size";

/** Default width of a freshly bounded interval (`hi = lo + DEFAULT_INTERVAL_SPAN - 1`). */
export const DEFAULT_INTERVAL_SPAN = 5;

export interface SizeInterval {
  lo: number;
  /** `null` for the last entry — it covers every size from `lo` upward. */
  hi: number | null;
}

/** Non-negative integer from raw text, `null` when empty or not an integer. */
export function parseMaxSize(raw: string | undefined): number | null {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  return parseInt(raw, 10);
}

/** Intervals for the stored raw `max_size` values (one per entry, last one's value is ignored).
 * A missing/invalid `hi` falls back to the default span; a `hi` below its own `lo` is raised to
 * `lo`, so every interval holds at least one size. */
export function resolveIntervals(rawMaxSizes: (string | undefined)[]): SizeInterval[] {
  const result: SizeInterval[] = [];
  let lo = 1;
  rawMaxSizes.forEach((raw, i) => {
    if (i === rawMaxSizes.length - 1) {
      result.push({ lo, hi: null });
      return;
    }
    const hi = Math.max(parseMaxSize(raw) ?? lo + DEFAULT_INTERVAL_SPAN - 1, lo);
    result.push({ lo, hi });
    lo = hi + 1;
  });
  return result;
}

/** Applies an edit of entry `index`'s upper bound and returns every entry's resulting `max_size`
 * (`null` for the last). Invalid text keeps the entry's current bound. Later bounds that the edit
 * pushed below their own lower bound are raised, so the chain stays strictly ascending. */
export function editMaxSize(rawMaxSizes: (string | undefined)[], index: number, value: string): (string | null)[] {
  const next = [...rawMaxSizes];
  if (parseMaxSize(value) !== null) next[index] = String(parseInt(value, 10));
  return resolveIntervals(next).map((iv) => (iv.hi === null ? null : String(iv.hi)));
}

/** Indices (after `index`) whose bound `editMaxSize` raised above what the entry's own stored
 * value resolved to before the edit — the cascaded ones the user didn't type into. */
export function cascadedIndices(rawMaxSizes: (string | undefined)[], index: number, next: (string | null)[]): number[] {
  const before = resolveIntervals(rawMaxSizes);
  const pushed: number[] = [];
  next.forEach((bound, i) => {
    if (bound !== null && i > index && before[i].hi !== Number(bound)) pushed.push(i);
  });
  return pushed;
}

/** Writes every non-last entry's resolved bound into its `params`, so what the panel shows is
 * what is stored and sent: maze-core treats a missing `max_size` as unbounded, while
 * `resolveIntervals` shows the default span. Returns the same entry objects when nothing changes. */
export function withExplicitBounds<T extends { params: Record<string, string> }>(entries: T[]): T[] {
  const intervals = resolveIntervals(entries.map((e) => e.params[MAX_SIZE_PARAM_ID]));
  return entries.map((entry, i) => {
    const hi = intervals[i].hi;
    if (hi === null || entry.params[MAX_SIZE_PARAM_ID] === String(hi)) return entry;
    return { ...entry, params: { ...entry.params, [MAX_SIZE_PARAM_ID]: String(hi) } };
  });
}

/** `withExplicitBounds` applied to the entries of each slot in `slotIds` (in list order) within a
 * mixed nested list, leaving other slots' entries and the overall order untouched. */
export function withExplicitBoundsInSlots<T extends { slotId: string; params: Record<string, string> }>(
  list: T[],
  slotIds: ReadonlySet<string>,
): T[] {
  const result = [...list];
  slotIds.forEach((slotId) => {
    const positions = list.flatMap((n, i) => (n.slotId === slotId ? [i] : []));
    const fixed = withExplicitBounds(positions.map((i) => list[i]));
    positions.forEach((pos, k) => { result[pos] = fixed[k]; });
  });
  return result;
}
