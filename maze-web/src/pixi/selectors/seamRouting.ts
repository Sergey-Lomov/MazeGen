/// Routing of the seam lines (GitHub issue #841): where the seam arrows and the graph hops across a
/// seam run round the field. A route goes straight when nothing is in the way and otherwise leaves its
/// face straight out to a rectangular ring round the field, runs along the ring and comes back the same
/// way; routes are kept off each other (no crossing where it can be avoided, never running along one).
/// Pure display-space geometry: the callers decide which pairs of ports to route.

import { pointInPolygonBy } from "../tessellationGeometry";

export type Point = [number, number];

/// Distance of the first routing ring from the field's bounding box and between two rings, relative to
/// the mean face length.
const RING_FIRST_SHARE = 1.6;
const RING_STEP_SHARE = 0.5;
/// How far outside its own cell a straight route starts, relative to the face length, so a route
/// touching only its own cell's boundary is not read as crossing it.
const START_EPS_SHARE = 0.02;

/// A port: where the route starts on the run's faces and the unit direction out of the field.
export interface Port {
  contact: Point;
  out: Point;
}

export const distance = (p: Point, q: Point): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

/// The point at arc length `length` along `path` and the unit direction of the segment it lies on.
export function pointAtLength(path: Point[], length: number): { at: Point; dir: Point } {
  let left = length;
  for (let i = 1; i < path.length; i++) {
    const segment = distance(path[i - 1], path[i]);
    if (left <= segment || i === path.length - 1) {
      const t = segment === 0 ? 0 : left / segment;
      return {
        at: [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t],
        dir: unitOf(path[i - 1], path[i]),
      };
    }
    left -= segment;
  }
  return { at: path[0], dir: [1, 0] };
}

// ---- Routing ----

/// A direction a straight route may run along (unit vector; either way).
export interface Axis { ux: number; uy: number }

/// The axes a connector of these ports may run along: across each face (the way the connector leaves it) and along
/// it (the way a connector runs next to its side), as undirected unit vectors. Read off the glued faces themselves, so
/// it holds for every tessellation and orientation; the axes of teleport connectors are a different, per-tessellation set.
export function portAxes(ports: readonly Port[]): Axis[] {
  const axes: Axis[] = [];
  const add = (ux: number, uy: number): void => {
    if (!axes.some((axis) => Math.abs(axis.ux * uy - axis.uy * ux) < 1e-4)) axes.push({ ux, uy });
  };
  for (const { out } of ports) {
    const length = Math.hypot(out[0], out[1]);
    if (length === 0) continue;
    add(out[0] / length, out[1] / length);
    add(-out[1] / length, out[0] / length);
  }
  return axes;
}

/// Whether the straight line `path` runs along one of `axes`. Only such a line is drawn straight; every
/// other route goes out to a ring, so the lines of a drawing keep to the few directions of the tessellation.
function alongAxis(path: Point[], axes: readonly Axis[]): boolean {
  const length = distance(path[0], path[path.length - 1]);
  if (length === 0) return false;
  const dx = (path[path.length - 1][0] - path[0][0]) / length;
  const dy = (path[path.length - 1][1] - path[0][1]) / length;
  return axes.some((axis) => Math.abs(axis.ux * dy - axis.uy * dx) < 1e-3);
}

/// A route for every seam. A seam whose straight line between the two faces runs along an axis and is clear of every cell and
/// of the routes already kept goes straight; the others go around the field on a rectangular ring.
/// Each ring route leaves its face straight out to the ring, runs along the ring and comes back the same
/// way. Runs that nest sit on nested rings (the inner run on the inner ring) and runs that overlap only
/// partly on different rings, so no two bodies run along each other. Which way round each run goes is
/// picked to cross as few other routes as possible (starting from the short way); a crossing that
/// cannot be avoided (a Mobius strip, a torus) is left for the renderer to draw as one arrow under the
/// other.
export function routeAll(seams: [Port, Port][], polygons: Point[][], unit: number, axes: readonly Axis[], contours: readonly Point[][] = []): Point[][] {
  const routes: (Point[] | null)[] = seams.map(() => null);
  const straightKept: Point[][] = [];
  // The shorter span first, so a run nested in another keeps its route inside that one's.
  const bySpan = seams.map((_, i) => i).sort((p, q) => distance(seams[p][0].contact, seams[p][1].contact) - distance(seams[q][0].contact, seams[q][1].contact));
  for (const i of bySpan) {
    const direct = directRoutes(seams[i], polygons, unit, axes, contours)
      .find((route) => !straightKept.some((other) => pathsCross(other, route) || runsAlong(route.slice(1, -1), other, unit)));
    if (!direct) continue;
    routes[i] = direct;
    straightKept.push(direct);
  }

  // A pair whose way out to a ring runs through a cell anyway crosses that cell: it takes the plain way through
  // rather than a loop that crosses a cell all the same.
  const box = boundsOf(polygons, seams.flat().map((port) => port.contact));
  seams.forEach((seam, i) => {
    if (routes[i] !== null || !ringBlocked(seam, polygons, box, unit)) return;
    routes[i] = forcedRoute(seam, polygons, axes, unit, contours);
    straightKept.push(routes[i]!);
  });

  const ringed = seams.map((_, i) => i).filter((i) => routes[i] === null);
  if (ringed.length > 0) {
    const perimeter = 2 * ((box.maxX - box.minX) + (box.maxY - box.minY));
    const ends = ringed.map((i) => {
      const [a, b] = seams[i];
      return { sa: perimeterPosition(exitPoint(a, box), box), sb: perimeterPosition(exitPoint(b, box), box) };
    });
    const build = (clockwise: boolean[]): Point[][] => {
      const runs = ends.map(({ sa, sb }, k) => (clockwise[k]
        ? { lo: sa, length: mod(sb - sa, perimeter) }
        : { lo: sb, length: mod(sa - sb, perimeter) }));
      const rings = assignRings(runs, perimeter);
      return ringed.map((i, k) => ringRoute(seams[i], box, unit * (RING_FIRST_SHARE + RING_STEP_SHARE * rings[k]), clockwise[k]));
    };
    const cost = (ring: Point[][]): number => {
      const all = [...straightKept, ...ring];
      let crossings = 0;
      for (let p = 0; p < all.length; p++) for (let q = p + 1; q < all.length; q++) if (pathsCross(all[p], all[q])) crossings++;
      return crossings + ring.reduce((sum, path) => sum + pathLength(path), 0) / 1e9;
    };
    // The short way round to begin with, then flip a run whenever that crosses fewer routes.
    let clockwise = ends.map(({ sa, sb }) => mod(sb - sa, perimeter) <= perimeter - mod(sb - sa, perimeter));
    let best = build(clockwise);
    let bestCost = cost(best);
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let k = 0; k < clockwise.length; k++) {
        const trial = clockwise.map((value, index) => (index === k ? !value : value));
        const built = build(trial);
        const trialCost = cost(built);
        if (trialCost < bestCost - 1e-12) {
          clockwise = trial;
          best = built;
          bestCost = trialCost;
          improved = true;
        }
      }
      if (!improved) break;
    }
    ringed.forEach((i, k) => { routes[i] = best[k]; });
  }
  return routes.map((route) => route!);
}

/// The routes between two ports that need no ring: the straight line and the one-bend route where the
/// two rays out of the faces meet (two runs meeting at a corner), each only when it keeps to the axes
/// and runs clear of every cell.
function directRoutes([a, b]: [Port, Port], polygons: Point[][], unit: number, axes: readonly Axis[], contours: readonly Point[][]): Point[][] {
  const eps = unit * START_EPS_SHARE;
  const out = (port: Port): Point => [port.contact[0] + port.out[0] * eps, port.contact[1] + port.out[1] * eps];
  const clear = (route: Point[]): boolean => {
    if (!route.slice(1).every((point, i) => alongAxis([route[i], point], axes))) return false;
    if (runsAlongContour(route, contours, unit)) return false;
    const points = [out(a), ...route.slice(1, -1), out(b)];
    return points.slice(1).every((point, i) => !blocked(points[i], point, polygons));
  };
  const routes: Point[][] = [];
  const line: Point[] = [a.contact, b.contact];
  if (clear(line)) routes.push(line);
  const corner = cornerRoute([a, b]);
  if (corner && clear(corner)) routes.push(corner);
  routes.push(...standOffRoutes([a, b], unit).filter(clear));
  return routes;
}

/// The one-bend route where the two rays out of the faces meet, or `null` when they do not (parallel, or diverging).
function cornerRoute([a, b]: [Port, Port]): Point[] | null {
  const det = b.out[0] * a.out[1] - a.out[0] * b.out[1];
  if (Math.abs(det) <= 1e-6) return null;
  const rx = b.contact[0] - a.contact[0];
  const ry = b.contact[1] - a.contact[1];
  const s = (b.out[0] * ry - b.out[1] * rx) / det;
  const t = (a.out[0] * ry - a.out[1] * rx) / det;
  if (s <= 1e-6 || t <= 1e-6) return null;
  return [a.contact, [a.contact[0] + a.out[0] * s, a.contact[1] + a.out[1] * s], b.contact];
}

/// How far out of the faces the stand-off routes go, in cells: the first one clears the contours, each next one is
/// further out, for runs nested in each other.
const STAND_OFF_FIRST_SHARE = 1.3;
const STAND_OFF_STEP_SHARE = 0.5;
const STAND_OFF_LEVELS = 8;

/// For two faces that look the same way from one wall (a run glued to another stretch of the same side): a short
/// step out across the faces, a long run parallel to the wall, and a step back, at each of a few distances out.
function standOffRoutes([a, b]: [Port, Port], unit: number): Point[][] {
  const [ox, oy] = a.out;
  if (Math.hypot(ox - b.out[0], oy - b.out[1]) > 1e-6) return [];
  // Both contacts on one line along the wall.
  const across = (b.contact[0] - a.contact[0]) * ox + (b.contact[1] - a.contact[1]) * oy;
  if (Math.abs(across) > unit * START_EPS_SHARE || distance(a.contact, b.contact) < 1e-9) return [];
  return Array.from({ length: STAND_OFF_LEVELS }, (_, level): Point[] => {
    const out = unit * (STAND_OFF_FIRST_SHARE + STAND_OFF_STEP_SHARE * level);
    return [a.contact, [a.contact[0] + ox * out, a.contact[1] + oy * out], [b.contact[0] + ox * out, b.contact[1] + oy * out], b.contact];
  });
}

/// A route for one pair among the already fixed `others`: straight when that is clear of cells, of the
/// others' routes and of running along them; otherwise the ring route (nearest ring first, both ways
/// round) that crosses the fewest of them and never runs along one.
export function routePair([a, b]: [Port, Port], others: Point[][], polygons: Point[][], box: Bounds, unit: number, axes: readonly Axis[], contours: readonly Point[][] = []): Point[] {
  const crossings = (path: Point[]): number => others.filter((other) => pathsCross(other, path)).length;
  const direct = directRoutes([a, b], polygons, unit, axes, contours)
    .find((route) => crossings(route) === 0 && !others.some((other) => runsAlong(route, other, unit)));
  if (direct) return direct;
  if (ringBlocked([a, b], polygons, box, unit)) return forcedRoute([a, b], polygons, axes, unit, contours);
  let best: Point[] | null = null;
  let bestCost = Infinity;
  for (let ring = 0; ring <= others.length + 1; ring++) {
    for (const clockwise of [true, false]) {
      const route = ringRoute([a, b], box, unit * (RING_FIRST_SHARE + RING_STEP_SHARE * ring), clockwise);
      // The stretch leaving a face is shared with whatever else uses that face; only the ring counts.
      const along = others.some((other) => runsAlong(route.slice(1, -1), other, unit));
      const cost = (along ? 1e6 : 0) + others.filter((other) => pathsCross(other, route)).length * 1e3 + ring * 10 + pathLength(route) / 1e9;
      if (cost < bestCost) {
        best = route;
        bestCost = cost;
      }
    }
    // Rings only get longer: the first clean one (no crossing, nothing run along) is the best.
    if (bestCost < 1e3) break;
  }
  return best!;
}

/// Whether a ring route of the pair would run through a cell on the way from a face out to the ring (the leg out
/// of a face is the same on every ring and either way round).
function ringBlocked(ports: [Port, Port], polygons: Point[][], box: Bounds, unit: number): boolean {
  const eps = unit * START_EPS_SHARE;
  return ports.some((port) => {
    const start: Point = [port.contact[0] + port.out[0] * eps, port.contact[1] + port.out[1] * eps];
    return blocked(start, exitPoint(port, box, unit * RING_FIRST_SHARE), polygons);
  });
}

/// The route of a pair that cannot avoid the cells: the straight line or the one-bend route, whichever keeps to the
/// axes and crosses fewer cells (the line when neither keeps to them).
function forcedRoute([a, b]: [Port, Port], polygons: Point[][], axes: readonly Axis[], unit: number, contours: readonly Point[][]): Point[] {
  const line: Point[] = [a.contact, b.contact];
  const candidates: Point[][] = [line];
  const corner = cornerRoute([a, b]);
  if (corner) candidates.push(corner);
  const keepsToAxes = (route: Point[]): boolean => route.slice(1).every((point, i) => alongAxis([route[i], point], axes));
  const through = (route: Point[]): number => route.slice(1).filter((point, i) => blocked(route[i], point, polygons)).length;
  const fit = candidates.filter(keepsToAxes);
  const apart = fit.filter((route) => !runsAlongContour(route, contours, unit));
  if (apart.length > 0) return pickFewestCells(apart);
  if (fit.length === 0) return line;
  return pickFewestCells(fit);
  function pickFewestCells(routes: Point[][]): Point[] {
    return routes.reduce((best, route) => (through(route) < through(best) || (through(route) === through(best) && pathLength(route) < pathLength(best)) ? route : best));
  }
}

/// How far the segment `r-s` lies along the segment from `from` of unit direction `dir` and `length`: the length of the
/// overlap of their projections on that direction, clipped to the segment.
function projectedOverlap(from: Point, dir: Point, length: number, r: Point, s: Point): number {
  const tR = dir[0] * (r[0] - from[0]) + dir[1] * (r[1] - from[1]);
  const tS = dir[0] * (s[0] - from[0]) + dir[1] * (s[1] - from[1]);
  return Math.max(Math.min(Math.max(tR, tS), length) - Math.max(Math.min(tR, tS), 0), 0);
}

/// How far `point` lies off the line through `from` of unit direction `dir`.
function offLine(from: Point, dir: Point, point: Point): number {
  return Math.abs(dir[0] * (point[1] - from[1]) - dir[1] * (point[0] - from[0]));
}

/// Whether a segment of `path` runs parallel to a contour closer than one cell (`unit`) over a stretch: a connector
/// keeps at least a cell away from the contours, on the axis across them, instead of lying over them.
function runsAlongContour(path: Point[], contours: readonly Point[][], unit: number): boolean {
  const minOverlap = unit * 0.5;
  for (let i = 1; i < path.length; i++) {
    const length = distance(path[i - 1], path[i]);
    if (length <= minOverlap) continue;
    const dx = (path[i][0] - path[i - 1][0]) / length;
    const dy = (path[i][1] - path[i - 1][1]) / length;
    // The stretches along all the contours together: a segment between two runs lies along both their ends.
    let along = 0;
    for (const contour of contours) {
      for (let j = 1; j < contour.length; j++) {
        const r = contour[j - 1];
        const s = contour[j];
        if (Math.abs(dx * (s[1] - r[1]) - dy * (s[0] - r[0])) > 1e-3 * Math.max(distance(r, s), 1e-9)) continue;
        if (offLine(path[i - 1], [dx, dy], r) >= unit) continue;
        along += projectedOverlap(path[i - 1], [dx, dy], length, r, s);
      }
    }
    if (along > minOverlap) return true;
  }
  return false;
}

/// Whether `path` runs along `other` for a stretch: a segment of one lies on a segment of the other
/// (within a small tolerance) over more than a short overlap.
function runsAlong(path: Point[], other: Point[], unit: number): boolean {
  const tol = unit * 0.02;
  const minOverlap = unit * 0.1;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length <= minOverlap) continue;
    const dx = (q[0] - p[0]) / length;
    const dy = (q[1] - p[1]) / length;
    for (let j = 1; j < other.length; j++) {
      const r = other[j - 1];
      const s = other[j];
      if (offLine(p, [dx, dy], r) >= tol || offLine(p, [dx, dy], s) >= tol) continue;
      if (projectedOverlap(p, [dx, dy], length, r, s) > minOverlap) return true;
    }
  }
  return false;
}

export function pathLength(path: Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return total;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(polygons: Point[][], extra: Point[]): Bounds {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of [...polygons.flat(), ...extra]) {
    box.minX = Math.min(box.minX, point[0]);
    box.minY = Math.min(box.minY, point[1]);
    box.maxX = Math.max(box.maxX, point[0]);
    box.maxY = Math.max(box.maxY, point[1]);
  }
  return box;
}

const mod = (value: number, by: number): number => ((value % by) + by) % by;

/// Where the ray from the port's contact leaves the rectangle `box`.
function exitPoint(port: Port, box: Bounds, grow = 0): Point {
  const [x, y] = port.contact;
  const [dx, dy] = port.out;
  const candidates: number[] = [];
  if (dx > 1e-9) candidates.push((box.maxX + grow - x) / dx);
  if (dx < -1e-9) candidates.push((box.minX - grow - x) / dx);
  if (dy > 1e-9) candidates.push((box.maxY + grow - y) / dy);
  if (dy < -1e-9) candidates.push((box.minY - grow - y) / dy);
  const t = Math.max(0, Math.min(...candidates));
  return [x + dx * t, y + dy * t];
}

/// Position of a point of the rectangle's boundary along its perimeter: clockwise (on screen, y down)
/// from the top-left corner.
function perimeterPosition(point: Point, box: Bounds): number {
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const eps = 1e-6;
  if (Math.abs(point[1] - box.minY) < eps) return point[0] - box.minX;
  if (Math.abs(point[0] - box.maxX) < eps) return width + (point[1] - box.minY);
  if (Math.abs(point[1] - box.maxY) < eps) return width + height + (box.maxX - point[0]);
  return 2 * width + height + (box.maxY - point[1]);
}

/// The ring of each run: a run is on a ring further out than every run it contains, and on a different
/// ring from every run it overlaps only partly. Disjoint runs may share a ring.
function assignRings(runs: { lo: number; length: number }[], perimeter: number): number[] {
  const eps = 1e-9;
  const contains = (outer: { lo: number; length: number }, inner: { lo: number; length: number }): boolean =>
    mod(inner.lo - outer.lo, perimeter) + inner.length <= outer.length + eps;
  const overlaps = (p: { lo: number; length: number }, q: { lo: number; length: number }): boolean =>
    mod(q.lo - p.lo, perimeter) < p.length - eps || mod(p.lo - q.lo, perimeter) < q.length - eps;
  const order = runs.map((_, k) => k).sort((p, q) => runs[p].length - runs[q].length);
  const ring: number[] = runs.map(() => -1);
  for (const p of order) {
    let r = 0;
    for (const q of order) {
      if (ring[q] >= 0 && contains(runs[p], runs[q])) r = Math.max(r, ring[q] + 1);
    }
    const taken = (candidate: number): boolean =>
      order.some((q) => q !== p && ring[q] === candidate && overlaps(runs[p], runs[q]));
    while (taken(r)) r++;
    ring[p] = r;
  }
  return ring;
}

/// The route out of `a`'s face to the ring `offset` outside the box, round the ring, and into `b`'s face.
function ringRoute([a, b]: [Port, Port], box: Bounds, offset: number, clockwise: boolean): Point[] {
  const ring: Bounds = { minX: box.minX - offset, minY: box.minY - offset, maxX: box.maxX + offset, maxY: box.maxY + offset };
  const width = ring.maxX - ring.minX;
  const height = ring.maxY - ring.minY;
  const perimeter = 2 * (width + height);
  const enter = exitPoint(a, box, offset);
  const leave = exitPoint(b, box, offset);
  const sa = perimeterPosition(enter, ring);
  const sb = perimeterPosition(leave, ring);
  const corners: [number, Point][] = [
    [0, [ring.minX, ring.minY]],
    [width, [ring.maxX, ring.minY]],
    [width + height, [ring.maxX, ring.maxY]],
    [2 * width + height, [ring.minX, ring.maxY]],
  ];
  const span = clockwise ? mod(sb - sa, perimeter) : mod(sa - sb, perimeter);
  const passed = corners
    .map(([s, point]) => ({ along: clockwise ? mod(s - sa, perimeter) : mod(sa - s, perimeter), point }))
    .filter(({ along }) => along > 1e-9 && along < span - 1e-9)
    .sort((p, q) => p.along - q.along)
    .map(({ point }) => point);
  return dedupe([a.contact, enter, ...passed, leave, b.contact]);
}

/// The path without repeated points.
function dedupe(path: Point[]): Point[] {
  return path.filter((point, i) => i === 0 || Math.hypot(point[0] - path[i - 1][0], point[1] - path[i - 1][1]) > 1e-9);
}

// ---- Intersections ----

function orient(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/// Whether the open segments `p-q` and `r-s` cross at a single interior point.
function segmentsCross(p: Point, q: Point, r: Point, s: Point): boolean {
  const o1 = orient(p, q, r);
  const o2 = orient(p, q, s);
  const o3 = orient(r, s, p);
  const o4 = orient(r, s, q);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function pathsCross(a: Point[], b: Point[]): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) if (segmentsCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
  }
  return false;
}

/// Whether the segment `from-to` runs through any cell: it crosses a cell's boundary or lies inside it.
function blocked(from: Point, to: Point, polygons: Point[][]): boolean {
  const middle: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  return polygons.some((polygon) => {
    for (let i = 0; i < polygon.length; i++) {
      if (segmentsCross(from, to, polygon[i], polygon[(i + 1) % polygon.length])) return true;
    }
    return insidePolygon(middle, polygon);
  });
}

/// Whether `point` lies in `polygon` or on its border.
export function insidePolygon(point: Point, polygon: Point[]): boolean {
  return pointInPolygonBy(point[0], point[1], polygon, (v) => v[0], (v) => v[1]);
}

export function unitOf(from: Point, to: Point): Point {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return length === 0 ? [1, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}
