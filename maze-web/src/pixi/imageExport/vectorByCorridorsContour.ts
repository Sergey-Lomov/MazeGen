import type { Graphics } from "pixi.js";

export type CorridorPoint = { x: number; y: number };
type Pt = CorridorPoint;
export type CorridorCellId = string | number;
export type CorridorCell = { id: CorridorCellId; center: CorridorPoint; polygon: readonly CorridorPoint[] };
export type CorridorPort = {
  cellId: CorridorCellId;
  midpoint: CorridorPoint;
  normal: CorridorPoint;
  face?: readonly [CorridorPoint, CorridorPoint] | { start: CorridorPoint; end: CorridorPoint };
  useCubicMouth?: boolean;
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

type Seg = {
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
type Tile = { id?: CorridorCellId; centre: Pt; ports: Port[]; boundary?: readonly Pt[] };
function faceLength(face: CorridorPort["face"]): number | undefined {
  if (!face) return undefined;
  const start = "start" in face ? face.start : face[0];
  const end = "end" in face ? face.end : face[1];
  const value = Math.hypot(end.x - start.x, end.y - start.y);
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
  for (const tile of tiles.values()) {
    tile.ports.sort((a, b) => angleOf(sub(a.mid, tile.centre)) - angleOf(sub(b.mid, tile.centre)));
  }
  return [...tiles.values()];
}

function directPairCurveCenter(from: Port, to: Port): Pt {
  // This provisional pair curve is used only to locate the common target. The target-side
  // tangents of the actual centre curves are intentionally left for the next stage.
  const distance = len(sub(to.mid, from.mid));
  if (distance <= 1e-7) return from.centre;
  const handle = distance * pairCurveHandleRatio(from, to);
  const cp1 = add(from.mid, mul(norm(mul(from.out, -1)), handle));
  const cp2 = sub(to.mid, mul(norm(to.out), handle));
  const steps = Math.max(32, Math.min(96, Math.ceil(distance / 2)));
  const points: Pt[] = [];
  for (let index = 0; index <= steps; index++) points.push(cubicPoint(from.mid, cp1, cp2, to.mid, index / steps));
  return pointAtPolylineDistance(points, polylineLength(points) / 2).point;
}

function targetPointForPorts(centre: Pt, ports: readonly Port[]): Pt {
  // Every neighboring pair votes with the geometric midpoint of its direct connection. A shared
  // target is the compromise between those pair centers, not an intersection of port tangents.
  if (ports.length === 0) return centre;
  const pairCenters: Pt[] = [];
  for (let index = 0; index < ports.length; index++) {
    pairCenters.push(directPairCurveCenter(ports[index], ports[(index + 1) % ports.length]));
  }
  const sum = pairCenters.reduce((result, point) => add(result, point), { x: 0, y: 0 });
  return mul(sum, 1 / pairCenters.length);
}

function targetTangentPairForPorts(ports: readonly Port[]): { first: number; second: number; firstTangent: Pt; secondTangent: Pt } | null {
  if (ports.length < 2) return null;
  let first = 0;
  let second = 1;
  let smallestNormalDot = dot(ports[first].out, ports[second].out);
  for (let firstIndex = 0; firstIndex < ports.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < ports.length; secondIndex++) {
      const normalDot = dot(ports[firstIndex].out, ports[secondIndex].out);
      if (normalDot < smallestNormalDot) {
        first = firstIndex;
        second = secondIndex;
        smallestNormalDot = normalDot;
      }
    }
  }
  const firstInward = norm(mul(ports[first].out, -1));
  const secondInward = norm(mul(ports[second].out, -1));
  let firstTangent = norm(sub(firstInward, secondInward));
  if (dot(firstTangent, firstInward) < 0) firstTangent = mul(firstTangent, -1);
  return { first, second, firstTangent, secondTangent: mul(firstTangent, -1) };
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
function pathCommandEnd(command: PathCmd): Pt {
  if (command.kind !== "arc") return command.to;
  return { x: command.c.x + Math.cos(command.a1) * command.r, y: command.c.y + Math.sin(command.a1) * command.r };
}

function sampledCenterCurve(port: Port, target: Pt, targetTangent?: Pt, handleRatio = 1 / 3): {
  path: PathCmd[];
  controlPoints: Pt[];
  points: Pt[];
} {
  const from = port.mid;
  const distance = len(sub(target, from));
  const inward = norm(mul(port.out, -1));
  const radial = norm(sub(target, from));
  const handle = distance * handleRatio;
  const cp1 = add(from, mul(inward, handle));
  const cp2 = sub(target, mul(targetTangent ? norm(targetTangent) : radial, handle));
  // The ribbon sides are later trimmed at their first intersection. Their inner side is therefore
  // much more sensitive to polyline resolution than the outer closure arc. Do not make the
  // resolution inversely proportional to corridor thickness: a thicker ribbon must not turn a
  // smooth side into a short faceted chain. Keep a stable geometric step and a bounded upper cost.
  const steps = Math.max(32, Math.min(96, Math.ceil(distance / 2)));
  const points: Pt[] = [];
  for (let index = 0; index <= steps; index++) points.push(cubicPoint(from, cp1, cp2, target, index / steps));
  return {
    path: [{ kind: "move", to: from }, { kind: "bezier", cp1, cp2, to: target }],
    controlPoints: [cp1, cp2],
    points,
  };
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

function sampleRibbonSides(port: Port, target: Pt, halfWidth: number, targetTangent?: Pt, handleRatio = 1 / 3): {
  left: Pt[];
  right: Pt[];
  path: PathCmd[];
  controlPoints: Pt[];
} {
  const centreCurve = sampledCenterCurve(port, target, targetTangent, handleRatio);
  const move = centreCurve.path[0];
  const curve = centreCurve.path[1];
  if (move.kind !== "move" || curve.kind !== "bezier") return { left: [], right: [], path: [], controlPoints: [] };

  const steps = centreCurve.points.length - 1;
  const left = regularizedOffsetCubic(move.to, curve.cp1, curve.cp2, curve.to, halfWidth, 1, steps);
  const right = regularizedOffsetCubic(move.to, curve.cp1, curve.cp2, curve.to, halfWidth, -1, steps);
  const ends = portBorderEnds(port, halfWidth);
  left[0] = ends.right;
  right[0] = ends.left;
  return { left, right, path: centreCurve.path, controlPoints: centreCurve.controlPoints };
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
function appendPolylineForward(cmds: PathCmd[], points: readonly Pt[], distance: number): Pt {
  const target = pointAtPolylineDistance(points, distance).point;
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
  appendPolylineCurve(cmds, currentPoint, target, currentTangent, pointAtPolylineDistance(points, distance).tangent);
  return target;
}
function appendPolylineReverse(cmds: PathCmd[], points: readonly Pt[], distance: number): Pt {
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
      return points[0];
    }
    remaining -= segmentLength;
  }
  const current = cmds[cmds.length - 1];
  const currentPoint = current ? pathCommandEnd(current) : start.point;
  appendPolylineCurve(cmds, currentPoint, points[0], mul(start.tangent, -1), mul(polylineTangentAt(points, 0), -1));
  return points[0];
}

function lineIntersect(p: Pt, dp: Pt, q: Pt, dq: Pt): Pt | null {
  const denominator = cross(dp, dq);
  if (Math.abs(denominator) <= 1e-9) return null;
  return add(p, mul(dp, cross(sub(q, p), dq) / denominator));
}

/** Returns the cubic handle ratio for a pair of ports. The pre-726 renderer's turn was a
 * circular arc around the intersection of the two supporting side lines: neighboring faces have
 * a nearby corner and need a stronger bend, while faces with one side between them have a farther
 * corner and need a flatter bend. The standard cubic approximation of an arc gives the ratio
 * `1 / (3 cos²(theta / 4))`; parallel sides naturally fall back to the straight-line ratio 1/3. */
function pairCurveHandleRatio(from: Port, to: Port): number {
  const corner = lineIntersect(from.mid, leftN(from.out), to.mid, leftN(to.out));
  if (!corner) return 1 / 3;

  const fromAngle = angleOf(sub(from.mid, corner));
  const toAngle = angleOf(sub(to.mid, corner));
  let sweep = Math.abs(toAngle - fromAngle);
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  if (sweep > Math.PI) sweep = Math.PI * 2 - sweep;

  const cosine = Math.max(0.25, Math.cos(sweep / 4));
  return 1 / (3 * cosine * cosine);
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
function quadraticBridgeSegment(from: Pt, to: Pt, fromTangent: Pt, toTangent: Pt, boundary?: readonly Pt[]): PathCmd {
  const start = norm(fromTangent);
  const end = norm(toTangent);
  const intersection = lineIntersect(from, start, to, end);
  const startReach = intersection ? len(sub(intersection, from)) : 0;
  const endReach = intersection ? len(sub(intersection, to)) : 0;
  if (intersection && startReach > 1e-5 && endReach > 1e-5 && (!boundary || pointInConvexPolygon(intersection, boundary))) {
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
function junctionCornerBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  halfWidth: number,
  requestedRadius: number | undefined,
  cornerHint?: Pt,
): PathCmd[] {
  const corner = cornerHint ?? lineIntersect(from, fromDirection, to, toDirection);
  if (!corner) return [{ kind: "line", to }];
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
  const radius = Math.min(maximumRadius, requestedRadius === undefined ? Math.min(maximumRadius, halfWidth * 0.75) : Math.max(0, requestedRadius));
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
    // `quadraticControlPoint` receives the direction from the endpoint toward the control point.
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
function targetCenteredClosureArc(from: Pt, to: Pt, target: Pt): PathCmd | null {
  const fromVector = sub(from, target);
  const toVector = sub(to, target);
  const radius = len(fromVector);
  if (radius <= 1e-7 || len(toVector) <= 1e-7) return null;
  const a0 = angleOf(fromVector);
  const a1 = angleOf(toVector);
  return { kind: "arc", c: target, r: radius, a0, a1, ccw: shortSweepCcw(a0, a1) };
}
function appendContourBetweenRibbons(cmds: PathCmd[], current: readonly Pt[], next: readonly Pt[], target: Pt, halfWidth: number, radius: number): void {
  const hit = firstPolylineIntersection(current, next);
  if (!hit) {
    appendPolylineForward(cmds, current, polylineLength(current));
    const currentEnd = current[current.length - 1];
    const nextEnd = next[next.length - 1];
    if (!pointsEqual(currentEnd, nextEnd)) {
      const closure = targetCenteredClosureArc(currentEnd, nextEnd, target);
      if (closure) {
        cmds.push(closure);
        if (!pointsEqual(pathCommandEnd(closure), nextEnd)) cmds.push({ kind: "line", to: nextEnd });
      } else cmds.push({ kind: "line", to: nextEnd });
    }
    appendPolylineReverse(cmds, next, polylineLength(next));
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
  cmds.push(...junctionCornerBridge(a.point, b.point, a.tangent, b.tangent, halfWidth, radius, hit.point));
  appendPolylineReverse(cmds, next, bDistance);
}
function constrainControlPoint(control: Pt, anchor: Pt, boundary: readonly Pt[]): Pt {
  if (pointInConvexPolygon(control, boundary)) return control;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const amount = (low + high) / 2;
    if (pointInConvexPolygon(add(anchor, mul(sub(control, anchor), amount)), boundary)) low = amount;
    else high = amount;
  }
  return add(anchor, mul(sub(control, anchor), low));
}
function constrainPathControls(cmds: PathCmd[], boundary: readonly Pt[] | undefined): PathCmd[] {
  if (!boundary || boundary.length < 3) return cmds;
  let current: Pt | null = null;
  return cmds.map((command) => {
    if (command.kind === "move") {
      current = command.to;
      return command;
    }
    if (command.kind === "quadratic") {
      const anchor = current ?? command.cp;
      current = command.to;
      return { ...command, cp: constrainControlPoint(command.cp, anchor, boundary) };
    }
    if (command.kind === "bezier") {
      const anchor = current ?? command.cp1;
      current = command.to;
      return { ...command, cp1: constrainControlPoint(command.cp1, anchor, boundary), cp2: constrainControlPoint(command.cp2, command.to, boundary) };
    }
    current = pathCommandEnd(command);
    return command;
  });
}
function universalJunctionContour(ribbons: readonly { left: Pt[]; right: Pt[] }[], halfWidth: number, target: Pt, boundary: readonly Pt[] | undefined, requestedRadius: number | undefined): PathCmd[] {
  if (ribbons.length === 0 || ribbons.some((ribbon) => ribbon.left.length < 2 || ribbon.right.length < 2)) return [];
  const radius = requestedRadius === undefined ? halfWidth * 0.75 : Math.max(0, requestedRadius);

  const cmds: PathCmd[] = [{ kind: "move", to: ribbons[0].left[0] }];
  for (let index = 0; index < ribbons.length; index++) {
    const current = ribbons[index].right;
    const next = ribbons[(index + 1) % ribbons.length].left;
    const mouth = current[0];
    const cursor = pathCommandEnd(cmds[cmds.length - 1]);
    if (!pointsEqual(cursor, mouth)) cmds.push({ kind: "line", to: mouth });
    appendContourBetweenRibbons(cmds, current, next, target, halfWidth, radius);
  }
  const first = ribbons[0].left[0];
  const cursor = pathCommandEnd(cmds[cmds.length - 1]);
  if (!pointsEqual(cursor, first)) cmds.push({ kind: "line", to: first });
  return constrainPathControls(cmds, boundary);
}
function pathInsideConvexCell(cmds: PathCmd[], boundary: readonly Pt[] | undefined): boolean {
  if (!boundary || boundary.length < 3) return true;
  const samples = contourToPolyline({ cmds, hole: false });
  if (samples.some((point) => !pointInConvexPolygon(point, boundary))) return false;
  return cmds.every((command) => {
    if (command.kind === "quadratic") return pointInConvexPolygon(command.cp, boundary);
    if (command.kind === "bezier") return pointInConvexPolygon(command.cp1, boundary) && pointInConvexPolygon(command.cp2, boundary);
    if (command.kind !== "arc") return true;
    let sweep = command.a1 - command.a0;
    if (command.ccw) {
      while (sweep > 0) sweep -= Math.PI * 2;
      while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
    } else {
      while (sweep < 0) sweep += Math.PI * 2;
      while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
    }
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.02));
    for (let index = 0; index <= steps; index++) {
      const angle = command.a0 + sweep * index / steps;
      if (!pointInConvexPolygon({ x: command.c.x + Math.cos(angle) * command.r, y: command.c.y + Math.sin(angle) * command.r }, boundary)) return false;
    }
    return true;
  });
}

function constrainPointInside(point: Pt, anchor: Pt, boundary: readonly Pt[] | undefined): Pt {
  if (!boundary || boundary.length < 3 || pointInConvexPolygon(point, boundary)) return point;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const amount = (low + high) / 2;
    if (pointInConvexPolygon(add(anchor, mul(sub(point, anchor), amount)), boundary)) low = amount;
    else high = amount;
  }
  return add(anchor, mul(sub(point, anchor), low));
}

function buildUniversalJunctionDebug(tile: Tile, halfWidth: number, roundJunctions: boolean, requestedRadius: number | undefined): CorridorGeometryDebug {
  const target = constrainPointInside(targetPointForPorts(tile.centre, tile.ports), tile.centre, tile.boundary);
  const orderedPorts = [...tile.ports].sort((a, b) => angleOf(sub(a.mid, target)) - angleOf(sub(b.mid, target)));
  const targetTangentPair = targetTangentPairForPorts(orderedPorts);
  const pairHandleRatio = targetTangentPair
    ? pairCurveHandleRatio(orderedPorts[targetTangentPair.first], orderedPorts[targetTangentPair.second])
    : 1 / 3;
  const rawRibbons = orderedPorts.map((port, portIndex) => {
    const targetTangent = targetTangentPair
      ? portIndex === targetTangentPair.first
        ? targetTangentPair.firstTangent
        : portIndex === targetTangentPair.second
          ? targetTangentPair.secondTangent
          : undefined
      : undefined;
    const handleRatio = targetTangent !== undefined ? pairHandleRatio : 1 / 3;
    const ribbon = sampleRibbonSides(port, target, halfWidth, targetTangent, handleRatio);
    return ribbon;
  });
  const ribbons = rawRibbons.map((ribbon) => {
    return {
      ...ribbon,
      left: ribbon.left.map((point) => constrainPointInside(point, target, tile.boundary)),
      right: ribbon.right.map((point) => constrainPointInside(point, target, tile.boundary)),
    };
  });
  const centerCurves = ribbons.map((ribbon, portIndex) => ({ portIndex, path: ribbon.path, controlPoints: ribbon.controlPoints }));
  const rawDebugRibbons = rawRibbons.map((ribbon, portIndex) => ({ portIndex, left: ribbon.left, right: ribbon.right }));
  const debugRibbons = ribbons.map((ribbon, portIndex) => ({ portIndex, left: ribbon.left, right: ribbon.right }));
  const before = universalJunctionContour(ribbons, halfWidth, target, tile.boundary, 0);
  const requested = roundJunctions ? requestedRadius : 0;
  let final = universalJunctionContour(ribbons, halfWidth, target, tile.boundary, requested);
  if (!pathInsideConvexCell(final, tile.boundary)) {
    let low = 0;
    let high = requested === undefined ? halfWidth * 0.75 : Math.max(0, requested);
    final = before;
    for (let iteration = 0; iteration < 28; iteration++) {
      const candidateRadius = (low + high) / 2;
      const candidate = universalJunctionContour(ribbons, halfWidth, target, tile.boundary, candidateRadius);
      if (pathInsideConvexCell(candidate, tile.boundary)) {
        low = candidateRadius;
        final = candidate;
      } else high = candidateRadius;
    }
  }
  return {
    cellId: tile.id ?? String(tile.centre.x) + ":" + String(tile.centre.y),
    target,
    centerCurves,
    rawRibbons: rawDebugRibbons,
    ribbons: debugRibbons,
    contourBeforeCornerRadius: before.length > 0 ? [{ cmds: before, hole: false }] : [],
    contour: final.length > 0 ? [{ cmds: final, hole: false }] : [],
  };
}

export function buildCorridorGeometry(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  roundJunctions = true,
  junctionRadius?: number,
): ContourPath[] {
  if (thickness <= 0 || cells.length === 0 || ports.length === 0) return [];
  const halfWidth = halfWidthForPorts(ports, thickness / 2);
  return buildTilesFromCells(cells, ports)
    .map((tile) => buildUniversalJunctionDebug(tile, halfWidth, roundJunctions, junctionRadius).contour[0])
    .filter((path): path is ContourPath => path !== undefined && path.cmds.length >= 2);
}

export function buildCorridorGeometryDebug(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  roundJunctions = true,
  junctionRadius?: number,
): CorridorGeometryDebug[] {
  if (thickness <= 0 || cells.length === 0 || ports.length === 0) return [];
  const halfWidth = halfWidthForPorts(ports, thickness / 2);
  return buildTilesFromCells(cells, ports).map((tile) => buildUniversalJunctionDebug(tile, halfWidth, roundJunctions, junctionRadius));
}

export function buildCorridorContour(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  roundJunctions?: boolean,
  junctionRadius?: number,
): ContourPath[];
export function buildCorridorContour(
  segments: Seg[],
  thickness: number,
  roundJunctions?: boolean,
  junctionRadius?: number,
): ContourPath[];
export function buildCorridorContour(
  input: Seg[] | readonly CorridorCell[],
  second: number | readonly CorridorPort[],
  third: boolean | number = true,
  fourth: number | boolean = true,
  fifth?: number,
): ContourPath[] {
  if (Array.isArray(second)) {
    return buildCorridorGeometry(
      input as readonly CorridorCell[],
      second,
      third as number,
      typeof fourth === "boolean" ? fourth : true,
      typeof fourth === "number" ? fourth : fifth,
    );
  }

  const segments = input as Seg[];
  const thickness = second as number;
  const roundJunctions = typeof third === "boolean" ? third : true;
  const junctionRadius = typeof fourth === "number" ? fourth : fifth;
  const cells = new Map<string, CorridorCell>();
  const ports: CorridorPort[] = [];
  const pointKey = (point: Pt): string => String(Math.round(point.x * 1e6)) + "," + String(Math.round(point.y * 1e6));
  const addCell = (centre: Pt, polygon?: readonly Pt[]): string => {
    const id = pointKey(centre);
    const current = cells.get(id);
    if (!current) cells.set(id, { id, center: centre, polygon: polygon ?? [] });
    else if (polygon && polygon.length >= 3 && current.polygon.length < 3) cells.set(id, { ...current, polygon });
    return id;
  };

  for (const segment of segments) {
    if (len(sub(segment.v1, segment.v0)) < 1e-6) continue;
    const midpoint = segment.faceMidpoint ?? (segment.v1TouchesSplit ? segment.v1 : mid(segment.v0, segment.v1));
    const normal = segment.faceNormal ?? norm(sub(segment.v1, segment.v0));
    const halfFace = segment.faceLength === undefined ? undefined : segment.faceLength / 2;
    const face = halfFace === undefined ? undefined : [sub(midpoint, mul(leftN(normal), halfFace)), add(midpoint, mul(leftN(normal), halfFace))] as const;
    const fromId = addCell(segment.v0, segment.cellVertices0);
    ports.push({ cellId: fromId, midpoint, normal, face });
    if (!segment.v1TouchesSplit) {
      const toId = addCell(segment.v1, segment.cellVertices1);
      ports.push({ cellId: toId, midpoint, normal: mul(normal, -1), face });
    }
  }

  const geometryCells = [...cells.values()].map((cell) => ({
    ...cell,
    polygon: cell.polygon.length >= 3 ? cell.polygon : [
      { x: cell.center.x - thickness, y: cell.center.y - thickness },
      { x: cell.center.x + thickness, y: cell.center.y - thickness },
      { x: cell.center.x + thickness, y: cell.center.y + thickness },
      { x: cell.center.x - thickness, y: cell.center.y + thickness },
    ],
  }));
  return buildCorridorGeometry(geometryCells, ports, thickness, roundJunctions, junctionRadius);
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
      for (let index = 1; index <= steps; index++) result.push(cubicPoint(from, command.cp1, command.cp2, command.to, index / steps));
    } else {
      let sweep = command.a1 - command.a0;
      if (command.ccw) {
        while (sweep > 0) sweep -= Math.PI * 2;
        while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
      } else {
        while (sweep < 0) sweep += Math.PI * 2;
        while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
      }
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.2));
      for (let index = 1; index <= steps; index++) {
        const angle = command.a0 + sweep * index / steps;
        result.push({ x: command.c.x + Math.cos(angle) * command.r, y: command.c.y + Math.sin(angle) * command.r });
      }
    }
  }
  return result;
}

export function traceCorridorContour(target: Graphics, paths: ContourPath[]): void {
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
        let sweep = command.a1 - command.a0;
        if (command.ccw) {
          while (sweep > 0) sweep -= Math.PI * 2;
          while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
        } else {
          while (sweep < 0) sweep += Math.PI * 2;
          while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
        }
        if (Math.abs(sweep) <= 1e-9 || command.r <= 0) continue;
        const arcCount = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI));
        const step = sweep / arcCount;
        for (let index = 0; index < arcCount; index++) {
          const angle = command.a0 + step * (index + 1);
          const end = { x: command.c.x + Math.cos(angle) * command.r, y: command.c.y + Math.sin(angle) * command.r };
          parts.push("A " + format(command.r) + " " + format(command.r) + " 0 0 " + (command.ccw ? "0 " : "1 ") + format(end.x) + " " + format(end.y));
        }
      }
    }
    if (closePaths) parts.push("Z");
  }
  return parts.join(" ");
}
