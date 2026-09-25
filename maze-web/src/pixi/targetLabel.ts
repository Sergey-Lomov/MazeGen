/** Shared formatter for a point's status-bar/dialog/debug-tape display label (GitHub issue #602) —
 *  replaces the ten independent copies of this "coordinates [+ floor] [+ split-node name]" text
 *  that had grown across the preset stage, the post-edit stage, and the debug event tree, each
 *  with its own visual convention (some wrapped in parens, some used a comma coordinate separator,
 *  some never resolved a split-node suffix at all — GitHub issue #595's follow-up: a teleport/
 *  vertical-passage/elevator target landing on a split tile only showed its floor, never which
 *  node it actually resolves to).
 *
 *  One visual convention now: `x:y` coordinates (colon-separated), prefixed with `Lf ` (`L` +
 *  1-based floor, a plain space as the floor/coordinate separator) when `includeFloor` — a `:`
 *  there read as part of the coordinates themselves and blurred into them once either number went
 *  negative (`L2:-4:3`). A trailing ` (<label>)` follows when the point is a split tile.
 *
 *  This module only formats already-resolved primitives — it knows nothing about `PresetEndpoint`,
 *  `PostEditEndpoint`/`NodeDto`, or the debug tape's own node snapshot, so it works for every
 *  stage's own data shape. Each stage keeps its own resolver (`presetTargetLabel` in
 *  `presetSplitLabels.ts`, `postEditTargetLabel` in `postEditSplitLabels.ts`, `bubbleLabel` in
 *  `debugRowText.ts`) responsible for turning its own endpoint/node into the `point`/`level`/
 *  `includeFloor`/`splitLabel` this function takes — `includeFloor`'s meaning (cross-floor-relative-
 *  to-the-active-floor, multi-floor-maze-at-all, or always) is entirely the caller's own call,
 *  matching whatever that call site showed before this refactor. */
export function formatTargetLabel(
  point: readonly [number, number],
  level: number,
  includeFloor: boolean,
  splitLabel: string | undefined,
): string {
  const coordText = `${point[0]}:${point[1]}`;
  const body = includeFloor ? `L${level + 1} ${coordText}` : coordText;
  return splitLabel ? `${body} (${splitLabel})` : body;
}
