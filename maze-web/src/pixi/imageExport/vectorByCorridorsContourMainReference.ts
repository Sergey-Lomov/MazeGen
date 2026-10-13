/* TEMPORARY MAIN-BRANCH REFERENCE.
 * This file is an exact copy of vectorByCorridorsContour.ts from Git branch main.
 * It is used only by the enlarged lab comparison mode and must not be used by production rendering.
 */
import type { Graphics } from "pixi.js";

type Pt = { x: number; y: number };

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
type Tile = { centre: Pt; ports: Port[]; boundary?: Pt[] };
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
 *  every tile's radii follow from its own geometry, so there is no radius parameter. */
export function buildCorridorContour(
  segments: Seg[],
  thickness: number,
  // `VectorByCorridorsRenderer` always passes `true` since GitHub issue #510 replaced the old
  // `roundJunctions` setting with a Contour-vs-Line rendering-mode switch (angular junctions now
  // mean picking Line mode, not this flag). Kept parameterized for `vectorByCorridorsContour.test.ts`,
  // which drives the `false` branch directly.
  roundJunctions = true,
  junctionStyle: CorridorJunctionStyle = "default",
): ContourPath[] {
  const h = fitHalfWidth(segments, thickness / 2);
  const tiles = buildTiles(segments);
  const paths: ContourPath[] = [];

  for (const tile of tiles) {
    const cmds = tileContour(tile, h, roundJunctions, junctionStyle);
    if (cmds.length >= 2) paths.push({ cmds, hole: false });
  }
  return paths;
}

/** Emits one closed path for a single tile. */
function tileContour(tile: Tile, h: number, roundJunctions: boolean, junctionStyle: CorridorJunctionStyle): PathCmd[] {
  const { ports } = tile;
  const n = ports.length;
  if (n === 0) return [];

  // Irregular convex cells can make a wall-intersection junction reach outside the cell. Use the
  // same convex-safe fallback for every junction whose ports carry real face geometry:
  // a cubic between consecutive mouth endpoints, with both controls directed into the cell. A
  // cubic stays inside the convex hull of its endpoints and controls, so it keeps the bend without
  // recreating the external spike.
  if (n >= 3 && ports.every((port) => port.useCubicMouth)) {
    return convexSafeJunctionContour(ports, h);
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
      {
        kind: "quadratic",
        cp: quadraticControlPoint(right, rightIn, inn, tangentAtStart, tile.boundary, "start"),
        to: rightIn,
      },
      { kind: "arc", c: capC, r: capRadius, a0, a1, ccw },
      {
        kind: "quadratic",
        cp: quadraticControlPoint(leftIn, left, tangentAtEnd, p.out, tile.boundary, "end"),
        to: left,
      },
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

  const filletScale = junctionStyle === "shallowThreeWay" && n === 3 ? 0.55 : 1;
  return junctionContour(ports, h, roundJunctions, filletScale);
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
function bendJunctionContour(ports: Port[], h: number, filletScale: number): PathCmd[] | null {
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
  const rf = Math.min(ARMPIT_FILLET_K * 2 * h, h * 0.7) * filletScale;

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
    const d = norm(wallDir);
    const nrm = leftN(d);
    const wallReach = dot(sub(wallEnd, corner), d);
    if (wallReach <= 1e-6) return { cmd: null, arcT: corner, wallT: corner };
    const candidates: { fc: Pt; arcT: Pt; wallT: Pt; radius: number; score: number }[] = [];
    // A thick corridor may not have room for the requested radius on the external side of the
    // inner circle. Try smaller radii rather than falling back to a malformed fillet.
    for (const radius of [rMax, rMax * 0.75, rMax * 0.5, rMax * 0.25]) {
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
    }
    const best = candidates.sort((a, b) => b.radius - a.radius || a.score - b.score)[0];
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
    // Leave room on both sides of the thick arm mouth. A fillet that consumes the whole available
    // wall interval is technically continuous but folds the two sides over one another visually.
    const r2 = Math.min(rf, rIn * 0.2, h * 0.35);
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

function junctionContour(ports: Port[], h: number, round: boolean, filletScale = 1): PathCmd[] {
  const n = ports.length;
  const cmds: PathCmd[] = [];

  if (round) {
    const bent = bendJunctionContour(ports, h, filletScale);
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

    if (!round) {
      // `roundJunctions` off: join the two arm side-walls with a straight mitre. Extend this arm's
      // trailing wall and the next arm's leading wall to their own intersection; fall back to a
      // plain bridge if they are parallel.
      const meet = lineIntersect(ends.left, into, nextEnds.right, nextInto);
      if (meet) cmds.push({ kind: "line", to: meet });
      cmds.push({ kind: "line", to: nextEnds.right });
      continue;
    }

    // CCW turn between the two arm axes. Reflex => the wide dead sector (convex gap).
    let turn = angleOf(nextInto) - angleOf(into);
    while (turn <= 0) turn += Math.PI * 2;
    const convexGap = turn > Math.PI;

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
      const rFillet = Math.min(rTurnIn, ARMPIT_FILLET_K * 2 * h, reach * tanHalf) * filletScale;
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

  // Walk: p0 outer end -> p0 inner end -> inner arc to p1 inner end -> p1 outer end -> outer arc
  // back to p0 outer end. `arcThroughPoints` adjusts the circle centre when the two Cairo faces
  // have different apothems, so the arc's mathematical endpoints remain exactly on both mouths.
  return [
    { kind: "move", to: p0Outer },
    { kind: "line", to: p0Inner },
    smoothMouthCurve(p0Inner, p1Inner, O, mul(p0.out, -1), p1.out, Boolean(p0.useCubicMouth || p1.useCubicMouth)),
    { kind: "line", to: p1Outer },
    smoothMouthCurve(p1Outer, p0Outer, O, mul(p1.out, -1), p0.out, Boolean(p1.useCubicMouth || p0.useCubicMouth)),
    { kind: "line", to: p0Outer },
  ];
}

function convexSafeJunctionContour(ports: Port[], h: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    const nextPort = ports[(i + 1) % ports.length];
    const { left, right } = portBorderEnds(port, h);
    const next = portBorderEnds(nextPort, h);
    cmds.push({ kind: i === 0 ? "move" : "line", to: right });
    cmds.push({ kind: "line", to: left });
    const chord = sub(next.right, left);
    const chordLength = len(chord);
    const into = mul(port.out, -1);
    const nextInto = mul(nextPort.out, -1);
    const startReach = Math.max(0, dot(sub(port.centre, left), into));
    const endReach = Math.max(0, dot(sub(nextPort.centre, next.right), nextInto));
    const handle = Math.min(chordLength / 3, startReach * 0.65, endReach * 0.65);
    if (handle > 1e-6) {
      cmds.push({
        kind: "bezier",
        cp1: add(left, mul(into, handle)),
        cp2: add(next.right, mul(nextInto, handle)),
        to: next.right,
      });
    } else {
      cmds.push({ kind: "line", to: next.right });
    }
  }
  const first = cmds[0];
  if (first && (first.kind === "move" || first.kind === "line")) cmds.push({ kind: "line", to: first.to });
  return cmds;
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
function tangentPointOnCircle(control: Pt, centre: Pt, radius: number, reference: Pt, boundary?: Pt[]): Pt | null {
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
function convexCellClearance(origin: Pt, vertices: Pt[]): number {
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
  boundary: Pt[] | undefined,
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

/** Move a fallback control point along a tangent, stopping at a convex cell boundary. */
function controlInside(origin: Pt, direction: Pt, distance: number, boundary?: Pt[]): Pt {
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

function pointInConvexPolygon(point: Pt, vertices: Pt[]): boolean {
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
export function contourToPolyline(path: ContourPath): Pt[] {
  const out: Pt[] = [];
  for (const cmd of path.cmds) {
    if (cmd.kind === "move" || cmd.kind === "line") {
      out.push(cmd.to);
    } else if (cmd.kind === "quadratic") {
      const from = out[out.length - 1] ?? cmd.cp;
      const steps = Math.max(2, Math.ceil(len(sub(cmd.to, from)) / 8));
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
      const steps = Math.max(2, Math.ceil(len(sub(cmd.to, from)) / 8));
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

