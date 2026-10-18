import type { Graphics, GraphicsContext } from "pixi.js";

export type CorridorPoint = { x: number; y: number };
type Pt = CorridorPoint;
export type CorridorCellId = string | number;
export type CorridorCell = { id: CorridorCellId; center: CorridorPoint; polygon: readonly CorridorPoint[] };
export type CorridorPort = {
  cellId: CorridorCellId;
  midpoint: CorridorPoint;
  normal: CorridorPoint;
  face?: readonly [CorridorPoint, CorridorPoint];
};
export type PathCmd =
  | { kind: "move"; to: Pt }
  | { kind: "line"; to: Pt }
  | { kind: "quadratic"; cp: Pt; to: Pt }
  | { kind: "bezier"; cp1: Pt; cp2: Pt; to: Pt }
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number; ccw: boolean };
export type ContourPath = { cmds: PathCmd[]; hole: boolean };
export type CorridorGeometryDebug = {
  cellId: CorridorCellId;
  target: Pt;
  centerCurves: Array<{ portIndex: number; path: PathCmd[]; controlPoints: Pt[] }>;
  rawRibbons: Array<{ portIndex: number; left: Pt[]; right: Pt[] }>;
  ribbons: Array<{ portIndex: number; left: Pt[]; right: Pt[] }>;
  contourBeforeCornerRadius: ContourPath[];
  contour: ContourPath[];
};

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, scalar: number): Pt => ({ x: a.x * scalar, y: a.y * scalar });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const norm = (a: Pt): Pt => {
  const length = len(a) || 1;
  return { x: a.x / length, y: a.y / length };
};
const leftN = (direction: Pt): Pt => ({ x: -direction.y, y: direction.x });
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const angleOf = (point: Pt): number => Math.atan2(point.y, point.x);

export type CorridorSegmentInput = {
  v0: Pt;
  v1: Pt;
  faceMidpoint?: Pt;
  faceNormal?: Pt;
  faceLength?: number;
  cellVertices0?: Pt[];
  cellVertices1?: Pt[];
  v1TouchesSplit?: boolean;
};
type Port = { centre: Pt; mid: Pt; out: Pt };
type Tile = { id: CorridorCellId; centre: Pt; ports: Port[]; boundary: readonly Pt[] };

/** Angular tolerance, in radians, for treating a port as lying on the atan2 branch cut. */
const PORT_ANGLE_EPSILON = 1e-9;

/** Junction corner radius used when the caller requests none, as a fraction of the half-width. */
const DEFAULT_JUNCTION_RADIUS_FACTOR = 0.75;

function faceLength(face: CorridorPort["face"]): number | undefined {
  if (!face) return undefined;
  const value = len(sub(face[1], face[0]));
  return Number.isFinite(value) ? value : undefined;
}

function halfWidthForPorts(ports: readonly CorridorPort[], requested: number): number {
  const lengths = ports.map((port) => faceLength(port.face)).filter((value): value is number => value !== undefined && value > 0);
  const shortest = Math.min(...lengths);
  return Number.isFinite(shortest) ? Math.min(requested, shortest / 2) : requested;
}

function buildTilesFromCells(cells: readonly CorridorCell[], ports: readonly CorridorPort[]): Tile[] {
  const cellById = new Map<CorridorCellId, CorridorCell>(cells.map((cell) => [cell.id, cell]));
  const tiles = new Map<CorridorCellId, Tile>();
  for (const port of ports) {
    const cell = cellById.get(port.cellId);
    if (!cell || cell.polygon.length < 3) continue;
    const tile = tiles.get(cell.id) ?? { id: cell.id, centre: cell.center, ports: [], boundary: cell.polygon };
    tile.ports.push({ centre: cell.center, mid: port.midpoint, out: norm(port.normal) });
    tiles.set(cell.id, tile);
  }
  return [...tiles.values()];
}

/** How far a pair of ports is from a pass straight through the cell: the distance between the
 *  midpoint of their mouths and the cell centre. Zero for two faces mirrored through the centre
 *  (opposite faces of a hexagon or of a brick), larger for faces that face each other off-centre. */
function pairCentreOffset(first: Port, second: Port): number {
  return len(sub(mul(add(first.mid, second.mid), 0.5), first.centre));
}

/** Returns the pair of ports whose normals are farthest apart in angle. The angle between two
 *  directions is taken the short way round, so it never exceeds 180°: a pair 270° apart counts as
 *  90° and loses to a pair 170° apart. Each unordered pair is considered once (1-2 and 2-1 are the
 *  same pair). When several distinct pairs share the maximum angle the one passing closest to the
 *  cell centre wins (the pass the tessellation calls straight keeps its line when a third port
 *  joins it, instead of being bent through the centre). When that is tied too there is no
 *  preferred pair, and `null` sends the target to the cell centre. */
function mostOppositePortPair(ports: readonly Port[]): [Port, Port] | null {
  if (ports.length < 2) return null;
  let smallestNormalDot = Number.POSITIVE_INFINITY;
  for (let firstIndex = 0; firstIndex < ports.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < ports.length; secondIndex++) {
      smallestNormalDot = Math.min(smallestNormalDot, dot(ports[firstIndex].out, ports[secondIndex].out));
    }
  }
  const widest: Array<{ pair: [Port, Port]; offset: number }> = [];
  for (let firstIndex = 0; firstIndex < ports.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < ports.length; secondIndex++) {
      const pair: [Port, Port] = [ports[firstIndex], ports[secondIndex]];
      if (dot(pair[0].out, pair[1].out) <= smallestNormalDot + 1e-9) widest.push({ pair, offset: pairCentreOffset(...pair) });
    }
  }
  const closest = Math.min(...widest.map((candidate) => candidate.offset));
  const best = widest.filter((candidate) => candidate.offset <= closest + PAIR_OFFSET_EPSILON);
  return best.length === 1 ? best[0].pair : null;
}

/** Offsets closer than this (world units) count as equally close to the centre. */
const PAIR_OFFSET_EPSILON = 1e-6;

function directPairCurveCenter(from: Port, to: Port): Pt {
  // This provisional pair curve is used only to locate the target. The target-side tangents of the
  // actual centre curves are set separately by `biarcTargetTangents`.
  const distance = len(sub(to.mid, from.mid));
  if (distance <= 1e-7) return from.centre;
  const handle = distance * pairCurveHandleRatio(from, to);
  const cp1 = sub(from.mid, mul(from.out, handle));
  const cp2 = sub(to.mid, mul(to.out, handle));
  const points = sampledCubicPoints(from.mid, cp1, cp2, to.mid, curveSampleSteps(distance));
  return pointAtPolylineDistance(points, polylineLength(points) / 2).point;
}

/** Direction of travel at `target` of the circular arc that leaves `port` inward and passes
 *  through `target`: the inward direction mirrored across the port-to-target chord. */
function arcArrivalTangent(port: Port, target: Pt): Pt {
  const inward = norm(mul(port.out, -1));
  const chord = norm(sub(target, port.mid));
  return norm(sub(mul(chord, 2 * dot(inward, chord)), inward));
}

/** Unsigned angle between two directions, in `[0, π]`. */
function angleBetween(a: Pt, b: Pt): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));
}

/** Cubic handle ratio (handle length / chord length) that approximates a circular arc turning
 *  from `start` to `end`: `1 / (3 cos²(phi / 4))`, where `phi` is the arc's turning angle. */
function arcHandleRatio(start: Pt, end: Pt): number {
  const cosine = Math.cos(angleBetween(start, end) / 4);
  return 1 / (3 * cosine * cosine);
}

/** Target tangents and handle ratios for the most opposite pair, built as a biarc: each half would
 *  be a circular arc from its port through the target, and the shared target tangent is the
 *  compromise between the two arcs' arrival directions. Both halves then pass through the target as
 *  one smooth curve. On regular cells both arcs agree and the turn is one exact circular arc;
 *  on irregular cells (Cairo) the compromise depends on the real port positions, not on the port
 *  normals alone, which would skew the curve into an S-shaped hump. */
function biarcTargetTangents(first: Port, second: Port, target: Pt): {
  firstTangent: Pt;
  secondTangent: Pt;
  firstHandleRatio: number;
  secondHandleRatio: number;
} {
  // `secondTangent` is the second half's travel direction at the target (port -> target), so the
  // continuous curve needs `firstTangent === -secondTangent`.
  const joined = sub(arcArrivalTangent(first, target), arcArrivalTangent(second, target));
  const firstTangent = len(joined) > 1e-7 ? norm(joined) : norm(sub(second.mid, first.mid));
  const secondTangent = mul(firstTangent, -1);
  return {
    firstTangent,
    secondTangent,
    firstHandleRatio: arcHandleRatio(mul(first.out, -1), firstTangent),
    secondHandleRatio: arcHandleRatio(mul(second.out, -1), secondTangent),
  };
}

function portBorderEnds(port: Port, halfWidth: number): { left: Pt; right: Pt } {
  const tangent = leftN(port.out);
  return { left: add(port.mid, mul(tangent, halfWidth)), right: sub(port.mid, mul(tangent, halfWidth)) };
}

function cubicPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
function cubicTangent(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}
function pointsEqual(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= 1e-7 && Math.abs(a.y - b.y) <= 1e-7;
}
function arcPoint(centre: Pt, radius: number, angle: number): Pt {
  return { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius };
}
/** Signed sweep of an arc command, normalized to its drawing direction (`ccw` sweeps negative). */
function arcSweep(command: Extract<PathCmd, { kind: "arc" }>): number {
  let sweep = command.a1 - command.a0;
  if (command.ccw) {
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
  } else {
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
  }
  return sweep;
}
function pathCommandEnd(command: PathCmd): Pt {
  return command.kind === "arc" ? arcPoint(command.c, command.r, command.a1) : command.to;
}

/** Sample count for a centre curve of chord `distance`. The ribbon sides are later trimmed at their
 *  first intersection, so their inner side is much more sensitive to polyline resolution than the
 *  outer closure arc. Do not make the resolution inversely proportional to corridor thickness: a
 *  thicker ribbon must not turn a smooth side into a short faceted chain. Keep a stable geometric
 *  step and a bounded upper cost. */
function curveSampleSteps(distance: number): number {
  return Math.max(32, Math.min(96, Math.ceil(distance / 2)));
}

function sampledCubicPoints(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number): Pt[] {
  const points: Pt[] = [];
  for (let index = 0; index <= steps; index++) points.push(cubicPoint(p0, p1, p2, p3, index / steps));
  return points;
}

function sampledPolylineCurvature(points: readonly Pt[]): number {
  let maximum = 0;
  for (let index = 1; index + 1 < points.length; index++) {
    const before = sub(points[index], points[index - 1]);
    const after = sub(points[index + 1], points[index]);
    const beforeLength = len(before);
    const afterLength = len(after);
    if (beforeLength <= 1e-7 || afterLength <= 1e-7) continue;
    const cosine = Math.max(-1, Math.min(1, dot(before, after) / (beforeLength * afterLength)));
    maximum = Math.max(maximum, Math.acos(cosine) / ((beforeLength + afterLength) / 2));
  }
  return maximum;
}

function regularizedOffsetCubic(
  p0: Pt,
  cp1: Pt,
  cp2: Pt,
  p3: Pt,
  halfWidth: number,
  side: number,
  steps: number,
): Pt[] {
  const startTangent = norm(sub(cp1, p0));
  const endTangent = norm(sub(p3, cp2));
  const start = add(p0, mul(leftN(startTangent), side * halfWidth));
  const end = add(p3, mul(leftN(endTangent), side * halfWidth));
  const exactOffset = sampledCubicPoints(p0, cp1, cp2, p3, steps).map((centre, index) => {
    const t = index / steps;
    const tangentValue = cubicTangent(p0, cp1, cp2, p3, t);
    const tangent = norm(len(tangentValue) > 1e-7 ? tangentValue : sub(p3, p0));
    return add(centre, mul(leftN(tangent), side * halfWidth));
  });

  let aa = 0;
  let ab = 0;
  let bb = 0;
  let ay = 0;
  let by = 0;
  const totalLength = polylineLength(exactOffset);
  let travelled = 0;
  for (let index = 0; index < exactOffset.length; index++) {
    if (index > 0) travelled += len(sub(exactOffset[index], exactOffset[index - 1]));
    const t = totalLength > 1e-7 ? travelled / totalLength : index / steps;
    const u = 1 - t;
    const firstBasis = 3 * u * u * t;
    const secondBasis = 3 * u * t * t;
    const base = add(mul(start, u * u * u + firstBasis), mul(end, secondBasis + t * t * t));
    const firstCoefficient = mul(startTangent, firstBasis);
    const secondCoefficient = mul(endTangent, -secondBasis);
    const residual = sub(exactOffset[index], base);
    aa += dot(firstCoefficient, firstCoefficient);
    ab += dot(firstCoefficient, secondCoefficient);
    bb += dot(secondCoefficient, secondCoefficient);
    ay += dot(firstCoefficient, residual);
    by += dot(secondCoefficient, residual);
  }

  const determinant = aa * bb - ab * ab;
  const fallback = Math.max(1e-4, len(sub(end, start)) / 3);
  const fittedFirst = determinant > 1e-8 ? (ay * bb - by * ab) / determinant : fallback;
  const fittedSecond = determinant > 1e-8 ? (by * aa - ay * ab) / determinant : fallback;
  const chord = Math.max(1e-4, len(sub(end, start)));
  const candidates = [0.25, 0.35, 0.45, 0.55, 0.7, 0.9, 1.1].map((factor) => chord * factor);
  const makeCandidate = (firstHandle: number, secondHandle: number): Pt[] => sampledCubicPoints(
    start,
    add(start, mul(startTangent, firstHandle)),
    sub(end, mul(endTangent, secondHandle)),
    end,
    steps,
  );
  const initial = makeCandidate(Math.max(0, fittedFirst), Math.max(0, fittedSecond));
  const maximumCurvature = 0.8 / Math.max(halfWidth, 1);
  if (sampledPolylineCurvature(initial) <= maximumCurvature) return initial;

  let best = initial;
  let bestCurvature = sampledPolylineCurvature(initial);
  let bestError = Number.POSITIVE_INFINITY;
  for (const firstHandle of candidates) {
    for (const secondHandle of candidates) {
      const candidate = makeCandidate(firstHandle, secondHandle);
      const curvature = sampledPolylineCurvature(candidate);
      let error = 0;
      for (let index = 0; index < candidate.length; index++) error += len(sub(candidate[index], exactOffset[index])) ** 2;
      if ((curvature <= maximumCurvature && (bestCurvature > maximumCurvature || error < bestError)) ||
        (bestCurvature > maximumCurvature && curvature < bestCurvature)) {
        best = candidate;
        bestCurvature = curvature;
        bestError = error;
      }
    }
  }
  return best;
}

/** `endDirection` is the centre curve's travel direction at its end (see `centreCurveEndDirection`). */
type Ribbon = { left: Pt[]; right: Pt[]; path: PathCmd[]; controlPoints: Pt[]; endDirection: Pt };
type TargetTangent = { tangent: Pt; handleRatio: number };

type Cubic = { p0: Pt; p1: Pt; p2: Pt; p3: Pt };

/** Cubic centre curve from `port` (leaving along its inward normal) to `target`. Without
 *  `targetTangent` the curve arrives radially with straight-line handles (ratio 1/3). */
function centreCurve(port: Port, target: Pt, targetTangent?: TargetTangent): Cubic {
  const from = port.mid;
  const handle = len(sub(target, from)) * (targetTangent?.handleRatio ?? 1 / 3);
  return {
    p0: from,
    p1: sub(from, mul(port.out, handle)),
    p2: sub(target, mul(norm(targetTangent?.tangent ?? sub(target, from)), handle)),
    p3: target,
  };
}

/** The part of `curve` over `[0, t]`, as an exact cubic (de Casteljau). */
function cubicHead(curve: Cubic, t: number): Cubic {
  const lerp = (a: Pt, b: Pt): Pt => add(a, mul(sub(b, a), t));
  const a = lerp(curve.p0, curve.p1);
  const b = lerp(curve.p1, curve.p2);
  const c = lerp(curve.p2, curve.p3);
  const ab = lerp(a, b);
  const bc = lerp(b, c);
  return { p0: curve.p0, p1: a, p2: ab, p3: lerp(ab, bc) };
}

/** Offsets `curve` (starting at `port`) by `halfWidth` on both sides. */
function ribbonAlong(port: Port, curve: Cubic, halfWidth: number): Ribbon {
  const { p0, p1, p2, p3 } = curve;
  const steps = curveSampleSteps(len(sub(p3, p0)));
  const left = regularizedOffsetCubic(p0, p1, p2, p3, halfWidth, 1, steps);
  const right = regularizedOffsetCubic(p0, p1, p2, p3, halfWidth, -1, steps);
  const ends = portBorderEnds(port, halfWidth);
  left[0] = ends.right;
  right[0] = ends.left;
  return {
    left,
    right,
    path: [{ kind: "move", to: p0 }, { kind: "bezier", cp1: p1, cp2: p2, to: p3 }],
    controlPoints: [p1, p2],
    endDirection: centreCurveEndDirection(port, curve),
  };
}

/** Outward unit normal and room (signed distance from `point`) for every face of a convex cell. */
function facesSeenFrom(point: Pt, boundary: readonly Pt[]): Array<{ outward: Pt; room: number }> {
  const interior = mul(boundary.reduce((sum, vertex) => add(sum, vertex), { x: 0, y: 0 }), 1 / boundary.length);
  return boundary.map((a, index) => {
    let outward = norm(leftN(sub(boundary[(index + 1) % boundary.length], a)));
    if (dot(outward, sub(a, interior)) < 0) outward = mul(outward, -1);
    return { outward, room: dot(sub(a, point), outward) };
  });
}

/** Whether a round dead-end cap — the half-disc of `halfWidth` around `centre`, facing `forward` —
 *  fits the convex `boundary`. Toward a face ahead of it (outward normal pointing forward) the
 *  half-disc reaches the full `halfWidth`; toward any other face only `halfWidth · |sin|` of the
 *  angle between that normal and `forward`. */
function roundCapFits(centre: Pt, forward: Pt, halfWidth: number, boundary: readonly Pt[]): boolean {
  const along = norm(forward);
  return facesSeenFrom(centre, boundary).every(({ outward, room }) => {
    const reach = dot(outward, along) > 0 ? halfWidth : halfWidth * Math.abs(cross(outward, along));
    return room >= reach - 1e-7;
  });
}

/** Centre curve of a dead end whose round cap (a half-disc of `halfWidth` around the curve's end)
 *  fits the cell. When the cap does not fit at the target, the end moves back along the original
 *  centre curve toward the port, to the farthest point where it fits. `null` when it does not fit
 *  even at the port (see `kinkedDeadEndCap`). */
function deadEndCentreCurve(port: Port, target: Pt, halfWidth: number, boundary: readonly Pt[]): Cubic | null {
  const curve = centreCurve(port, target);
  const roundCapFitsAt = (t: number): boolean =>
    roundCapFits(cubicHead(curve, t).p3, cubicTangent(curve.p0, curve.p1, curve.p2, curve.p3, t), halfWidth, boundary);
  if (roundCapFitsAt(1)) return curve;
  if (!roundCapFitsAt(0)) return null;
  // Advancing the end moves the cap toward the far faces, so the ends where it fits are taken as one
  // interval starting at the port; bisect its far end.
  let fits = 0;
  let fails = 1;
  for (let iteration = 0; iteration < 40; iteration++) {
    const candidate = (fits + fails) / 2;
    if (roundCapFitsAt(candidate)) fits = candidate;
    else fails = candidate;
  }
  return cubicHead(curve, fits);
}

/** The deepest circular arc from `start` to `end`, bulging toward `bulge` (perpendicular to the
 *  chord), by at most `maxSagitta`, that stays inside the convex `boundary`; a straight line when no
 *  bulge fits. It meets the chord's ends at an angle (a kink) unless it is a full semicircle.
 *
 *  With half-chord `c` and sagitta `s`, the arc has radius `R = (c² + s²) / 2s`, its centre `R − s`
 *  behind the chord, and spans `±θ` around `bulge` with `cos θ = (c² − s²) / (c² + s²)`. A face
 *  with outward normal `o` (`β = o·bulge`) and room `r` from the chord's middle is only reached by
 *  the arc's interior once `β ≥ cos θ`; the arc's farthest point toward it is then `sβ + R(1 − β)`
 *  from the middle, which stays within `r` for `(1 + β)s² − 2rs + (1 − β)c² ≤ 0`, i.e. up to the
 *  larger root. Below that span only the chord's ends face it, and they lie inside the cell. */
function deepestChordArc(start: Pt, end: Pt, bulge: Pt, maxSagitta: number, boundary: readonly Pt[]): PathCmd {
  const middle = mid(start, end);
  const direction = norm(bulge);
  const halfChord = len(sub(end, start)) / 2;
  let sagitta = Math.min(maxSagitta, halfChord);
  for (const { outward, room } of facesSeenFrom(middle, boundary)) {
    const beta = dot(outward, direction);
    if (beta <= 0) continue;
    const discriminant = room * room - (1 - beta * beta) * halfChord * halfChord;
    // A negative discriminant would mean a chord end outside the cell; the arc then only fits while
    // it does not reach this face at all.
    const faceLimit = discriminant >= 0 ? (room + Math.sqrt(discriminant)) / (1 + beta) : halfChord * Math.sqrt((1 - beta) / (1 + beta));
    sagitta = Math.min(sagitta, faceLimit);
  }
  if (sagitta <= 1e-9) return { kind: "line", to: end };
  const radius = (halfChord * halfChord + sagitta * sagitta) / (2 * sagitta);
  const centre = add(middle, mul(direction, sagitta - radius));
  const apex = add(middle, mul(direction, sagitta));
  const fromCentre = sub(start, centre);
  // `ccw: true` decreases the angle, starting along `(y, -x)` of `fromCentre`; take the way through the apex.
  const ccw = dot({ x: fromCentre.y, y: -fromCentre.x }, sub(apex, start)) > 0;
  return { kind: "arc", c: centre, r: radius, a0: angleOf(fromCentre), a1: angleOf(sub(end, centre)), ccw };
}

/** Dead end whose round cap does not fit even at the port: the deepest arc through both mouth ends
 *  (`deepestChordArc`), meeting the mouth at an angle instead of leaving it perpendicularly. */
function kinkedDeadEndCap(port: Port, halfWidth: number, boundary: readonly Pt[]): PathCmd[] {
  const across = leftN(port.out);
  const start = add(port.mid, mul(across, halfWidth));
  const end = sub(port.mid, mul(across, halfWidth));
  return [
    { kind: "move", to: start },
    deepestChordArc(start, end, mul(port.out, -1), halfWidth, boundary),
    { kind: "line", to: start },
  ];
}

/** Whether an arc stays inside the convex `boundary`. Per face, the arc's farthest point toward it
 *  is the full radius when the face's outward normal lies within the arc's swept angles, and one of
 *  the arc's two ends otherwise. */
function arcInsideConvexCell(arc: Extract<PathCmd, { kind: "arc" }>, boundary: readonly Pt[]): boolean {
  const sweep = arcSweep(arc);
  const ends = [arcPoint(arc.c, arc.r, arc.a0), arcPoint(arc.c, arc.r, arc.a1)];
  return facesSeenFrom(arc.c, boundary).every(({ outward, room }) => {
    let fromStart = (sweep >= 0 ? angleOf(outward) - arc.a0 : arc.a0 - angleOf(outward)) % (Math.PI * 2);
    if (fromStart < 0) fromStart += Math.PI * 2;
    const reach = fromStart <= Math.abs(sweep) ? arc.r : Math.max(...ends.map((point) => dot(sub(point, arc.c), outward)));
    return room >= reach - 1e-7;
  });
}

type PolylineHit = { point: Pt; aDistance: number; bDistance: number };
function firstPolylineIntersection(a: readonly Pt[], b: readonly Pt[]): PolylineHit | null {
  let aOffset = 0;
  let best: PolylineHit | null = null;
  for (let ai = 0; ai + 1 < a.length; ai++) {
    const a0 = a[ai];
    const ad = sub(a[ai + 1], a0);
    const aLength = len(ad);
    if (aLength <= 1e-8) continue;
    let bOffset = 0;
    for (let bi = 0; bi + 1 < b.length; bi++) {
      const b0 = b[bi];
      const bd = sub(b[bi + 1], b0);
      const bLength = len(bd);
      if (bLength <= 1e-8) continue;
      const denominator = cross(ad, bd);
      if (Math.abs(denominator) <= 1e-9) {
        bOffset += bLength;
        continue;
      }
      const delta = sub(b0, a0);
      const ta = cross(delta, bd) / denominator;
      const tb = cross(delta, ad) / denominator;
      if (ta >= -1e-7 && ta <= 1 + 1e-7 && tb >= -1e-7 && tb <= 1 + 1e-7) {
        const aAmount = Math.max(0, Math.min(1, ta));
        const bAmount = Math.max(0, Math.min(1, tb));
        const candidate = {
          point: add(a0, mul(ad, aAmount)),
          aDistance: aOffset + aLength * aAmount,
          bDistance: bOffset + bLength * bAmount,
        };
        if (!best || candidate.aDistance < best.aDistance - 1e-7 ||
          (Math.abs(candidate.aDistance - best.aDistance) <= 1e-7 && candidate.bDistance < best.bDistance)) best = candidate;
      }
      bOffset += bLength;
    }
    aOffset += aLength;
  }
  return best;
}
function polylineLength(points: readonly Pt[]): number {
  let result = 0;
  for (let index = 1; index < points.length; index++) result += len(sub(points[index], points[index - 1]));
  return result;
}
function pointAtPolylineDistance(points: readonly Pt[], distance: number): { point: Pt; tangent: Pt } {
  if (points.length === 0) return { point: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  if (points.length === 1) return { point: points[0], tangent: { x: 1, y: 0 } };
  let remaining = Math.max(0, distance);
  for (let index = 1; index < points.length; index++) {
    const segment = sub(points[index], points[index - 1]);
    const segmentLength = len(segment);
    if (segmentLength <= 1e-8) continue;
    if (remaining <= segmentLength || index === points.length - 1) {
      const amount = Math.max(0, Math.min(1, remaining / segmentLength));
      return { point: add(points[index - 1], mul(segment, amount)), tangent: norm(segment) };
    }
    remaining -= segmentLength;
  }
  return { point: points[points.length - 1], tangent: norm(sub(points[points.length - 1], points[points.length - 2])) };
}
function polylineTangentAt(points: readonly Pt[], index: number): Pt {
  if (points.length < 2) return { x: 1, y: 0 };
  if (index <= 0) return norm(sub(points[1], points[0]));
  if (index >= points.length - 1) return norm(sub(points[points.length - 1], points[points.length - 2]));
  return norm(sub(points[index + 1], points[index - 1]));
}
function appendPolylineCurve(cmds: PathCmd[], from: Pt, to: Pt, fromTangent: Pt, toTangent: Pt): void {
  if (pointsEqual(from, to)) return;
  // The sampled side is already a smooth curve. Reconstructing each small section with a
  // tangent-intersection quadratic makes the control point jump on the concave offset and turns
  // a smooth side into a handful of visibly different bends. Use a short cubic whose handles are
  // tied to the path tangents instead; neighboring sections then meet with matching derivatives.
  const distance = len(sub(to, from));
  const handle = Math.max(1e-4, distance / 3);
  cmds.push({
    kind: "bezier",
    cp1: add(from, mul(norm(fromTangent), handle)),
    // `toTangent` is the direction of travel at the end of the segment. The second
    // control point must therefore lie behind the endpoint, opposite to that direction.
    cp2: sub(to, mul(norm(toTangent), handle)),
    to,
  });
}
function appendPolylineForward(cmds: PathCmd[], points: readonly Pt[], distance: number): void {
  const end = pointAtPolylineDistance(points, distance);
  let travelled = 0;
  let currentTangent = polylineTangentAt(points, 0);
  for (let index = 1; index < points.length; index++) {
    const segmentLength = len(sub(points[index], points[index - 1]));
    if (segmentLength <= 1e-8) continue;
    if (travelled + segmentLength >= distance - 1e-7) break;
    const current = cmds[cmds.length - 1];
    const previousPoint = current ? pathCommandEnd(current) : points[0];
    appendPolylineCurve(cmds, previousPoint, points[index], currentTangent, polylineTangentAt(points, index));
    currentTangent = polylineTangentAt(points, index);
    travelled += segmentLength;
  }
  const current = cmds[cmds.length - 1];
  const currentPoint = current ? pathCommandEnd(current) : points[0];
  appendPolylineCurve(cmds, currentPoint, end.point, currentTangent, end.tangent);
}
function appendPolylineReverse(cmds: PathCmd[], points: readonly Pt[], distance: number): void {
  const start = pointAtPolylineDistance(points, distance);
  let remaining = distance;
  for (let index = 0; index < points.length - 1; index++) {
    const segment = sub(points[index + 1], points[index]);
    const segmentLength = len(segment);
    if (segmentLength <= 1e-8) continue;
    if (remaining <= segmentLength + 1e-7) {
      const candidate = add(points[index], mul(segment, Math.max(0, remaining / segmentLength)));
      const current = cmds[cmds.length - 1];
      const currentPoint = current ? pathCommandEnd(current) : start.point;
      let currentTangent = mul(norm(segment), -1);
      appendPolylineCurve(cmds, currentPoint, candidate, currentTangent, currentTangent);
      for (let reverse = index; reverse >= 0; reverse--) {
        const cursor = cmds[cmds.length - 1];
        const cursorPoint = cursor ? pathCommandEnd(cursor) : candidate;
        const tangent = mul(polylineTangentAt(points, reverse), -1);
        appendPolylineCurve(cmds, cursorPoint, points[reverse], currentTangent, tangent);
        currentTangent = tangent;
      }
      return;
    }
    remaining -= segmentLength;
  }
  const current = cmds[cmds.length - 1];
  const currentPoint = current ? pathCommandEnd(current) : start.point;
  appendPolylineCurve(cmds, currentPoint, points[0], mul(start.tangent, -1), mul(polylineTangentAt(points, 0), -1));
}

function lineIntersect(p: Pt, dp: Pt, q: Pt, dq: Pt): Pt | null {
  const denominator = cross(dp, dq);
  if (Math.abs(denominator) <= 1e-9) return null;
  return add(p, mul(dp, cross(sub(q, p), dq) / denominator));
}

/** Handle length over chord length of a cubic that approximates a half circle over the chord. */
const U_TURN_HANDLE_RATIO = 2 / 3;

/** Returns the cubic handle ratio for a pair of ports. The pre-726 renderer's turn was a
 * circular arc around the intersection of the two supporting side lines: neighboring faces have
 * a nearby corner and need a stronger bend, while faces with one side between them have a farther
 * corner and need a flatter bend (`arcHandleRatio` of the arc's sweep around that corner); parallel
 * sides naturally fall back to the straight-line ratio 1/3. */
function pairCurveHandleRatio(from: Port, to: Port): number {
  // Two faces looking the same way (the half faces of one brick edge) have no corner to turn
  // around: the pair curve is a U-turn, a half circle over the chord, whose cubic handles are 2/3
  // of the chord. The straight-line ratio would flatten it to a quarter of the chord's depth,
  // and the ribbon's inner side would then fold over itself.
  if (dot(from.out, to.out) > 1 - 1e-9) return U_TURN_HANDLE_RATIO;
  const corner = lineIntersect(from.mid, leftN(from.out), to.mid, leftN(to.out));
  return corner ? arcHandleRatio(sub(from.mid, corner), sub(to.mid, corner)) : 1 / 3;
}

function shortSweepCcw(a: number, b: number): boolean {
  let delta = b - a;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return delta < 0;
}
function pointInConvexPolygon(point: Pt, vertices: readonly Pt[]): boolean {
  let positive = false;
  let negative = false;
  for (let index = 0; index < vertices.length; index++) {
    const side = cross(sub(vertices[(index + 1) % vertices.length], vertices[index]), sub(point, vertices[index]));
    if (side > 1e-7) positive = true;
    if (side < -1e-7) negative = true;
  }
  return !(positive && negative);
}
/** `fromTangent`/`toTangent` point from each endpoint toward the control point. */
function quadraticBridgeSegment(from: Pt, to: Pt, fromTangent: Pt, toTangent: Pt): PathCmd {
  const start = norm(fromTangent);
  const end = norm(toTangent);
  const intersection = lineIntersect(from, start, to, end);
  const startReach = intersection ? len(sub(intersection, from)) : 0;
  const endReach = intersection ? len(sub(intersection, to)) : 0;
  if (intersection && startReach > 1e-5 && endReach > 1e-5) {
    return { kind: "quadratic", cp: intersection, to };
  }

  // A tangent intersection at an endpoint produces a degenerate quadratic (`cp === from` or
  // `cp === to`). That is especially visible where the two inner sides of a thick turn meet. Use
  // independent cubic controls for this fallback so both endpoint tangents remain non-zero.
  const distance = len(sub(to, from));
  const handle = Math.max(1e-4, distance / 3);
  return {
    kind: "bezier",
    cp1: add(from, mul(start, handle)),
    cp2: add(to, mul(end, handle)),
    to,
  };
}
/** Rounds the corner where two ribbon sides cross: runs from `from` toward `corner`, fillets it with
 *  an arc of at most `requestedRadius`, and continues back out to `to`. */
function junctionCornerBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  corner: Pt,
  requestedRadius: number,
): PathCmd[] {
  const fromReach = dot(sub(corner, from), fromDirection);
  const toReach = dot(sub(corner, to), toDirection);
  if (fromReach <= 1e-6 || toReach <= 1e-6) return [{ kind: "line", to }];
  const fromRay = norm(sub(from, corner));
  const toRay = norm(sub(to, corner));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(fromRay, toRay)))) / 2;
  const sinHalf = Math.sin(halfAngle);
  const tanHalf = Math.tan(halfAngle);
  if (sinHalf <= 1e-6 || tanHalf <= 1e-6) return [{ kind: "line", to }];
  const maximumRadius = Math.min(fromReach, toReach) * tanHalf;
  const radius = Math.min(maximumRadius, requestedRadius);
  if (radius <= 1e-6) return [{ kind: "line", to: corner }, { kind: "line", to }];
  const tangentDistance = radius / tanHalf;
  const fromTangent = add(corner, mul(fromRay, tangentDistance));
  const toTangent = add(corner, mul(toRay, tangentDistance));
  const centre = add(corner, mul(norm(add(fromRay, toRay)), radius / sinHalf));
  const a0 = angleOf(sub(fromTangent, centre));
  const a1 = angleOf(sub(toTangent, centre));
  const ccw = shortSweepCcw(a0, a1);
  const arcTangent = (angle: number): Pt => ccw ? { x: Math.sin(angle), y: -Math.cos(angle) } : { x: -Math.sin(angle), y: Math.cos(angle) };
  return [
    // `quadraticBridgeSegment` receives the direction from the endpoint toward the control point.
    // At the beginning of an arc that direction is opposite to the arc's forward tangent; using
    // the forward tangent here makes the control point collapse onto the arc endpoint and creates
    // the visible kink on the inner edge of a thick ribbon.
    quadraticBridgeSegment(from, fromTangent, fromDirection, mul(arcTangent(a0), -1)),
    { kind: "arc", c: centre, r: radius, a0, a1, ccw },
    // The contour leaves the arc toward `to` in the reverse direction of the next ribbon. Since
    // the quadratic helper expects the endpoint-to-control direction (the opposite of the path
    // tangent at the endpoint), that direction is the next ribbon's forward tangent itself.
    quadraticBridgeSegment(toTangent, to, arcTangent(a1), toDirection),
  ];
}
/** `bulge`, when given, is the direction the arc's middle must face. A dead-end cap joins the two
 *  sides of one ribbon, whose ends sit diametrically opposite around the target: both sweeps are
 *  exactly half a turn, and picking the "short" one leaves the choice to rounding noise, which
 *  sometimes folds the cap back through the ribbon as a concave bite. */
function targetCenteredClosureArc(from: Pt, to: Pt, target: Pt, bulge?: Pt): Extract<PathCmd, { kind: "arc" }> | null {
  const fromVector = sub(from, target);
  const toVector = sub(to, target);
  const radius = len(fromVector);
  if (radius <= 1e-7 || len(toVector) <= 1e-7) return null;
  const a0 = angleOf(fromVector);
  const a1 = angleOf(toVector);
  // `ccw: true` decreases the angle, i.e. starts moving along `(fromVector.y, -fromVector.x)`.
  const ccw = bulge ? cross(fromVector, bulge) < 0 : shortSweepCcw(a0, a1);
  return { kind: "arc", c: target, r: radius, a0, a1, ccw };
}
/** Maximum direction change at which two ribbon sides are treated as one smooth side. */
const SMOOTH_JOIN_ANGLE = Math.PI / 18;
/** `deadEndForward`, given only for a dead end, is the direction its cap must bulge toward. */
function appendContourBetweenRibbons(cmds: PathCmd[], current: readonly Pt[], next: readonly Pt[], target: Pt, halfWidth: number, radius: number, boundary: readonly Pt[], deadEndForward?: Pt): void {
  const hit = firstPolylineIntersection(current, next);
  if (!hit) {
    appendPolylineForward(cmds, current, polylineLength(current));
    const currentEnd = current[current.length - 1];
    const nextEnd = next[next.length - 1];
    if (!pointsEqual(currentEnd, nextEnd)) {
      const closure = targetCenteredClosureArc(currentEnd, nextEnd, target, deadEndForward);
      if (closure && !deadEndForward && !arcInsideConvexCell(closure, boundary)) {
        // A junction side closure that would leave the cell (target close to a face): the deepest
        // arc straight from one side end to the other that fits, bulging the way the closure did.
        // A dead end's cap already fits by construction (`deadEndCentreCurve`).
        const closureMiddle = arcPoint(closure.c, closure.r, closure.a0 + arcSweep(closure) / 2);
        const chordMiddle = mid(currentEnd, nextEnd);
        let bulge = leftN(norm(sub(nextEnd, currentEnd)));
        if (dot(bulge, sub(closureMiddle, chordMiddle)) < 0) bulge = mul(bulge, -1);
        cmds.push(deepestChordArc(currentEnd, nextEnd, bulge, Math.max(0, dot(bulge, sub(closureMiddle, chordMiddle))), boundary));
      } else if (closure) {
        cmds.push(closure);
        if (!pointsEqual(pathCommandEnd(closure), nextEnd)) cmds.push({ kind: "line", to: nextEnd });
      } else cmds.push({ kind: "line", to: nextEnd });
    }
    appendPolylineReverse(cmds, next, polylineLength(next));
    return;
  }
  // Sides that already meet tangent-continuously (the inner side of a smooth two-port turn, whose
  // halves share the target tangent) have no corner to round: a corner bridge there would only cut
  // a dent into an otherwise circular side.
  const currentTangent = pointAtPolylineDistance(current, hit.aDistance).tangent;
  const nextTangent = pointAtPolylineDistance(next, hit.bDistance).tangent;
  if (dot(currentTangent, nextTangent) <= -Math.cos(SMOOTH_JOIN_ANGLE)) {
    appendPolylineForward(cmds, current, hit.aDistance);
    appendPolylineReverse(cmds, next, hit.bDistance);
    return;
  }
  // Keep enough room for the requested corner, but do not discard a large part of the sampled
  // ribbon when the radius is zero. The latter would replace the curve with one long straight
  // transition segment.
  const probe = Math.min(Math.max(radius, halfWidth * 0.25), halfWidth * 2, hit.aDistance * 0.75, hit.bDistance * 0.75);
  const aDistance = Math.max(0, hit.aDistance - probe);
  const bDistance = Math.max(0, hit.bDistance - probe);
  const a = pointAtPolylineDistance(current, aDistance);
  const b = pointAtPolylineDistance(next, bDistance);
  appendPolylineForward(cmds, current, aDistance);
  cmds.push(...junctionCornerBridge(a.point, b.point, a.tangent, b.tangent, hit.point, radius));
  appendPolylineReverse(cmds, next, bDistance);
}
/** Pulls `point` toward `anchor` (assumed inside) until it lies within the convex `boundary`. */
function constrainPointInside(point: Pt, anchor: Pt, boundary: readonly Pt[]): Pt {
  if (pointInConvexPolygon(point, boundary)) return point;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const amount = (low + high) / 2;
    if (pointInConvexPolygon(add(anchor, mul(sub(point, anchor), amount)), boundary)) low = amount;
    else high = amount;
  }
  return add(anchor, mul(sub(point, anchor), low));
}
function constrainPathControls(cmds: PathCmd[], boundary: readonly Pt[]): PathCmd[] {
  let current: Pt | null = null;
  return cmds.map((command) => {
    if (command.kind === "move") {
      current = command.to;
      return command;
    }
    if (command.kind === "quadratic") {
      const anchor = current ?? command.cp;
      current = command.to;
      return { ...command, cp: constrainPointInside(command.cp, anchor, boundary) };
    }
    if (command.kind === "bezier") {
      const anchor = current ?? command.cp1;
      current = command.to;
      return { ...command, cp1: constrainPointInside(command.cp1, anchor, boundary), cp2: constrainPointInside(command.cp2, command.to, boundary) };
    }
    current = pathCommandEnd(command);
    return command;
  });
}
/** Travel direction at the end of a centre curve. Taken from the curve's control points: the
 *  sampled sides of a very short ribbon (a dead-end cap moved right up to its port) are too short to
 *  give a reliable direction, which used to flip the cap back through the port. A curve collapsed to
 *  a point still leaves the port inward. */
function centreCurveEndDirection(port: Port, curve: Cubic): Pt {
  for (const from of [curve.p2, curve.p1, curve.p0]) {
    if (len(sub(curve.p3, from)) > 1e-9) return norm(sub(curve.p3, from));
  }
  return mul(port.out, -1);
}

function universalJunctionContour(ribbons: readonly Ribbon[], halfWidth: number, target: Pt, boundary: readonly Pt[], radius: number): PathCmd[] {
  if (ribbons.length === 0 || ribbons.some((ribbon) => ribbon.left.length < 2 || ribbon.right.length < 2)) return [];

  const cmds: PathCmd[] = [{ kind: "move", to: ribbons[0].left[0] }];
  for (let index = 0; index < ribbons.length; index++) {
    const current = ribbons[index].right;
    const next = ribbons[(index + 1) % ribbons.length].left;
    const mouth = current[0];
    const cursor = pathCommandEnd(cmds[cmds.length - 1]);
    if (!pointsEqual(cursor, mouth)) cmds.push({ kind: "line", to: mouth });
    appendContourBetweenRibbons(cmds, current, next, target, halfWidth, radius, boundary, ribbons.length === 1 ? ribbons[0].endDirection : undefined);
  }
  const first = ribbons[0].left[0];
  const cursor = pathCommandEnd(cmds[cmds.length - 1]);
  if (!pointsEqual(cursor, first)) cmds.push({ kind: "line", to: first });
  return constrainPathControls(cmds, boundary);
}
/** Builds one tile's shape: a centre curve from every port to a shared target, offset into a ribbon,
 *  with consecutive ribbons joined around the target and their corners rounded. The radius-0 contour
 *  is a lab-only stage, built only `withStages`. */
function buildTileGeometry(tile: Tile, halfWidth: number, requestedRadius: number | undefined, withStages: boolean): CorridorGeometryDebug {
  const oppositePair = mostOppositePortPair(tile.ports);
  const baseTarget = constrainPointInside(oppositePair ? directPairCurveCenter(oppositePair[0], oppositePair[1]) : tile.centre, tile.centre, tile.boundary);
  const deadEndCurve = tile.ports.length === 1 ? deadEndCentreCurve(tile.ports[0], baseTarget, halfWidth, tile.boundary) : null;
  if (tile.ports.length === 1 && !deadEndCurve) {
    // No ribbon and no junction corners: the cap is the whole tile.
    const cap: ContourPath[] = [{ cmds: kinkedDeadEndCap(tile.ports[0], halfWidth, tile.boundary), hole: false }];
    return { cellId: tile.id, target: tile.ports[0].mid, centerCurves: [], rawRibbons: [], ribbons: [], contourBeforeCornerRadius: cap, contour: cap };
  }
  const target = deadEndCurve ? deadEndCurve.p3 : baseTarget;
  const portAngle = (port: Port): number => {
    const angle = angleOf(sub(port.mid, target));
    // A port straight behind the target sits on the atan2 branch cut, where float noise flips -π and π.
    return angle < -Math.PI + PORT_ANGLE_EPSILON ? angle + Math.PI * 2 : angle;
  };
  const orderedPorts = [...tile.ports].sort((a, b) => portAngle(a) - portAngle(b));
  const targetTangents = new Map<Port, TargetTangent>();
  if (oppositePair) {
    const biarc = biarcTargetTangents(oppositePair[0], oppositePair[1], target);
    targetTangents.set(oppositePair[0], { tangent: biarc.firstTangent, handleRatio: biarc.firstHandleRatio });
    targetTangents.set(oppositePair[1], { tangent: biarc.secondTangent, handleRatio: biarc.secondHandleRatio });
  }
  const rawRibbons = orderedPorts.map((port) => ribbonAlong(port, deadEndCurve ?? centreCurve(port, target, targetTangents.get(port)), halfWidth));
  const ribbons = rawRibbons.map((ribbon) => ({
    ...ribbon,
    left: ribbon.left.map((point) => constrainPointInside(point, target, tile.boundary)),
    right: ribbon.right.map((point) => constrainPointInside(point, target, tile.boundary)),
  }));

  const radius = Math.max(0, requestedRadius ?? halfWidth * DEFAULT_JUNCTION_RADIUS_FACTOR);
  // Each corner fillet is already limited to what fits its corner (`junctionCornerBridge`).
  const sharp = withStages ? universalJunctionContour(ribbons, halfWidth, target, tile.boundary, 0) : [];
  const final = universalJunctionContour(ribbons, halfWidth, target, tile.boundary, radius);
  return {
    cellId: tile.id,
    target,
    centerCurves: ribbons.map((ribbon, portIndex) => ({ portIndex, path: ribbon.path, controlPoints: ribbon.controlPoints })),
    rawRibbons: rawRibbons.map((ribbon, portIndex) => ({ portIndex, left: ribbon.left, right: ribbon.right })),
    ribbons: ribbons.map((ribbon, portIndex) => ({ portIndex, left: ribbon.left, right: ribbon.right })),
    contourBeforeCornerRadius: sharp.length > 0 ? [{ cmds: sharp, hole: false }] : [],
    contour: final.length > 0 ? [{ cmds: final, hole: false }] : [],
  };
}

/** Pure geometry engine: one filled path per cell that has at least one port. `junctionRadius`
 *  defaults to `DEFAULT_JUNCTION_RADIUS_FACTOR` of the half-width. */
export function buildCorridorGeometry(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  junctionRadius?: number,
): ContourPath[] {
  return buildCorridorGeometryInstances(cells, ports, thickness, junctionRadius)
    .map((instance) => translateContourPath(instance.shape, instance.offset));
}

/** One tile placed as a shared local shape: `shape` is built around the origin and drawn at
 *  `offset` (the tile centre). Tiles with equal `key` share the same `shape` object. */
export type CorridorContourInstance = { cellId: CorridorCellId; key: string; shape: ContourPath; offset: CorridorPoint };

/** Local tile shapes by key; `null` marks a key that produced no drawable path. A caller may keep
 *  one across calls: keys include the effective half-width and junction radius. */
export type CorridorShapeCache = Map<string, ContourPath | null>;

/** `buildCorridorGeometry` without the final translation, in tile order: every tile of the same
 *  local shape (cell polygon + port set relative to the tile centre, half-width, junction radius)
 *  shares one shape built around the origin. Port order is not part of the shape key: the builder
 *  orders ports by angle and the most-opposite-pair search is order-independent. Lab stages
 *  (`buildCorridorGeometryDebug`) always build per tile. */
export function buildCorridorGeometryInstances(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  junctionRadius?: number,
  shapeCache: CorridorShapeCache = new Map(),
): CorridorContourInstance[] {
  if (thickness <= 0 || cells.length === 0 || ports.length === 0) return [];
  const halfWidth = halfWidthForPorts(ports, thickness / 2);
  const keyPrefix = "contour/" + halfWidth + "/" + (junctionRadius ?? "default") + "@";
  const instances: CorridorContourInstance[] = [];
  for (const tile of buildTilesFromCells(cells, ports)) {
    const toLocal = (point: Pt): Pt => sub(point, tile.centre);
    const portKeys = tile.ports.map((port) => keyPoint(toLocal(port.mid)) + ";" + keyPoint(port.out)).sort();
    const key = keyPrefix + tile.boundary.map((point) => keyPoint(toLocal(point))).join("|") + "#" + portKeys.join("|");
    let shape = shapeCache.get(key);
    if (shape === undefined) {
      const origin = { x: 0, y: 0 };
      const localTile: Tile = {
        id: tile.id,
        centre: origin,
        ports: tile.ports.map((port) => ({ centre: origin, mid: toLocal(port.mid), out: port.out })),
        boundary: tile.boundary.map(toLocal),
      };
      const path = buildTileGeometry(localTile, halfWidth, junctionRadius, false).contour[0];
      shape = path !== undefined && path.cmds.length >= 2 ? path : null;
      shapeCache.set(key, shape);
    }
    if (shape) instances.push({ cellId: tile.id, key, shape, offset: tile.centre });
  }
  return instances;
}

/** `buildCorridorGeometry` with every intermediate construction stage, for the geometry lab. */
export function buildCorridorGeometryDebug(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  junctionRadius?: number,
): CorridorGeometryDebug[] {
  if (thickness <= 0 || cells.length === 0 || ports.length === 0) return [];
  const halfWidth = halfWidthForPorts(ports, thickness / 2);
  return buildTilesFromCells(cells, ports).map((tile) => buildTileGeometry(tile, halfWidth, junctionRadius, true));
}

/** Key quantum for tile-type keys, in world units: far below any visible difference, far above the
 *  float noise left by subtracting the cell centre. */
const TILE_KEY_QUANTUM = 1e-6;
const keyNumber = (value: number): number => Math.round(value / TILE_KEY_QUANTUM);
const keyPoint = (point: Pt): string => keyNumber(point.x) + "," + keyNumber(point.y);

function translateContourPath(path: ContourPath, offset: Pt): ContourPath {
  return {
    hole: path.hole,
    cmds: path.cmds.map((command): PathCmd => {
      switch (command.kind) {
        case "move":
        case "line":
          return { kind: command.kind, to: add(command.to, offset) };
        case "quadratic":
          return { kind: "quadratic", cp: add(command.cp, offset), to: add(command.to, offset) };
        case "bezier":
          return { kind: "bezier", cp1: add(command.cp1, offset), cp2: add(command.cp2, offset), to: add(command.to, offset) };
        case "arc":
          return { ...command, c: add(command.c, offset) };
      }
    }),
  };
}

/** Adapts the selector's centre-to-centre corridor segments to the engine's cells and face ports.
 *  A segment with `v1TouchesSplit` contributes only its `v0` port. A cell without a known polygon
 *  gets a square of half-side `thickness` around its centre. Cell ids are the rounded centres. */
export function corridorSegmentsToGeometryInput(segments: readonly CorridorSegmentInput[], thickness: number): { cells: CorridorCell[]; ports: CorridorPort[] } {
  const cells = new Map<string, CorridorCell>();
  const ports: CorridorPort[] = [];
  const addCell = (centre: Pt, polygon?: readonly Pt[]): string => {
    const id = String(Math.round(centre.x * 1e6)) + "," + String(Math.round(centre.y * 1e6));
    const current = cells.get(id);
    if (!current) cells.set(id, { id, center: centre, polygon: polygon ?? [] });
    else if (polygon && polygon.length >= 3 && current.polygon.length < 3) cells.set(id, { ...current, polygon });
    return id;
  };

  for (const segment of segments) {
    if (len(sub(segment.v1, segment.v0)) < 1e-6) continue;
    const midpoint = segment.faceMidpoint ?? (segment.v1TouchesSplit ? segment.v1 : mid(segment.v0, segment.v1));
    const normal = segment.faceNormal ?? norm(sub(segment.v1, segment.v0));
    const halfFaceOffset = segment.faceLength === undefined ? undefined : mul(leftN(normal), segment.faceLength / 2);
    const face = halfFaceOffset === undefined ? undefined : [sub(midpoint, halfFaceOffset), add(midpoint, halfFaceOffset)] as const;
    const fromId = addCell(segment.v0, segment.cellVertices0);
    ports.push({ cellId: fromId, midpoint, normal, face });
    if (!segment.v1TouchesSplit) {
      const toId = addCell(segment.v1, segment.cellVertices1);
      ports.push({ cellId: toId, midpoint, normal: mul(normal, -1), face });
    }
  }

  return {
    cells: [...cells.values()].map((cell) => ({
      ...cell,
      polygon: cell.polygon.length >= 3 ? cell.polygon : [
        { x: cell.center.x - thickness, y: cell.center.y - thickness },
        { x: cell.center.x + thickness, y: cell.center.y - thickness },
        { x: cell.center.x + thickness, y: cell.center.y + thickness },
        { x: cell.center.x - thickness, y: cell.center.y + thickness },
      ],
    })),
    ports,
  };
}

/** `corridorSegmentsToGeometryInput` followed by `buildCorridorGeometryInstances`. */
export function buildCorridorContourInstances(segments: readonly CorridorSegmentInput[], thickness: number, junctionRadius?: number, shapeCache?: CorridorShapeCache): CorridorContourInstance[] {
  const { cells, ports } = corridorSegmentsToGeometryInput(segments, thickness);
  return buildCorridorGeometryInstances(cells, ports, thickness, junctionRadius, shapeCache);
}

/** `corridorSegmentsToGeometryInput` followed by `buildCorridorGeometry`. */
export function buildCorridorContour(segments: readonly CorridorSegmentInput[], thickness: number, junctionRadius?: number): ContourPath[] {
  const { cells, ports } = corridorSegmentsToGeometryInput(segments, thickness);
  return buildCorridorGeometry(cells, ports, thickness, junctionRadius);
}

export function contourToPolyline(path: ContourPath, curveStep = 8): Pt[] {
  const result: Pt[] = [];
  for (const command of path.cmds) {
    if (command.kind === "move" || command.kind === "line") {
      result.push(command.to);
    } else if (command.kind === "quadratic") {
      const from = result.length > 0 ? result[result.length - 1] : command.cp;
      const steps = Math.max(2, Math.ceil(len(sub(command.to, from)) / curveStep));
      for (let index = 1; index <= steps; index++) {
        const t = index / steps;
        const u = 1 - t;
        result.push({ x: u * u * from.x + 2 * u * t * command.cp.x + t * t * command.to.x, y: u * u * from.y + 2 * u * t * command.cp.y + t * t * command.to.y });
      }
    } else if (command.kind === "bezier") {
      const from = result.length > 0 ? result[result.length - 1] : command.cp1;
      const steps = Math.max(4, Math.ceil(len(sub(command.to, from)) / curveStep));
      result.push(...sampledCubicPoints(from, command.cp1, command.cp2, command.to, steps).slice(1));
    } else {
      const sweep = arcSweep(command);
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.2));
      for (let index = 1; index <= steps; index++) result.push(arcPoint(command.c, command.r, command.a0 + sweep * index / steps));
    }
  }
  return result;
}

export function traceCorridorContour(target: Graphics | GraphicsContext, paths: ContourPath[]): void {
  for (const path of paths) {
    for (const command of path.cmds) {
      if (command.kind === "move") target.moveTo(command.to.x, command.to.y);
      else if (command.kind === "line") target.lineTo(command.to.x, command.to.y);
      else if (command.kind === "quadratic") target.quadraticCurveTo(command.cp.x, command.cp.y, command.to.x, command.to.y);
      else if (command.kind === "bezier") target.bezierCurveTo(command.cp1.x, command.cp1.y, command.cp2.x, command.cp2.y, command.to.x, command.to.y);
      else target.arc(command.c.x, command.c.y, command.r, command.a0, command.a1, command.ccw);
    }
    target.closePath();
  }
}

export function contourToSvgPath(paths: readonly ContourPath[], closePaths = true): string {
  const format = (value: number): string => Object.is(value, -0) ? "0" : String(value);
  const parts: string[] = [];
  for (const path of paths) {
    for (const command of path.cmds) {
      if (command.kind === "move") parts.push("M " + format(command.to.x) + " " + format(command.to.y));
      else if (command.kind === "line") parts.push("L " + format(command.to.x) + " " + format(command.to.y));
      else if (command.kind === "quadratic") parts.push("Q " + format(command.cp.x) + " " + format(command.cp.y) + " " + format(command.to.x) + " " + format(command.to.y));
      else if (command.kind === "bezier") parts.push("C " + format(command.cp1.x) + " " + format(command.cp1.y) + " " + format(command.cp2.x) + " " + format(command.cp2.y) + " " + format(command.to.x) + " " + format(command.to.y));
      else {
        const sweep = arcSweep(command);
        if (Math.abs(sweep) <= 1e-9 || command.r <= 0) continue;
        const arcCount = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI));
        const step = sweep / arcCount;
        for (let index = 0; index < arcCount; index++) {
          const end = arcPoint(command.c, command.r, command.a0 + step * (index + 1));
          parts.push("A " + format(command.r) + " " + format(command.r) + " 0 0 " + (command.ccw ? "0 " : "1 ") + format(end.x) + " " + format(end.y));
        }
      }
    }
    if (closePaths) parts.push("Z");
  }
  return parts.join(" ");
}
