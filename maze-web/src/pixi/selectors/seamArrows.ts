import type { FieldConfig } from "../../fieldConfig";
import { configAllCells } from "../tessellationCells";
import { getCellCenter, getCellVertices, getFaceEdgeSegment } from "../tessellationGeometry";
import { offsetPolyline, polylineLength } from "../geometry/polylineOps";
import type { WireTopology } from "../../wasm/types";
import { getSeamModel, type HalfEdge, type Seam } from "./seams";
import { pointToSegmentDistance as distanceToSegment } from "../renderers/teleportGeometryUtils";
import { boundsOf, distance, insidePolygon, pathLength, pointAtLength, portAxes, routeAll, routePair, unitOf, type Point, type Port } from "./seamRouting";

/// Share of the face length the arrowhead spans across, and of it the head's length.
const HEAD_WIDTH_SHARE = 0.5;
const HEAD_LENGTH_SHARE = 0.8;
/// The body's own width, relative to the face length.
const BODY_WIDTH_SHARE = 0.16;
/// Gap between a face and the arrow standing off it (head and body alike), relative to the head length.
const HEAD_GAP_SHARE = 0.35;
/// The contour of a glue run longer than one face repeats the faces' own shape. Its distance from the
/// faces and its stroke width are its own, not tied to the wall thickness.
export const BRACE_OFFSET = 12;
export const BRACE_WIDTH = 6;
/// The longest end of a contour that is cut off where it crosses the other run's contour, in brace offsets: the
/// overshoot of two runs meeting at a corner. A longer stretch is a crossing of its own and stays.
const MAX_CORNER_CUT = 3;
/// The share of a segment the arrowhead may take: both heads of a straight body share one segment, so each takes
/// less. A head never shrinks below `MIN_HEAD_SCALE` of its nominal size.
const HEAD_FIT_SHARE = 0.9;
const HEAD_SHARED_SHARE = 0.45;
const MIN_HEAD_SCALE = 0.35;
/// A route leaving its wall at a flatter angle than this (cosine to the wall's normal) gets an ordinary head, perpendicular to the body.
const MIN_OBLIQUE_COS = 0.35;

/// One glue arrow (`Specs/topology.md`, "Seam rendering model"): a glue (a group of folds, two runs of
/// faces) is drawn as one arrow, not one per glued pair. Each run gets a contour running parallel to
/// all its faces, a short way off them; a single polyline leaves the middle of
/// one contour, runs outside the field and arrives at the middle of the other, with an arrowhead at
/// each end. A run of a single face has no contour: the body stands a short way off the face. The body is straight when nothing is in the way and bends around the field otherwise.
/// Display space, pure data: the renderer only fills it in.
export interface SeamArrow {
  /// Indices into `SeamModel.seams` of the glued pairs this arrow stands for.
  seams: number[];
  /// The glue's group id, or `null` for a fold outside any group.
  group: number | null;
  twist: boolean;
  /// The route between the middles of the two contours (or, for a single face, a gap off each face): the base of the head
  /// at each end is its first and last point.
  path: Point[];
  /// The body as drawn: the pieces of `path` (always the whole of it).
  bodies: Point[][];
  /// The contours of the two runs (none for a run of one face) and their stroke width.
  braces: Point[][];
  braceWidth: number;
  /// Which run each contour belongs to: 0 for run A, 1 for run B.
  braceSides: (0 | 1)[];
  /// The route of each glued pair on its own, for showing where one face of a run leads (empty when the
  /// runs are single faces: the arrow itself is then the pair).
  pairs: SeamPair[];
  /// Body stroke width and head size.
  width: number;
  headWidth: number;
  headLength: number;
  /// Closed triangles, one at each end: tip further from the run than the base.
  headA: Point[];
  headB: Point[];
  /// Middle of the route and the unit direction of the flow there: where a twisted seam shows its icon.
  mid: Point;
  midDir: Point;
}

/// One glued pair of an arrow: its own route from the contour of one run to the contour of the other,
/// with its own heads, standing in for the arrow's body while a face of a contour is hovered.
export interface SeamPair {
  /// Index into `SeamModel.seams`.
  seam: number;
  /// Index into `WireTopology.folds`.
  fold: number;
  /// Where the route starts on the contour of run A and of run B.
  anchors: [Point, Point];
  /// The hover zone of each of the pair's two faces: the band from the face out to the centre line of its
  /// contour and the same distance to the other side. Hovering inside one picks the pair.
  zones: [Point[], Point[]];
  path: Point[];
  /// The slot of each of the pair's two faces: where a graph edge ends at the contour.
  slots: [SeamSlot, SeamSlot];
  headA: Point[];
  headB: Point[];
  mid: Point;
  midDir: Point;
}

/// Where a graph edge meets one face of a glued pair (GitHub issue #841): a point on the face's contour (the
/// anchor of the pair's route) on the cell the face belongs to.
export interface SeamSlot {
  cell: [number, number];
  faceIdx: number;
  at: Point;
}

/// One side of a glue: its faces as a chain, the route port in the middle, the bracket and how far the
/// stem stands off the faces.
interface Run {
  faceLength: number;
  port: Port;
  /// The port of every face of the run, in the order of the glue's seams.
  ports: Port[];
  /// The hover zone polygon of every face, in the same order.
  zones: Point[][];
  brace: Point[] | null;
  standOff: number;
}

const arrowCache = new WeakMap<FieldConfig, { topology: WireTopology | null; arrows: SeamArrow[] }>();

/// `buildSeamArrows`, remembered per field config and topology: the graph renderers ask for the route
/// of every hop through a seam.
export function seamArrowsFor(cfg: FieldConfig, topology: WireTopology | null): SeamArrow[] {
  const cached = arrowCache.get(cfg);
  if (cached && cached.topology === topology) return cached.arrows;
  const arrows = buildSeamArrows(cfg, topology);
  arrowCache.set(cfg, { topology, arrows });
  return arrows;
}

/// The arrows of every glue of the current field, ordered by their first fold. `topology` supplies the
/// groups and which side of each fold is run A; without it every fold is a glue of its own. Empty when
/// the field has no folds.
export function buildSeamArrows(cfg: FieldConfig, topology: WireTopology | null = null): SeamArrow[] {
  const model = getSeamModel(cfg);
  if (model.seams.length === 0) return [];

  const glues = glueGroups(model.seams, topology);
  const built: { glue: { group: number | null; seams: Seam[] }; a: Run; b: Run; halvesA: HalfEdge[]; halvesB: HalfEdge[] }[] = [];
  for (const glue of glues) {
    const halvesA = glue.seams.map((seam) => runASide(seam, topology));
    const halvesB = glue.seams.map((seam, i) => (halvesA[i] === seam.a ? seam.b : seam.a));
    const a = buildRun(halvesA, cfg);
    const b = buildRun(halvesB, cfg);
    if (a && b) built.push({ glue, a, b, halvesA, halvesB });
  }
  if (built.length === 0) return [];
  // Two runs meeting at a corner have contours that cross and overshoot into each other's walls.
  for (const item of built) {
    let cutA: [boolean, boolean] = [false, false];
    let cutB: [boolean, boolean] = [false, false];
    if (item.a.brace && item.b.brace) [item.a.brace, item.b.brace, cutA, cutB] = trimAtCrossing(item.a.brace, item.b.brace);
    // An end that is not cut at a corner stops short of the wall by as much as the contour stands off its faces.
    if (item.a.brace) item.a.brace = pullBackEnds(item.a.brace, cutA);
    if (item.b.brace) item.b.brace = pullBackEnds(item.b.brace, cutB);
  }

  const polygons = configAllCells(cfg).map(([x, y]) => getCellVertices(x, y, cfg).map((v): Point => [v.x, v.y]));
  const axes = portAxes(built.flatMap((item) => [...item.a.ports, ...item.b.ports]));
  const unit = built.reduce((sum, item) => sum + (item.a.faceLength + item.b.faceLength) / 2, 0) / built.length;
  const contours = built.flatMap((item) => [item.a.brace, item.b.brace].filter((brace): brace is Point[] => brace !== null));
  const routes = routeAll(built.map((item) => [item.a.port, item.b.port] as [Port, Port]), polygons, unit, axes, contours);
  const box = boundsOf(polygons, built.flatMap((item) => [item.a.port.contact, item.b.port.contact]));

  const arrows: SeamArrow[] = built.map((item, i) => {
    const faceLength = (item.a.faceLength + item.b.faceLength) / 2;
    const headWidth = faceLength * HEAD_WIDTH_SHARE;
    const headLength = headWidth * HEAD_LENGTH_SHARE;
    const path = standOff(routes[i], item.a.standOff, item.b.standOff);
    const ending = endings(path, headLength, headWidth, [item.a.port.out, item.b.port.out]);
    const braceRuns = [item.a, item.b].map((run, side) => ({ run, side: side as 0 | 1 })).filter(({ run }) => run.brace !== null);
    const pairs = item.glue.seams.map((seam, k): SeamPair => {
      // A single face is its own pair; the faces of a run each get a route fitted among the other
      // glues' arrows, so it neither crosses nor runs along them.
      const route = item.a.brace === null
        ? path
        : standOff(routePair([item.a.ports[k], item.b.ports[k]], routes.filter((_, j) => j !== i), polygons, box, unit, axes, contours), item.a.standOff, item.b.standOff);
      const anchor = (run: Run): Point => [
        run.ports[k].contact[0] + run.ports[k].out[0] * run.standOff,
        run.ports[k].contact[1] + run.ports[k].out[1] * run.standOff,
      ];
      const slot = (run: Run, half: HalfEdge): SeamSlot => ({
        cell: half.cell,
        faceIdx: half.faceIdx,
        at: anchor(run),
      });
      const slots: [SeamSlot, SeamSlot] = [slot(item.a, item.halvesA[k]), slot(item.b, item.halvesB[k])];
      return { seam: seam.a.seam, fold: seam.fold, anchors: [slots[0].at, slots[1].at], zones: [item.a.zones[k], item.b.zones[k]], slots, path: route, ...endings(route, headLength, headWidth, [item.a.ports[k].out, item.b.ports[k].out]) };
    });
    return {
      seams: item.glue.seams.map((seam) => seam.a.seam),
      group: item.glue.group,
      twist: item.glue.seams[0].twist,
      path,
      bodies: [path],
      braces: [item.a.brace, item.b.brace].filter((brace): brace is Point[] => brace !== null),
      braceWidth: BRACE_WIDTH,
      braceSides: braceRuns.map(({ side }) => side),
      pairs,
      width: faceLength * BODY_WIDTH_SHARE,
      headWidth,
      headLength,
      headA: ending.headA,
      headB: ending.headB,
      mid: ending.mid,
      midDir: ending.midDir,
    };
  });
  return arrows;
}

/// The two polylines with the short end cut off each where they cross (the corner of two runs of one glue), so
/// they meet in one point instead of overshooting. Untouched when they do not cross near an end.
function trimAtCrossing(p: Point[], q: Point[]): [Point[], Point[], [boolean, boolean], [boolean, boolean]] {
  const limit = MAX_CORNER_CUT * BRACE_OFFSET;
  const cut = (line: Point[], other: Point[]): { line: Point[]; ends: [boolean, boolean] } => {
    const total = pathLength(line);
    let best: { at: number; point: Point; end: number } | null = null;
    let walked = 0;
    for (let i = 1; i < line.length; i++) {
      const segment = distance(line[i - 1], line[i]);
      for (let j = 1; j < other.length; j++) {
        const hit = segmentCrossing(line[i - 1], line[i], other[j - 1], other[j]);
        if (!hit) continue;
        const at = walked + hit.t * segment;
        const end = Math.min(at, total - at);
        if (end <= limit && (!best || end < best.end)) best = { at, point: hit.point, end };
      }
      walked += segment;
    }
    if (!best) return { line, ends: [false, false] };
    const found = best;
    const kept: Point[] = [];
    walked = 0;
    if (found.at <= total - found.at) {
      kept.push(found.point);
      for (let i = 1; i < line.length; i++) {
        walked += distance(line[i - 1], line[i]);
        if (walked > found.at + 1e-9) kept.push(line[i]);
      }
    } else {
      kept.push(line[0]);
      for (let i = 1; i < line.length; i++) {
        walked += distance(line[i - 1], line[i]);
        if (walked < found.at - 1e-9) kept.push(line[i]);
      }
      kept.push(found.point);
    }
    if (kept.length < 2) return { line, ends: [false, false] };
    return { line: kept, ends: found.at <= total - found.at ? [true, false] : [false, true] };
  };
  const cutP = cut(p, q);
  const cutQ = cut(q, p);
  return [cutP.line, cutQ.line, cutP.ends, cutQ.ends];
}

/// `line` with `BRACE_OFFSET` taken off each end that is not `kept`; unchanged when that would leave nothing.
function pullBackEnds(line: Point[], kept: [boolean, boolean]): Point[] {
  const from = kept[0] ? 0 : BRACE_OFFSET;
  const to = pathLength(line) - (kept[1] ? 0 : BRACE_OFFSET);
  if (to - from < 1e-6) return line;
  const out: Point[] = [pointAtLength(line, from).at];
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    walked += distance(line[i - 1], line[i]);
    if (walked > from + 1e-9 && walked < to - 1e-9) out.push(line[i]);
  }
  out.push(pointAtLength(line, to).at);
  return out;
}

/// Where segment `a1 a2` crosses segment `b1 b2` (`t` along the first), or `null`.
function segmentCrossing(a1: Point, a2: Point, b1: Point, b2: Point): { t: number; point: Point } | null {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const det = rx * sy - ry * sx;
  // Lines that run (nearly) along each other only touch at their ends: that is no crossing.
  if (Math.abs(det) <= 1e-6 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return null;
  const t = ((b1[0] - a1[0]) * sy - (b1[1] - a1[1]) * sx) / det;
  const u = ((b1[0] - a1[0]) * ry - (b1[1] - a1[1]) * rx) / det;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, point: [a1[0] + rx * t, a1[1] + ry * t] };
}

/// The heads at the two ends of `path` and the middle of it, where a twisted glue shows its icon. `outs` are the unit
/// normals out of the two walls the route starts and ends at: a head's base lies along its wall, so a route leaving it at
/// an angle gets a skewed triangle (its height off the wall stays the nominal length), not a crooked one over the contour.
function endings(path: Point[], nominalLength: number, nominalWidth: number, outs: [Point, Point]): Pick<SeamPair, "headA" | "headB" | "mid" | "midDir"> {
  // A short route (two runs meeting in a corner) shrinks the heads so they stay on their own segments.
  const first = distance(path[0], path[1]);
  const last = distance(path[path.length - 1], path[path.length - 2]);
  const share = path.length === 2 ? HEAD_SHARED_SHARE : HEAD_FIT_SHARE;
  const startDir = unitOf(path[0], path[1]);
  const end = path[path.length - 1];
  const endDir = unitOf(end, path[path.length - 2]);
  const cosStart = obliqueCos(startDir, outs[0]);
  const cosEnd = obliqueCos(endDir, outs[1]);
  const scale = Math.max(MIN_HEAD_SCALE, Math.min(1, (first * share * cosStart) / nominalLength, (last * share * cosEnd) / nominalLength));
  const headLength = nominalLength * scale;
  const headWidth = nominalWidth * scale;
  const { at, dir } = pointAtHalf(path);
  return {
    headA: wallHead(path[0], startDir, outs[0], cosStart, headLength, headWidth),
    headB: wallHead(end, endDir, outs[1], cosEnd, headLength, headWidth),
    mid: at,
    midDir: dir,
  };
}

/// The seams grouped by glue, in the order of their first fold. A seam outside every group (or any seam
/// without a topology) is a glue of its own.
function glueGroups(seams: readonly Seam[], topology: WireTopology | null): { group: number | null; seams: Seam[] }[] {
  const byFold = new Map(seams.map((seam) => [seam.fold, seam]));
  const used = new Set<number>();
  const glues: { group: number | null; seams: Seam[] }[] = [];
  for (const group of topology?.groups ?? []) {
    const members = group.folds.map((fold) => byFold.get(fold)).filter((seam): seam is Seam => seam !== undefined);
    if (members.length === 0) continue;
    for (const seam of members) used.add(seam.fold);
    glues.push({ group: group.id, seams: members });
  }
  for (const seam of seams) if (!used.has(seam.fold)) glues.push({ group: null, seams: [seam] });
  return glues.sort((p, q) => p.seams[0].fold - q.seams[0].fold);
}

/// The side of `seam` that belongs to run A of its fold (side `a` when the topology is not known).
function runASide(seam: Seam, topology: WireTopology | null): HalfEdge {
  const end = topology?.folds[seam.fold]?.a;
  if (!end) return seam.a;
  return seam.b.cell[0] === end.cell[0] && seam.b.cell[1] === end.cell[1] && seam.b.faceIdx === end.face_idx ? seam.b : seam.a;
}

/// A run of glued faces as a chain, its middle port and its bracket.
function buildRun(halves: readonly HalfEdge[], cfg: FieldConfig): Run | null {
  const faces = halves.map((half) => {
    const face = getFaceEdgeSegment(half.cell, half.faceIdx, cfg);
    if (!face) return null;
    const center = getCellCenter(half.cell[0], half.cell[1], cfg);
    return { face, center };
  });
  if (faces.some((face) => face === null) || faces.length === 0) return null;
  const items = faces as { face: NonNullable<ReturnType<typeof getFaceEdgeSegment>>; center: { x: number; y: number } }[];
  const lengths = items.map(({ face }) => polylineLength(face.polyline.map(([x, y]) => [x, y] as Point)));
  const faceLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  if (faceLength === 0) return null;
  const headLength = faceLength * HEAD_WIDTH_SHARE * HEAD_LENGTH_SHARE;

  const outOf = ({ face, center }: (typeof items)[number]): Point | null => {
    const length = Math.hypot(face.contact.x - center.x, face.contact.y - center.y);
    return length === 0 ? null : [(face.contact.x - center.x) / length, (face.contact.y - center.y) / length];
  };
  // The hover zone of a face is centred on its contour: from the face out to twice the contour offset.
  const zones = items.map((item) => {
    const polyline = item.face.polyline.map(([x, y]) => [x, y] as Point);
    const out = outOf(item);
    if (!out || polyline.length < 2) return [];
    const left: Point = [-(polyline[1][1] - polyline[0][1]), polyline[1][0] - polyline[0][0]];
    const side = left[0] * out[0] + left[1] * out[1] >= 0 ? 1 : -1;
    return [...polyline, ...offsetPolyline(polyline, side * 2 * BRACE_OFFSET).reverse()].map(([x, y]): Point => [x, y]);
  });

  if (items.length === 1) {
    const out = outOf(items[0]);
    if (!out) return null;
    const port: Port = { contact: [items[0].face.contact.x, items[0].face.contact.y], out };
    return {
      faceLength,
      port,
      ports: [port],
      zones,
      brace: null,
      standOff: headLength * HEAD_GAP_SHARE,
    };
  }

  // The faces joined into one chain, each oriented to continue from the one before.
  let chain: Point[] = items[0].face.polyline.map(([x, y]) => [x, y] as Point);
  items.slice(1).forEach(({ face }, index) => {
    let next = face.polyline.map(([x, y]) => [x, y] as Point);
    if (index === 0) {
      // The first face may have to be turned round to meet the second.
      const meets = (point: Point) => Math.min(distance(point, next[0]), distance(point, next[next.length - 1]));
      if (meets(chain[0]) < meets(chain[chain.length - 1])) chain = [...chain].reverse();
    }
    if (distance(chain[chain.length - 1], next[next.length - 1]) < distance(chain[chain.length - 1], next[0])) next = [...next].reverse();
    chain.push(...next);
  });
  chain = chain.filter((point, i) => i === 0 || distance(point, chain[i - 1]) > 1e-9);
  const total = pathLength(chain);
  const first = chain[1];
  const outFirst = outOf(items[0]);
  if (!outFirst || total === 0 || !first) return null;
  // Which side of the chain is out of the field.
  const left: Point = [-(first[1] - chain[0][1]), first[0] - chain[0][0]];
  const sign = left[0] * outFirst[0] + left[1] * outFirst[1] >= 0 ? 1 : -1;

  const ports: Port[] = [];
  for (const item of items) {
    const faceOut = outOf(item);
    if (!faceOut) return null;
    ports.push({ contact: [item.face.contact.x, item.face.contact.y], out: faceOut });
  }
  // The stem leaves from the centre of the middle face (of the two nearest the middle, the later one).
  const mid = ports[Math.floor(ports.length / 2)];
  const brace = offsetPolyline(chain, sign * BRACE_OFFSET).map(([x, y]): Point => [x, y]);
  return { faceLength, port: mid, ports, zones, brace, standOff: BRACE_OFFSET };
}

/// Whether `point` is on the arrow: within reach of its route or brackets or inside a head.
export function arrowContains(arrow: SeamArrow, point: Point, slack = 0, useCells = true): boolean {
  for (const [line, width] of [[arrow.path, arrow.width], ...arrow.braces.map((brace) => [brace, arrow.braceWidth] as const)] as const) {
    const reach = line === arrow.path ? width / 2 + slack : braceReach(arrow, slack);
    for (let i = 1; i < line.length; i++) {
      if (distanceToSegment(point, line[i - 1], line[i]) <= reach) return true;
    }
  }
  if (useCells && arrow.pairs.some((pair) => pair.zones.some((zone) => insidePolygon(point, zone)))) return true;
  return [arrow.headA, arrow.headB].some((head) => insidePolygon(point, head) || head.some((corner, k) => distanceToSegment(point, corner, head[(k + 1) % head.length]) <= slack));
}

function braceReach(arrow: SeamArrow, slack: number): number {
  return arrow.braceWidth / 2 + slack;
}

/// The arrow and pair (indices) of the glued pair on seam `seam`, or `null`.
export function seamFocusOf(arrows: readonly SeamArrow[], seam: number): { arrow: number; pair: number } | null {
  for (let arrow = 0; arrow < arrows.length; arrow++) {
    const pair = arrows[arrow].pairs.findIndex((candidate) => candidate.seam === seam);
    if (pair >= 0) return { arrow, pair };
  }
  return null;
}

/// The glued pair under `point`: the one whose cell holds it or, failing that, the one whose face on the
/// hovered contour is nearest. `null` when the point is on neither.
export function pairAt(arrow: SeamArrow, point: Point, slack = 0, useCells = true): number | null {
  const inCell = !useCells ? -1 : arrow.pairs.findIndex((pair) => pair.zones.some((zone) => insidePolygon(point, zone)));
  if (inCell >= 0) return inCell;
  if (arrow.pairs.length === 0) return null;
  const reach = braceReach(arrow, slack);
  const hit = arrow.braces.findIndex((brace) => brace.some((from, i) => i > 0 && distanceToSegment(point, brace[i - 1], from) <= reach));
  if (hit < 0) return null;
  const side = arrow.braceSides[hit];
  let best = 0;
  arrow.pairs.forEach((pair, k) => {
    if (distance(pair.anchors[side], point) < distance(arrow.pairs[best].anchors[side], point)) best = k;
  });
  return best;
}

/// The cosine between a route's first segment `dir` and the wall's normal `out`; 1 when the route is too flat against the
/// wall for an oblique head (the head is then the ordinary one, perpendicular to the body).
function obliqueCos(dir: Point, out: Point): number {
  const cos = dir[0] * out[0] + dir[1] * out[1];
  return cos >= MIN_OBLIQUE_COS ? cos : 1;
}

/// The head at the start `base` of a route leaving along `dir`: its base lies along the wall (across `out`), its tip is on
/// the body and `length` off the wall. With a body along `out` it is the isosceles `headPolygon`.
function wallHead(base: Point, dir: Point, out: Point, cos: number, length: number, width: number): Point[] {
  const flat = dir[0] * out[0] + dir[1] * out[1] < MIN_OBLIQUE_COS;
  if (flat) return headPolygon([base[0] + dir[0] * length, base[1] + dir[1] * length], dir, length, width);
  const reach = length / cos;
  const half = width / 2;
  return [
    [base[0] + dir[0] * reach, base[1] + dir[1] * reach],
    [base[0] - out[1] * half, base[1] + out[0] * half],
    [base[0] + out[1] * half, base[1] - out[0] * half],
  ];
}

/// A triangle with its tip at `tip`, pointing along `dir`.
export function headPolygon(tip: Point, dir: Point, length: number, width: number): Point[] {
  const [dx, dy] = dir;
  const baseX = tip[0] - dx * length;
  const baseY = tip[1] - dy * length;
  const half = width / 2;
  return [tip, [baseX - dy * half, baseY + dx * half], [baseX + dy * half, baseY - dx * half]];
}

/// The point halfway along `path` by length and the flow direction of the segment it lies on.
function pointAtHalf(path: Point[]): { at: Point; dir: Point } {
  return pointAtLength(path, pathLength(path) / 2);
}

/// The path with its start pulled `gapStart` and its end `gapEnd` inward along the first and last segments.
function standOff(path: Point[], gapStart: number, gapEnd: number): Point[] {
  const out = path.map((point): Point => [point[0], point[1]]);
  const pull = (end: number, next: number, gap: number): void => {
    const length = Math.hypot(out[next][0] - out[end][0], out[next][1] - out[end][1]);
    if (length === 0) return;
    const by = Math.min(gap, length * 0.6);
    out[end] = [out[end][0] + ((out[next][0] - out[end][0]) / length) * by, out[end][1] + ((out[next][1] - out[end][1]) / length) * by];
  };
  pull(0, 1, gapStart);
  pull(out.length - 1, out.length - 2, gapEnd);
  return out;
}

