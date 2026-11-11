import type { ElevatorBadgePlacement } from "../../store/imageExportTypes";
import { TILE_SIZE } from "../constants";
import { circleOverlapsRoundedRect, type RoundedRectGeometry } from "./verticalConnectionGeometry";

// Label formatting moved to the neutral `indexLabel.ts` (shared with GitHub issue #471's marker
// index labels). Re-exported here so existing importers keep working unchanged.
export { toRoman, toLetters } from "./indexLabel";
export { formatIndexLabel as formatElevatorBadgeLabel } from "./indexLabel";

/** One badge's own world-space center, in layout order (ascending floor index — see
 *  `ElevatorBadgeSettings`'s own doc comment). Pure geometry, no drawing — shared by
 *  `VerticalConnectionRenderer` (drawing) and `computeVectorByWallsWarnings` (overlap detection),
 *  same "one geometry function, several consumers" convention `chevronRowStep` uses. */
export type ElevatorBadgePos = { x: number; y: number };

/** A region badges must stay clear of (GitHub issue #964) — today the marker-index plates, border
 *  included. A badge slot whose disc overlaps any obstacle is not used; its badge moves to the next
 *  free slot instead. */
export type ElevatorBadgeObstacle = RoundedRectGeometry;

/** Everything one marker's badge layout depends on. */
export interface ElevatorBadgeLayoutInput {
  cx: number;
  cy: number;
  markerRadius: number;
  count: number;
  /** Badge outer radius, border ring included. */
  radius: number;
  distance: number;
  gap: number;
  placement: ElevatorBadgePlacement;
  evenDistribution: boolean;
  /** Regions no badge may overlap; none = every slot is free. */
  obstacles?: readonly ElevatorBadgeObstacle[];
}

/** `positions` are in ascending floor order; `overflow` is the `elevator_badges_too_many` verdict —
 *  a two-sided layout whose side holds more badges than its free slots inside the cell. */
export interface ElevatorBadgeLayout {
  positions: ElevatorBadgePos[];
  overflow: boolean;
}

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

/** Float slack of the "slot lies inside the cell" test. */
const FIT_EPSILON = 1e-9;

type SideRowParams = {
  cx: number;
  cy: number;
  markerRadius: number;
  radius: number;
  distance: number;
  gap: number;
  rowAxis: "x" | "y";
  offsetAxis: "x" | "y";
  /** `-1` for the left/top side, `+1` for right/bottom. */
  sign: 1 | -1;
};

/** A slot of one side's row: its world center plus its offset along the row axis from the row's
 *  own middle (the side's anchor point). */
type RowSlot = ElevatorBadgePos & { along: number };

/** Picks the `count` slots of one side's row — a slot grid `2*radius + gap` apart, centered on the
 *  side's anchor (`distance` past `markerRadius`), parity-aligned so that with nothing in the way
 *  it is exactly the centered run of `count` badges. A slot overlapping an obstacle is skipped and
 *  the run grows outward over the grid, nearest to the anchor first. Ascending along the row axis,
 *  so floor order stays left-to-right / top-to-bottom. A row never wraps: a side that cannot hold
 *  `count` badges inside the cell keeps drawing them past its bounds and trips the
 *  `elevator_badges_too_many` warning instead (see `ElevatorBadgePlacement`'s own doc comment). */
function pickSideSlots(side: SideRowParams, count: number, isBlocked: ((x: number, y: number) => boolean) | undefined): RowSlot[] {
  if (count <= 0) return [];
  const step = side.radius * 2 + side.gap;
  const anchorOffset = side.markerRadius + side.distance + side.radius;
  const anchorX = side.offsetAxis === "x" ? side.cx + side.sign * anchorOffset : side.cx;
  const anchorY = side.offsetAxis === "y" ? side.cy + side.sign * anchorOffset : side.cy;
  const slotAt = (along: number): RowSlot => (
    side.rowAxis === "y" ? { x: anchorX, y: anchorY + along, along } : { x: anchorX + along, y: anchorY, along }
  );
  const picked: RowSlot[] = [];
  // Distance of the grid line from the anchor, in steps: 0, 1, 2... for an odd run, 0.5, 1.5... for an even one.
  let d = count % 2 === 1 ? 0 : 0.5;
  // Obstacles are finite, so a free slot always turns up; the bound only guards a degenerate `step`.
  for (let guard = 0; picked.length < count && guard < 10_000; guard++, d++) {
    for (const along of d === 0 ? [0] : [-d * step, d * step]) {
      const slot = slotAt(along);
      if (isBlocked?.(slot.x, slot.y)) continue;
      picked.push(slot);
      if (picked.length === count) break;
    }
  }
  return picked.sort((a, b) => a.along - b.along);
}

/** `true` when every slot lies inside the cell along the row axis. A badge larger than the cell
 *  still gets its one central slot. */
function slotsFitCell(slots: readonly RowSlot[], radius: number): boolean {
  const half = Math.max(TILE_SIZE / 2, radius);
  return slots.every((slot) => Math.abs(slot.along) + radius <= half + FIT_EPSILON);
}

/** How many badges one side can hold inside the cell: the largest run (up to `slotsPerRow`) whose
 *  slots, obstacles skipped, all stay within the cell. Equals `slotsPerRow` when nothing is in the way. */
function sideCapacity(side: SideRowParams, isBlocked: ((x: number, y: number) => boolean) | undefined): number {
  let capacity = 0;
  const limit = slotsPerRow(side.radius, side.gap);
  for (let n = 1; n <= limit; n++) {
    if (!slotsFitCell(pickSideSlots(side, n, isBlocked), side.radius)) break;
    capacity = n;
  }
  return capacity;
}

/** `true` for a `placement` whose *leading* side (the one that fills first — see
 *  `ElevatorBadgeSettings.evenDistribution`) is the left/top one (`sign: -1` in
 *  `SideRowParams`); `false` for its `right_left`/`bottom_top` mirror. */
function isLeadingSideFirst(placement: ElevatorBadgePlacement): boolean {
  return placement === "left_right" || placement === "top_bottom";
}

/** Splits `count` badges between a placement's two sides (GitHub issue #430 follow-up
 *  `evenDistribution` toggle). Even: halves `count` (ceil/floor), leading side getting the extra
 *  badge on an odd split — but a side never takes more than it can hold inside the cell, so when an
 *  obstacle (GitHub issue #964) leaves one side fewer free slots than its half, the surplus moves to
 *  the other side instead of spreading that row out. Uneven: the leading side fills up to its own
 *  capacity first, the remainder spills onto the other side — ascending floor order is preserved
 *  throughout (the first `min(count, leadingCapacity)` floors lead, not an interleaved round-robin).
 *  When `count` exceeds both capacities combined no split could ever fit both sides, and this falls
 *  back to the plain even halves: a genuinely-too-many-badges case reads better balanced than
 *  lopsidedly overflowing on one side while the other still has room (GitHub issue #430 second
 *  follow-up). The capacities differ per side once an obstacle blocks slots of only one of them.
 *  Returns `[leadingCount, otherCount]`. */
function splitBadgeCount(count: number, leadingCapacity: number, otherCapacity: number, evenDistribution: boolean): [number, number] {
  const halves: [number, number] = [Math.ceil(count / 2), Math.floor(count / 2)];
  if (count > leadingCapacity + otherCapacity) return halves;
  if (evenDistribution) {
    const leading = Math.min(Math.max(halves[0], count - otherCapacity), leadingCapacity);
    return [leading, count - leading];
  }
  const leading = Math.min(count, leadingCapacity);
  return [leading, count - leading];
}

const FULL_TURN = 2 * Math.PI;
/** Resolution of the ring scan for obstacle-blocked arcs; the arc edges are then bisected exactly. */
const RING_SAMPLES = 720;
const RING_EDGE_ITERATIONS = 24;

type RingArc = { from: number; to: number };

/** Bisects between a free angle and a blocked one down to the edge; returns the free side. */
function refineRingEdge(freeTheta: number, blockedTheta: number, isBlockedAt: (theta: number) => boolean): number {
  let free = freeTheta;
  let blocked = blockedTheta;
  for (let i = 0; i < RING_EDGE_ITERATIONS; i++) {
    const mid = (free + blocked) / 2;
    if (isBlockedAt(mid)) blocked = mid;
    else free = mid;
  }
  return free;
}

/** The angles (radians clockwise from 12 o'clock, within `[0, 2π]`) at which a badge fits, as
 *  ascending arcs. An arc reaching `2π` continues into the one starting at `0`. */
function freeRingArcs(isBlockedAt: (theta: number) => boolean): RingArc[] {
  const step = FULL_TURN / RING_SAMPLES;
  const arcs: RingArc[] = [];
  let runStart: number | null = null;
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const theta = i * step;
    const blocked = isBlockedAt(theta);
    if (!blocked && runStart === null) {
      runStart = i === 0 ? 0 : refineRingEdge(theta, theta - step, isBlockedAt);
    } else if (blocked && runStart !== null) {
      arcs.push({ from: runStart, to: refineRingEdge(theta - step, theta, isBlockedAt) });
      runStart = null;
    }
  }
  if (runStart !== null) arcs.push({ from: runStart, to: FULL_TURN });
  return arcs;
}

/** Re-roots the free arcs at the end of their largest blocked stretch (angles unwrapped, so they
 *  ascend over up to one turn), making the arcs a strip with that stretch as its seam. Spacing
 *  badges symmetrically along this strip centers them on the free ring, whichever side the
 *  obstacle sits on. No blocked stretch (one arc spanning the circle) leaves the arcs as they are. */
function rootArcsAtLargestGap(arcs: readonly RingArc[]): RingArc[] {
  if (arcs.length === 1 && arcs[0].from === 0 && arcs[0].to === FULL_TURN) return [...arcs];
  let gapEnd = 0;
  let widest = -1;
  for (let i = 0; i < arcs.length; i++) {
    const prev = arcs[(i + arcs.length - 1) % arcs.length];
    // The stretch before arc `i`; for the first arc it wraps back to the last arc's end.
    const width = i === 0 ? arcs[0].from + FULL_TURN - prev.to : arcs[i].from - prev.to;
    if (width > widest) {
      widest = width;
      gapEnd = i;
    }
  }
  return [...arcs.slice(gapEnd), ...arcs.slice(0, gapEnd).map((arc) => ({ from: arc.from + FULL_TURN, to: arc.to + FULL_TURN }))];
}

/** Length of free ring between the strip's start and `theta` (any multiple-of-turn copy of it that
 *  falls inside the strip); a `theta` inside a blocked stretch counts up to that stretch's start.
 *  `undefined` when no copy of `theta` lies within the strip's span (it is on the seam). */
function freeOffsetOfTheta(arcs: readonly RingArc[], theta: number): number | undefined {
  const first = arcs[0].from;
  const last = arcs[arcs.length - 1].to;
  let target = theta;
  while (target < first) target += FULL_TURN;
  if (target > last) return undefined;
  let offset = 0;
  for (const arc of arcs) {
    if (target < arc.from) return offset;
    if (target <= arc.to) return offset + target - arc.from;
    offset += arc.to - arc.from;
  }
  return offset;
}

/** The ring angle `offset` radians along the free arcs, counted from the first one's start and
 *  wrapping around their total length — blocked stretches take no length, so spacing is measured
 *  over free ring only. */
function thetaAtFreeOffset(arcs: readonly RingArc[], total: number, offset: number): number {
  let rest = ((offset % total) + total) % total;
  for (const arc of arcs) {
    const length = arc.to - arc.from;
    if (rest <= length) return arc.from + rest;
    rest -= length;
  }
  return arcs[arcs.length - 1].to;
}

/** `"full_circle"`: badges on a ring of radius `markerRadius + distance + radius`.
 *  `evenDistribution` on spaces all `count` evenly over the free ring, starting at 12 o'clock
 *  (`-90°`), clockwise, ignoring `gap`; off instead lays them out one after another `gap` apart
 *  (chord distance) as a contiguous arc centered on 12 o'clock — unless that arc's own span would
 *  wrap past the free ring, in which case this falls back to the even ring too (badges no longer
 *  fit side by side around it at all, so a contiguous-arc layout can't represent it; GitHub issue
 *  #430 second follow-up). Stretches of the ring where a badge would overlap an obstacle (GitHub
 *  issue #964) are skipped, and the badges are kept centered on the free ring: with something in
 *  the way the even layout runs along the free arcs from the seam (the obstacle's side) in equal
 *  shares centered in their slots — mirror-symmetric around the opposite point — and the contiguous
 *  arc stays centered on 12 o'clock measured over free ring. With nothing in the way the free ring
 *  is the whole circle and this is the plain layout. A ring fully blocked draws as if free. */
function layoutRing(input: ElevatorBadgeLayoutInput, isBlocked: ((x: number, y: number) => boolean) | undefined): ElevatorBadgePos[] {
  const { cx, cy, count, radius, gap, evenDistribution } = input;
  const ringRadius = input.markerRadius + input.distance + radius;
  const pointAt = (theta: number): ElevatorBadgePos => ({ x: cx + Math.sin(theta) * ringRadius, y: cy - Math.cos(theta) * ringRadius });
  const found = isBlocked ? freeRingArcs((theta) => { const p = pointAt(theta); return isBlocked(p.x, p.y); }) : [];
  const obstructed = found.length > 0 && !(found.length === 1 && found[0].from === 0 && found[0].to === FULL_TURN);
  const arcs = found.length === 0 ? [{ from: 0, to: FULL_TURN }] : rootArcsAtLargestGap(found);
  const total = arcs.reduce((sum, arc) => sum + arc.to - arc.from, 0);

  const chordStep = radius * 2 + gap;
  const angleStep = ringRadius > 0 && chordStep > 0 ? 2 * Math.asin(Math.min(1, chordStep / (2 * ringRadius))) : 0;
  const arcSpan = angleStep * (count - 1);
  const offsets: number[] = [];
  if (evenDistribution || arcSpan >= total) {
    // Plain ring: first badge at 12 o'clock. Obstructed: the seam is not 12 o'clock, so slot centers.
    const share = total / count;
    for (let i = 0; i < count; i++) offsets.push(obstructed ? (i + 0.5) * share : i * share);
  } else {
    const center = obstructed ? (freeOffsetOfTheta(arcs, 0) ?? total / 2) : 0;
    for (let i = 0; i < count; i++) offsets.push(center + (i - (count - 1) / 2) * angleStep);
  }
  return offsets.map((offset) => pointAt(thetaAtFreeOffset(arcs, total, offset)));
}

/** The obstacles whose bounding box reaches the ring's outer edge — the rest can never block a ring
 *  slot, and the ring scan tests every obstacle at hundreds of angles, so dropping them early keeps
 *  maps with many marker-index plates cheap. */
function obstaclesNearRing(input: ElevatorBadgeLayoutInput): readonly ElevatorBadgeObstacle[] {
  const obstacles = input.obstacles ?? [];
  const reach = input.markerRadius + input.distance + 2 * input.radius;
  return obstacles.filter((o) => (
    o.x <= input.cx + reach && o.x + o.w >= input.cx - reach && o.y <= input.cy + reach && o.y + o.h >= input.cy - reach
  ));
}

/** Lays out `count` badges of `radius` around a marker centered at `(cx, cy)` (GitHub issue #430,
 *  `evenDistribution`/`right_left`/`bottom_top` follow-up). `"left_right"`/`"right_left"` split
 *  `count` between a left row and a right row (`"top_bottom"`/`"bottom_top"`: top/bottom columns)
 *  per `splitBadgeCount` — the name's first half is the side that fills first, and a split that
 *  still overflows both sides falls back to the even halves (see `splitBadgeCount`'s own doc
 *  comment). `"full_circle"` is `layoutRing`. `obstacles` (GitHub issue #964) take slots out of
 *  both: no badge overlaps one, the badges use the remaining free slots instead. `count <= 0`
 *  yields no positions. The single source of badge geometry for drawing and the export warnings. */
export function computeElevatorBadgeLayout(input: ElevatorBadgeLayoutInput): ElevatorBadgeLayout {
  const { count, radius, placement, evenDistribution } = input;
  if (count <= 0) return { positions: [], overflow: false };
  const obstacles = placement === "full_circle" ? obstaclesNearRing(input) : input.obstacles ?? [];
  const isBlocked = obstacles.length > 0
    ? (x: number, y: number) => obstacles.some((obstacle) => circleOverlapsRoundedRect(x, y, radius, obstacle))
    : undefined;

  if (placement === "full_circle") return { positions: layoutRing(input, isBlocked), overflow: false };

  const horizontal = placement === "left_right" || placement === "right_left";
  const base = { cx: input.cx, cy: input.cy, markerRadius: input.markerRadius, radius, distance: input.distance, gap: input.gap, rowAxis: horizontal ? "y" : "x", offsetAxis: horizontal ? "x" : "y" } as const;
  const leadingSign: 1 | -1 = isLeadingSideFirst(placement) ? -1 : 1;
  const leadingSide: SideRowParams = { ...base, sign: leadingSign };
  const otherSide: SideRowParams = { ...base, sign: leadingSign === -1 ? 1 : -1 };
  const leadingCapacity = sideCapacity(leadingSide, isBlocked);
  const otherCapacity = sideCapacity(otherSide, isBlocked);
  const [leadingCount, otherCount] = splitBadgeCount(count, leadingCapacity, otherCapacity, evenDistribution);
  const positions = [
    ...pickSideSlots(leadingSide, leadingCount, isBlocked),
    ...pickSideSlots(otherSide, otherCount, isBlocked),
  ].map(({ x, y }) => ({ x, y }));
  return { positions, overflow: leadingCount > leadingCapacity || otherCount > otherCapacity };
}

/** Badge centers only — `computeElevatorBadgeLayout` for callers that don't need `overflow`. */
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
  obstacles?: readonly ElevatorBadgeObstacle[],
): ElevatorBadgePos[] {
  return computeElevatorBadgeLayout({ cx, cy, markerRadius, count, radius, distance, gap, placement, evenDistribution, obstacles }).positions;
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
 *  just grows past a half-circle, a purely visual (not "broken") overflow. This is the obstacle-free
 *  verdict; with obstacles read `computeElevatorBadgeLayout(...).overflow`. */
export function elevatorBadgesTooMany(count: number, radius: number, gap: number, placement: ElevatorBadgePlacement, evenDistribution: boolean): boolean {
  return computeElevatorBadgeLayout({ cx: 0, cy: 0, markerRadius: 0, count, radius, distance: 0, gap, placement, evenDistribution }).overflow;
}
