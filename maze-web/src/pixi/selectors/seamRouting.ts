/// Routing of the seam lines (GitHub issue #841, #917): where the seam arrows and the graph hops across a
/// seam run round the field. A route goes straight when nothing is in the way and otherwise is searched
/// over a horizontal and vertical grid (`searchRoute`); routes are kept off each other (no crossing where
/// it can be avoided, never closer than the line gap).
/// Pure display-space geometry: the callers decide which pairs of ports to route.

import { pointInPolygonBy } from "../tessellationGeometry";

export type Point = [number, number];

/// Distance of the first lane round the field from its bounding box, relative to the mean face length.
const RING_FIRST_SHARE = 1.6;
/// The thickness of a drawn seam line. Two lines keep at least four of these apart, centre to centre.
export const SEAM_LINE_WIDTH = 6;
const LINE_GAP = SEAM_LINE_WIDTH * 4;
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
/// of the routes already kept goes straight; the others are searched (`searchRoute`) one after another, the shorter span first,
/// each among the routes before it. A crossing that cannot be avoided (a Mobius strip, a torus) is left for the renderer to
/// draw as one arrow under the other.
export function routeAll(seams: [Port, Port][], polygons: Point[][], unit: number, axes: readonly Axis[], contours: readonly Point[][] = []): Point[][] {
  const routes: (Point[] | null)[] = seams.map(() => null);
  const straightKept: Point[][] = [];
  // The shorter span first, so a run nested in another keeps its route inside that one's.
  const bySpan = seams.map((_, i) => i).sort((p, q) => distance(seams[p][0].contact, seams[p][1].contact) - distance(seams[q][0].contact, seams[q][1].contact));
  for (const i of bySpan) {
    const direct = directRoutes(seams[i], polygons, unit, axes, contours)
      .find((route) => !straightKept.some((other) => pathsCross(other, route) || runsAlong(route, other, unit, LINE_GAP - 1e-6)));
    if (!direct) continue;
    routes[i] = direct;
    straightKept.push(direct);
  }

  // Every other pair: the cheapest route among the routes already kept, or, where none is clear of the cells, the plain
  // way through. Which route is laid first decides who sits inside whom, so a few orders are tried (by depth, by span, and
  // by position along each axis, either way) and the layout with the fewest crossings, then the least length, is kept.
  const box = boundsOf(polygons, seams.flat().map((port) => port.contact));
  const searched = bySpan.filter((i) => routes[i] === null);
  if (searched.length > 0) {
    const mid = (i: number, axis: 0 | 1): number => (seams[i][0].contact[axis] + seams[i][1].contact[axis]) / 2;
    // How deep a pair sits in the field: its faces' mean distance to the nearest side of the box. A pair near a side leaves
    // by it and goes inside the ones further in, so laying the shallow ones first nests them with no crossing.
    const depth = (i: number): number => seams[i].reduce((sum, port) => sum + (Math.abs(port.out[0]) >= Math.abs(port.out[1])
      ? Math.min(port.contact[1] - box.minY, box.maxY - port.contact[1])
      : Math.min(port.contact[0] - box.minX, box.maxX - port.contact[0])), 0);
    const orders: number[][] = [
      [...searched].sort((p, q) => depth(p) - depth(q)),
      searched,
      [...searched].reverse(),
      [...searched].sort((p, q) => mid(p, 1) - mid(q, 1)),
      [...searched].sort((p, q) => mid(q, 1) - mid(p, 1)),
      [...searched].sort((p, q) => mid(p, 0) - mid(q, 0)),
      [...searched].sort((p, q) => mid(q, 0) - mid(p, 0)),
    ];
    let bestLayout: (Point[] | null)[] | null = null;
    let bestScore = Infinity;
    for (const order of orders) {
      const layout = [...routes];
      for (const i of order) {
        const kept = layout.filter((route): route is Point[] => route !== null);
        layout[i] = searchRoute(seams[i], kept, polygons, box, unit, contours) ?? overCellsRoute(seams[i], kept, polygons, box, unit) ?? forcedRoute(seams[i], polygons, axes, unit, contours);
      }
      // Each route is then laid again among all the others, so runs that nest settle on nested lanes.
      for (let pass = 0; pass < REROUTE_PASSES && searched.length > 1; pass++) {
        for (const i of pass % 2 === 0 ? order : [...order].reverse()) {
          const others = layout.filter((route, j): route is Point[] => j !== i && route !== null);
          layout[i] = searchRoute(seams[i], others, polygons, box, unit, contours) ?? layout[i];
        }
      }
      const all = layout as Point[][];
      let crossings = 0;
      let along = 0;
      for (let p = 0; p < all.length; p++) {
        for (let q = p + 1; q < all.length; q++) {
          if (pathsCross(all[p], all[q])) crossings++;
          if (runsAlong(all[p], all[q], unit, LINE_GAP - 1e-6)) along++;
        }
      }
      const score = (crossings + along * 10) * 1e9 + all.reduce((sum, route) => sum + pathLength(route), 0);
      if (score < bestScore - 1e-9) {
        bestScore = score;
        bestLayout = layout;
      }
    }
    bestLayout!.forEach((route, i) => { routes[i] = route; });
  }
  return routes.map((route) => route!);
}

/// How many faces either side of the middle one are tried as the stem's port, at most.
const PORT_SEARCH_REACH = 4;

/// The faces (indices into `portsA` and `portsB`) the stem of a glue leaves from and arrives at: the middle ones when a
/// clean route joins them, else the pair nearest the middle that has one. A route is clean when it needs no pass over the
/// field: a direct one exists or the way out of both faces to a ring is free. With no clean pair the middle ones stay.
export function pickStemPorts(portsA: readonly Port[], portsB: readonly Port[], polygons: Point[][], unit: number, axes: readonly Axis[], contours: readonly Point[][] = []): [number, number] {
  const middleA = Math.floor(portsA.length / 2);
  const middleB = Math.floor(portsB.length / 2);
  // At most a quarter of the run either side of the middle, so the stem never leaves from near the end of the contour.
  const near = (length: number, middle: number): number[] => Array.from({ length }, (_, i) => i)
    .filter((i) => Math.abs(i - middle) <= Math.min(PORT_SEARCH_REACH, Math.max(1, Math.floor(length / 4))))
    .sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle) || p - q);
  const pairs = near(portsA.length, middleA).flatMap((i) => near(portsB.length, middleB).map((j): [number, number] => [i, j]))
    .sort((p, q) => (Math.abs(p[0] - middleA) + Math.abs(p[1] - middleB)) - (Math.abs(q[0] - middleA) + Math.abs(q[1] - middleB))
      // Both stems the same way off their middles, so the two ends sit level instead of one above and one below the centre.
      || Math.abs((p[0] - middleA) - (p[1] - middleB)) - Math.abs((q[0] - middleA) - (q[1] - middleB))
      || Math.max(Math.abs(p[0] - middleA), Math.abs(p[1] - middleB)) - Math.max(Math.abs(q[0] - middleA), Math.abs(q[1] - middleB)));
  const box = boundsOf(polygons, [...portsA, ...portsB].map((port) => port.contact));
  const clean = ([i, j]: [number, number]): boolean => {
    const pair: [Port, Port] = [portsA[i], portsB[j]];
    return directRoutes(pair, polygons, unit, axes, contours).length > 0 || !ringBlocked(pair, polygons, box, unit);
  };
  return pairs.find(clean) ?? [middleA, middleB];
}

/// The routes between two ports that need no search: the straight line (when it leaves both faces across them) and the
/// one-bend route where the two rays out of the faces meet (two runs meeting at a corner), each only when it keeps to the
/// axes and runs clear of every cell, plus the stand-off routes of faces looking the same way.
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
  if (leavesAlongNormals([a, b]) && clear(line)) routes.push(line);
  const corner = cornerRoute([a, b]);
  if (corner && clear(corner)) routes.push(corner);
  routes.push(...standOffRoutes([a, b], unit).filter(clear));
  return routes;
}

/// How little of a face's normal the straight line to the partner may have before it counts as running along the face.
const MIN_NORMAL_SHARE = 0.3;

/// Whether the straight line between two ports leaves both faces more across than along them. A line that lies along its
/// faces (two faces on one row looking the same way or away from each other) would run over the cells' borders, touching
/// neither face square, so such a pair needs a route with stubs out of the faces instead.
function leavesAlongNormals([a, b]: [Port, Port]): boolean {
  const dir = unitOf(a.contact, b.contact);
  return [a, b].every((port) => Math.abs(port.out[0] * dir[0] + port.out[1] * dir[1]) >= MIN_NORMAL_SHARE);
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
  // Rays leaning the same way meet in an acute corner: a hairpin, not a bend.
  if (a.out[0] * b.out[0] + a.out[1] * b.out[1] > 1e-6) return null;
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
/// others' routes and of running along them; otherwise the cheapest searched route (`searchRoute`).
export function routePair([a, b]: [Port, Port], others: Point[][], polygons: Point[][], box: Bounds, unit: number, axes: readonly Axis[], contours: readonly Point[][] = []): Point[] {
  const crossings = (path: Point[]): number => others.filter((other) => pathsCross(other, path)).length;
  const direct = directRoutes([a, b], polygons, unit, axes, contours)
    .find((route) => crossings(route) === 0 && !others.some((other) => runsAlong(route, other, unit, LINE_GAP - 1e-6)));
  if (direct) return direct;
  const searched = searchRoute([a, b], others, polygons, box, unit, contours);
  return searched ?? overCellsRoute([a, b], others, polygons, box, unit) ?? forcedRoute([a, b], polygons, axes, unit, contours);
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

/// The last resort before the plain line: the same search with the cells no obstacle, so the route crosses the field but
/// still leaves and meets the faces square. Not for faces that look along the line joining them: there the plain line
/// already leaves each face along its normal. The contours are no obstacle either: where the way round is shut by them, the
/// way over the field is the only one left.
function overCellsRoute([a, b]: [Port, Port], others: Point[][], polygons: Point[][], box: Bounds, unit: number): Point[] | null {
  const dir = unitOf(a.contact, b.contact);
  const along = (port: Port): boolean => Math.abs(port.out[0] * dir[1] - port.out[1] * dir[0]) < 1e-3;
  if (along(a) && along(b)) return null;
  // Across the field the route leaves each face inward and meets the other from inside, not out round the contour.
  const inward = (port: Port): Port => ({ contact: port.contact, out: [-port.out[0], -port.out[1]] });
  return searchRoute([inward(a), inward(b)], others, polygons, box, unit, NO_CONTOURS, true);
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

/// The price of one bend in a searched route, in cells of length: fewer bends win unless the detour is long.
const BEND_COST = 200;
/// The price of crossing another route and of running along one, in cells of length (running along is nearly forbidden).
const CROSS_COST = 10;
const ALONG_COST = 3000;
/// How many crossings one run along another weighs when lane attempts are compared: the ratio of their route prices.
const ALONG_PER_CROSSING = ALONG_COST / CROSS_COST;
/// How many times the searched routes are laid again among each other.
const REROUTE_PASSES = 3;
/// How many lanes round the field a search may use at most: a safeguard, since lanes are only added while the route found
/// still crosses or runs along another one.
const MAX_LANES = 48;

/// The cell size of the field: the side of a square of the mean cell area (a square's side, about 1.6 faces for a hex).
const cellSizeCache = new WeakMap<Point[][], number>();

function cellSize(polygons: Point[][], unit: number): number {
  const known = cellSizeCache.get(polygons);
  if (known !== undefined) return known;
  const size = measureCell(polygons, unit);
  cellSizeCache.set(polygons, size);
  return size;
}

function measureCell(polygons: Point[][], unit: number): number {
  const areas = polygons.map((polygon) => Math.abs(polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return sum + (p[0] * q[1] - q[0] * p[1]);
  }, 0)) / 2).filter((area) => area > 0);
  return areas.length === 0 ? unit : Math.sqrt(areas.reduce((sum, area) => sum + area, 0) / areas.length);
}

const NO_CELLS: Point[][] = [];
const NO_CONTOURS: Point[][] = [];

const barredCache = new WeakMap<Point[][], WeakMap<readonly Point[][], Map<string, boolean>>>();

/// The remembered verdicts (cell crossed or contour run along) of the grid edges of one field, shared by every search.
function barredEdges(polygons: Point[][], contours: readonly Point[][]): Map<string, boolean> {
  let byContours = barredCache.get(polygons);
  if (!byContours) barredCache.set(polygons, byContours = new WeakMap());
  let edges = byContours.get(contours);
  if (!edges) byContours.set(contours, edges = new Map());
  return edges;
}

const cellBoxCache = new WeakMap<Point[][], Bounds[]>();

function cellBoxes(polygons: Point[][]): Bounds[] {
  let boxes = cellBoxCache.get(polygons);
  if (!boxes) cellBoxCache.set(polygons, boxes = polygons.map((polygon) => boundsOf([polygon], [])));
  return boxes;
}

/// How far past a cell a route passes it, in cells: the clearance of the lines `linesPastBlockers` adds.
const PASS_SHARE = 0.5;

/// The lines that let a route slip past the first cell in its way: from each point, the first cell met along each of the
/// four axis rays gives one line just beyond each side of it. Without them a route blocked right at its stub has only the
/// lanes round the whole field to turn on, and runs out to them and back.
function linesPastBlockers(points: Point[], polygons: Point[][], area: Bounds, unit: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const clearance = unit * PASS_SHARE;
  const reach = Math.max(area.maxX - area.minX, area.maxY - area.minY) * 2;
  const boxes = cellBoxes(polygons);
  for (const point of points) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const far: Point = [point[0] + dx * reach, point[1] + dy * reach];
      let nearest = -1;
      let nearestAt = Infinity;
      boxes.forEach((box, i) => {
        const at = dx !== 0 ? (dx > 0 ? box.minX - point[0] : point[0] - box.maxX) : (dy > 0 ? box.minY - point[1] : point[1] - box.maxY);
        if (at < -1e-6 || at >= nearestAt) return;
        const across = dx !== 0 ? point[1] : point[0];
        if (across < (dx !== 0 ? box.minY : box.minX) || across > (dx !== 0 ? box.maxY : box.maxX)) return;
        if (!blocked(point, far, [polygons[i]])) return;
        nearest = i;
        nearestAt = at;
      });
      if (nearest < 0) continue;
      const box = boxes[nearest];
      if (dx !== 0) ys.push(box.minY - clearance, box.maxY + clearance);
      else xs.push(box.minX - clearance, box.maxX + clearance);
    }
  }
  return { xs, ys };
}

/// The cheapest route between two faces among the `others`, searched rather than built from a template. Each face is left
/// along its normal for one cell (a stub, so the route leaves square to its wall, whatever the slant of the face), and the
/// rest runs horizontally and vertically (A*) over the lines through the two stub ends and lanes round the field, added on demand. The price is
/// length, plus a charge per bend, a heavy one per crossing of another route and a near-prohibitive one per run along another,
/// so the path turns as soon as it is clear and never makes a detour that a bend or two would save. No leg crosses a cell or
/// lies along a contour, and no turn is sharper than a right angle. `null` when no such route exists.
function searchRoute([a, b]: [Port, Port], others: Point[][], polygons: Point[][], box: Bounds, unit: number, contours: readonly Point[][], overCells = false): Point[] | null {
  const eps = unit * START_EPS_SHARE;
  const stub = cellSize(polygons, unit);
  const stubEnd = (port: Port): Point => [port.contact[0] + port.out[0] * stub, port.contact[1] + port.out[1] * stub];
  const sa = stubEnd(a);
  const sb = stubEnd(b);
  const startShift: Point = [a.contact[0] + a.out[0] * eps, a.contact[1] + a.out[1] * eps];
  const endShift: Point = [b.contact[0] + b.out[0] * eps, b.contact[1] + b.out[1] * eps];
  // With `overCells` the cells are not obstacles: the last resort where no way round the field exists.
  const obstacles = overCells ? NO_CELLS : polygons;
  if (blocked(startShift, sa, obstacles) || blocked(endShift, sb, obstacles)) return null;

  const grown = boundsOf([], [[box.minX, box.minY], [box.maxX, box.maxY], sa, sb]);
  // Headings: 0 +x, 1 -x, 2 +y, 3 -y, 4 the first leg's own (only at the start).
  const dirs: Point[] = [[1, 0], [-1, 0], [0, 1], [0, -1], a.out];
  const edgeCosts = new Map<string, number>();
  const reach = unit * 0.1;
  const otherBoxes = others.map((other) => boundsOf([], other));
  const barred = barredEdges(obstacles, contours);
  const edgeCost = (p: Point, q: Point): number => {
    const key = `${p[0]},${p[1]},${q[0]},${q[1]}`;
    const known = edgeCosts.get(key);
    if (known !== undefined) return known;
    let cost = distance(p, q);
    let closed = barred.get(key);
    if (closed === undefined) {
      closed = blocked(p, q, obstacles) || runsAlongContour([p, q], contours, unit);
      barred.set(key, closed);
    }
    if (closed) cost = Infinity;
    else {
      const [lowX, highX] = p[0] < q[0] ? [p[0], q[0]] : [q[0], p[0]];
      const [lowY, highY] = p[1] < q[1] ? [p[1], q[1]] : [q[1], p[1]];
      others.forEach((other, k) => {
        const around = otherBoxes[k];
        if (around.maxX < lowX - reach || around.minX > highX + reach || around.maxY < lowY - reach || around.minY > highY + reach) return;
        if (pathsCross(other, [p, q])) cost += CROSS_COST * unit;
        if (runsAlong([p, q], other, unit, LINE_GAP - 1e-6)) cost += ALONG_COST * unit;
      });
    }
    edgeCosts.set(key, cost);
    return cost;
  };

  // The lanes round the field are added as the route needs them: it is searched with one lane a side, then twice as many
  // while the route found still crosses or runs along another one.
  const attempt = (lanes: number): Point[] | null => {
    const lines = (low: number, high: number, own: number[]): number[] => {
      const values = [...own];
      // The lanes round the field lie on one lattice (multiples of the line gap), so routes laid apart share lanes
      // that are never closer than the gap.
      const inner = Math.floor((low - unit * RING_FIRST_SHARE) / LINE_GAP) * LINE_GAP;
      const outer = Math.ceil((high + unit * RING_FIRST_SHARE) / LINE_GAP) * LINE_GAP;
      for (let k = 0; k < lanes; k++) values.push(inner - LINE_GAP * k, outer + LINE_GAP * k);
      return values.sort((p, q) => p - q).filter((value, i, all) => i === 0 || value - all[i - 1] > 1e-6);
    };
    const past = linesPastBlockers([sa, sb], obstacles, grown, unit);
    // Across the field there are no cells to give lines past them, so the middle of the two stub ends gives a turn inside it.
    const middle = overCells ? [(sa[0] + sb[0]) / 2] : [];
    const middleY = overCells ? [(sa[1] + sb[1]) / 2] : [];
    const xs = lines(grown.minX, grown.maxX, [sa[0], sb[0], ...past.xs, ...middle]);
    const ys = lines(grown.minY, grown.maxY, [sa[1], sb[1], ...past.ys, ...middleY]);
    const indexOf = (values: number[], value: number): number => values.findIndex((v) => Math.abs(v - value) < 1e-6);


    interface State { ix: number; iy: number; heading: number; cost: number; f: number; from: number }
    const states: State[] = [];
    const best = new Map<string, number>();
    const open: number[] = [];
    const keyOf = (ix: number, iy: number, heading: number): string => `${ix},${iy}:${heading}`;
    const goalX = indexOf(xs, sb[0]);
    const goalY = indexOf(ys, sb[1]);
    // A* order: the cost so far plus the grid distance left, which no route can undercut.
    const push = (ix: number, iy: number, heading: number, cost: number, from: number): void => {
      const f = cost + Math.abs(xs[ix] - sb[0]) + Math.abs(ys[iy] - sb[1]);
      const known = best.get(keyOf(ix, iy, heading));
      if (known !== undefined && states[known].cost <= cost + 1e-12) return;
      states.push({ ix, iy, heading, cost, f, from });
      best.set(keyOf(ix, iy, heading), states.length - 1);
      // Sift the new state up the binary heap `open`.
      let at = open.length;
      open.push(states.length - 1);
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (states[open[parent]].f <= f) break;
        [open[parent], open[at]] = [open[at], open[parent]];
        at = parent;
      }
    };
    push(indexOf(xs, sa[0]), indexOf(ys, sa[1]), 4, 0, -1);
    const toward: Point = [-b.out[0], -b.out[1]];
    let finish: { cost: number; state: number } | null = null;
    while (open.length > 0) {
      const current = open[0];
      const last = open.pop()!;
      if (open.length > 0) {
        open[0] = last;
        let at = 0;
        for (;;) {
          let least = at;
          for (const child of [2 * at + 1, 2 * at + 2]) if (child < open.length && states[open[child]].f < states[open[least]].f) least = child;
          if (least === at) break;
          [open[least], open[at]] = [open[at], open[least]];
          at = least;
        }
      }
      const state = states[current];
      if (finish && state.f >= finish.cost) break;
      if (best.get(keyOf(state.ix, state.iy, state.heading)) !== current) continue;
      const heading = dirs[state.heading];
      if (state.ix === goalX && state.iy === goalY) {
        // Arriving: the last leg is the other face's stub, which must not be met by a sharp turn.
        const dot = heading[0] * toward[0] + heading[1] * toward[1];
        if (dot >= -1e-6) {
          const total = state.cost + (dot < 1 - 1e-4 ? unit * BEND_COST : 0);
          if (!finish || total < finish.cost) finish = { cost: total, state: current };
        }
      }
      for (let d = 0; d < 4; d++) {
        const dot = heading[0] * dirs[d][0] + heading[1] * dirs[d][1];
        if (dot < -1e-6) continue;
        const nx = state.ix + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = state.iy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
        const cost = edgeCost([xs[state.ix], ys[state.iy]], [xs[nx], ys[ny]]);
        if (!Number.isFinite(cost)) continue;
        push(nx, ny, d, state.cost + cost + (dot < 1 - 1e-4 ? unit * BEND_COST : 0), current);
      }
    }
    if (!finish) return null;
    const chain: Point[] = [];
    for (let at = finish.state; at >= 0; at = states[at].from) chain.unshift([xs[states[at].ix], ys[states[at].iy]]);
    return mergeStraight(dedupe([a.contact, ...chain, b.contact]));
  };
  // Running along another route weighs far more than crossing one, as in the price of a route.
  const clashCount = (route: Point[]): number => others.reduce((sum, other) => sum + (pathsCross(other, route) ? 1 : 0) + (runsAlong(route, other, unit, LINE_GAP - 1e-6) ? ALONG_PER_CROSSING : 0), 0);
  // No more lanes than there are routes to keep apart. The best route found so far (fewest clashes) is kept.
  const most = Math.min(others.length + 1, MAX_LANES);
  let found: Point[] | null = null;
  let foundClashes = Infinity;
  for (let lanes = 1; ; lanes *= 2) {
    const route = attempt(Math.min(lanes, most));
    const clashes = route ? clashCount(route) : Infinity;
    if (route && clashes < foundClashes) {
      found = route;
      foundClashes = clashes;
    }
    if (foundClashes === 0 || lanes >= most) return found;
  }
}

/// The path without the points where it does not turn.
function mergeStraight(path: Point[]): Point[] {
  return path.filter((point, i) => {
    if (i === 0 || i === path.length - 1) return true;
    const before = unitOf(path[i - 1], point);
    const after = unitOf(point, path[i + 1]);
    return Math.abs(before[0] * after[1] - before[1] * after[0]) > 1e-6;
  });
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
function runsAlong(path: Point[], other: Point[], unit: number, tol = unit * 0.02): boolean {
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
