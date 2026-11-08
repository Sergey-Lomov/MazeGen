import type { ExportWarning, ExportWarningId } from "./exportWarnings";
import type { TeleportEdge } from "../renderers/types";
import type { Pos } from "../tessellationGeometry";
import { getCellVertices } from "../tessellationGeometry";
import { TILE_SIZE } from "../constants";
import { arrowPlacements } from "../renderers/teleportConnectorRouting";
import { manualConnectorPoints } from "../renderers/teleportConnectorManual";
import { coordKey, computeFloorBadges, planGroupDrawOrder } from "../renderers/teleportGeometry";
import { FIELD_EXIT_SAMPLE_STEP, pointInField, pointToSegmentDistance } from "../renderers/teleportGeometryUtils";
import { buildTeleportGroups } from "./teleportGroups";
import { buildTeleportConnectorContext, type TeleportConnectorContext, type TeleportConnectorInput } from "./teleportConnectorContext";

type Pt = [number, number];
type Polygon = Pt[];

/** Slack (display units) under which a measured distance still counts as "on" the shape — float noise and sub-pixel drags. */
const TOLERANCE = 0.5;
/** Highlight polygons are this much wider than the stroke they mark, so a thin line stays visible under the overlay. */
const HIGHLIGHT_PAD = 2;
const DISC_SIDES = 16;
/** Sampling step along a line, display units, and the cap on samples per segment. */
const OVERLAP_SAMPLE_STEP = 1;
const MAX_OVERLAP_SAMPLES = 400;
/** A stretch of one line lying within the hiding reach of another counts as an overlap from this many reaches long (a right-angle crossing is 2; 6 flags crossings under about 20 degrees). */
const MIN_OVERLAP_RUN = 6;
/** The arrow is `ARROW_REACH` x `arrowSize` long (tip `size` ahead of its center, tail half of that behind it): `drawDirectionArrow`. */
const ARROW_REACH = 1.5;

/** One polyline of a drawn connector: a connector through a seam is two pieces (`RoutedConnector.partnerPoints`). */
type Piece = { points: number[]; box: [number, number, number, number] };

function disc(center: readonly number[], radius: number): Polygon {
  return Array.from({ length: DISC_SIDES }, (_, i): Pt => {
    const angle = (i / DISC_SIDES) * Math.PI * 2;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  });
}

/** The rectangle a stroke of `halfWidth` covers along `a`-`b`. */
function strip(a: readonly number[], b: readonly number[], halfWidth: number): Polygon {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (length < 1e-9) return disc(a, halfWidth);
  const nx = (-dy / length) * halfWidth, ny = (dx / length) * halfWidth;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

function polylineLength(points: readonly number[]): number {
  let total = 0;
  for (let i = 0; i + 3 < points.length; i += 2) total += Math.hypot(points[i + 2] - points[i], points[i + 3] - points[i + 1]);
  return total;
}

function polylineDistance(points: readonly number[], p: readonly [number, number]): number {
  if (points.length < 4) return points.length >= 2 ? Math.hypot(p[0] - points[0], p[1] - points[1]) : Infinity;
  let closest = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    closest = Math.min(closest, pointToSegmentDistance([p[0], p[1]], [points[i], points[i + 1]], [points[i + 2], points[i + 3]]));
  }
  return closest;
}

function toPiece(points: number[]): Piece {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  return { points, box: [minX, minY, maxX, maxY] };
}

/** The sub-strips of `a` that run closer than `distance` to `b` for at least `MIN_OVERLAP_RUN` x `distance`: where the later-drawn
 *  line and its gap hide the other along a stretch, not just where two lines cross. `distance` is the hiding reach: half a line
 *  plus the gap, i.e. the other line's centerline lies under the gap of this one. */
function overlapStrips(a: Piece, b: Piece, distance: number, halfWidth: number): Polygon[] {
  const result: Polygon[] = [];
  const others: { from: Pt; to: Pt }[] = [];
  for (let j = 0; j + 3 < b.points.length; j += 2) others.push({ from: [b.points[j], b.points[j + 1]], to: [b.points[j + 2], b.points[j + 3]] });
  for (let i = 0; i + 3 < a.points.length; i += 2) {
    const ax = a.points[i], ay = a.points[i + 1], bx = a.points[i + 2], by = a.points[i + 3];
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-9) continue;
    const candidates = others.filter(({ from, to }) => boxesTouch(
      [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
      [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])],
      distance,
    ));
    if (candidates.length === 0) continue;
    const steps = Math.min(MAX_OVERLAP_SAMPLES, Math.max(1, Math.ceil(length / OVERLAP_SAMPLE_STEP)));
    let runStart = -1;
    const flush = (endStep: number) => {
      if (runStart < 0) return;
      const lo = runStart / steps, hi = endStep / steps;
      if ((hi - lo) * length >= MIN_OVERLAP_RUN * distance) {
        result.push(strip([ax + (bx - ax) * lo, ay + (by - ay) * lo], [ax + (bx - ax) * hi, ay + (by - ay) * hi], halfWidth));
      }
      runStart = -1;
    };
    for (let k = 0; k <= steps; k++) {
      const p: Pt = [ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps];
      if (candidates.some(({ from, to }) => pointToSegmentDistance(p, from, to) < distance)) { if (runStart < 0) runStart = k; } else flush(k - 1);
    }
    flush(steps);
  }
  return result;
}

const boxesTouch = (a: Piece["box"], b: Piece["box"], pad: number): boolean =>
  a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];

/** The field's cell polygons bucketed on a grid, so a point lookup tests only the few cells near it. */
class FieldIndex {
  private readonly buckets = new Map<string, Pos[][]>();
  private readonly size: number;

  constructor(polygons: Pos[][]) {
    let size = 1;
    for (const polygon of polygons) {
      const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
      size = Math.max(size, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
    this.size = size;
    for (const polygon of polygons) {
      const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
      for (let bx = Math.floor(Math.min(...xs) / size); bx <= Math.floor(Math.max(...xs) / size); bx++) {
        for (let by = Math.floor(Math.min(...ys) / size); by <= Math.floor(Math.max(...ys) / size); by++) {
          const key = `${bx},${by}`;
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(polygon); else this.buckets.set(key, [polygon]);
        }
      }
    }
  }

  contains(x: number, y: number): boolean {
    const bucket = this.buckets.get(`${Math.floor(x / this.size)},${Math.floor(y / this.size)}`);
    return bucket !== undefined && pointInField({ x, y }, bucket);
  }
}

/** The inner side of a bend is mitered up to this many half widths. */
const INNER_MITER_LIMIT = 6;
/** Arc step on the outer side of a bend, radians. */
const JOIN_ARC_STEP = Math.PI / 12;

/** One closed outline `halfWidth` to each side of the polyline `points`: every side runs parallel to its segment. The inner
 *  side of a bend is mitered, the outer side follows the round join of the connector's own stroke, so a bend stays one shape. */
export function bufferPolyline(points: readonly Pt[], halfWidth: number): Polygon {
  const path = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-9);
  if (path.length < 2) return path.length === 1 ? disc(path[0], halfWidth) : [];
  const normals = path.slice(1).map((p, i): Pt => {
    const length = Math.hypot(p[0] - path[i][0], p[1] - path[i][1]);
    return [-(p[1] - path[i][1]) / length, (p[0] - path[i][0]) / length];
  });
  /** The outline points at `path[i]` on the `side` (+1 left, -1 right) of the line. */
  const corner = (i: number, side: number): Pt[] => {
    const p = path[i];
    const at = (n: Pt, scale = 1): Pt => [p[0] + side * n[0] * halfWidth * scale, p[1] + side * n[1] * halfWidth * scale];
    if (i === 0) return [at(normals[0])];
    if (i === path.length - 1) return [at(normals[i - 1])];
    const sx = normals[i - 1][0] + normals[i][0], sy = normals[i - 1][1] + normals[i][1];
    const length = Math.hypot(sx, sy);
    const from = Math.atan2(normals[i - 1][1], normals[i - 1][0]);
    let sweep = Math.atan2(normals[i][1], normals[i][0]) - from;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    if (Math.abs(sweep) < 0.02) return [at(normals[i])];
    // The side the path turns away from is the outer one: it follows a circle around the vertex, like the stroke's round join.
    const outer = side * sweep < 0;
    if (!outer) return [at(length < 1e-6 ? normals[i] : [sx / length, sy / length], Math.min(length < 1e-6 ? Infinity : 2 / length, INNER_MITER_LIMIT))];
    const arcSteps = Math.max(1, Math.ceil(Math.abs(sweep) / JOIN_ARC_STEP));
    return Array.from({ length: arcSteps + 1 }, (_, k) => at([Math.cos(from + (sweep * k) / arcSteps), Math.sin(from + (sweep * k) / arcSteps)]));
  };
  const left = path.flatMap((_, i) => corner(i, 1));
  const right = path.flatMap((_, i) => corner(i, -1)).reverse();
  return [...left, ...right];
}

/** The parts of the polyline `points` whose stroke (`halfWidth` per side) leaves the field, each run of them (across bends
 *  too) as one outline `highlightHalfWidth` to each side. */
function outsideFieldStrips(points: readonly number[], index: FieldIndex, halfWidth: number, highlightHalfWidth: number): Polygon[] {
  type Sample = { at: Pt; outside: boolean; corner: boolean; bridged?: boolean };
  const samples: Sample[] = [];
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i], ay = points[i + 1], bx = points[i + 2], by = points[i + 3];
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-9) continue;
    const nx = (-(by - ay) / length) * halfWidth, ny = ((bx - ax) / length) * halfWidth;
    const steps = Math.max(1, Math.ceil(length / FIELD_EXIT_SAMPLE_STEP));
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
      const inside = index.contains(x, y) && (halfWidth <= 0 || (index.contains(x + nx, y + ny) && index.contains(x - nx, y - ny)));
      samples.push({ at: [x, y], outside: !inside, corner: s === 0 || s === steps });
    }
  }
  // A lone inside sample between two outside ones is a grazing touch of the border, not a way back into the field: bridge it.
  samples.forEach((sample, k) => {
    if (!sample.outside && k > 0 && k < samples.length - 1 && samples[k - 1].outside && samples[k + 1].outside) sample.bridged = true;
  });
  samples.forEach((sample) => { if (sample.bridged) sample.outside = true; });
  const result: Polygon[] = [];
  let runStart = -1;
  const flush = (endSample: number) => {
    if (runStart < 0) return;
    // One sample of slack on each side, so the mark reaches the points that are still inside.
    const from = Math.max(0, runStart - 1), to = Math.min(samples.length - 1, endSample + 1);
    const run = samples.slice(from, to + 1).filter((sample, k, all) => k === 0 || k === all.length - 1 || sample.corner).map((sample) => sample.at);
    result.push(bufferPolyline(run, highlightHalfWidth));
    runStart = -1;
  };
  samples.forEach((sample, k) => {
    if (sample.outside) { if (runStart < 0) runStart = k; } else flush(k - 1);
  });
  flush(samples.length - 1);
  return result;
}

/** The three corners `drawDirectionArrow` fills for an arrow of `size` centered at `p`. */
function arrowTriangle(p: { x: number; y: number; dx: number; dy: number }, size: number): Polygon {
  const px = -p.dy, py = p.dx;
  const baseX = p.x - p.dx * size * 0.5, baseY = p.y - p.dy * size * 0.5;
  return [[p.x + p.dx * size, p.y + p.dy * size], [baseX + px * size * 0.6, baseY + py * size * 0.6], [baseX - px * size * 0.6, baseY - py * size * 0.6]];
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function pointInTriangle(p: Pt, t: Polygon): boolean {
  const s = [cross(t[0], t[1], p), cross(t[1], t[2], p), cross(t[2], t[0], p)];
  return s.every((v) => v >= 0) || s.every((v) => v <= 0);
}

/** Distance from the segment `a`-`b` to the filled triangle `t` (0 when they touch). */
function segmentTriangleDistance(a: Pt, b: Pt, t: Polygon): number {
  if (pointInTriangle(a, t) || t.some((corner, i) => segmentsIntersect(a, b, corner, t[(i + 1) % 3]))) return 0;
  return Math.min(
    ...t.map((corner) => pointToSegmentDistance(corner, a, b)),
    ...t.map((corner, i) => Math.min(pointToSegmentDistance(a, corner, t[(i + 1) % 3]), pointToSegmentDistance(b, corner, t[(i + 1) % 3]))),
  );
}

/** The eight teleport connector presentation warnings about connector geometry (GitHub issue #945). Each is one
 *  entry per id; the offending parts of the drawn connectors are `floorPolygons` on `input.activeFloorIndex`. Judged on
 *  the path the renderer draws (`buildTeleportConnectorContext`), a manually authored one included. */
export function computeTeleportConnectorWarnings(input: TeleportConnectorInput, context?: TeleportConnectorContext): ExportWarning[] {
  const { settings, nodes, cfg, activeFloorIndex } = input;
  if (settings.teleportConnectorStyle === "none" || input.teleportEdges.length === 0) return [];
  const ctx = context ?? buildTeleportConnectorContext(input);
  const { teleportStyle: style, layout, routed, scaler, footprints } = ctx;
  const edges: TeleportEdge[] = layout.teleportEdges;

  const halfWidth = style.connectorWidth / 2;
  const reach = halfWidth + style.connectorGapWidth;
  const highlight = reach + HIGHLIGHT_PAD;
  const pieces = routed.map((connector) => [connector.points, ...(connector.partnerPoints ? [connector.partnerPoints] : [])].filter((p) => p.length >= 4).map(toPiece));
  const found = new Map<ExportWarningId, Polygon[]>();
  const report = (id: ExportWarningId, polygons: Polygon[]) => {
    if (polygons.length === 0) return;
    found.set(id, [...(found.get(id) ?? []), ...polygons]);
  };

  // Marker footprints are the ones the scaler sized, so a marker's drawn radius is read the way the renderer reads it.
  const badges = computeFloorBadges(edges);
  const markerRadius = (pos: readonly number[], withGap: boolean): number => {
    const key = coordKey(pos[0], pos[1]);
    const badge = badges.has(key);
    const fill = badge ? style.floorBadge.size / 2 : style.size / 2;
    const adaptation = badge ? style.floorBadge.sizeAdaptation : style.sizeAdaptation;
    const border = badge ? style.floorBadge.borderWidth : style.borderWidth;
    const gap = badge ? style.floorBadge.gapWidth : style.edgeGapWidth;
    return fill * scaler.factorAt([pos[0], pos[1]], adaptation) + border + (withGap ? gap : 0);
  };

  // Draw order of `TeleportRenderer.renderGroups`: group by group, a group's connectors in layout order; later draws over earlier.
  const edgeIndex = new Map(edges.map((edge, i) => [edge, i] as const));
  const drawRank = new Array<number>(edges.length).fill(-1);
  planGroupDrawOrder(buildTeleportGroups(edges, settings.teleportMergeMode), edges.map((edge, i) => ({ edge, routed: routed[i], color: 0 })))
    .flatMap(({ connectors }) => connectors)
    .forEach((planned, rank) => { drawRank[edgeIndex.get(planned.edge) ?? -1] = rank; });

  // Connectors hiding one another.
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      for (const a of pieces[i]) {
        for (const b of pieces[j]) {
          if (!boxesTouch(a.box, b.box, reach)) continue;
          // Measured along the connector drawn on top, the one whose line and gap hide the other.
          const [top, below] = drawRank[i] > drawRank[j] ? [a, b] : [b, a];
          report("teleport_connectors_overlap", overlapStrips(top, below, reach, highlight));
        }
      }
    }
  }


  const manualPaths = settings.manualTeleportConnectorPaths;
  const degenerate: Polygon[] = [];
  const tooShort: Polygon[] = [];
  edges.forEach((edge, i) => {
    const connector = pieces[i];
    const length = connector.reduce((sum, piece) => sum + polylineLength(piece.points), 0);

    // Zero-length: nothing of the line is left to read.
    if (length < Math.max(style.connectorWidth, 1)) { degenerate.push(disc(edge.from, highlight + 2)); return; }

    // An endpoint dragged off its marker.
    if (manualConnectorPoints(edge, manualPaths) !== null) {
      const points = routed[i].points;
      for (const [end, marker] of [[[points[0], points[1]], edge.from], [[points[points.length - 2], points[points.length - 1]], edge.to]] as const) {
        const bound = markerRadius(marker, true);
        if (Math.hypot(end[0] - marker[0], end[1] - marker[1]) > bound + TOLERANCE) report("teleport_connector_endpoint_detached", [disc(end, highlight + 2), disc(marker, bound)]);
      }
    }

    if (edge.oneWay && style.arrowMode !== "none") {
      // The arrow needs room between the markers that hide the connector's two ends.
      const visible = length - markerRadius(edge.from, false) - markerRadius(edge.to, false);
      if (visible < ARROW_REACH * style.arrowSize) tooShort.push(disc([(edge.from[0] + edge.to[0]) / 2, (edge.from[1] + edge.to[1]) / 2], style.arrowSize + highlight));
      // An arrow whose tip or tail lies off the line sticks out of it (a bend under the arrow, a line shorter than the arrow).
      for (const piece of connector) {
        for (const p of arrowPlacements(piece.points, style.arrowMode, style.arrowPeriod * TILE_SIZE, style.arrowSize)) {
          const tip: Pt = [p.x + p.dx * style.arrowSize, p.y + p.dy * style.arrowSize];
          const tail: Pt = [p.x - p.dx * style.arrowSize * 0.5, p.y - p.dy * style.arrowSize * 0.5];
          if (polylineDistance(piece.points, tip) > halfWidth + TOLERANCE || polylineDistance(piece.points, tail) > halfWidth + TOLERANCE) {
            report("teleport_connector_arrow_sticks_out", [arrowTriangle(p, style.arrowSize + style.connectorGapWidth + HIGHLIGHT_PAD)]);
          }
          // A connector drawn after this one lays its line and gap over the arrow; one drawn before it lies under the arrow, which is fine.
          const triangle = arrowTriangle(p, style.arrowSize);
          const triangleBox: Piece["box"] = [Math.min(...triangle.map((t) => t[0])), Math.min(...triangle.map((t) => t[1])), Math.max(...triangle.map((t) => t[0])), Math.max(...triangle.map((t) => t[1]))];
          const covered = pieces.some((others, k) => drawRank[k] > drawRank[i] && others.some((other) => {
            if (!boxesTouch(other.box, triangleBox, reach)) return false;
            for (let s = 0; s + 3 < other.points.length; s += 2) {
              if (segmentTriangleDistance([other.points[s], other.points[s + 1]], [other.points[s + 2], other.points[s + 3]], triangle) < reach) return true;
            }
            return false;
          }));
          if (covered) report("teleport_connector_covers_arrow", [arrowTriangle(p, style.arrowSize + style.connectorGapWidth + HIGHLIGHT_PAD)]);
        }
      }
    }

    // A marker the router steers connectors around (start/finish, vertical passage, another teleport's endpoint or badge).
    for (const footprint of footprints) {
      if ([edge.from, edge.to].some((end) => Math.abs(end[0] - footprint.pos[0]) < 1e-6 && Math.abs(end[1] - footprint.pos[1]) < 1e-6)) continue;
      const factor = scaler.factorAt(footprint.pos, footprint.adaptation);
      const radius = footprint.outsetScales ? (footprint.radius + footprint.outset) * factor : footprint.radius * factor + footprint.outset;
      let hit = false;
      for (const piece of connector) {
        for (let k = 0; k + 3 < piece.points.length; k += 2) {
          const a: Pt = [piece.points[k], piece.points[k + 1]], b: Pt = [piece.points[k + 2], piece.points[k + 3]];
          if (pointToSegmentDistance([footprint.pos[0], footprint.pos[1]], a, b) < radius + halfWidth) hit = true;
        }
      }
      if (hit) report("teleport_connector_crosses_marker", [disc(footprint.pos, radius + HIGHLIGHT_PAD)]);
    }
  });
  report("teleport_connector_too_short_for_arrow", tooShort);
  report("teleport_connector_degenerate", degenerate);

  // "Avoid leaving the field": checked on the drawn stroke, like the router's own candidate check.
  if (settings.teleportAvoidFieldExit) {
    const seen = new Set<string>();
    const polygons: Pos[][] = [];
    for (const node of nodes) {
      const key = `${node.x},${node.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      polygons.push(getCellVertices(node.x, node.y, cfg));
    }
    const index = new FieldIndex(polygons);
    pieces.forEach((connector, i) => {
      // A seam piece ends on the glued face, where an offset stroke edge may sit outside: the centerline decides there.
      const width = routed[i].partnerPoints ? 0 : reach;
      for (const piece of connector) report("teleport_connector_leaves_field", outsideFieldStrips(piece.points, index, width, highlight));
    });
  }

  const order: ExportWarningId[] = [
    "teleport_connectors_overlap", "teleport_connector_endpoint_detached", "teleport_connector_leaves_field",
    "teleport_connector_crosses_marker", "teleport_connector_arrow_sticks_out", "teleport_connector_too_short_for_arrow", "teleport_connector_covers_arrow", "teleport_connector_degenerate",
  ];
  return order.flatMap((id): ExportWarning[] => {
    const polygons = found.get(id);
    return polygons ? [{ id, key: id, nodes: [], edges: [], floorPolygons: polygons.map((polygon) => ({ floorIndex: activeFloorIndex, polygon })) }] : [];
  });
}
