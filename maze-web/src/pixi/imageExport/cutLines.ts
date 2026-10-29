import type { FieldConfig } from "../../fieldConfig";
import type { WireTopology } from "../../wasm/types";
import type { CutExportSettings, CutLineSetting, CutMode } from "../../store/imageExportTypes";
import { getSeamModel, type Seam, type HalfEdge } from "../selectors/seams";
import { displayTransform, getCellVertices } from "../tessellationGeometry";
import { applyTransform } from "../geometry/worldTransform";

/// Cut lines for export (GitHub issue #859, `Specs/image-export.md`, "Cut lines"). A glue (fold
/// group) whose seam is a pure translation makes the surface periodic along that translation. A cut
/// line splits the printed sheet at a chosen position instead of at the zigzag of cell faces: the
/// sheet shows one period of the surface between the line and the line shifted by the glue's period,
/// and every cell that crosses the line is drawn in two parts, one on each side. Nothing here touches
/// the maze or the topology; everything is display space (the space the export draws in).

export type Vec2 = [number, number];

export type { CutMode, CutLineSetting };

/// The cut line setting of a glue, or `undefined` when it has none. Floors have their own topologies, whose group ids can repeat.
export const cutSettingOf = (cuts: CutExportSettings, floorId: string, group: number): CutLineSetting | undefined => cuts.lines[floorId]?.[group];

export type CutUnavailableReason = "no_seams" | "topological_only" | "not_translation" | "inconsistent" | "parallel";

export interface GroupCut {
  group: number;
  /// Translation between the glue's two sides (points from run A towards run B), display space.
  period: Vec2;
  /// A point on the automatic cut line: the middle of the narrowest strip around the centres of run A's cells.
  origin: Vec2;
  /// Unit direction of the run, which every cut line of the glue must follow.
  direction: Vec2;
  /// Range of the manual offset (fraction of the period, `0` is the automatic line): the line stays between the
  /// borders of the cells the automatic line runs through.
  minOffset: number;
  maxOffset: number;
}

export type GroupCutAvailability = ({ ok: true } & GroupCut) | { ok: false; group: number; reason: CutUnavailableReason };

/// Translation parts tolerated as zero, in world units / unitless matrix entries.
const TRANSLATION_EPS = 1e-6;
/// A cut line may not be closer to the period direction than this (sine of the angle).
const MIN_CROSS = 0.2;

const sub = (p: Vec2, q: Vec2): Vec2 => [p[0] - q[0], p[1] - q[1]];
const add = (p: Vec2, q: Vec2): Vec2 => [p[0] + q[0], p[1] + q[1]];
const scale = (p: Vec2, k: number): Vec2 => [p[0] * k, p[1] * k];
const dot = (p: Vec2, q: Vec2): number => p[0] * q[0] + p[1] * q[1];
const cross = (p: Vec2, q: Vec2): number => p[0] * q[1] - p[1] * q[0];
const length = (p: Vec2): number => Math.hypot(p[0], p[1]);
const mean = (points: Vec2[]): Vec2 => scale(points.reduce(add, [0, 0] as Vec2), 1 / points.length);

function translationOf(seam: Seam): Vec2 | null {
  const matrix = seam.a.fromPartner;
  if (!matrix) return null;
  const [a, b, c, d, e, f] = matrix;
  if (Math.abs(a - 1) > TRANSLATION_EPS || Math.abs(b) > TRANSLATION_EPS || Math.abs(c) > TRANSLATION_EPS || Math.abs(d - 1) > TRANSLATION_EPS) return null;
  return [e, f];
}

/// Cells whose centres differ by less than this (display units) are on one level of a zigzag edge.
const LEVEL_EPS = 1e-4;

/// The extent of `cells` along `normal`: the lowest and the highest vertex of any of them.
function heightsOf(cells: [number, number][], cfg: FieldConfig, normal: Vec2): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const [x, y] of cells) {
    for (const vertex of getCellVertices(x, y, cfg)) {
      const height = vertex.x * normal[0] + vertex.y * normal[1];
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
  }
  return [low, high];
}

/// Which side of the chain an end of the run is: the farthest pair of contact points gives the run's
/// direction; a run of a single face uses its own chain.
function runDirection(seams: HalfEdge[], toDisplay: (p: Vec2) => Vec2): Vec2 | null {
  const points = seams.map((half) => toDisplay(half.contact));
  let best: [Vec2, Vec2] | null = null;
  let bestLength = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const gap = length(sub(points[j], points[i]));
      if (gap > bestLength) {
        bestLength = gap;
        best = [points[i], points[j]];
      }
    }
  }
  if (!best && seams.length > 0) {
    const segments = seams[0].segments;
    if (segments.length > 0) best = [toDisplay(segments[0].from), toDisplay(segments[segments.length - 1].to)];
  }
  if (!best) return null;
  const direction = sub(best[1], best[0]);
  const norm = length(direction);
  return norm < TRANSLATION_EPS ? null : scale(direction, 1 / norm);
}

/// Convex hull of `points` (monotone chain), counter-clockwise, without collinear points.
function convexHull(points: Vec2[]): Vec2[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (sorted.length < 3) return sorted;
  const half = (input: Vec2[]): Vec2[] => {
    const chain: Vec2[] = [];
    for (const p of input) {
      while (chain.length >= 2 && cross(sub(chain[chain.length - 1], chain[chain.length - 2]), sub(p, chain[chain.length - 1])) <= 1e-12) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/// The direction of the straight line that stays closest to every point: that of the narrowest strip containing them all.
/// It follows the run whatever its cells look like (equal or not, in a zigzag or in a row), because it does not
/// depend on how many cells lie on either side of the line. A side of the narrowest strip lies on an edge of
/// the convex hull, so the hull edges are the only directions to try. `null` for fewer than two distinct points.
function narrowestStrip(points: Vec2[]): Vec2 | null {
  const hull = convexHull(points);
  if (hull.length < 2) return null;
  let best: { direction: Vec2; width: number; span: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const from = hull[i];
    const edge = sub(hull[(i + 1) % hull.length], from);
    const span = length(edge);
    if (span < TRANSLATION_EPS) continue;
    const direction = scale(edge, 1 / span);
    const normal: Vec2 = [-direction[1], direction[0]];
    const heights = hull.map((p) => dot(p, normal));
    const low = Math.min(...heights);
    const high = Math.max(...heights);
    const width = high - low;
    const tie = TRANSLATION_EPS * (1 + width);
    if (best && (width > best.width + tie || (width > best.width - tie && span <= best.span))) continue;
    best = { direction, width, span };
  }
  return best && best.direction;
}

/// Availability of a cut for every glue of the topology: either the data a cut line needs or the
/// reason it cannot be offered.
export function resolveGroupCuts(cfg: FieldConfig, topology: WireTopology | null | undefined): GroupCutAvailability[] {
  if (!topology || topology.groups.length === 0) return [];
  const model = getSeamModel(cfg);
  const transform = displayTransform(cfg);
  const toDisplay = (p: Vec2): Vec2 => applyTransform(transform, p) as Vec2;
  const toDisplayVector = (p: Vec2): Vec2 => [transform.a * p[0] + transform.c * p[1], transform.b * p[0] + transform.d * p[1]];

  return topology.groups.map((group): GroupCutAvailability => {
    const seams = model.seams.filter((seam) => topology.folds[seam.fold]?.group === group.id);
    if (seams.length === 0) return { ok: false, group: group.id, reason: "no_seams" };
    if (seams.some((seam) => !seam.isometric)) return { ok: false, group: group.id, reason: "topological_only" };

    let period: Vec2 | null = null;
    for (const seam of seams) {
      const raw = translationOf(seam);
      if (!raw) return { ok: false, group: group.id, reason: "not_translation" };
      let vector = toDisplayVector(raw);
      // A seam's sides are ordered by cell coordinates, so its sign is arbitrary: take it canonical.
      if (vector[0] < -TRANSLATION_EPS || (Math.abs(vector[0]) <= TRANSLATION_EPS && vector[1] < 0)) vector = scale(vector, -1);
      if (!period) period = vector;
      else if (length(sub(vector, period)) > TRANSLATION_EPS * (1 + length(period))) return { ok: false, group: group.id, reason: "inconsistent" };
    }
    if (!period || length(period) < TRANSLATION_EPS) return { ok: false, group: group.id, reason: "not_translation" };

    // A seam's `a` side is only the smaller cell, so across a run it can be either end of the field. Run A is
    // made of the side that the period points away from, so it is one edge of the field and run B the other.
    const sides = seams.map((seam) => {
      const a = toDisplay(seam.a.center);
      const b = toDisplay(seam.b.center);
      return dot(sub(b, a), period) >= 0 ? { near: seam.a, nearCenter: a, farCenter: b } : { near: seam.b, nearCenter: b, farCenter: a };
    });
    const centersA = sides.map((side) => side.nearCenter);
    const centerA = mean(centersA);
    const centerB = mean(sides.map((side) => side.farCenter));
    // The period points from run A towards run B, so the strip between the cut line and its shifted
    // twin lies over the field.
    const towardsB = sub(centerB, centerA);
    const oriented = dot(towardsB, period) < 0 ? scale(period, -1) : period;

    // The automatic line runs through the cells along the run, as straight as they allow.
    const strip = narrowestStrip(centersA);
    const stripDirection = strip && (strip[0] < -TRANSLATION_EPS || (Math.abs(strip[0]) <= TRANSLATION_EPS && strip[1] < 0) ? scale(strip, -1) : strip);
    const direction = stripDirection ?? runDirection(sides.map((side) => side.near), toDisplay);
    if (!direction) return { ok: false, group: group.id, reason: "parallel" };
    const periodUnit = scale(oriented, 1 / length(oriented));
    if (Math.abs(cross(direction, periodUnit)) < MIN_CROSS) return { ok: false, group: group.id, reason: "parallel" };

    const normal: Vec2 = [-direction[1], direction[0]];
    // The line runs through the centres of the outermost cells of the run (the field's edge row), as far from run B
    // as they reach; on a zigzag edge the cells set back from it are not the ones it cuts through.
    const across = dot(oriented, normal);
    const heights = centersA.map((center) => dot(center, normal));
    const outermost = across >= 0 ? Math.min(...heights) : Math.max(...heights);
    const origin = add(centerA, scale(normal, outermost - dot(centerA, normal)));
    // The cells the automatic line runs through: the outermost level of the run. A manual line moves within their extent.
    const reach = heightsOf(sides.filter((_, i) => Math.abs(heights[i] - outermost) < LEVEL_EPS).map((side) => side.near.cell), cfg, normal);
    const range = across === 0 ? [0, 0] : [(reach[0] - outermost) / across, (reach[1] - outermost) / across];
    const minOffset = Math.min(0, ...range);
    const maxOffset = Math.max(0, ...range);
    return { ok: true, group: group.id, period: oriented, origin, direction, minOffset, maxOffset };
  });
}

/// The cut line of a glue under `setting`: a point on it and the glue's period. `null` when the glue
/// has no cut (`none`, or unavailable).
export function cutLineOf(cut: GroupCutAvailability, setting: CutLineSetting | undefined): { point: Vec2; cut: GroupCut } | null {
  if (!cut.ok || !setting || setting.mode === "none") return null;
  const offset = setting.mode === "auto" ? 0 : Math.min(Math.max(setting.offset, cut.minOffset), cut.maxOffset);
  return { point: add(cut.origin, scale(cut.period, offset)), cut };
}

/// The two lines a cut makes on the sheet: the cut line itself and its twin one period over. They are the
/// two sides of the seam, so they glue to each other.
export function cutLineSides(line: { point: Vec2; cut: GroupCut }): [Vec2, Vec2] {
  return [line.point, add(line.point, line.cut.period)];
}

/// The setting's offset after a drag: the position of a display-space point projected onto the glue's
/// period, as a fraction, clamped to `[minOffset, maxOffset]`.
export function offsetForPoint(cut: GroupCut, point: Vec2): number {
  const normal: Vec2 = [-cut.direction[1], cut.direction[0]];
  const across = dot(cut.period, normal);
  if (across === 0) return 0;
  return Math.min(Math.max(dot(sub(point, cut.origin), normal) / across, cut.minOffset), cut.maxOffset);
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CutGuide {
  group: number;
  from: Vec2;
  to: Vec2;
}

export interface CutPlan {
  /// Convex polygon of the sheet content, display space.
  region: Vec2[];
  bounds: Box;
  /// Translations of the whole scene to draw, each clipped to `region`; always includes `[0, 0]`, first.
  offsets: Vec2[];
  /// The cut lines inside the region, for drawing guides: both ends of every glue's line and of its
  /// shifted twin, with the glue they belong to.
  guides: CutGuide[];
}

function clipHalfPlane(polygon: Vec2[], normal: Vec2, point: Vec2): Vec2[] {
  const side = (p: Vec2) => dot(sub(p, point), normal);
  const result: Vec2[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const sideCurrent = side(current);
    const sideNext = side(next);
    if (sideCurrent >= 0) result.push(current);
    if ((sideCurrent >= 0) !== (sideNext >= 0)) {
      const t = sideCurrent / (sideCurrent - sideNext);
      result.push([current[0] + (next[0] - current[0]) * t, current[1] + (next[1] - current[1]) * t]);
    }
  }
  return result;
}

function boxOf(points: Vec2[]): Box {
  return {
    minX: Math.min(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxX: Math.max(...points.map((p) => p[0])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
}

/// Segment of the infinite line (`point`, `direction`) inside the convex `polygon`, or `null`.
export function lineInside(polygon: Vec2[], point: Vec2, direction: Vec2): [Vec2, Vec2] | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edge = sub(b, a);
    const inward: Vec2 = [-edge[1], edge[0]];
    const numerator = dot(sub(a, point), inward);
    const denominator = dot(direction, inward);
    if (Math.abs(denominator) < 1e-12) {
      if (numerator > 1e-9) return null;
      continue;
    }
    const t = numerator / denominator;
    if (denominator > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null;
  return [add(point, scale(direction, lo)), add(point, scale(direction, hi))];
}

/// The stretch of the infinite line (`point`, unit `direction`) from the first tile it enters to the last it leaves: one
/// unbroken line across the field, whatever gaps the tiles leave along it. Empty when it crosses no tile.
/// A tile may be any simple polygon: the line enters and leaves it in pairs.
export function lineSpans(tiles: Vec2[][], point: Vec2, direction: Vec2): [Vec2, Vec2][] {
  const normal: Vec2 = [-direction[1], direction[0]];
  const intervals: [number, number][] = [];
  for (const tile of tiles) {
    const heights = tile.map((p) => dot(sub(p, point), normal));
    if (Math.min(...heights) > 0 || Math.max(...heights) < 0) continue;
    const crossings: number[] = [];
    for (let i = 0; i < tile.length; i++) {
      const j = (i + 1) % tile.length;
      if (heights[i] <= 0 === heights[j] <= 0) continue;
      const at = heights[i] / (heights[i] - heights[j]);
      crossings.push(dot(sub(add(tile[i], scale(sub(tile[j], tile[i]), at)), point), direction));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) intervals.push([crossings[i], crossings[i + 1]]);
  }
  if (intervals.length === 0) return [];
  // Not `Math.min(...)`: a large field gives more intervals than a call can take as arguments.
  const from = intervals.reduce((least, interval) => Math.min(least, interval[0]), Infinity);
  const to = intervals.reduce((most, interval) => Math.max(most, interval[1]), -Infinity);
  return [[add(point, scale(direction, from)), add(point, scale(direction, to))]];
}

/// The spans of a cut line's twin (side 1), one period over; side 0 is the line itself.
export function sideSpans(spans: [Vec2, Vec2][], period: Vec2, side: 0 | 1): [Vec2, Vec2][] {
  return side === 0 ? spans : spans.map(([from, to]): [Vec2, Vec2] => [add(from, period), add(to, period)]);
}

/// Distance from `point` to the segment `from`-`to`.
export function distanceToSegment(point: Vec2, from: Vec2, to: Vec2): number {
  const edge = sub(to, from);
  const lengthSquared = dot(edge, edge);
  const t = lengthSquared === 0 ? 0 : Math.min(Math.max(dot(sub(point, from), edge) / lengthSquared, 0), 1);
  return length(sub(point, add(from, scale(edge, t))));
}

/// The part of each span that lies inside `window`, a segment of the same line (`lineInside`); `null` window: none.
export function clipSpans(spans: [Vec2, Vec2][], window: [Vec2, Vec2] | null, direction: Vec2): [Vec2, Vec2][] {
  if (!window) return [];
  const lo0 = dot(window[0], direction);
  const hi0 = dot(window[1], direction);
  const result: [Vec2, Vec2][] = [];
  for (const [from, to] of spans) {
    const start = dot(from, direction);
    const lo = Math.max(start, lo0);
    const hi = Math.min(dot(to, direction), hi0);
    if (hi > lo + 1e-9) result.push([add(from, scale(direction, lo - start)), add(from, scale(direction, hi - start))]);
  }
  return result;
}

/// Everything the export needs to draw the cut sheet: the region (the field's box, plus the mode's margin, clipped by each
/// glue's strip), the scene copies that fill it and the guide lines. `null` when no glue is cut.
/// `field` is the display-space bounding box of the floor's cells; `tiles` are the cells' polygons, and the guides are
/// drawn only over them (without `tiles`, over the whole region).
export function buildCutPlan(
  field: Box,
  entries: { point: Vec2; cut: GroupCut }[],
  margin: { left: number; right: number; top: number; bottom: number } = { left: 0, right: 0, top: 0, bottom: 0 },
  tiles: Vec2[][] | null = null,
): CutPlan | null {
  if (entries.length === 0) return null;
  // The strip of a glue reaches past the field along its period (the missing half of a cell comes
  // from the shifted copy), so the starting box is widened by each period; the strips then cut it.
  const reach = entries.reduce<Vec2>((sum, { cut }) => [sum[0] + Math.abs(cut.period[0]), sum[1] + Math.abs(cut.period[1])], [0, 0]);
  // The mode's margin (walls and markers poking past the cells) is kept on every side: along a cut it is
  // clipped by the strip anyway, and across it the sheet ends at the field's own edge, walls included.
  const [x0, x1] = [field.minX - reach[0] - margin.left, field.maxX + reach[0] + margin.right];
  const [y0, y1] = [field.minY - reach[1] - margin.top, field.maxY + reach[1] + margin.bottom];
  let region: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (const { point, cut } of entries) {
    let normal: Vec2 = [-cut.direction[1], cut.direction[0]];
    if (dot(normal, cut.period) < 0) normal = scale(normal, -1);
    region = clipHalfPlane(region, normal, point);
    region = clipHalfPlane(region, scale(normal, -1), add(point, cut.period));
    if (region.length < 3) return null;
  }
  const bounds = boxOf(region);

  let offsets: Vec2[] = [[0, 0]];
  for (const { cut } of entries) {
    offsets = offsets.flatMap((base) => [-1, 0, 1].map((k): Vec2 => add(base, scale(cut.period, k))));
  }
  const overlaps = ([dx, dy]: Vec2) =>
    field.minX + dx < bounds.maxX && field.maxX + dx > bounds.minX && field.minY + dy < bounds.maxY && field.maxY + dy > bounds.minY;
  // The unshifted copy first: it alone carries the mode's backdrop, which the others must not cover.
  offsets = offsets.filter(overlaps).sort((p, q) => Number(q[0] === 0 && q[1] === 0) - Number(p[0] === 0 && p[1] === 0));

  const guides: CutGuide[] = [];
  for (const { point, cut } of entries) {
    // The twin line shows the halves that moved over, so it has image where the line itself cuts a tile.
    const over = tiles ? lineSpans(tiles, point, cut.direction) : null;
    for (const side of [0, 1] as const) {
      const segment = lineInside(region, side === 0 ? point : add(point, cut.period), cut.direction);
      if (!segment) continue;
      const spans = over ? sideSpans(over, cut.period, side) : [segment];
      for (const [from, to] of clipSpans(spans, segment, cut.direction)) guides.push({ group: cut.group, from, to });
    }
  }
  return { region, bounds, offsets, guides };
}
