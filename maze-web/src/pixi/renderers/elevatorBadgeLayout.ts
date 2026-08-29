import type { ElevatorBadgePlacement } from "../../store/imageExportTypes";
import { TILE_SIZE } from "../constants";

// Label formatting moved to the neutral `indexLabel.ts` (shared with GitHub issue #471's marker
// index labels). Re-exported here so existing importers keep working unchanged.
export { toRoman, toLetters } from "./indexLabel";
export { formatIndexLabel as formatElevatorBadgeLabel } from "./indexLabel";

/** One badge's own world-space center, in layout order (ascending floor index — see
 *  `ElevatorBadgeSettings`'s own doc comment). Pure geometry, no drawing — shared by
 *  `VerticalConnectionRenderer` (drawing) and `computeVectorByWallsWarnings` (overlap detection),
 *  same "one geometry function, several consumers" convention `chevronRowStep` uses. */
export type ElevatorBadgePos = { x: number; y: number };

/** How many badges of `radius` (each `2*radius` wide/tall, `gap` between consecutive ones' own
 *  edges) fit across one tile's own width/height (`TILE_SIZE`) — the per-side capacity
 *  `elevatorBadgesTooMany` checks against for `"left_right"`/`"top_bottom"` placements. Always at
 *  least 1 (a single badge that itself exceeds `TILE_SIZE` still gets its own slot). Computed from
 *  `radius`/`gap` alone — slot count is always resolved before any badge position, so a wrap/overflow
 *  decision never gets made without first accounting for `gap`. */
export function slotsPerRow(radius: number, gap: number): number {
  const step = radius * 2 + gap;
  if (step <= 0) return 1;
  return Math.max(1, Math.floor((TILE_SIZE + gap) / step));
}

/** Lays out `count` badges of `radius`, `gap` apart, as a single sub-row/column centered on
 *  `(cx, cy)` — `axis: "x"` spreads along X (used by `"top_bottom"`'s own row), `axis: "y"` along Y
 *  (`"left_right"`'s own column). Ascending layout order matches ascending floor order. */
function layoutSubRow(cx: number, cy: number, count: number, radius: number, gap: number, axis: "x" | "y"): ElevatorBadgePos[] {
  const step = radius * 2 + gap;
  const positions: ElevatorBadgePos[] = [];
  for (let i = 0; i < count; i++) {
    const along = (i - (count - 1) / 2) * step;
    positions.push(axis === "y" ? { x: cx, y: cy + along } : { x: cx + along, y: cy });
  }
  return positions;
}

/** Lays out `count` badges on one side of the marker (e.g. the left side for `"left_right"`) along
 *  `axis`, offset from the marker center by `distance` past `markerRadius` — always a single row,
 *  never wrapping to a second sub-row: a side whose own `count` exceeds `slotsPerRow(...)` capacity
 *  is instead flagged by the `elevator_badges_too_many` export warning (`elevatorBadgesTooMany`),
 *  see `ElevatorBadgePlacement`'s own doc comment. `sign` is `-1` for the left/top side, `+1` for
 *  right/bottom. */
function layoutMarkerSide(
  cx: number, cy: number, markerRadius: number, count: number, radius: number, distance: number, gap: number,
  rowAxis: "x" | "y", offsetAxis: "x" | "y", sign: 1 | -1,
): ElevatorBadgePos[] {
  if (count <= 0) return [];
  const offset = markerRadius + distance + radius;
  return layoutSubRow(
    offsetAxis === "x" ? cx + sign * offset : cx,
    offsetAxis === "y" ? cy + sign * offset : cy,
    count, radius, gap, rowAxis,
  );
}

/** `true` for a `placement` whose *leading* side (the one that fills first — see
 *  `ElevatorBadgeSettings.evenDistribution`) is the left/top one (`sign: -1` in
 *  `layoutMarkerSide`); `false` for its `right_left`/`bottom_top` mirror. */
function isLeadingSideFirst(placement: ElevatorBadgePlacement): boolean {
  return placement === "left_right" || placement === "top_bottom";
}

/** Splits `count` badges between a placement's two sides (GitHub issue #430 follow-up
 *  `evenDistribution` toggle). Even: halves `count` (ceil/floor), leading side getting the extra
 *  badge on an odd split. Uneven: the leading side fills up to `capacity` first, the remainder
 *  spills onto the other side — ascending floor order is preserved throughout (the first
 *  `min(count, capacity)` floors lead, not an interleaved round-robin) — *unless* that still leaves
 *  the other side over capacity too (`count > 2 * capacity`, i.e. no split could ever fit both
 *  sides), in which case this falls back to the even split: a genuinely-too-many-badges case reads
 *  better balanced than lopsidedly overflowing on one side while the other still has room (GitHub
 *  issue #430 second follow-up). Returns `[leadingCount, otherCount]`. */
function splitBadgeCount(count: number, capacity: number, evenDistribution: boolean): [number, number] {
  if (evenDistribution || count > 2 * capacity) return [Math.ceil(count / 2), Math.floor(count / 2)];
  const leading = Math.min(count, capacity);
  return [leading, count - leading];
}

/** Lays out `count` badges of `radius` around a marker centered at `(cx, cy)` (GitHub issue #430,
 *  `evenDistribution`/`right_left`/`bottom_top` follow-up). `"left_right"`/`"right_left"` split
 *  `count` between a left row and a right row (`"top_bottom"`/`"bottom_top"`: top/bottom columns)
 *  per `splitBadgeCount` — the name's first half is the side that fills first, and a split that
 *  still overflows both sides falls back to the even halves (see `splitBadgeCount`'s own doc
 *  comment). `"full_circle"` spreads badges on a ring of radius `markerRadius + distance + radius`:
 *  `evenDistribution` on spaces all `count` evenly around the whole circle, starting at 12 o'clock
 *  (`-90°`), clockwise, ignoring `gap`; off instead lays them out one after another `gap` apart
 *  (chord distance) as a contiguous arc centered on 12 o'clock — unless that arc's own span would
 *  wrap past a full circle, in which case this falls back to the even ring too (badges no longer fit
 *  side by side around it at all, so a contiguous-arc layout can't represent it). `count <= 0`
 *  returns an empty array. */
export function computeElevatorBadgePositions(
  cx: number,
  cy: number,
  markerRadius: number,
  count: number,
  radius: number,
  distance: number,
  gap: number,
  placement: ElevatorBadgePlacement,
  evenDistribution: boolean,
): ElevatorBadgePos[] {
  if (count <= 0) return [];

  if (placement === "full_circle") {
    const ringRadius = markerRadius + distance + radius;
    const positions: ElevatorBadgePos[] = [];
    // Uneven mode lays badges out as a contiguous `gap`-spaced arc — but once that arc's own span
    // would wrap past a full circle (badges no longer fit side by side around the ring at all), an
    // arc layout can't represent it meaningfully any more, so this falls back to the even ring
    // (GitHub issue #430 second follow-up), same "can't stay lopsided once it doesn't fit" rationale
    // `splitBadgeCount` uses for the two-sided placements.
    const chordStep = radius * 2 + gap;
    const angleStep = ringRadius > 0 && chordStep > 0 ? 2 * Math.asin(Math.min(1, chordStep / (2 * ringRadius))) : 0;
    const arcSpan = angleStep * (count - 1);
    if (evenDistribution || arcSpan >= 2 * Math.PI) {
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (i / count) * 2 * Math.PI;
        positions.push({ x: cx + Math.cos(angle) * ringRadius, y: cy + Math.sin(angle) * ringRadius });
      }
    } else {
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + (i - (count - 1) / 2) * angleStep;
        positions.push({ x: cx + Math.cos(angle) * ringRadius, y: cy + Math.sin(angle) * ringRadius });
      }
    }
    return positions;
  }

  const rowAxis = placement === "left_right" || placement === "right_left" ? "y" : "x";
  const offsetAxis = placement === "left_right" || placement === "right_left" ? "x" : "y";
  const capacity = slotsPerRow(radius, gap);
  const [leadingCount, otherCount] = splitBadgeCount(count, capacity, evenDistribution);
  const leadingSign: 1 | -1 = isLeadingSideFirst(placement) ? -1 : 1;
  const leading = layoutMarkerSide(cx, cy, markerRadius, leadingCount, radius, distance, gap, rowAxis, offsetAxis, leadingSign);
  const other = layoutMarkerSide(cx, cy, markerRadius, otherCount, radius, distance, gap, rowAxis, offsetAxis, leadingSign === -1 ? 1 : -1);
  return [...leading, ...other];
}

/** `true` when any two badges in `positions` (all sharing `radius`) visually overlap — their
 *  centers sit closer than `2 * radius` apart (GitHub issue #430's own overflow-warning
 *  criterion: real geometric overlap, not a fixed count threshold). O(n²) — badge counts are always
 *  small (a handful of floors per elevator at most), so a spatial index isn't warranted. */
export function elevatorBadgesOverlap(positions: ElevatorBadgePos[], radius: number): boolean {
  const minDist = radius * 2;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dist = Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
      if (dist < minDist) return true;
    }
  }
  return false;
}

/** `true` when `count` badges can't all fit in a single row/column per side (GitHub issue #430's
 *  `elevator_badges_too_many` warning) — only meaningful for `"left_right"`/`"right_left"`/
 *  `"top_bottom"`/`"bottom_top"`, which split `count` between two sides (`splitBadgeCount`) and cap
 *  each at `slotsPerRow(radius, gap)` (`ElevatorBadgePlacement`'s own doc comment: no second
 *  sub-row, an overflowing side trips this warning instead). Always `false` for `"full_circle"`,
 *  whose ring has no per-row capacity of its own to exceed — with `evenDistribution` off it instead
 *  just grows past a half-circle, a purely visual (not "broken") overflow. */
export function elevatorBadgesTooMany(count: number, radius: number, gap: number, placement: ElevatorBadgePlacement, evenDistribution: boolean): boolean {
  if (placement === "full_circle" || count <= 0) return false;
  const capacity = slotsPerRow(radius, gap);
  const [leadingCount, otherCount] = splitBadgeCount(count, capacity, evenDistribution);
  return leadingCount > capacity || otherCount > capacity;
}
