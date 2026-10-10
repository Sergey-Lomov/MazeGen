import type { TeleportEdge } from "./types";
import type { RoutedConnector } from "./teleportConnectorRouting";
import type { TeleportGroup } from "../selectors/teleportGroups";

export function coordKey(x: number, y: number): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/** Distance from a square marker's center to the point where a line along unit direction
 * (ux, uy) should stop: the square's border along that direction (Chebyshev distance,
 * half / max(|ux|, |uy|)), plus half the stroke width to compensate for the round line cap
 * extending past its geometric endpoint. Using a flat `half` alone undershoots at
 * non-axis-aligned angles and the cap still overlaps the square. `TeleportRenderer` itself no
 * longer clips its own connecting line (GitHub issue #293 follow-up: it now runs straight
 * center-to-center, occluded by the marker shapes drawn in a layer above it) — this export is kept
 * for `PostEditRenderer`/`PresetConnectionsRenderer`, which still clip their own teleport-endpoint
 * connecting lines to a fixed square marker's border the pre-#293 way. */
export function clipDistance(ux: number, uy: number, half: number, strokeWidth: number): number {
  return half / Math.max(Math.abs(ux), Math.abs(uy)) + strokeWidth / 2;
}

/** A cell/point reads as half-filled when the markers landing on it disagree: at least one edge
 * wants a filled marker there and at least one (a different edge) wants an outline marker there.
 * Returns the set of coordKey-encoded points that are mixed. */
export function computeMixedCells(edges: TeleportEdge[]): Set<string> {
  const cellWants = new Map<string, { filled: boolean; outline: boolean }>();
  const want = (cx: number, cy: number, filled: boolean) => {
    const key = coordKey(cx, cy);
    const entry = cellWants.get(key) ?? { filled: false, outline: false };
    if (filled) entry.filled = true; else entry.outline = true;
    cellWants.set(key, entry);
  };
  for (const e of edges) {
    const samePoint = coordKey(e.from[0], e.from[1]) === coordKey(e.to[0], e.to[1]);
    if (e.oneWay) {
      want(e.from[0], e.from[1], true);
      // A single-point edge (`from`/`to` at the same coordinate) is one marker, not two ends; the
      // ordinary "`to` = outline" contribution below would otherwise fight `from`'s own "filled"
      // reading at the exact same point, registering it as `"mixed"`.
      if (!samePoint) want(e.to[0], e.to[1], false);
    } else {
      want(e.from[0], e.from[1], true);
      want(e.to[0], e.to[1], true);
    }
  }
  const mixed = new Set<string>();
  for (const [key, entry] of cellWants) {
    if (entry.filled && entry.outline) mixed.add(key);
  }
  return mixed;
}

/** `"filled"` when every edge landing on this point wants it filled (an entry, or either end of a
 *  two-way), `"outline"` when every edge wants it empty (an exit-only one-way endpoint), `"mixed"`
 *  when edges disagree (rare: two different teleports through the same point, one wanting it
 *  filled, the other empty). */
export type PointFillState = "filled" | "outline" | "mixed";

export function resolvePointFillState(edges: TeleportEdge[], cx: number, cy: number): PointFillState {
  const key = coordKey(cx, cy);
  let filled = false;
  let outline = false;
  for (const e of edges) {
    const samePoint = coordKey(e.from[0], e.from[1]) === coordKey(e.to[0], e.to[1]);
    if (e.oneWay) {
      if (coordKey(e.from[0], e.from[1]) === key) filled = true;
      // See `computeMixedCells`'s own comment: a single-point edge's `to` doesn't contribute a
      // separate "outline" reading — `from`'s own "filled" reading above already fully describes it.
      if (!samePoint && coordKey(e.to[0], e.to[1]) === key) outline = true;
    } else {
      if (coordKey(e.from[0], e.from[1]) === key || coordKey(e.to[0], e.to[1]) === key) filled = true;
    }
  }
  if (filled && outline) return "mixed";
  return filled ? "filled" : "outline";
}

/** A cross-floor edge's own `to` (GitHub issue #337 — see `TeleportEdge.toFloor`'s own doc comment)
 *  isn't the real target cell, just the midpoint the connector routes toward — this point must draw
 *  a floor-number badge instead of an ordinary teleport marker. `from` can carry the same role via
 *  `fromFloor` (GitHub issue #357 follow-up — see that field's own doc comment): at most one of the
 *  two is ever set on a given edge, so both are checked independently here. Keyed by coordinate
 *  since that's how `TeleportGroup.points` itself identifies a drawable point; 0-indexed
 *  `toFloor`/`fromFloor` values are resolved to their 1-based display number (matching
 *  `FloorSwitcher`'s own convention) here so `drawFloorBadge` only ever deals in display numbers. */
export function computeFloorBadges(edges: TeleportEdge[]): Map<string, number> {
  const badges = new Map<string, number>();
  for (const e of edges) {
    if (e.toFloor !== undefined) badges.set(coordKey(e.to[0], e.to[1]), e.toFloor + 1);
    if (e.fromFloor !== undefined) badges.set(coordKey(e.from[0], e.from[1]), e.fromFloor + 1);
  }
  return badges;
}

type PlannedConnector = { edge: TeleportEdge; routed: RoutedConnector; color: number };

/** Resolves the per-group draw order `renderGroups` walks: one entry per group (in `groups`' own
 *  order), each carrying just its own connectors (an edge's own two endpoints always land
 *  in the same group — the edge itself is what `buildTeleportGroups` merges on — so every connector
 *  belongs to exactly one group unambiguously). Pure/no drawing, so the interleave order itself
 *  (a group's connectors immediately before its own points, then the next group — GitHub issue #293
 *  follow-up) is unit-testable without a `Graphics` mock. A connector whose endpoints don't resolve
 *  to any group (shouldn't happen given the above, but a defensive no-op rather than a throw) is
 *  silently dropped from the plan. */
export function planGroupDrawOrder(
  groups: TeleportGroup[],
  connectors: PlannedConnector[],
): { group: TeleportGroup; connectors: PlannedConnector[] }[] {
  const groupKeyByPoint = new Map<string, string>();
  for (const group of groups) {
    for (const [px, py] of group.points) groupKeyByPoint.set(coordKey(px, py), group.key);
  }
  const connectorsByGroup = new Map<string, PlannedConnector[]>();
  for (const c of connectors) {
    const [fx, fy] = c.edge.from;
    const groupKey = groupKeyByPoint.get(coordKey(fx, fy)) ?? groupKeyByPoint.get(coordKey(...c.edge.to));
    if (groupKey === undefined) continue;
    const bucket = connectorsByGroup.get(groupKey) ?? [];
    bucket.push(c);
    connectorsByGroup.set(groupKey, bucket);
  }

  return groups.map((group) => ({ group, connectors: connectorsByGroup.get(group.key) ?? [] }));
}
