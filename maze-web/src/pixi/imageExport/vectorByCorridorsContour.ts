import type { Graphics } from "pixi.js";

export type CorridorPoint = { x: number; y: number };
type Pt = CorridorPoint;

export type CorridorCellId = string | number;

/** A convex render cell.  The geometry engine only needs this shape; it has no knowledge of a
 * tessellation, grid coordinates, or renderer state. */
export type CorridorCell = {
  id: CorridorCellId;
  center: CorridorPoint;
  polygon: readonly CorridorPoint[];
};

/** A passage mouth on one finite cell face.  Both cells sharing a face should use the same face
 * endpoints.  That makes the effective mouth identical on both sides and prevents hairline seams. */
export type CorridorPort = {
  cellId: CorridorCellId;
  midpoint: CorridorPoint;
  normal: CorridorPoint;
  face?: readonly [CorridorPoint, CorridorPoint] | { start: CorridorPoint; end: CorridorPoint };
  /** Use a cubic handoff when a circular arc cannot satisfy both face tangents (irregular faces). */
  useCubicMouth?: boolean;
};

/** One command in a traced contour path. `line` draws a straight segment to `to`; `quadratic`
 *  and `bezier` draw smooth handoffs; `arc` draws a circular arc around `c` of radius `r` from
 *  angle `a0` to `a1`, `ccw` picking the sweep direction. Angles are in radians. */
export type PathCmd =
  | { kind: "move"; to: Pt }
  | { kind: "line"; to: Pt }
  | { kind: "quadratic"; cp: Pt; to: Pt }
  | { kind: "bezier"; cp1: Pt; cp2: Pt; to: Pt }
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number; ccw: boolean };

/** One closed sub-path of the corridor contour. With the per-tile build every tile emits exactly
 *  one path, they never overlap, and none is a hole — `hole` stays `false` and is kept only so the
 *  trace/fill call site and the tests need no change. */
export type ContourPath = { cmds: PathCmd[]; hole: boolean };

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const norm = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left normal (90° CCW). */
const leftN = (d: Pt): Pt => ({ x: -d.y, y: d.x });
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const angleOf = (v: Pt): number => Math.atan2(v.y, v.x);

type Seg = {
  v0: Pt;
  v1: Pt;
  faceMidpoint?: Pt;
  faceNormal?: Pt;
  faceLength?: number;
  cellVertices0?: Pt[];
  cellVertices1?: Pt[];
  fromNode?: number;
  toNode?: number;
  v1TouchesSplit?: boolean;
};

/** One connection of a tile: the passage leaves the tile centre `centre` toward `mid` (the middle
 *  of the shared border), `out` is the outward unit normal there. The drawn corridor is `2h` wide,
 *  so the border it must draw is the segment `mid ± tangent·h`. */
type Port = { centre: Pt; mid: Pt; out: Pt; useCubicMouth?: boolean };

/** One tile: its centre and every port, in CCW order around the centre. */
type Tile = { centre: Pt; ports: Port[]; boundary?: readonly Pt[] };
export type CorridorJunctionStyle = "default" | "shallowThreeWay";

/** Groups the centre-to-centre corridor segments into per-tile port lists. Every segment端 is a
 *  connection of the tile whose centre sits at that segment end. A split-touching far end (`v1TouchesSplit`)
 *  contributes a port only to the near (plain) tile — the split tile's own geometry is drawn
 *  elsewhere (`drawSplitPassages`). */
function buildTiles(segments: Seg[]): Tile[] {
  const byKey = new Map<string, Tile>();
  const keyOf = (p: Pt): string => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const tileAt = (centre: Pt, boundary?: Pt[]): Tile => {
    const k = keyOf(centre);
    let t = byKey.get(k);
    if (!t) {
      t = { centre, ports: [], boundary };
      byKey.set(k, t);
    } else if (!t.boundary && boundary) {
      t.boundary = boundary;
    }
    return t;
  };

  for (const s of segments) {
    if (len(sub(s.v1, s.v0)) < 1e-6) continue;
    // A Cairo port uses the actual shared-face centre and its perpendicular outward normal. The
    // centroid-to-centroid axis is not the face normal for these irregular pentagons.
    const faceMid = s.faceMidpoint ?? (s.v1TouchesSplit ? s.v1 : mid(s.v0, s.v1));
    const nearMid = s.v1TouchesSplit ? { ...s.v1 } : faceMid;
    const nearOut = s.faceNormal ?? norm(sub(s.v1, s.v0));
    tileAt(s.v0, s.cellVertices0).ports.push({ centre: s.v0, mid: nearMid, out: nearOut, useCubicMouth: Boolean(s.faceMidpoint) });

    if (!s.v1TouchesSplit) {
      const farMid = faceMid;
      const farOut = s.faceNormal ? mul(s.faceNormal, -1) : norm(sub(s.v0, s.v1));
      tileAt(s.v1, s.cellVertices1).ports.push({ centre: s.v1, mid: farMid, out: farOut, useCubicMouth: Boolean(s.faceMidpoint) });
    }
  }

  const tiles = [...byKey.values()];
  for (const t of tiles) {
    t.ports.sort((a, b) => angleOf(sub(a.mid, t.centre)) - angleOf(sub(b.mid, t.centre)));
  }
  return tiles;
}

function faceLength(face: CorridorPort["face"]): number | undefined {
  if (!face) return undefined;
  const start = Array.isArray(face) ? face[0] : ("start" in face ? face.start : undefined);
  const end = Array.isArray(face) ? face[1] : ("end" in face ? face.end : undefined);
  if (!start || !end) return undefined;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  return Number.isFinite(length) ? length : undefined;
}

function halfWidthForPorts(ports: readonly CorridorPort[], requested: number): number {
  const finiteFaceLengths = ports
    .map((port) => faceLength(port.face))
    .filter((length): length is number => length !== undefined && length > 0);
  const shortestFace = Math.min(...finiteFaceLengths);
  return Number.isFinite(shortestFace) ? Math.min(requested, shortestFace / 2) : requested;
}

function buildTilesFromCells(cells: readonly CorridorCell[], ports: readonly CorridorPort[]): Tile[] {
  const cellById = new Map<CorridorCellId, CorridorCell>(cells.map((cell) => [cell.id, cell]));
  const tiles = new Map<CorridorCellId, Tile>();

  for (const port of ports) {
    const cell = cellById.get(port.cellId);
    if (!cell || cell.polygon.length < 3) continue;
    const tile = tiles.get(cell.id) ?? { centre: cell.center, ports: [], boundary: cell.polygon };
    tile.ports.push({
      centre: cell.center,
      mid: port.midpoint,
      out: norm(port.normal),
      useCubicMouth: port.useCubicMouth,
    });
    tiles.set(cell.id, tile);
  }

  for (const tile of tiles.values()) {
    tile.ports.sort((a, b) => angleOf(sub(a.mid, tile.centre)) - angleOf(sub(b.mid, tile.centre)));
  }
  return [...tiles.values()];
}

/** The two endpoints of a port's border segment, `mid ± tangent·h`. `left` is on the +left-normal
 *  side of `out` (i.e. CCW), `right` the other. */
function portBorderEnds(port: Port, h: number): { left: Pt; right: Pt } {
  const t = leftN(port.out); // tangent along the border, CCW around the tile
  return { left: add(port.mid, mul(t, h)), right: sub(port.mid, mul(t, h)) };
}

/** A port mouth must fit on the finite face of its cell. The limit is computed once for the whole
 * segment set so both sides of a shared face use exactly the same effective width; deriving it per
 * tile would leave a junction clamped while its one-port neighbour still used the requested width. */
function fitHalfWidth(segments: Seg[], h: number): number {
  const cairoFaceHalf = Math.min(...segments
    .map((s) => s.faceLength)
    .filter((length): length is number => length !== undefined && Number.isFinite(length))
    .map((length) => length / 2));
  if (Number.isFinite(cairoFaceHalf)) return Math.min(h, cairoFaceHalf);

  const apothems = segments.map((s) => {
    const distance = len(sub(s.v1, s.v0));
    return s.v1TouchesSplit ? distance : distance / 2;
  });
  const apothem = Math.min(...apothems);
  const angles = segments
    .map((s) => {
      const a = angleOf(sub(s.v1, s.v0));
      return a < 0 ? a + Math.PI : a % Math.PI;
    })
    .sort((a, b) => a - b);
  const uniqueAngles = angles.filter((a, i) => i === 0 || a - angles[i - 1] > 1e-5);
  if (uniqueAngles.length < 2) return h;
  let minGap = Math.PI * 2;
  for (let i = 0; i < uniqueAngles.length; i++) {
    const next = i + 1 < uniqueAngles.length ? uniqueAngles[i + 1] : uniqueAngles[0] + Math.PI;
    minGap = Math.min(minGap, next - uniqueAngles[i]);
  }
  const faceHalf = apothem * Math.tan(minGap / 2);
  return Number.isFinite(faceHalf) && faceHalf > 0 ? Math.min(h, faceHalf) : h;
}

/** Builds the corridor contour as one closed path per tile (the per-tile rework).
 *
 *  Each tile is drawn from its own connections only. On every border where the tile has a passage it
 *  draws a straight border segment `thickness` long, centred on the middle of that border. Between
 *  two consecutive ports the tile's outline is:
 *   - a **straight-through** tile (2 opposite ports): a rectangle, the two borders joined straight.
 *   - a **turn** tile (2 ports at an angle): a pair of *concentric* circular arcs — inner radius
 *     `R - h`, outer `R + h`, where `R` is the distance from the corner point (where the two border
 *     lines meet) to each border midpoint — so the corridor keeps a constant `thickness` width all
 *     the way through the bend. This is the fix for issue #493: the old renderer left the inner
 *     elbow a sharp point, so turns read as half-rounded and thicker.
 *   - a **dead-end** tile (1 port): a `thickness`-wide stub from the border to the tile centre, then
 *     a 180-degree semicircular cap of radius `h`.
 *   - a **junction** tile (3+ ports): each port's border, joined to the next around the tile centre
 *     by an arc (see `junctionContour`) when `roundJunctions` is set, or by a straight mitre corner
 *     when it is not — turns and dead ends stay rounded either way.
 *
 *  Adjacent tiles draw mirror-image borders on the shared face (same midpoint, same length), so the
 *  filled shapes meet edge-to-edge with no seam and no overlap. `thickness` is the corridor width;
 *  every tile's default radii follow from its own geometry. Callers may provide a fixed junction
 *  radius when they want the same target radius across all combinations of one tessellation. */
export function buildCorridorGeometry(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  // `VectorByCorridorsRenderer` always passes `true` since GitHub issue #510 replaced the old
  // `roundJunctions` setting with a Contour-vs-Line rendering-mode switch (angular junctions now
  // mean picking Line mode, not this flag). Kept parameterized for callers that need the lower-level
  // contour behavior directly.
  roundJunctions = true,
  junctionStyle: CorridorJunctionStyle = "default",
  junctionRadius?: number,
): ContourPath[] {
  if (thickness <= 0 || cells.length === 0 || ports.length === 0) return [];
  const h = halfWidthForPorts(ports, thickness / 2);
  const tiles = buildTilesFromCells(cells, ports);
  const paths: ContourPath[] = [];
  const radius = junctionRadius === undefined ? undefined : Math.max(0, junctionRadius);

  for (const tile of tiles) {
    let cmds = tileContour(tile, h, roundJunctions, junctionStyle, radius);
    if (radius !== undefined && radius > 1e-6 && !pathInsideConvexCell(cmds, tile.boundary)) {
      // The fillet itself may fit while the complete junction contour still crosses a narrow or
      // skewed cell. Clamp the user-facing radius against the whole contour, otherwise the generic
      // safety fallback replaces the junction with a visibly segmented Bezier shape at the limit.
      let low = 0;
      let high = radius;
      const sharp = tileContour(tile, h, roundJunctions, junctionStyle, 0);
      if (pathInsideConvexCell(sharp, tile.boundary)) {
        cmds = sharp;
        for (let iteration = 0; iteration < 28; iteration++) {
          const candidateRadius = (low + high) / 2;
          const candidate = tileContour(tile, h, roundJunctions, junctionStyle, candidateRadius);
          if (pathInsideConvexCell(candidate, tile.boundary)) {
            low = candidateRadius;
            cmds = candidate;
          } else {
            high = candidateRadius;
          }
        }
      }
    }
    // All curve controls are selected from the cell interior for generic cells.  The fast path
    // above retains the established arc-based appearance; this fallback handles narrow or skewed
    // convex cells where an arc's mathematical centre would otherwise put a kink outside the cell.
    if (!pathInsideConvexCell(cmds, tile.boundary)) {
      cmds = convexSafeCellContour(tile, h);
    }
    if (cmds.length >= 2) paths.push({ cmds, hole: false });
  }
  return paths;
}

/**
 * Compatibility adapter for the selector's centre-to-centre records.  The selector is responsible
 * for tessellation-specific work (finding faces and polygons); the contour engine above consumes
 * only the resulting cells and ports.
 */
export function buildCorridorContour(
  cells: readonly CorridorCell[],
  ports: readonly CorridorPort[],
  thickness: number,
  roundJunctions?: boolean,
  junctionStyle?: CorridorJunctionStyle,
  junctionRadius?: number,
): ContourPath[];
export function buildCorridorContour(
  segments: Seg[],
  thickness: number,
  roundJunctions?: boolean,
  junctionStyle?: CorridorJunctionStyle,
  junctionRadius?: number,
): ContourPath[];
export function buildCorridorContour(
  input: Seg[] | readonly CorridorCell[],
  second: number | readonly CorridorPort[],
  third: boolean | number = true,
  fourth: CorridorJunctionStyle | boolean = "default",
  fifth: CorridorJunctionStyle | number = "default",
  sixth?: number,
): ContourPath[] {
  if (Array.isArray(second)) {
    return buildCorridorGeometry(
      input as readonly CorridorCell[],
      second,
      third as number,
      typeof fourth === "boolean" ? fourth : true,
      typeof fifth === "string" ? fifth : "default",
      sixth,
    );
  }
  const segments = input as Seg[];
  const thickness = second as number;
  const roundJunctions = typeof third === "boolean" ? third : true;
  const junctionStyle = typeof fourth === "string" ? fourth : "default";
  const junctionRadius = typeof fifth === "number" ? fifth : undefined;
  const cells = new Map<string, CorridorCell>();
  const ports: CorridorPort[] = [];
  const pointKey = (point: Pt): string => `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
  const addCell = (centre: Pt, polygon?: readonly Pt[]): string => {
    const id = pointKey(centre);
    if (!cells.has(id)) cells.set(id, { id, center: centre, polygon: polygon ?? [] });
    else if (polygon && polygon.length >= 3 && cells.get(id)!.polygon.length < 3) {
      cells.set(id, { ...cells.get(id)!, polygon });
    }
    return id;
  };

  for (const segment of segments) {
    if (len(sub(segment.v1, segment.v0)) < 1e-6) continue;
    const midpoint = segment.faceMidpoint ?? (segment.v1TouchesSplit ? segment.v1 : mid(segment.v0, segment.v1));
    const normal = segment.faceNormal ?? norm(sub(segment.v1, segment.v0));
    const halfFace = segment.faceLength ? segment.faceLength / 2 : undefined;
    const face = halfFace === undefined
      ? undefined
      : [sub(midpoint, mul(leftN(normal), halfFace)), add(midpoint, mul(leftN(normal), halfFace))] as const;
    const fromId = addCell(segment.v0, segment.cellVertices0);
    ports.push({ cellId: fromId, midpoint, normal, face, useCubicMouth: Boolean(segment.faceMidpoint) });
    if (!segment.v1TouchesSplit) {
      const toId = addCell(segment.v1, segment.cellVertices1);
      ports.push({
        cellId: toId,
        midpoint,
        normal: mul(normal, -1),
        face,
        useCubicMouth: Boolean(segment.faceMidpoint),
      });
    }
  }

  // Centre-only records are retained for the line/legacy split paths.  Keep their established
  // angle-based construction; the polygon-aware path below is the generic engine used whenever
  // the selector (or an external caller) supplies actual cell polygons.
  if (!segments.some((segment) => segment.cellVertices0 || segment.cellVertices1)) {
    const h = fitHalfWidth(segments, thickness / 2);
    return buildTiles(segments)
      .map((tile) => ({ cmds: tileContour(tile, h, roundJunctions, junctionStyle, junctionRadius), hole: false }))
      .filter((path) => path.cmds.length >= 2);
  }

  // Legacy test fixtures may omit polygons.  They still get the same angle-based construction;
  // generic callers should always provide polygons so the containment guarantee can be enforced.
  const geometryCells = [...cells.values()].map((cell) => ({
    ...cell,
    polygon: cell.polygon.length >= 3 ? cell.polygon : [
      { x: cell.center.x - thickness, y: cell.center.y - thickness },
      { x: cell.center.x + thickness, y: cell.center.y - thickness },
      { x: cell.center.x + thickness, y: cell.center.y + thickness },
      { x: cell.center.x - thickness, y: cell.center.y + thickness },
    ],
  }));
  return buildCorridorGeometry(geometryCells, ports, thickness, roundJunctions, junctionStyle, junctionRadius);
}

function pathInsideConvexCell(cmds: PathCmd[], boundary: readonly Pt[] | undefined): boolean {
  if (!boundary || boundary.length < 3) return true;
  const samples = contourToPolyline({ cmds, hole: false });
  if (samples.some((point) => !pointInConvexPolygon(point, boundary))) return false;
  return cmds.every((cmd) => {
    if (cmd.kind === "arc") {
      let sweep = cmd.a1 - cmd.a0;
      if (cmd.ccw) {
        while (sweep > 0) sweep -= Math.PI * 2;
        while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
      } else {
        while (sweep < 0) sweep += Math.PI * 2;
        while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
      }
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.02));
      for (let i = 0; i <= steps; i++) {
        const angle = cmd.a0 + (sweep * i) / steps;
        if (!pointInConvexPolygon({ x: cmd.c.x + Math.cos(angle) * cmd.r, y: cmd.c.y + Math.sin(angle) * cmd.r }, boundary)) return false;
      }
    }
    if (cmd.kind === "quadratic") return pointInConvexPolygon(cmd.cp, boundary);
    if (cmd.kind === "bezier") {
      return pointInConvexPolygon(cmd.cp1, boundary) && pointInConvexPolygon(cmd.cp2, boundary);
    }
    return true;
  });
}

/** Convex-hull-safe fallback.  A Bezier curve stays inside the convex hull of its endpoints and
 * controls, so every control is deliberately walked inward from a face mouth. */
function convexSafeCellContour(tile: Tile, h: number): PathCmd[] {
  const { ports, boundary } = tile;
  if (ports.length === 0) return [];
  if (ports.length === 1) {
    const port = ports[0];
    const ends = portBorderEnds(port, h);
    const tangent = leftN(port.out);
    const radius = boundary ? Math.min(h, convexCellClearance(tile.centre, boundary) * 0.98) : h;
    const capC = tile.centre;
    const rightIn = add(capC, mul(tangent, -radius));
    const leftIn = add(capC, mul(tangent, radius));
    const a0 = angleOf(sub(rightIn, capC));
    const a1 = angleOf(sub(leftIn, capC));
    const ccw = chooseArcSweep(a0, a1, norm(sub(capC, port.mid)));
    return [
      { kind: "move", to: ends.right },
      { kind: "quadratic", cp: controlInside(ends.right, mul(port.out, -1), len(sub(ends.right, rightIn)) / 2, boundary), to: rightIn },
      { kind: "arc", c: capC, r: radius, a0, a1, ccw },
      { kind: "quadratic", cp: controlInside(leftIn, port.out, len(sub(leftIn, ends.left)) / 2, boundary), to: ends.left },
      { kind: "line", to: ends.right },
    ];
  }

  const cmds: PathCmd[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    const next = ports[(i + 1) % ports.length];
    const ends = portBorderEnds(port, h);
    const nextEnds = portBorderEnds(next, h);
    cmds.push({ kind: i === 0 ? "move" : "line", to: ends.right });
    cmds.push({ kind: "line", to: ends.left });
    const distance = len(sub(nextEnds.right, ends.left));
    const handle = Math.min(distance / 3, len(sub(tile.centre, ends.left)) * 0.65, len(sub(tile.centre, nextEnds.right)) * 0.65);
    if (handle > 1e-6) {
      cmds.push({
        kind: "bezier",
        cp1: controlInside(ends.left, mul(port.out, -1), handle, boundary),
        cp2: controlInside(nextEnds.right, mul(next.out, -1), handle, boundary),
        to: nextEnds.right,
      });
    } else {
      cmds.push({ kind: "line", to: nextEnds.right });
    }
  }
  const first = cmds[0];
  if (first && (first.kind === "move" || first.kind === "line")) cmds.push({ kind: "line", to: first.to });
  return cmds;
}

/** Emits one closed path for a single tile. */
function tileContour(tile: Tile, h: number, roundJunctions: boolean, junctionStyle: CorridorJunctionStyle, junctionRadius?: number): PathCmd[] {
  const { ports } = tile;
  const n = ports.length;
  if (n === 0) return [];

  // Irregular convex cells can make a wall-intersection junction reach outside the cell. Use the
  // same convex-safe construction for every junction whose ports carry real face geometry. Active
  // gaps use a true miter or circular fillet; the wide dead-sector gap keeps a safe curved bridge.
  if (n >= 3 && ports.every((port) => port.useCubicMouth)) {
    return convexSafeJunctionContour(ports, h, junctionRadius, tile.boundary);
  }

  if (n === 1) {
    // Dead end: a `thickness`-wide stub running from the shared border straight into the tile, then
    // a 180-degree semicircular cap of radius `h`. Four anchor points — two where the stub meets the
    // border (shared with the neighbour tile), two where the straight walls hand off to the cap.
    const p = ports[0];
    const { left, right } = portBorderEnds(p, h); // on the border
    const inn = mul(p.out, -1);
    const tangent = leftN(p.out);
    // Cairo's face midpoint and centroid are not always on the same normal line. Put the cap
    // centre on the actual tile centre so a marker at the cell centre is never left off-axis. Keep
    // the cap diameter perpendicular to the shared face so its two handoff points stay ordered
    // with the exact mouth endpoints; only the selected semicircle side follows the cell centre.
    const capC = p.centre;
    const capDirection = norm(sub(capC, p.mid));
    const capBoundaryRadius = tile.boundary ? convexCellClearance(capC, tile.boundary) : h;
    // Leave a little room for the quadratic handoff to turn into the cap tangent before the boundary.
    const capRadius = Math.min(h, capBoundaryRadius * (capBoundaryRadius < h ? 0.98 : 1));
    let leftIn = add(capC, mul(tangent, capRadius));     // start of the cap, left wall
    let rightIn = sub(capC, mul(tangent, capRadius));   // start of the cap, right wall

    // Keep the handoff direction at the shared face, but move the cap endpoints along the same
    // circle when a quadratic's endpoint tangent would otherwise disagree with the round cap.
    // This changes only the local join point, not the curve's direction at the neighbouring cell.
    const initialA0 = angleOf(sub(rightIn, capC));
    const initialA1 = angleOf(sub(leftIn, capC));
    const initialCcw = chooseArcSweep(initialA0, initialA1, capDirection);
    const initialTangentAtStart = initialCcw
      ? { x: Math.sin(initialA0), y: -Math.cos(initialA0) }
      : { x: -Math.sin(initialA0), y: Math.cos(initialA0) };
    const initialTangentAtEnd = initialCcw
      ? { x: Math.sin(initialA1), y: -Math.cos(initialA1) }
      : { x: -Math.sin(initialA1), y: Math.cos(initialA1) };
    const initialRightControl = quadraticControlPoint(right, rightIn, inn, initialTangentAtStart, tile.boundary, "start");
    const initialLeftControl = quadraticControlPoint(leftIn, left, initialTangentAtEnd, p.out, tile.boundary, "end");
    rightIn = tangentPointOnCircle(initialRightControl, capC, capRadius, rightIn, tile.boundary) ?? rightIn;
    leftIn = tangentPointOnCircle(initialLeftControl, capC, capRadius, leftIn, tile.boundary) ?? leftIn;

    const a0 = angleOf(sub(rightIn, capC));
    const a1 = angleOf(sub(leftIn, capC));
    // The endpoints are opposite across the cap centre, so choose between the two exact 180-degree
    // sweeps by testing the actual midpoint direction used by Pixi (`ccw: true` decreases angle).
    const ccw = chooseArcSweep(a0, a1, capDirection);
    const tangentAtStart = ccw
      ? { x: Math.sin(a0), y: -Math.cos(a0) }
      : { x: -Math.sin(a0), y: Math.cos(a0) };
    const tangentAtEnd = ccw
      ? { x: Math.sin(a1), y: -Math.cos(a1) }
      : { x: -Math.sin(a1), y: Math.cos(a1) };
    return [
      { kind: "move", to: right },
      smoothDeadEndHandoff(right, rightIn, inn, tangentAtStart, tile.boundary),
      { kind: "arc", c: capC, r: capRadius, a0, a1, ccw },
      smoothDeadEndHandoff(leftIn, left, tangentAtEnd, p.out, tile.boundary),
      { kind: "line", to: right },
    ];
  }

  if (n === 2) {
    const [p0, p1] = ports;
    const collinear = dot(p0.out, p1.out) < -1 + 1e-4;
    if (collinear) {
      // Straight through: rectangle between the two border segments.
      const e0 = portBorderEnds(p0, h);
      const e1 = portBorderEnds(p1, h);
      // Order the four corners into a simple quad. p0.left -> p0.right are one edge; the opposite
      // edge is p1's, whichever orientation makes a non-self-crossing loop.
      const loop = [e0.left, e0.right, e1.left, e1.right];
      // Sort by angle around the centroid to guarantee a simple polygon.
      const cx = (loop[0].x + loop[1].x + loop[2].x + loop[3].x) / 4;
      const cy = (loop[0].y + loop[1].y + loop[2].y + loop[3].y) / 4;
      loop.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
      return [
        { kind: "move", to: loop[0] },
        { kind: "line", to: loop[1] },
        { kind: "line", to: loop[2] },
        { kind: "line", to: loop[3] },
        { kind: "line", to: loop[0] },
      ];
    }
    return turnContour(p0, p1, h);
  }

  const styleScale = junctionStyle === "shallowThreeWay" && n === 3 ? 0.55 : 1;
  return junctionContour(ports, h, roundJunctions, styleScale, junctionRadius);
}

/** Max concave-armpit fillet radius, as a multiple of the corridor width `2h`. The armpit corner is
 *  a tangent fillet between the two arms' extended side-walls of radius `min(R - h, ARMPIT_FILLET_K
 *  * 2h)`. The turn-tile inner elbow `R - h` grows with the tessellation step, ballooning a
 *  thin-corridor junction; capping the radius against the corridor width keeps the fill about one
 *  corridor wide regardless of the step. When the cap does not bite it is exactly the `R - h` turn
 *  elbow. */
const ARMPIT_FILLET_K = 0.9;

/** A junction tile (3+ ports). Walk the outline CCW: each port contributes its `thickness`-wide
 *  border (`right` -> `left`), then between it and the next port:
 *   - **concave armpit** (both arms have a passage, CCW turn between the two arm axes < 180 degrees):
 *     a tangent fillet of radius `min(R - h, ARMPIT_FILLET_K * 2h)` between the two arm side-walls —
 *     `R` = distance from `O` (where the two border lines meet) to each border midpoint. Capping the
 *     radius against the corridor width keeps the junction fill about one corridor wide regardless
 *     of the tessellation step; when the cap does not bite it is exactly the turn-tile inner elbow.
 *   - **convex gap** (the wide dead sector between the two outermost arms, no passage there — a
 *     reflex turn): the turn's *outer* elbow — an arc of radius `R + h` between the two borders'
 *     outer ends, swept the short way (as `turnContour` sweeps its outer arc). Same arc a
 *     one-face-apart passage draws; by construction `R + h` is roughly `|O - tile centre|`, so the
 *     arc runs close past the centre without quite reaching it — that is fine, the fill still reads
 *     as one smooth junction.
 *   - **straight-through** (collinear arms, no `O`): a plain line across.
 *
 *  No core disc. Ports are CCW around the centre. */
/** A junction with exactly one reflex "dead sector" (e.g. a hex cell with passages on 3 adjacent
 *  faces) has a corridor bending one-face-apart across it. That corridor's OUTER edge is the dead
 *  sector's `R + h` arc about `O`; its INNER edge must be the concentric `R - h` arc about the same
 *  `O`, running unbroken from one dead-sector arm to the other along the short side, with each
 *  in-between arm cutting a notch out of that one arc where its two side-walls cross the circle.
 *  Drawing those sections as stand-alone armpit fillets leaves a straight inner edge against the
 *  curved outer one and pinches the fill. `ia`/`ib` are the dead sector's two arms, `ib === ia + 1`
 *  (mod n); the short side runs `ib, ib+1, ..., ia`. Returns the whole closed contour, or null if
 *  the junction has zero or several dead sectors (then the per-section loop handles it). */
function bendJunctionContour(ports: Port[], h: number, filletScale: number, requestedRadius?: number): PathCmd[] | null {
  const n = ports.length;
  let dead: { O: Pt; ia: number; ib: number } | null = null;
  let deadCount = 0;
  for (let i = 0; i < n; i++) {
    const p = ports[i];
    const next = ports[(i + 1) % n];
    let turn = angleOf(mul(next.out, -1)) - angleOf(mul(p.out, -1));
    while (turn <= 0) turn += Math.PI * 2;
    if (turn <= Math.PI) continue;
    deadCount++;
    const O = lineIntersect(p.mid, leftN(p.out), next.mid, leftN(next.out));
    if (O) dead = { O, ia: i, ib: (i + 1) % n };
  }
  if (deadCount !== 1 || !dead) return null;

  const { O, ia, ib } = dead;
  const R =
    (len(sub(ports[ia].mid, O)) + len(sub(ports[ib].mid, O))) / 2;
  const rIn = Math.max(0, R - h);
  if (rIn < 1e-4) return null;

  // Short-side arms in CCW order: ib, ib+1, ..., ia.
  const shortLen = ((ia - ib + n) % n) + 1;
  const arm: number[] = [];
  for (let k = 0; k < shortLen; k++) arm.push((ib + k) % n);

  // For each short-side arm, its two border ends and which one is inner (nearer `O`).
  const info = arm.map((idx) => {
    const port = ports[idx];
    const e = portBorderEnds(port, h);
    const inner = len(sub(e.left, O)) < len(sub(e.right, O)) ? e.left : e.right;
    const outer = inner === e.left ? e.right : e.left;
    return { port, e, inner, outer, into: norm(mul(port.out, -1)) };
  });

  const cmds: PathCmd[] = [];
  const arcTo = (from: Pt, to: Pt) => {
    cmds.push(arcThroughPoints(from, to, O));
  };

  // Concave-fillet radius for the corners where the inner arc hands off to an arm's side-wall.
  const defaultRadius = Math.min(ARMPIT_FILLET_K * 2 * h, h * 0.7) * filletScale;
  const rf = requestedRadius === undefined ? defaultRadius : Math.max(0, requestedRadius);

  /** Where the line through `wallP` along `wallU` crosses `C(O, rIn)`, taking the crossing closest
   *  to `wallP` (the in-between arm's mouth sits inside the circle between the tile centre and the
   *  through-corridor's inner arc, so its wall exits the circle just past the border end). Null if
   *  the line misses. */
  const wallCrossesArc = (wallP: Pt, wallU: Pt, near: Pt): Pt | null => {
    const f = sub(wallP, O);
    const b = dot(f, wallU);
    const disc = b * b - (dot(f, f) - rIn * rIn);
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const pA = add(wallP, mul(wallU, -b - root));
    const pB = add(wallP, mul(wallU, -b + root));
    return len(sub(pA, near)) <= len(sub(pB, near)) ? pA : pB;
  };

  /** Small fillet tangent to the inner circle and a straight wall. The old implementation moved
   *  the circle's tangent point along its tangent, which made it a chord point rather than a point
   *  on C(O, rIn). Solve the two offset-line/circle intersections instead, then derive both actual
   *  tangent points from the same fillet centre. */
  const cornerFillet = (
    corner: Pt,
    wallDir: Pt,
    rMax: number,
    arcHint: Pt,
    reverse: boolean,
    wallEnd: Pt,
  ): { cmd: PathCmd | null; arcT: Pt; wallT: Pt } => {
    // A zero-radius fillet is still a real corner. Represent it as a degenerate line command to
    // the corner instead of returning a missing command: the caller must keep both the inner-arc
    // endpoint and the wall endpoint in the contour walk.
    if (rMax <= 1e-6) {
      return { cmd: { kind: "line", to: corner }, arcT: corner, wallT: corner };
    }
    const d = norm(wallDir);
    const nrm = leftN(d);
    const wallReach = dot(sub(wallEnd, corner), d);
    if (wallReach <= 1e-6) return { cmd: null, arcT: corner, wallT: corner };
    type FilletCandidate = { fc: Pt; arcT: Pt; wallT: Pt; radius: number; score: number };
    const findCandidate = (radius: number): FilletCandidate | undefined => {
      if (radius <= 1e-6) return undefined;
      const candidates: FilletCandidate[] = [];
      for (const side of [-1, 1]) {
        const offset = mul(nrm, side * radius);
        const q = add(corner, offset);
        const along = d;
        const f = sub(q, O);
        const b = dot(f, along);
        const tangentDistance = rIn - radius;
        const disc = b * b - (dot(f, f) - tangentDistance * tangentDistance);
        if (disc < 0) continue;
        const root = Math.sqrt(disc);
        for (const t of [-b - root, -b + root]) {
          const fc = add(q, mul(along, t));
          const fo = sub(fc, O);
          const foLen = len(fo);
          if (foLen < 1e-6) continue;
          const arcT = add(O, mul(fo, rIn / foLen));
          const wallT = sub(fc, offset);
          const wallDistance = dot(sub(wallT, corner), d);
          if (wallDistance < -1e-6 || wallDistance > wallReach + 1e-6) continue;
          const towardArc = norm(sub(arcT, corner));
          if (dot(towardArc, norm(arcHint)) <= 0) continue;
          const score =
            wallDistance +
            len(sub(arcT, corner)) -
            10 * dot(towardArc, norm(arcHint));
          candidates.push({ fc, arcT, wallT, radius, score });
        }
      }
      return candidates.sort((a, b) => a.score - b.score)[0];
    };

    // A requested radius may not fit between the inner arc and the arm wall. Find the largest
    // fitting radius continuously instead of trying a few fixed fractions, which made the
    // visible radius jump backwards when the requested value crossed the geometric limit.
    let best = findCandidate(rMax);
    if (!best) {
      let low = 0;
      let high = rMax;
      for (let iteration = 0; iteration < 28; iteration++) {
        const radius = (low + high) / 2;
        const candidate = findCandidate(radius);
        if (candidate) {
          low = radius;
          best = candidate;
        } else {
          high = radius;
        }
      }
    }
    if (!best) return { cmd: null, arcT: corner, wallT: corner };
    const aArc = angleOf(sub(best.arcT, best.fc));
    const aWall = angleOf(sub(best.wallT, best.fc));
    return {
      cmd: {
        kind: "arc",
        c: best.fc,
        r: best.radius,
        a0: reverse ? aWall : aArc,
        a1: reverse ? aArc : aWall,
        ccw: shortSweepCcw(reverse ? aWall : aArc, reverse ? aArc : aWall),
      },
      arcT: best.arcT,
      wallT: best.wallT,
    };
  };
  // Walk the inner edge CCW: arm `ib`'s border to its inner end, then `R - h` arcs about `O` along
  // the short side. An in-between arm's mouth (its shared grid face) sits inside `C(O, rIn)`, so its
  // corridor runs from there toward the tile centre, crossing `C(O, rIn)` once on the way. The inner
  // arc runs to where the arm's trailing side-wall crosses the circle -- rounded there -- then out
  // along that wall to the border end, across the `thickness` mouth, back along the leading
  // side-wall to its own crossing -- rounded again -- and the arc resumes. The dead sector's
  // `R + h` arc closes the loop from arm `ia`'s outer end to arm `ib`'s.
  const first = info[0];
  cmds.push({ kind: "move", to: first.outer });
  cmds.push({ kind: "line", to: first.inner });
  let cursor = first.inner;

  for (let k = 1; k < shortLen; k++) {
    const b = info[k];
    if (b.port === ports[ia]) {
      arcTo(cursor, b.inner);
      cmds.push({ kind: "line", to: b.outer });
      break;
    }
    // In-between arm. Both side-walls run along `b.into` (border end -> tile centre); the mouth
    // (`b.e.right` -> `b.e.left`) sits inside `C(O, rIn)`, so each wall crosses that circle once.
    // `outward` = away from the tile centre along the wall.
    const outward = mul(b.into, -1); // border end -> away from tile centre, along the wall
    const bm = mid(b.e.right, b.e.left); // arm mouth midpoint
    const cT = wallCrossesArc(b.e.right, b.into, bm); // trailing wall x inner arc, mouth-side crossing
    const cL = wallCrossesArc(b.e.left, b.into, bm); // leading wall x inner arc, mouth-side crossing
    // The historical default keeps a conservative gap around the inner arc. An explicit radius is
    // a user-facing visual setting, so do not reduce it to a tiny fraction of the corridor width
    // on large hex cells; only the available inner-arc space remains as a geometric cap. The
    // cornerFillet search still falls back through smaller radii when the requested one cannot fit.
    const r2 = requestedRadius === undefined
      ? Math.min(rf, rIn * 0.2, h * 0.35)
      : Math.min(rf, rIn * 0.45);
    if (!cT || !cL) {
      // There is no valid circle crossing to use as an arc endpoint. Keep the contour closed with
      // the actual wall endpoints instead of asking `arcTo` to project a non-circle point.
      cmds.push({ kind: "line", to: b.e.right });
      cmds.push({ kind: "line", to: b.e.left });
      cursor = b.e.left;
      continue;
    }
    // Trailing corner `cT`: big arc arrives, then contour turns OUT along the trailing wall
    // (`outward`). The arc's tangent away from the corner points back toward `cursor`.
    const fT = cornerFillet(cT, outward, r2, sub(cursor, cT), false, b.e.right);
    // A failed fillet has no usable circle endpoint. Do not consume its fallback `corner`: it is
    // only a search anchor and can be outside the cell. The mouth endpoint is the safe fallback.
    if (fT.cmd) {
      arcTo(cursor, fT.arcT);
      cmds.push(fT.cmd);
    }
    cmds.push({ kind: "line", to: b.e.right });
    cmds.push({ kind: "line", to: b.e.left });
    // Leading corner `cL`: contour arrives down the leading wall (travel dir `b.into`), then the big
    // arc resumes toward `first.outer`. Wall direction away from corner = `b.into`; arc tangent away
    // from corner points on toward the dead sector's outer end.
    const fL = cornerFillet(cL, mul(b.into, -1), r2, sub(info[shortLen - 1].outer, cL), true, b.e.left);
    if (fL.cmd) {
      cmds.push({ kind: "line", to: fL.wallT });
      cmds.push(fL.cmd);
      cursor = fL.arcT;
    } else {
      // `wallT`/`arcT` are the search-corner fallback when no fillet fits. Finish at the actual
      // outer endpoint so the following closing arc starts from the point it expects.
      const finalOuter = info[shortLen - 1].outer;
      cmds.push({ kind: "line", to: finalOuter });
      cursor = finalOuter;
    }
  }

  arcTo(info[shortLen - 1].outer, first.outer);

  const anchor = firstAnchor(cmds);
  if (anchor) cmds.push({ kind: "line", to: anchor });
  return cmds;
}

function junctionContour(ports: Port[], h: number, round: boolean, filletScale = 1, requestedRadius?: number): PathCmd[] {
  const n = ports.length;
  const cmds: PathCmd[] = [];
  const enableRounding = round && (requestedRadius === undefined || requestedRadius > 1e-6);

  // A requested radius of zero still needs the special one-dead-sector contour: its main inner
  // and outer arcs remain curved, while the small fillets where those arcs meet intermediate arm
  // walls collapse to sharp corners. Only the per-corner fillets are disabled by zero.
  if (round && (requestedRadius === undefined || requestedRadius >= 0)) {
    const bent = bendJunctionContour(ports, h, filletScale, requestedRadius);
    if (bent) return bent;
  }

  for (let i = 0; i < n; i++) {
    const p = ports[i];
    const next = ports[(i + 1) % n];
    const into = mul(p.out, -1); // border -> centre, this arm's axis
    const nextInto = mul(next.out, -1);
    const ends = portBorderEnds(p, h);
    const nextEnds = portBorderEnds(next, h);

    // This arm's CCW-trailing side-wall starts at `ends.left` and runs along `into`; the next arm's
    // CCW-leading side-wall starts at `nextEnds.right` and runs along `nextInto`.
    if (i === 0) cmds.push({ kind: "move", to: ends.right });
    else cmds.push({ kind: "line", to: ends.right });
    cmds.push({ kind: "line", to: ends.left });

    const t0 = leftN(p.out);
    const t1 = leftN(next.out);
    const O = lineIntersect(p.mid, t0, next.mid, t1);

    // CCW turn between the two arm axes. Reflex => the wide dead sector (convex gap). The outer
    // elbow faces that dead sector and remains rounded even when the requested junction fillet is
    // zero; `junctionRadius` controls the inward armpit corners, not this outer turn.
    let turn = angleOf(nextInto) - angleOf(into);
    while (turn <= 0) turn += Math.PI * 2;
    const convexGap = turn > Math.PI;

    if (!enableRounding && !convexGap) {
      // A zero junction radius makes the inward armpit a sharp mitre. Extend this arm's trailing
      // wall and the next arm's leading wall to their own intersection; fall back to a plain bridge
      // if they are parallel.
      const meet = lineIntersect(ends.left, into, nextEnds.right, nextInto);
      if (meet) cmds.push({ kind: "line", to: meet });
      cmds.push({ kind: "line", to: nextEnds.right });
      continue;
    }

    if (!O) {
      // Collinear arms — straight bridge, no arc.
      cmds.push({ kind: "line", to: nextEnds.right });
      continue;
    }

    const R = (len(sub(p.mid, O)) + len(sub(next.mid, O))) / 2;

    // Inner / outer end of each border relative to `O`.
    const pInner = len(sub(ends.left, O)) < len(sub(ends.right, O)) ? ends.left : ends.right;
    const pOuter = pInner === ends.left ? ends.right : ends.left;
    const nInner = len(sub(nextEnds.left, O)) < len(sub(nextEnds.right, O)) ? nextEnds.left : nextEnds.right;
    const nOuter = nInner === nextEnds.left ? nextEnds.right : nextEnds.left;

    if (convexGap) {
      // Wide dead sector between the two outermost arms: the *outer* elbow of the same turn-tile
      // construction -- one arc of radius `R + h` around `O` between the two outer border ends,
      // swept the same short way `turnContour` sweeps its outer arc (`shortSweepCcw(aOut_next,
      // aOut_this)`). Constant `thickness` corridor width around the bend, exactly like a
      // one-face-apart passage.
      cmds.push({ kind: "line", to: pOuter });
      cmds.push(smoothMouthCurve(pOuter, nOuter, O, mul(p.out, -1), next.out, Boolean(p.useCubicMouth || next.useCubicMouth)));
      cmds.push({ kind: "line", to: nextEnds.right });
      continue;
    }

    // Concave armpit. The turn-tile inner elbow `R - h` about `O` grows with the tessellation step,
    // so a thin corridor at a wide junction gets a huge shallow arc that balloons the fill.
    // Instead: run each arm's own side-wall *inward* from its
    // inner border end (`pInner` along `into`, `nInner` along `nextInto`) and round the corner
    // between the two extended walls with a tangent fillet of radius `min(R - h, ARMPIT_FILLET_K *
    // 2h)`. `W` = where the two walls meet; the fillet touches each wall `rFillet / tan(half)` back
    // from `W`, its centre on the in-pointing bisector at `rFillet / sin(half)`.
    const wallA = norm(into);
    const wallB = norm(nextInto);
    const W = lineIntersect(pInner, wallA, nInner, wallB);
    const rTurnIn = Math.max(0, R - h);
    const half = Math.acos(Math.max(-1, Math.min(1, dot(wallA, wallB)))) / 2;
    const sinHalf = Math.sin(half);
    const tanHalf = Math.tan(half);
    if (!W || sinHalf < 1e-4 || rTurnIn < 1e-4) {
      // Parallel walls / collinear — straight bridge across the inner ends.
      cmds.push({ kind: "line", to: pInner });
      cmds.push({ kind: "line", to: nInner });
      cmds.push({ kind: "line", to: nextEnds.right });
    } else {
      // How far `W` is from each inner border end, along that arm's wall.
      const sA = dot(sub(W, pInner), wallA);
      const sB = dot(sub(W, nInner), wallB);
      // Fillet radius: capped against the corridor width, and shrunk so its tangent points
      // (`rFillet / tan(half)` back from `W`) stay between the border ends and `W`.
      const reach = Math.max(0, Math.min(sA, sB));
      const defaultRadius = Math.min(rTurnIn, ARMPIT_FILLET_K * 2 * h, reach * tanHalf) * filletScale;
      const rFillet = requestedRadius === undefined
        ? defaultRadius
        : Math.min(rTurnIn, Math.max(0, requestedRadius), reach * tanHalf);
      if (rFillet < 1e-4) {
        // `W` is only the intersection of the two infinitely extended walls. When the requested
        // fillet has no room, that intersection can be outside the convex cell (the Cairo corner
        // case produces the visible spike). Never emit it as a contour point; bridge the two safe
        // mouth endpoints directly instead.
        cmds.push({ kind: "line", to: pInner });
        cmds.push({ kind: "line", to: nInner });
        cmds.push({ kind: "line", to: nextEnds.right });
        continue;
      }
      const back = rFillet / tanHalf; // W -> tangent point, along each wall
      const tanA = add(W, mul(wallA, -back));
      const tanB = add(W, mul(wallB, -back));
      const fc = add(W, mul(norm(add(mul(wallA, -1), mul(wallB, -1))), rFillet / sinHalf));
      const a0 = angleOf(sub(tanA, fc));
      const a1 = angleOf(sub(tanB, fc));
      cmds.push({ kind: "line", to: pInner });
      cmds.push({ kind: "line", to: tanA });
      cmds.push({ kind: "arc", c: fc, r: rFillet, a0, a1, ccw: shortSweepCcw(a0, a1) });
      cmds.push({ kind: "line", to: tanB });
      cmds.push({ kind: "line", to: nextEnds.right });
    }
  }

  const first = firstAnchor(cmds);
  if (first) cmds.push({ kind: "line", to: first });
  return cmds;
}

/** A turn tile: two ports meeting at an angle. Concentric inner/outer arcs of constant gap `2h`. */
function turnContour(p0: Port, p1: Port, h: number): PathCmd[] {
  // Corner point: intersection of the two border *lines* (through each midpoint, along its tangent).
  const t0 = leftN(p0.out);
  const t1 = leftN(p1.out);
  const corner = lineIntersect(p0.mid, t0, p1.mid, t1);
  const O = corner ?? mid(p0.mid, p1.mid);

  const e0 = portBorderEnds(p0, h);
  const e1 = portBorderEnds(p1, h);
  // Which endpoint of each port is the inner (closer to O) one.
  const p0Inner = len(sub(e0.left, O)) < len(sub(e0.right, O)) ? e0.left : e0.right;
  const p0Outer = p0Inner === e0.left ? e0.right : e0.left;
  const p1Inner = len(sub(e1.left, O)) < len(sub(e1.right, O)) ? e1.left : e1.right;
  const p1Outer = p1Inner === e1.left ? e1.right : e1.left;

  const offsetTurn = offsetTurnContour(p0, p1, h, p0Inner, p0Outer, p1Inner, p1Outer);
  if (offsetTurn) return offsetTurn;

  // Degenerate fallback for parallel or otherwise unsolved tangent geometry. The generic offset
  // construction above handles ordinary turns; retain the circular approximation only when its
  // centreline cannot be solved.
  return [
    { kind: "move", to: p0Outer },
    { kind: "line", to: p0Inner },
    smoothMouthCurve(p0Inner, p1Inner, O, mul(p0.out, -1), p1.out, Boolean(p0.useCubicMouth || p1.useCubicMouth)),
    { kind: "line", to: p1Outer },
    smoothMouthCurve(p1Outer, p0Outer, O, mul(p1.out, -1), p0.out, Boolean(p1.useCubicMouth || p0.useCubicMouth)),
    { kind: "line", to: p0Outer },
  ];
}

/**
 * Build a two-port turn as one width-preserving ribbon. The centreline is represented by two
 * joined quadratic segments with a common tangent at their joint. Each rail uses the same joint
 * and endpoint tangents, so the two sides cannot acquire unrelated cubic handle lengths.
 *
 * A true offset of a quadratic is rational rather than polynomial. Two ordinary quadratics are
 * the compact vector approximation used here: they preserve the exact mouth endpoints and all
 * endpoint tangents, while keeping the number of path commands constant for every tessellation.
 */
function offsetTurnContour(
  p0: Port,
  p1: Port,
  h: number,
  p0Inner: Pt,
  p0Outer: Pt,
  p1Inner: Pt,
  p1Outer: Pt,
): PathCmd[] | null {
  const start = p0.mid;
  const end = p1.mid;
  const startTangent = norm(mul(p0.out, -1));
  const endTangent = norm(p1.out);
  const halfChord = mul(sub(end, start), 0.5);
  const tangentAverage = mul(add(startTangent, endTangent), 0.5);
  const chordSquared = dot(halfChord, halfChord);
  if (chordSquared < 1e-9) return null;

  // Solve the equal-reach two-quadratic construction. If `reach` is the distance from each
  // endpoint to the centreline joint's control handles, the common joint tangent is
  //   jointTangent = halfChord / reach - tangentAverage.
  // Requiring |jointTangent| = 1 gives a quadratic equation in 1 / reach.
  const projection = dot(halfChord, tangentAverage);
  const discriminant = projection * projection - chordSquared * (dot(tangentAverage, tangentAverage) - 1);
  if (discriminant < -1e-8) return null;
  const inverseReach = (projection + Math.sqrt(Math.max(0, discriminant))) / chordSquared;
  if (inverseReach <= 1e-8) return null;
  const reach = 1 / inverseReach;
  const jointTangent = norm(sub(mul(halfChord, inverseReach), tangentAverage));
  const joint = add(start, mul(add(startTangent, jointTangent), reach));

  // The sign of a rail is measured from the left normal of the centreline tangent. For the inner
  // rail the sign must agree at both mouths; otherwise this is a reflex/degenerate orientation
  // for which the two-port offset is not a single ribbon.
  const startOffsetLeft = add(start, mul(leftN(startTangent), h));
  const endOffsetLeft = add(end, mul(leftN(endTangent), h));
  const startSign = len(sub(p0Inner, startOffsetLeft)) < 1e-6 ? 1 : -1;
  const endSign = len(sub(p1Inner, endOffsetLeft)) < 1e-6 ? 1 : -1;
  if (startSign !== endSign) return null;

  const offset = (point: Pt, tangent: Pt, sign: number): Pt => add(point, mul(leftN(tangent), h * sign));
  const innerJoint = offset(joint, jointTangent, startSign);
  const outerJoint = offset(joint, jointTangent, -startSign);

  const railQuadratic = (from: Pt, to: Pt, fromTangent: Pt, toTangent: Pt): PathCmd => ({
    kind: "quadratic",
    cp: quadraticControlPoint(from, to, fromTangent, toTangent, undefined, "start"),
    to,
  });

  return [
    { kind: "move", to: p0Outer },
    { kind: "line", to: p0Inner },
    railQuadratic(p0Inner, innerJoint, startTangent, jointTangent),
    railQuadratic(innerJoint, p1Inner, jointTangent, endTangent),
    { kind: "line", to: p1Outer },
    railQuadratic(p1Outer, outerJoint, mul(endTangent, -1), mul(jointTangent, -1)),
    railQuadratic(outerJoint, p0Outer, mul(jointTangent, -1), mul(startTangent, -1)),
    { kind: "line", to: p0Outer },
  ];
}

function legacyConvexSafeJunctionContour(ports: Port[], h: number, junctionRadius?: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    const nextPort = ports[(i + 1) % ports.length];
    const { left, right } = portBorderEnds(port, h);
    const next = portBorderEnds(nextPort, h);
    cmds.push({ kind: i === 0 ? "move" : "line", to: right });
    cmds.push({ kind: "line", to: left });
    const into = mul(port.out, -1);
    const nextInto = mul(nextPort.out, -1);
    let turn = angleOf(nextInto) - angleOf(into);
    while (turn <= 0) turn += Math.PI * 2;
    const convexGap = turn > Math.PI;

    const offsetBridge = offsetJunctionBridge(port, nextPort, h, left, next.right, junctionRadius, convexGap);

    if (!convexGap) {
      if (offsetBridge) {
        cmds.push(...offsetBridge);
      } else {
        cmds.push(...junctionCornerBridge(left, next.right, into, nextInto, h, junctionRadius));
      }
      continue;
    }

    // The wide dead-sector gap is the outside of the junction. It remains the same curved turn as
    // a two-port connection, even when the inner corner radius is zero; `junctionRadius` is
    // intentionally not used here. The previous inward-handle approximation could collapse to a
    // zero-length handle on a regular hex and leave a straight chord instead of the outer arc.
    const outerCorner = lineIntersect(
      port.mid,
      leftN(port.out),
      nextPort.mid,
      leftN(nextPort.out),
    );
    if (offsetBridge) {
      cmds.push(...offsetBridge);
    } else if (outerCorner) {
      cmds.push(smoothMouthCurve(left, next.right, outerCorner, into, nextPort.out, true));
    } else {
      cmds.push({ kind: "line", to: next.right });
    }
  }
  const first = cmds[0];
  if (first && (first.kind === "move" || first.kind === "line")) cmds.push({ kind: "line", to: first.to });
  return cmds;
}

type QuadraticRailSegment = { from: Pt; cp: Pt; to: Pt };
type QuadraticRail = { segments: QuadraticRailSegment[]; from: Pt; to: Pt };

/** Build a junction from the selected face-centre polygon. A centre-contained junction uses only
 * line/corner/line bridges. Otherwise one long two-port turn supplies both rails: the outer rail is
 * used for the extreme gap and the inner rail is cut at the intermediate port walls. */
function convexSafeJunctionContour(
  ports: Port[],
  h: number,
  junctionRadius?: number,
  boundary?: readonly Pt[],
): PathCmd[] {
  const centre = ports[0]?.centre;
  if (!centre || ports.length < 3) return legacyConvexSafeJunctionContour(ports, h, junctionRadius);

  // A face-centre polygon is not enough to classify an irregular junction.  On Cairo, for
  // example, the cell centre may be inside the active face triangle while one consecutive pair
  // still cannot be joined by two forward-facing mouth normals.  That pair is the real outside
  // gap: promote it to the outer rail and attach its neighbours to the matching inner rail.
  const curvedGaps = ports
    .map((_, index) => index)
    .filter((index) => requiresCurvedCornerBridge(ports[index], ports[(index + 1) % ports.length], h));
  const wideGap = findDistinctWideGap(ports);
  const largestGap = findLargestAngularGap(ports);
  const tiedThreeWayGap = ports.length === 3 && curvedGaps.length > 1 && curvedGaps.includes(largestGap)
    ? largestGap
    : null;
  const preferredOuterGap = curvedGaps.length === 1 ? curvedGaps[0] : wideGap ?? tiedThreeWayGap;
  if (preferredOuterGap !== null && preferredOuterGap !== undefined) {
    const candidateGaps = [preferredOuterGap, ...curvedGaps].filter((gap, index, all) => all.indexOf(gap) === index);
    for (const gap of candidateGaps) {
      const candidate = buildOuterJunctionContour(ports, h, junctionRadius, gap, boundary);
      if (candidate) return candidate;
    }
    return legacyConvexSafeJunctionContour(ports, h, junctionRadius);
  }

  const facePolygon = ports.map((port) => port.mid);
  if (pointInConvexPolygon(centre, facePolygon)) {
    return buildCentreJunctionContour(ports, h, junctionRadius);
  }
  return buildOuterJunctionContour(ports, h, junctionRadius, undefined, boundary)
    ?? legacyConvexSafeJunctionContour(ports, h, junctionRadius);
}

function buildCentreJunctionContour(ports: Port[], h: number, junctionRadius?: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    const nextPort = ports[(i + 1) % ports.length];
    const ends = portBorderEnds(port, h);
    const next = portBorderEnds(nextPort, h);
    cmds.push({ kind: i === 0 ? "move" : "line", to: ends.right });
    cmds.push({ kind: "line", to: ends.left });
    cmds.push(...straightCornerBridge(
      ends.left,
      next.right,
      mul(port.out, -1),
      mul(nextPort.out, -1),
      h,
      junctionRadius,
      true,
    ));
  }
  const first = cmds[0];
  if (first && (first.kind === "move" || first.kind === "line")) cmds.push({ kind: "line", to: first.to });
  return cmds;
}

function buildOuterJunctionContour(
  ports: Port[],
  h: number,
  junctionRadius?: number,
  selectedGapIndex?: number,
  boundary?: readonly Pt[],
): PathCmd[] | null {
  const outerGapIndex = selectedGapIndex ?? findLargestAngularGap(ports);

  const startIndex = (outerGapIndex + 1) % ports.length;
  const endIndex = outerGapIndex;
  if (startIndex === endIndex) return null;
  const start = ports[startIndex];
  const end = ports[endIndex];
  const startEnds = portBorderEnds(start, h);
  const endEnds = portBorderEnds(end, h);
  const rails = offsetTurnRails(start, end, h);
  if (!rails) return null;

  const inner = selectRail(rails, startEnds.left, endEnds.right);
  const outer = selectRail(rails, endEnds.left, startEnds.right);
  if (!inner || !outer) return null;

  const firstIntermediateIndex = (startIndex + 1) % ports.length;
  const lastIntermediateIndex = (endIndex - 1 + ports.length) % ports.length;
  const firstBaseCut = findRailCut(inner, ports[firstIntermediateIndex], h, "right");
  const lastBaseCut = findRailCut(inner, ports[lastIntermediateIndex], h, "left");
  const firstCut = firstBaseCut
    ? moveCutToCorner(inner, firstBaseCut, -1, (candidate) => junctionCornerBridge(
      candidate.point,
      portBorderEnds(ports[firstIntermediateIndex], h).right,
      candidate.tangent,
      mul(ports[firstIntermediateIndex].out, -1),
      h,
      junctionRadius,
    ), h, junctionRadius)
    : null;
  const lastCut = lastBaseCut
    ? moveCutToCorner(inner, lastBaseCut, 1, (candidate) => junctionCornerBridge(
      portBorderEnds(ports[lastIntermediateIndex], h).left,
      candidate.point,
      mul(ports[lastIntermediateIndex].out, -1),
      mul(candidate.tangent, -1),
      h,
      junctionRadius,
    ), h, junctionRadius)
    : null;
  if (!firstCut || !lastCut || firstCut.u >= lastCut.u) return null;

  // The branch should aim at the centreline of the shared ribbon, not at its inner boundary.
  // `selectRail` intentionally reverses the outer rail for contour traversal, so align it with
  // the inner rail before taking midpoints; otherwise the two rails are averaged from opposite
  // ends and the supposed target is not on the main curve at all.
  const centreOuter = samePoint(outer.from, inner.from) && samePoint(outer.to, inner.to)
    ? outer
    : reverseRail(outer);
  const centrelineAt = (u: number): Pt => mid(railLocation(inner, u).point, railLocation(centreOuter, u).point);
  const centrelineTangentAt = (u: number): Pt => norm(add(
    railLocation(inner, u).tangent,
    railLocation(centreOuter, u).tangent,
  ));
  const firstCentrelinePoint = centrelineAt(firstCut.u);
  const lastCentrelinePoint = centrelineAt(lastCut.u);
  const sharedBranchTarget = firstIntermediateIndex === lastIntermediateIndex
    ? centrelineAt((firstCut.u + lastCut.u) / 2)
    : undefined;
  const firstBranchTarget = sharedBranchTarget ?? firstCentrelinePoint;
  const lastBranchTarget = sharedBranchTarget ?? lastCentrelinePoint;
  const sharedBranch = firstIntermediateIndex === lastIntermediateIndex && sharedBranchTarget
    ? buildCentrelineBranchBoundaries(
      ports[firstIntermediateIndex],
      firstCut.point,
      lastCut.point,
      sharedBranchTarget,
      centrelineTangentAt((firstCut.u + lastCut.u) / 2),
      h,
      boundary,
    )
    : null;
  const sharpRadius = junctionRadius !== undefined && junctionRadius <= 1e-6;
  const cmds: PathCmd[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    const nextPort = ports[(i + 1) % ports.length];
    const ends = portBorderEnds(port, h);
    const next = portBorderEnds(nextPort, h);
    cmds.push({ kind: i === 0 ? "move" : "line", to: ends.right });
    cmds.push({ kind: "line", to: ends.left });

    if (i === outerGapIndex) {
      cmds.push(...railCommands(outer));
      continue;
    }

    const stepFromStart = (i - startIndex + ports.length) % ports.length;
    if (stepFromStart === 0) {
      cmds.push(...railSlice(inner, 0, firstCut.u));
      if (sharedBranch && sharpRadius) {
        cmds.push(sharedBranch.right);
      } else {
        cmds.push(...railJoinBridge(
          firstCut.point,
          next.right,
          firstCut.tangent,
          mul(nextPort.out, -1),
          h,
          junctionRadius,
          boundary,
          firstBranchTarget,
        ));
      }
      continue;
    }

    if (stepFromStart === ports.length - 2) {
      if (sharedBranch && sharpRadius) {
        cmds.push(sharedBranch.left);
      } else {
        cmds.push(...railJoinBridge(
          ends.left,
          lastCut.point,
          mul(port.out, -1),
          mul(lastCut.tangent, -1),
          h,
          junctionRadius,
          boundary,
          lastBranchTarget,
        ));
      }
      cmds.push(...railSlice(inner, lastCut.u, 1));
      continue;
    }

    cmds.push(...straightCornerBridge(
      ends.left,
      next.right,
      mul(port.out, -1),
      mul(nextPort.out, -1),
      h,
      junctionRadius,
    ));
  }

  const first = cmds[0];
  if (first && (first.kind === "move" || first.kind === "line")) cmds.push({ kind: "line", to: first.to });
  return cmds;
}

/** Build both sides of a three-way branch from one centreline. The contour is still trimmed at
 * the inner rail, but the paired boundary controls are offsets of the same centreline control;
 * this keeps the branch width coherent while its centre aims into the main ribbon. */
function buildCentrelineBranchBoundaries(
  port: Port,
  rightCut: Pt,
  leftCut: Pt,
  target: Pt,
  targetTangent: Pt,
  h: number,
  boundary?: readonly Pt[],
): { right: PathCmd; left: PathCmd } {
  const ends = portBorderEnds(port, h);
  const startTangent = norm(mul(port.out, -1));
  const targetControlDirection = norm(mul(targetTangent, -1));
  const centrelineLength = len(sub(target, port.mid));
  // The branch must visibly turn toward the main centreline; a handle limited to one corridor
  // width is almost collinear on Cairo and renders as a straight chord. Keep the paired controls
  // bounded together, but give the centreline enough reach to follow the main turn.
  const handle = Math.min(centrelineLength * 0.5, h * 2.5);
  const centreControl = mid(
    add(port.mid, mul(startTangent, handle)),
    add(target, mul(targetControlDirection, handle)),
  );
  const rightOffset = mid(sub(ends.right, port.mid), sub(rightCut, target));
  const leftOffset = mid(sub(ends.left, port.mid), sub(leftCut, target));
  const rightControl = clampControlInside(add(centreControl, rightOffset), mid(rightCut, ends.right), boundary);
  const leftControl = clampControlInside(add(centreControl, leftOffset), mid(ends.left, leftCut), boundary);
  return {
    right: { kind: "quadratic", cp: rightControl, to: ends.right },
    left: { kind: "quadratic", cp: leftControl, to: leftCut },
  };
}

function clampControlInside(control: Pt, anchor: Pt, boundary?: readonly Pt[]): Pt {
  if (!boundary || pointInConvexPolygon(control, boundary)) return control;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const amount = (low + high) / 2;
    const candidate = add(anchor, mul(sub(control, anchor), amount));
    if (pointInConvexPolygon(candidate, boundary)) low = amount;
    else high = amount;
  }
  return add(anchor, mul(sub(control, anchor), low));
}

/** Join an intermediate port to the shared inner rail. The central connector may stay sharp at
 * radius zero, but both approaches still follow a smooth tangent toward the shared rail. */
function railJoinBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  h: number,
  requestedRadius?: number,
  boundary?: readonly Pt[],
  attractionCenter?: Pt,
): PathCmd[] {
  if (requestedRadius !== undefined && requestedRadius <= 1e-6) {
    // Radius zero disables the corner fillet, but the branch still has to flow into the shared
    // rail. One bounded quadratic is deliberately used here: unlike the cubic fallback it cannot
    // turn its two handles across each other and create a loop on irregular cells.
    return [boundedRailJoinBridge(from, to, fromDirection, toDirection, h, boundary, attractionCenter)];
  }
  return junctionCornerBridge(from, to, fromDirection, toDirection, h, requestedRadius, true);
}

function boundedRailJoinBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  h: number,
  boundary?: readonly Pt[],
  attractionCenter?: Pt,
): PathCmd {
  const chord = sub(to, from);
  const chordLength = len(chord);
  if (chordLength <= 1e-6) return { kind: "line", to };

  // Do not use the exact intersection of the endpoint tangents here. On an irregular cell that
  // intersection can be very far away; the resulting quadratic folds back before reaching the
  // rail. A short, shared handle keeps the bend directed from the port toward the rail.
  const handle = Math.min(chordLength / 3, h * 0.75);
  const startHandle = add(from, mul(norm(fromDirection), handle));
  const endHandle = add(to, mul(norm(toDirection), handle));
  const midpoint = mid(from, to);
  let control = mid(startHandle, endHandle);

  if (attractionCenter) {
    const towardCenter = sub(attractionCenter, control);
    const attraction = Math.min(h, chordLength * 0.2);
    if (len(towardCenter) > 1e-6) control = add(control, mul(norm(towardCenter), attraction));
  }

  if (boundary && !pointInConvexPolygon(control, boundary)) {
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 24; iteration++) {
      const amount = (low + high) / 2;
      const candidate = add(midpoint, mul(sub(control, midpoint), amount));
      if (pointInConvexPolygon(candidate, boundary)) low = amount;
      else high = amount;
    }
    control = add(midpoint, mul(sub(control, midpoint), low));
  }
  return { kind: "quadratic", cp: control, to };
}

function findLargestAngularGap(ports: Port[]): number {
  let largestGapIndex = 0;
  let largestGap = -1;
  for (let i = 0; i < ports.length; i++) {
    const current = angleOf(sub(ports[i].mid, ports[i].centre));
    const next = angleOf(sub(ports[(i + 1) % ports.length].mid, ports[i].centre));
    let gap = next - current;
    while (gap <= 0) gap += Math.PI * 2;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = i;
    }
  }
  return largestGapIndex;
}

/** Select a single, clearly wider dead sector even when all normal rays happen to intersect. This
 * catches irregular-cell turns such as Cairo 1-3-4, where the centre lies inside the face polygon
 * but the two extreme ports still need one shared outer rail. */
function findDistinctWideGap(ports: Port[]): number | null {
  const gaps = ports.map((port, index) => {
    const current = angleOf(sub(port.mid, port.centre));
    const next = angleOf(sub(ports[(index + 1) % ports.length].mid, port.centre));
    let gap = next - current;
    while (gap <= 0) gap += Math.PI * 2;
    return { index, gap };
  }).sort((a, b) => b.gap - a.gap);
  const largest = gaps[0];
  const second = gaps[1];
  if (!largest || !second) return null;
  return largest.gap >= Math.PI * 0.8 && largest.gap >= second.gap * 1.08
    ? largest.index
    : null;
}

function offsetTurnRails(p0: Port, p1: Port, h: number): [QuadraticRail, QuadraticRail] | null {
  const corner = lineIntersect(p0.mid, leftN(p0.out), p1.mid, leftN(p1.out));
  if (!corner) return null;
  const e0 = portBorderEnds(p0, h);
  const e1 = portBorderEnds(p1, h);
  const p0Inner = len(sub(e0.left, corner)) < len(sub(e0.right, corner)) ? e0.left : e0.right;
  const p0Outer = p0Inner === e0.left ? e0.right : e0.left;
  const p1Inner = len(sub(e1.left, corner)) < len(sub(e1.right, corner)) ? e1.left : e1.right;
  const p1Outer = p1Inner === e1.left ? e1.right : e1.left;
  const full = offsetTurnContour(p0, p1, h, p0Inner, p0Outer, p1Inner, p1Outer);
  if (!full) return null;
  const innerFirst = full[2];
  const innerSecond = full[3];
  const outerFirst = full[5];
  const outerSecond = full[6];
  if (innerFirst.kind !== "quadratic" || innerSecond.kind !== "quadratic" || outerFirst.kind !== "quadratic" || outerSecond.kind !== "quadratic") return null;
  return [
    {
      from: p0Inner,
      to: p1Inner,
      segments: [
        { from: p0Inner, cp: innerFirst.cp, to: innerFirst.to },
        { from: innerFirst.to, cp: innerSecond.cp, to: p1Inner },
      ],
    },
    {
      from: p0Outer,
      to: p1Outer,
      segments: [
        { from: p0Outer, cp: outerSecond.cp, to: outerFirst.to },
        { from: outerFirst.to, cp: outerFirst.cp, to: p1Outer },
      ],
    },
  ];
}

/** Whether the ordinary line/corner/line bridge has a valid forward corner. */
function requiresCurvedCornerBridge(port: Port, nextPort: Port, h: number): boolean {
  const from = portBorderEnds(port, h).left;
  const to = portBorderEnds(nextPort, h).right;
  const fromDirection = mul(port.out, -1);
  const toDirection = mul(nextPort.out, -1);
  const corner = lineIntersect(from, fromDirection, to, toDirection);
  if (!corner) return true;

  const fromReach = dot(sub(corner, from), fromDirection);
  const toReach = dot(sub(corner, to), toDirection);
  if (fromReach <= 1e-6 || toReach <= 1e-6) return true;

  const rayFromCorner = norm(sub(from, corner));
  const rayToCorner = norm(sub(to, corner));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(rayFromCorner, rayToCorner)))) / 2;
  return Math.sin(halfAngle) <= 1e-6 || Math.tan(halfAngle) <= 1e-6;
}

function reverseRail(rail: QuadraticRail): QuadraticRail {
  return {
    from: rail.to,
    to: rail.from,
    segments: [...rail.segments].reverse().map((segment) => ({
      from: segment.to,
      cp: segment.cp,
      to: segment.from,
    })),
  };
}

function samePoint(a: Pt, b: Pt): boolean {
  return len(sub(a, b)) <= 1e-5;
}

function selectRail(rails: [QuadraticRail, QuadraticRail], from: Pt, to: Pt): QuadraticRail | null {
  for (const rail of rails) {
    if (samePoint(rail.from, from) && samePoint(rail.to, to)) return rail;
    const reversed = reverseRail(rail);
    if (samePoint(reversed.from, from) && samePoint(reversed.to, to)) return reversed;
  }
  return null;
}

function railCommands(rail: QuadraticRail): PathCmd[] {
  return rail.segments.map((segment) => ({ kind: "quadratic", cp: segment.cp, to: segment.to }));
}

function quadraticAt(segment: QuadraticRailSegment, t: number): Pt {
  const u = 1 - t;
  return add(add(mul(segment.from, u * u), mul(segment.cp, 2 * u * t)), mul(segment.to, t * t));
}

function quadraticTangent(segment: QuadraticRailSegment, t: number): Pt {
  return norm(add(mul(sub(segment.cp, segment.from), 2 * (1 - t)), mul(sub(segment.to, segment.cp), 2 * t)));
}

function findRailCut(
  rail: QuadraticRail,
  port: Port,
  h: number,
  endpoint: "left" | "right",
): { u: number; point: Pt; tangent: Pt } | null {
  const ends = portBorderEnds(port, h);
  const candidates: { u: number; point: Pt; tangent: Pt; distance: number }[] = [];
  for (const [segmentIndex, segment] of rail.segments.entries()) {
    for (const origin of [endpoint === "left" ? ends.left : ends.right]) {
      const direction = mul(port.out, -1);
      let previous = segment.from;
      const steps = 24;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const current = quadraticAt(segment, t);
        const hit = lineIntersect(previous, sub(current, previous), origin, direction);
        if (hit) {
          const along = dot(sub(hit, previous), sub(current, previous));
          const segmentLengthSquared = dot(sub(current, previous), sub(current, previous));
          const rayDistance = dot(sub(hit, origin), direction);
          if (along >= -1e-5 && along <= segmentLengthSquared + 1e-5 && rayDistance >= -1e-5) {
            const local = (step - 1 + Math.max(0, Math.min(1, along / Math.max(segmentLengthSquared, 1e-9)))) / steps;
            const u = (segmentIndex + local) / rail.segments.length;
            candidates.push({ u, point: hit, tangent: quadraticTangent(segment, local), distance: len(sub(hit, port.mid)) });
          }
        }
        previous = current;
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const result = candidates[0];
  if (result) return { u: result.u, point: result.point, tangent: result.tangent };

  // On an irregular cell the side-wall ray can miss the inner rail entirely. Keep the outer-rail
  // construction coherent by using the closest forward rail point instead of abandoning the
  // whole two-rail contour and falling back to independent pairwise bridges.
  const origin = endpoint === "left" ? ends.left : ends.right;
  const direction = norm(mul(port.out, -1));
  let nearest: { u: number; point: Pt; tangent: Pt; distance: number } | null = null;
  for (const [segmentIndex, segment] of rail.segments.entries()) {
    for (let step = 0; step <= 48; step++) {
      const local = step / 48;
      const point = quadraticAt(segment, local);
      if (dot(sub(point, origin), direction) < -1e-6) continue;
      const distance = Math.abs(cross(sub(point, origin), direction));
      const candidate = {
        u: (segmentIndex + local) / rail.segments.length,
        point,
        tangent: quadraticTangent(segment, local),
        distance,
      };
      if (!nearest || candidate.distance < nearest.distance) nearest = candidate;
    }
  }
  return nearest ? { u: nearest.u, point: nearest.point, tangent: nearest.tangent } : null;
}

function moveCutToCorner(
  rail: QuadraticRail,
  base: { u: number; point: Pt; tangent: Pt },
  direction: -1 | 1,
  canConnect: (candidate: { u: number; point: Pt; tangent: Pt }) => PathCmd[],
  h: number,
  requestedRadius?: number,
): { u: number; point: Pt; tangent: Pt } {
  const radius = requestedRadius === undefined ? h * 0.75 : requestedRadius;
  if (radius <= 1e-6) return base;
  const baseArc = canConnect(base).find((command): command is Extract<PathCmd, { kind: "arc" }> => command.kind === "arc");
  if (baseArc && baseArc.r >= radius - 1e-6) return base;
  let best: { cut: { u: number; point: Pt; tangent: Pt }; radius: number } | null = null;
  for (const delta of [0.02, 0.04, 0.07, 0.11, 0.16, 0.22, 0.3, 0.4]) {
    const u = Math.max(0.01, Math.min(0.99, base.u + direction * delta));
    const candidate = railLocation(rail, u);
    const arc = canConnect(candidate).find((command): command is Extract<PathCmd, { kind: "arc" }> => command.kind === "arc");
    if (arc && (!best || arc.r > best.radius)) best = { cut: candidate, radius: arc.r };
  }
  return best?.cut ?? base;
}

function railSlice(rail: QuadraticRail, fromU: number, toU: number): PathCmd[] {
  if (toU <= fromU + 1e-6) return [];
  const start = Math.max(0, Math.min(1, fromU)) * rail.segments.length;
  const end = Math.max(0, Math.min(1, toU)) * rail.segments.length;
  const result: PathCmd[] = [];
  for (let index = 0; index < rail.segments.length; index++) {
    const localStart = Math.max(0, start - index);
    const localEnd = Math.min(1, end - index);
    if (localEnd <= localStart + 1e-6) continue;
    const segment = trimQuadratic(rail.segments[index], localStart, localEnd);
    result.push({ kind: "quadratic", cp: segment.cp, to: segment.to });
  }
  return result;
}

function railLocation(rail: QuadraticRail, u: number): { u: number; point: Pt; tangent: Pt } {
  const scaled = Math.max(0, Math.min(1, u)) * rail.segments.length;
  const index = Math.min(rail.segments.length - 1, Math.floor(scaled));
  const local = Math.min(1, Math.max(0, scaled - index));
  const segment = rail.segments[index];
  return { u, point: quadraticAt(segment, local), tangent: quadraticTangent(segment, local) };
}

function trimQuadratic(segment: QuadraticRailSegment, fromT: number, toT: number): QuadraticRailSegment {
  const firstSplit = splitQuadratic(segment.from, segment.cp, segment.to, toT).left;
  if (fromT <= 1e-6) return firstSplit;
  const relative = fromT / Math.max(toT, 1e-9);
  return splitQuadratic(firstSplit.from, firstSplit.cp, firstSplit.to, relative).right;
}

/** Build one junction bridge from three components: a curved approach, a central connector, and a
 * curved exit. The requested radius belongs to the central connector; the approach curves keep the
 * port-side tangents and are not replaced by a single cubic bridge. */
function offsetJunctionBridge(
  p0: Port,
  p1: Port,
  h: number,
  from: Pt,
  to: Pt,
  requestedRadius: number | undefined,
  convexGap: boolean,
): PathCmd[] | null {
  if (requestedRadius === undefined) {
    return naturalOffsetJunctionBridge(p0, p1, h, from, to);
  }

  const startTangent = norm(mul(p0.out, -1));
  const endTangent = norm(mul(p1.out, -1));
  const corner = lineIntersect(p0.mid, startTangent, p1.mid, endTangent);
  if (!corner) return null;

  const reach0 = dot(sub(corner, p0.mid), startTangent);
  const reach1 = dot(sub(corner, p1.mid), endTangent);
  if (reach0 <= 1e-6 || reach1 <= 1e-6) return null;

  const ray0 = norm(sub(p0.mid, corner));
  const ray1 = norm(sub(p1.mid, corner));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(ray0, ray1)))) / 2;
  const sinHalf = Math.sin(halfAngle);
  const tanHalf = Math.tan(halfAngle);
  if (sinHalf <= 1e-6 || tanHalf <= 1e-6) return null;

  const maximumCentrelineRadius = Math.min(reach0, reach1) * tanHalf;
  const requestedCentrelineRadius = convexGap || requestedRadius === undefined
    ? maximumCentrelineRadius
    : Math.max(0, requestedRadius) + h;
  const centrelineRadius = Math.min(maximumCentrelineRadius, requestedCentrelineRadius);
  if (centrelineRadius <= 1e-6) return null;

  const tangentDistance = centrelineRadius / tanHalf;
  const centrelineT0 = add(corner, mul(ray0, tangentDistance));
  const centrelineT1 = add(corner, mul(ray1, tangentDistance));
  const centre = add(corner, mul(norm(add(ray0, ray1)), centrelineRadius / sinHalf));
  const startNormal = leftN(startTangent);
  const endNormal = leftN(endTangent);
  const startOffsetLeft = add(p0.mid, mul(startNormal, h));
  const endOffsetLeft = add(p1.mid, mul(endNormal, h));
  const startSign = len(sub(from, startOffsetLeft)) <= 1e-5 ? 1 : -1;
  const endSign = len(sub(to, endOffsetLeft)) <= 1e-5 ? 1 : -1;
  if (startSign !== endSign) return null;

  const railT0 = add(centrelineT0, mul(startNormal, startSign * h));
  const railT1 = add(centrelineT1, mul(endNormal, endSign * h));
  const zeroInnerRadius = !convexGap && requestedRadius !== undefined && requestedRadius <= 1e-6;
  const railRadius = zeroInnerRadius
    ? 0
    : (len(sub(railT0, centre)) + len(sub(railT1, centre))) / 2;
  const joint0 = zeroInnerRadius ? centre : railT0;
  const joint1 = zeroInnerRadius ? centre : railT1;

  if (railRadius <= 1e-6) {
    return [
      quadraticBridgeSegment(from, joint0, startTangent, startTangent),
      { kind: "line", to: joint1 },
      quadraticBridgeSegment(joint1, to, p1.out, p1.out),
    ];
  }

  const a0 = angleOf(sub(railT0, centre));
  const a1 = angleOf(sub(railT1, centre));
  const ccw = shortSweepCcw(a0, a1);
  const arcTangent = (angle: number): Pt => ccw
    ? { x: Math.sin(angle), y: -Math.cos(angle) }
    : { x: -Math.sin(angle), y: Math.cos(angle) };
  return [
    quadraticBridgeSegment(from, railT0, startTangent, arcTangent(a0)),
    { kind: "arc", c: centre, r: railRadius, a0, a1, ccw },
    quadraticBridgeSegment(railT1, to, arcTangent(a1), p1.out),
  ];
}

/** Natural geometry: retain the width-preserving two-rail construction, but expose it as the same
 * three-part bridge used by explicit-radius junctions. The middle quadratic is the connecting part
 * around the old shared joint; it is no longer hidden in a two-command slice. */
function naturalOffsetJunctionBridge(
  p0: Port,
  p1: Port,
  h: number,
  from: Pt,
  to: Pt,
): PathCmd[] | null {
  const corner = lineIntersect(p0.mid, leftN(p0.out), p1.mid, leftN(p1.out));
  if (!corner) return null;

  const e0 = portBorderEnds(p0, h);
  const e1 = portBorderEnds(p1, h);
  const p0Inner = len(sub(e0.left, corner)) < len(sub(e0.right, corner)) ? e0.left : e0.right;
  const p0Outer = p0Inner === e0.left ? e0.right : e0.left;
  const p1Inner = len(sub(e1.left, corner)) < len(sub(e1.right, corner)) ? e1.left : e1.right;
  const p1Outer = p1Inner === e1.left ? e1.right : e1.left;
  const full = offsetTurnContour(p0, p1, h, p0Inner, p0Outer, p1Inner, p1Outer);
  if (!full) return null;

  const samePoint = (a: Pt, b: Pt): boolean => len(sub(a, b)) <= 1e-5;
  if (samePoint(from, p0Inner) && samePoint(to, p1Inner)) {
    const first = full[2];
    const second = full[3];
    if (first.kind !== "quadratic" || second.kind !== "quadratic") return null;
    return threePartQuadraticBridge(from, first, second, to);
  }
  if (samePoint(from, p0Outer) && samePoint(to, p1Outer)) {
    const outerFirst = full[5];
    const outerSecond = full[6];
    if (outerFirst.kind !== "quadratic" || outerSecond.kind !== "quadratic") return null;
    return threePartQuadraticBridge(
      from,
      { kind: "quadratic", cp: outerSecond.cp, to: outerFirst.to },
      { kind: "quadratic", cp: outerFirst.cp, to: p1Outer },
      to,
    );
  }
  return null;
}

function quadraticBridgeSegment(
  from: Pt,
  to: Pt,
  fromTangent: Pt,
  toTangent: Pt,
  boundary?: readonly Pt[],
): PathCmd {
  return {
    kind: "quadratic",
    cp: quadraticControlPoint(from, to, fromTangent, toTangent, boundary, "start"),
    to,
  };
}

function splitQuadratic(from: Pt, cp: Pt, to: Pt, t: number): {
  left: { from: Pt; cp: Pt; to: Pt };
  right: { from: Pt; cp: Pt; to: Pt };
} {
  const lerp = (a: Pt, b: Pt, amount: number): Pt => add(a, mul(sub(b, a), amount));
  const first = lerp(from, cp, t);
  const second = lerp(cp, to, t);
  const joint = lerp(first, second, t);
  return {
    left: { from, cp: first, to: joint },
    right: { from: joint, cp: second, to },
  };
}

function threePartQuadraticBridge(
  from: Pt,
  first: Extract<PathCmd, { kind: "quadratic" }>,
  second: Extract<PathCmd, { kind: "quadratic" }>,
  to: Pt,
): PathCmd[] {
  const firstHalf = splitQuadratic(from, first.cp, first.to, 0.5);
  const secondHalf = splitQuadratic(first.to, second.cp, to, 0.5);
  const centralFrom = firstHalf.right.from;
  const centralTo = secondHalf.left.to;
  const central = quadraticBridgeSegment(
    centralFrom,
    centralTo,
    sub(firstHalf.right.cp, centralFrom),
    sub(centralTo, secondHalf.left.cp),
  );
  return [
    { kind: "quadratic", cp: firstHalf.left.cp, to: firstHalf.left.to },
    central,
    { kind: "quadratic", cp: secondHalf.right.cp, to: secondHalf.right.to },
  ];
}

function straightCornerBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  h: number,
  requestedRadius?: number,
  allowCurvedFallback = false,
): PathCmd[] {
  const corner = lineIntersect(from, fromDirection, to, toDirection);
  if (!corner) return allowCurvedFallback
    ? curvedCornerBridge(from, to, fromDirection, toDirection)
    : [{ kind: "line", to }];
  const fromReach = dot(sub(corner, from), fromDirection);
  const toReach = dot(sub(corner, to), toDirection);
  if (fromReach <= 1e-6 || toReach <= 1e-6) {
    // The two mouth normals are the required tangents at the cell faces, but on an irregular
    // cell their forward rays do not always meet inside the tile.  Do not collapse that case to a
    // chord: the chord loses both face normals and makes a Cairo centre junction look like an
    // outer straight bridge.  Keep the normal tangents and let a cubic turn them toward each other.
    return allowCurvedFallback
      ? curvedCornerBridge(from, to, fromDirection, toDirection)
      : [{ kind: "line", to }];
  }

  const rayFromCorner = norm(sub(from, corner));
  const rayToCorner = norm(sub(to, corner));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(rayFromCorner, rayToCorner)))) / 2;
  const sinHalf = Math.sin(halfAngle);
  const tanHalf = Math.tan(halfAngle);
  if (sinHalf <= 1e-6 || tanHalf <= 1e-6) return allowCurvedFallback
    ? curvedCornerBridge(from, to, fromDirection, toDirection)
    : [{ kind: "line", to }];

  const maximumRadius = Math.min(fromReach, toReach) * tanHalf;
  const radius = Math.min(
    maximumRadius,
    requestedRadius === undefined ? Math.min(maximumRadius, h * 0.75) : Math.max(0, requestedRadius),
  );
  if (radius <= 1e-6) return [{ kind: "line", to: corner }, { kind: "line", to }];

  const tangentDistance = radius / tanHalf;
  const fromTangent = add(corner, mul(rayFromCorner, tangentDistance));
  const toTangent = add(corner, mul(rayToCorner, tangentDistance));
  const center = add(corner, mul(norm(add(rayFromCorner, rayToCorner)), radius / sinHalf));
  const a0 = angleOf(sub(fromTangent, center));
  const a1 = angleOf(sub(toTangent, center));
  return [
    { kind: "line", to: fromTangent },
    { kind: "arc", c: center, r: radius, a0, a1, ccw: shortSweepCcw(a0, a1) },
    { kind: "line", to },
  ];
}

/** Bridge two mouth corners when their inward normal rays have no forward intersection. The cubic
 * keeps the exact face-normal tangent at both mouths and bends through the interior instead of
 * replacing the whole connection with a chord. A cubic is used only for this geometrically
 * impossible line/fillet case; ordinary pairs retain the straight/arc/straight construction. */
function curvedCornerBridge(from: Pt, to: Pt, fromDirection: Pt, toDirection: Pt): PathCmd[] {
  const chord = sub(to, from);
  const chordLength = len(chord);
  if (chordLength <= 1e-6) return [{ kind: "line", to }];
  const handle = chordLength / 3;
  return [{
    kind: "bezier",
    cp1: add(from, mul(norm(fromDirection), handle)),
    cp2: add(to, mul(norm(toDirection), handle)),
    to,
  }];
}

/** Connect two consecutive mouth corners through three components: a curved approach, a central
 * fillet (or zero-length sharp connector), and a curved exit. The fallback uses the same structure
 * as the offset bridge when the full rail construction cannot solve its orientation. */
function junctionCornerBridge(
  from: Pt,
  to: Pt,
  fromDirection: Pt,
  toDirection: Pt,
  h: number,
  requestedRadius?: number,
  allowCurvedFallback = false,
): PathCmd[] {
  const curvedFallback = (): PathCmd[] => curvedCornerBridge(from, to, fromDirection, toDirection);
  const corner = lineIntersect(from, fromDirection, to, toDirection);
  if (!corner) return allowCurvedFallback
    ? curvedFallback()
    : [{ kind: "line", to }];

  const fromReach = dot(sub(corner, from), fromDirection);
  const toReach = dot(sub(corner, to), toDirection);
  if (fromReach <= 1e-6 || toReach <= 1e-6) return allowCurvedFallback
    ? curvedFallback()
    : [{ kind: "line", to }];

  const rayFromCorner = norm(sub(from, corner));
  const rayToCorner = norm(sub(to, corner));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot(rayFromCorner, rayToCorner)))) / 2;
  const sinHalf = Math.sin(halfAngle);
  const tanHalf = Math.tan(halfAngle);
  if (sinHalf <= 1e-6 || tanHalf <= 1e-6) return allowCurvedFallback
    ? curvedFallback()
    : [{ kind: "line", to }];

  const maximumRadius = Math.min(fromReach, toReach) * tanHalf;
  const defaultRadius = Math.min(maximumRadius, h * 0.75);
  const radius = Math.min(
    maximumRadius,
    requestedRadius === undefined ? defaultRadius : Math.max(0, requestedRadius),
  );
  if (radius <= 1e-6) {
    return [
      quadraticBridgeSegment(from, corner, fromDirection, fromDirection),
      { kind: "line", to: corner },
      quadraticBridgeSegment(corner, to, mul(toDirection, -1), mul(toDirection, -1)),
    ];
  }

  const tangentDistance = radius / tanHalf;
  const fromTangent = add(corner, mul(rayFromCorner, tangentDistance));
  const toTangent = add(corner, mul(rayToCorner, tangentDistance));
  const center = add(corner, mul(norm(add(rayFromCorner, rayToCorner)), radius / sinHalf));
  const a0 = angleOf(sub(fromTangent, center));
  const a1 = angleOf(sub(toTangent, center));
  const ccw = shortSweepCcw(a0, a1);
  const arcTangent = (angle: number): Pt => ccw
    ? { x: Math.sin(angle), y: -Math.cos(angle) }
    : { x: -Math.sin(angle), y: Math.cos(angle) };

  return [
    quadraticBridgeSegment(from, fromTangent, fromDirection, arcTangent(a0)),
    { kind: "arc", c: center, r: radius, a0, a1, ccw },
    quadraticBridgeSegment(toTangent, to, arcTangent(a1), mul(toDirection, -1)),
  ];
}

/** Uses the old circular arc when both mouth endpoints have the same radius. When Cairo joins
 *  faces of different lengths, one circle cannot both pass through the exact mouth endpoints and
 *  have the correct perpendicular tangent at both ends. A cubic then preserves both invariants:
 *  exact endpoints and opposite continuation directions across the shared face. */
function smoothMouthCurve(from: Pt, to: Pt, preferredCenter: Pt, fromTangent: Pt, toTangent: Pt, useCubic: boolean): PathCmd {
  const fromRadius = len(sub(from, preferredCenter));
  const toRadius = len(sub(to, preferredCenter));
  if (!useCubic || Math.abs(fromRadius - toRadius) <= 1e-7) return arcThroughPoints(from, to, preferredCenter);

  const chordLength = len(sub(to, from));
  const handle = Math.max(1, chordLength / 3);
  const start = norm(fromTangent);
  const end = norm(toTangent);
  return {
    kind: "bezier",
    cp1: add(from, mul(start, handle)),
    cp2: sub(to, mul(end, handle)),
    to,
  };
}

/** Builds the short circular arc through both explicit endpoints. A Cairo turn may join a short
 *  and a long face, so their mouth endpoints are not always at the same radius from the nominal
 *  face-line corner. Using that nominal radius would move one arc endpoint away from the face.
 *  Keep the nominal centre when possible; otherwise project it onto the endpoints' perpendicular
 *  bisector, producing the nearest circle that passes through both exact mouth points. */
function arcThroughPoints(from: Pt, to: Pt, preferredCenter: Pt): PathCmd {
  const chord = sub(to, from);
  const chordLength = len(chord);
  if (chordLength < 1e-9) return { kind: "line", to };

  const fromRadius = len(sub(from, preferredCenter));
  const toRadius = len(sub(to, preferredCenter));
  let center = preferredCenter;
  if (Math.abs(fromRadius - toRadius) > 1e-7) {
    const midpoint = mid(from, to);
    const bisector = leftN(mul(chord, 1 / chordLength));
    center = add(midpoint, mul(bisector, dot(sub(preferredCenter, midpoint), bisector)));
  }

  const a0 = angleOf(sub(from, center));
  const a1 = angleOf(sub(to, center));
  return { kind: "arc", c: center, r: len(sub(from, center)), a0, a1, ccw: shortSweepCcw(a0, a1) };
}

/** The `ccw` flag (pixi / canvas `arc` convention: `true` sweeps toward *decreasing* angle) that
 *  makes the arc from `a` to `b` take the short way round. */
function shortSweepCcw(a: number, b: number): boolean {
  let d = b - a;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  // d > 0 -> short way is increasing angle -> counterclockwise=false.
  return d < 0;
}

/** Intersection of line (p, dir dp) and line (q, dir dq); null if near-parallel. */
function lineIntersect(p: Pt, dp: Pt, q: Pt, dq: Pt): Pt | null {
  const denom = cross(dp, dq);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(q, p), dq) / denom;
  return add(p, mul(dp, t));
}

/** Select the Pixi arc sweep whose midpoint points toward `direction`. */
function chooseArcSweep(a0: number, a1: number, direction: Pt): boolean {
  let increasing = a1 - a0;
  while (increasing <= 0) increasing += Math.PI * 2;
  let decreasing = a1 - a0;
  while (decreasing >= 0) decreasing -= Math.PI * 2;
  const increasingMid = { x: Math.cos(a0 + increasing / 2), y: Math.sin(a0 + increasing / 2) };
  const decreasingMid = { x: Math.cos(a0 + decreasing / 2), y: Math.sin(a0 + decreasing / 2) };
  // Pixi's `ccw: true` uses the decreasing-angle sweep.
  return dot(decreasingMid, direction) >= dot(increasingMid, direction);
}

/** Find the circle point nearest `reference` where the line from `control` is tangent to the
 * circle. This lets a quadratic keep its existing face-side direction while ending tangent to the
 * round cap. Returns null when the control point lies inside the circle and no tangent exists. */
function tangentPointOnCircle(control: Pt, centre: Pt, radius: number, reference: Pt, boundary?: readonly Pt[]): Pt | null {
  const fromCentre = sub(control, centre);
  const distance = len(fromCentre);
  if (distance <= radius + 1e-6 || radius <= 1e-6) return null;

  const base = angleOf(fromCentre);
  const offset = Math.acos(Math.max(-1, Math.min(1, radius / distance)));
  const candidates = [
    { x: centre.x + Math.cos(base + offset) * radius, y: centre.y + Math.sin(base + offset) * radius },
    { x: centre.x + Math.cos(base - offset) * radius, y: centre.y + Math.sin(base - offset) * radius },
  ].filter((point) => !boundary || pointInConvexPolygon(point, boundary));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => len(sub(a, reference)) - len(sub(b, reference)));
  return candidates[0];
}

/** Radius of the largest circle centred at `origin` that is guaranteed to stay in a convex cell. */
function convexCellClearance(origin: Pt, vertices: readonly Pt[]): number {
  let clearance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const edge = sub(vertices[(i + 1) % vertices.length], a);
    const edgeLength = len(edge);
    if (edgeLength > 1e-9) clearance = Math.min(clearance, Math.abs(cross(edge, sub(origin, a))) / edgeLength);
  }
  return clearance;
}

/** A quadratic has one control point, so its two endpoint tangents must meet at that point.
 *  Use that exact intersection when it is a forward, cell-safe point. If the tangent lines are
 *  parallel or their intersection would leave the convex tile, keep the control point on the
 *  tangent selected by the caller. Dead-end handoffs select the cap tangent so the contour joins
 *  the semicircle without a visible kink. */
function quadraticControlPoint(
  from: Pt,
  to: Pt,
  fromTangent: Pt,
  toTangent: Pt,
  boundary: readonly Pt[] | undefined,
  preferredTangent: "start" | "end",
): Pt {
  const start = norm(fromTangent);
  const end = norm(toTangent);
  const intersection = lineIntersect(from, start, to, end);
  if (intersection) {
    const startReach = dot(sub(intersection, from), start);
    const endReach = dot(sub(to, intersection), end);
    if (startReach > 1e-6 && endReach > 1e-6 && (!boundary || pointInConvexPolygon(intersection, boundary))) {
      return intersection;
    }
  }
  const chordLength = len(sub(to, from));
  const distance = Math.min(chordLength / 3, 10);
  const origin = preferredTangent === "start" ? from : to;
  const direction = preferredTangent === "start" ? start : mul(end, -1);
  return controlInside(origin, direction, distance, boundary);
}

/** A dead-end handoff with exact endpoint tangents whenever a quadratic can fit. A quadratic has
 * one shared control point, so some asymmetric Cairo faces cannot satisfy both tangents inside the
 * cell. In that case use a cubic with one control on each tangent; its controls stay inside the
 * convex cell and the transition to the cap remains smooth instead of visibly kinked. */
function smoothDeadEndHandoff(
  from: Pt,
  to: Pt,
  fromTangent: Pt,
  toTangent: Pt,
  boundary: readonly Pt[] | undefined,
): PathCmd {
  const start = norm(fromTangent);
  const end = norm(toTangent);
  const intersection = lineIntersect(from, start, to, end);
  if (intersection) {
    const startReach = dot(sub(intersection, from), start);
    const endReach = dot(sub(to, intersection), end);
    if (startReach > 1e-6 && endReach > 1e-6 && (!boundary || pointInConvexPolygon(intersection, boundary))) {
      return { kind: "quadratic", cp: intersection, to };
    }
    // The two exact tangents meet, but their shared quadratic control is outside the cell (the
    // asymmetric Cairo case). Use a cubic so both endpoint tangents remain exact.
    const chordLength = len(sub(to, from));
    const handle = Math.min(chordLength / 3, 10);
    return {
      kind: "bezier",
      cp1: controlInside(from, start, handle, boundary),
      cp2: controlInside(to, mul(end, -1), handle, boundary),
      to,
    };
  }

  // Parallel tangents have no shared quadratic control, but the legacy single-control fallback is
  // still the stable shape for symmetric cells such as squares.
  return { kind: "quadratic", cp: quadraticControlPoint(from, to, start, end, boundary, "start"), to };
}

/** Move a fallback control point along a tangent, stopping at a convex cell boundary. */
function controlInside(origin: Pt, direction: Pt, distance: number, boundary?: readonly Pt[]): Pt {
  const candidate = add(origin, mul(direction, distance));
  if (!boundary || pointInConvexPolygon(candidate, boundary)) return candidate;

  let low = 0;
  let high = distance;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    if (pointInConvexPolygon(add(origin, mul(direction, middle)), boundary)) low = middle;
    else high = middle;
  }
  return add(origin, mul(direction, low));
}

function pointInConvexPolygon(point: Pt, vertices: readonly Pt[]): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const side = cross(sub(b, a), sub(point, a));
    if (side > 1e-7) positive = true;
    if (side < -1e-7) negative = true;
  }
  return !(positive && negative);
}

function firstAnchor(cmds: PathCmd[]): Pt | null {
  for (const c of cmds) {
    if (c.kind === "move" || c.kind === "line" || c.kind === "quadratic") return c.to;
    if (c.kind === "arc") return { x: c.c.x + Math.cos(c.a0) * c.r, y: c.c.y + Math.sin(c.a0) * c.r };
  }
  return null;
}

/** Samples a contour path to a plain point polyline — arcs at ~0.2 rad steps. For tests /
 *  export-margin measurement; the renderer traces the real line/curve/arc commands. */
export function contourToPolyline(path: ContourPath, curveStep = 8): Pt[] {
  const out: Pt[] = [];
  for (const cmd of path.cmds) {
    if (cmd.kind === "move" || cmd.kind === "line") {
      out.push(cmd.to);
    } else if (cmd.kind === "quadratic") {
      const from = out[out.length - 1] ?? cmd.cp;
      const steps = Math.max(2, Math.ceil(len(sub(cmd.to, from)) / curveStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        out.push({
          x: u * u * from.x + 2 * u * t * cmd.cp.x + t * t * cmd.to.x,
          y: u * u * from.y + 2 * u * t * cmd.cp.y + t * t * cmd.to.y,
        });
      }
    } else if (cmd.kind === "bezier") {
      const from = out[out.length - 1] ?? cmd.cp1;
      const steps = Math.max(2, Math.ceil(len(sub(cmd.to, from)) / curveStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        out.push({
          x: u * u * u * from.x + 3 * u * u * t * cmd.cp1.x + 3 * u * t * t * cmd.cp2.x + t * t * t * cmd.to.x,
          y: u * u * u * from.y + 3 * u * u * t * cmd.cp1.y + 3 * u * t * t * cmd.cp2.y + t * t * t * cmd.to.y,
        });
      }
    } else {
      let sweep = cmd.a1 - cmd.a0;
      if (!cmd.ccw) {
        while (sweep < 0) sweep += Math.PI * 2;
        while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep > 0) sweep -= Math.PI * 2;
        while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
      }
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.2));
      for (let k = 1; k <= steps; k++) {
        const a = cmd.a0 + (sweep * k) / steps;
        out.push({ x: cmd.c.x + Math.cos(a) * cmd.r, y: cmd.c.y + Math.sin(a) * cmd.r });
      }
    }
  }
  return out;
}

/** Traces every tile path onto `target` as a closed sub-path; the caller fills once afterwards. The
 *  tiles never overlap, so a plain (non-zero) fill is seamless. */
export function traceCorridorContour(target: Graphics, paths: ContourPath[]): void {
  for (const path of paths) {
    for (const cmd of path.cmds) {
      if (cmd.kind === "move") target.moveTo(cmd.to.x, cmd.to.y);
      else if (cmd.kind === "line") target.lineTo(cmd.to.x, cmd.to.y);
      else if (cmd.kind === "quadratic") target.quadraticCurveTo(cmd.cp.x, cmd.cp.y, cmd.to.x, cmd.to.y);
      else if (cmd.kind === "bezier") target.bezierCurveTo(cmd.cp1.x, cmd.cp1.y, cmd.cp2.x, cmd.cp2.y, cmd.to.x, cmd.to.y);
      else target.arc(cmd.c.x, cmd.c.y, cmd.r, cmd.a0, cmd.a1, cmd.ccw);
    }
    target.closePath();
  }
}

/** Serializes the same contour commands used by `traceCorridorContour` to an SVG path. This is
 *  an exact command translation, not a sampled polyline: curves remain curves and Pixi's
 *  clockwise/counter-clockwise canvas arc convention is mapped to SVG's sweep flag. It is used by
 *  the geometry lab so its preview shares the universal contour geometry without introducing a
 *  second approximation algorithm. */
export function contourToSvgPath(paths: readonly ContourPath[]): string {
  const format = (value: number): string => Object.is(value, -0) ? "0" : String(value);
  const parts: string[] = [];

  for (const path of paths) {
    for (const cmd of path.cmds) {
      if (cmd.kind === "move") {
        parts.push(`M ${format(cmd.to.x)} ${format(cmd.to.y)}`);
      } else if (cmd.kind === "line") {
        parts.push(`L ${format(cmd.to.x)} ${format(cmd.to.y)}`);
      } else if (cmd.kind === "quadratic") {
        parts.push(`Q ${format(cmd.cp.x)} ${format(cmd.cp.y)} ${format(cmd.to.x)} ${format(cmd.to.y)}`);
      } else if (cmd.kind === "bezier") {
        parts.push(`C ${format(cmd.cp1.x)} ${format(cmd.cp1.y)} ${format(cmd.cp2.x)} ${format(cmd.cp2.y)} ${format(cmd.to.x)} ${format(cmd.to.y)}`);
      } else {
        let sweep = cmd.a1 - cmd.a0;
        if (cmd.ccw) {
          while (sweep > 0) sweep -= Math.PI * 2;
          while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
        } else {
          while (sweep < 0) sweep += Math.PI * 2;
          while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
        }
        if (Math.abs(sweep) <= 1e-9 || cmd.r <= 0) continue;

        // SVG cannot represent a full circle with one A command because its endpoint would equal
        // its start point. Splitting every arc at pi also keeps the conversion exact for that case.
        const arcCount = Math.max(1, Math.ceil(Math.abs(sweep) / Math.PI));
        const step = sweep / arcCount;
        for (let index = 0; index < arcCount; index++) {
          const angle = cmd.a0 + step * (index + 1);
          const end = {
            x: cmd.c.x + Math.cos(angle) * cmd.r,
            y: cmd.c.y + Math.sin(angle) * cmd.r,
          };
          parts.push(`A ${format(cmd.r)} ${format(cmd.r)} 0 0 ${cmd.ccw ? 0 : 1} ${format(end.x)} ${format(end.y)}`);
        }
      }
    }
    parts.push("Z");
  }

  return parts.join(" ");
}
