import type { Graphics } from "pixi.js";

type Pt = { x: number; y: number };

/** One command in a traced contour path. `line` draws a straight segment to `to`; `arc` draws a
 *  circular arc around `c` of radius `r` from angle `a0` to `a1`, `ccw` picking the sweep
 *  direction. Angles are in radians. */
export type PathCmd =
  | { kind: "move"; to: Pt }
  | { kind: "line"; to: Pt }
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
  fromNode?: number;
  toNode?: number;
  v1TouchesSplit?: boolean;
};

/** One connection of a tile: the passage leaves the tile centre `centre` toward `mid` (the middle
 *  of the shared border), `out` is the outward unit normal there. The drawn corridor is `2h` wide,
 *  so the border it must draw is the segment `mid ± tangent·h`. */
type Port = { centre: Pt; mid: Pt; out: Pt };

/** One tile: its centre and every port, in CCW order around the centre. */
type Tile = { centre: Pt; ports: Port[] };

/** Groups the centre-to-centre corridor segments into per-tile port lists. Every segment端 is a
 *  connection of the tile whose centre sits at that segment end. A split-touching far end (`v1TouchesSplit`)
 *  contributes a port only to the near (plain) tile — the split tile's own geometry is drawn
 *  elsewhere (`drawSplitPassages`). */
function buildTiles(segments: Seg[]): Tile[] {
  const byKey = new Map<string, Tile>();
  const keyOf = (p: Pt): string => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const tileAt = (centre: Pt): Tile => {
    const k = keyOf(centre);
    let t = byKey.get(k);
    if (!t) {
      t = { centre, ports: [] };
      byKey.set(k, t);
    }
    return t;
  };

  for (const s of segments) {
    if (len(sub(s.v1, s.v0)) < 1e-6) continue;
    // Near tile (centre = v0): border midpoint is halfway to v1 for a plain neighbour, or exactly
    // v1 when v1 is already the shared-face midpoint (split neighbour).
    const nearMid = s.v1TouchesSplit ? { ...s.v1 } : mid(s.v0, s.v1);
    const nearOut = norm(sub(s.v1, s.v0));
    tileAt(s.v0).ports.push({ centre: s.v0, mid: nearMid, out: nearOut });

    if (!s.v1TouchesSplit) {
      const farMid = mid(s.v0, s.v1);
      const farOut = norm(sub(s.v0, s.v1));
      tileAt(s.v1).ports.push({ centre: s.v1, mid: farMid, out: farOut });
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
  roundJunctions = true,
): ContourPath[] {
  const h = thickness / 2;
  const tiles = buildTiles(segments);
  const paths: ContourPath[] = [];

  for (const tile of tiles) {
    const cmds = tileContour(tile, h, roundJunctions);
    if (cmds.length >= 2) paths.push({ cmds, hole: false });
  }
  return paths;
}

/** Emits one closed path for a single tile. */
function tileContour(tile: Tile, h: number, roundJunctions: boolean): PathCmd[] {
  const { ports } = tile;
  const n = ports.length;
  if (n === 0) return [];

  if (n === 1) {
    // Dead end: a `thickness`-wide stub running from the shared border straight into the tile, then
    // a 180-degree semicircular cap of radius `h`. Four anchor points — two where the stub meets the
    // border (shared with the neighbour tile), two where the straight walls hand off to the cap.
    const p = ports[0];
    const { left, right } = portBorderEnds(p, h); // on the border
    const depth = len(sub(p.centre, p.mid));      // straight-wall length: border -> tile centre
    const inn = mul(p.out, -1);
    const leftIn = add(left, mul(inn, depth));    // start of the cap, left wall
    const rightIn = add(right, mul(inn, depth));  // start of the cap, right wall
    const capC = add(p.mid, mul(inn, depth));     // cap centre, on the stub axis
    const a0 = angleOf(sub(rightIn, capC));
    const a1 = angleOf(sub(leftIn, capC));
    // `rightIn` and `leftIn` sit exactly opposite across `capC` (sweep is a bare 180 degrees), so a
    // short-way test is a coin toss on floating angles and flips the cap inside-out on the diagonal
    // stub axes of a hex/triangle grid at some thicknesses. Pick the sweep direction explicitly: the
    // cap must bulge *away* from the tile (toward `inn`), so its apex `capC + inn·h` must lie on the
    // drawn arc. Test the CCW sweep a0 -> a1: if its midpoint angle points along `inn`, that sweep
    // is the one that passes through the apex.
    let ccwSweep = a1 - a0;
    while (ccwSweep <= 0) ccwSweep += Math.PI * 2;
    const ccwMidDir = { x: Math.cos(a0 + ccwSweep / 2), y: Math.sin(a0 + ccwSweep / 2) };
    // pixi `ccw: true` sweeps toward *decreasing* angle, i.e. the complement of this CCW sweep.
    const ccw = dot(ccwMidDir, inn) < 0;
    return [
      { kind: "move", to: right },
      { kind: "line", to: rightIn },
      { kind: "arc", c: capC, r: h, a0, a1, ccw },
      { kind: "line", to: left },
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

  return junctionContour(ports, h, roundJunctions);
}

/** A junction tile (3+ ports). Walk the outline CCW: each port contributes its `thickness`-wide
 *  border (`right` -> `left`), then between it and the next port one arc of the same turn-tile
 *  construction — centre `O` where the two border *lines* meet, `R` = distance from `O` to each
 *  border midpoint:
 *   - **concave armpit** (both arms have a passage, CCW turn between the two arm axes < 180 degrees):
 *     the turn's *inner* elbow — an arc of radius `R - h` between the two borders' inner ends,
 *     swept the short way. Constant `thickness` through the bend.
 *   - **convex gap** (the wide dead sector between the two outermost arms, no passage there — a
 *     reflex turn): the turn's *outer* elbow — an arc of radius `R + h` between the two borders'
 *     outer ends, swept the short way (as `turnContour` sweeps its outer arc). Same arc a
 *     one-face-apart passage draws; by construction `R + h` is roughly `|O - tile centre|`, so the
 *     arc runs close past the centre without quite reaching it — that is fine, the fill still reads
 *     as one smooth junction.
 *   - **straight-through** (collinear arms, no `O`): a plain line across.
 *
 *  No core disc. Ports are CCW around the centre. */
function junctionContour(ports: Port[], h: number, round: boolean): PathCmd[] {
  const n = ports.length;
  const cmds: PathCmd[] = [];

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
      const rOut = R + h;
      const b0 = angleOf(sub(pOuter, O)); // arc starts here (we're standing on pOuter)
      const b1 = angleOf(sub(nOuter, O));
      cmds.push({ kind: "line", to: pOuter });
      cmds.push({ kind: "arc", c: O, r: rOut, a0: b0, a1: b1, ccw: shortSweepCcw(b0, b1) });
      cmds.push({ kind: "line", to: nextEnds.right });
      continue;
    }

    // Concave armpit: the inner elbow of a turn -- an arc of radius `R - h` around `O` between the
    // two *inner* border ends, swept the short way. Constant `thickness` through the bend.
    const rIn = Math.max(0, R - h);
    const a0 = angleOf(sub(pInner, O));
    const a1 = angleOf(sub(nInner, O));
    cmds.push({ kind: "line", to: pInner });
    cmds.push({ kind: "arc", c: O, r: rIn, a0, a1, ccw: shortSweepCcw(a0, a1) });
    cmds.push({ kind: "line", to: nextEnds.right });
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
  const R = (len(sub(p0.mid, O)) + len(sub(p1.mid, O))) / 2;
  const rIn = Math.max(0, R - h);
  const rOut = R + h;

  const e0 = portBorderEnds(p0, h);
  const e1 = portBorderEnds(p1, h);
  // Which endpoint of each port is the inner (closer to O) one.
  const p0Inner = len(sub(e0.left, O)) < len(sub(e0.right, O)) ? e0.left : e0.right;
  const p0Outer = p0Inner === e0.left ? e0.right : e0.left;
  const p1Inner = len(sub(e1.left, O)) < len(sub(e1.right, O)) ? e1.left : e1.right;
  const p1Outer = p1Inner === e1.left ? e1.right : e1.left;

  const aIn0 = angleOf(sub(p0Inner, O));
  const aIn1 = angleOf(sub(p1Inner, O));
  const aOut0 = angleOf(sub(p0Outer, O));
  const aOut1 = angleOf(sub(p1Outer, O));

  // Each arc sweeps the short way around O between its own two endpoints.
  const ccwIn = shortSweepCcw(aIn0, aIn1);
  const ccwOut = shortSweepCcw(aOut1, aOut0);

  // Walk: p0 outer end -> p0 inner end -> inner arc to p1 inner end -> p1 outer end -> outer arc
  // back to p0 outer end.
  return [
    { kind: "move", to: p0Outer },
    { kind: "line", to: p0Inner },
    { kind: "arc", c: O, r: rIn, a0: aIn0, a1: aIn1, ccw: ccwIn },
    { kind: "line", to: p1Outer },
    { kind: "arc", c: O, r: rOut, a0: aOut1, a1: aOut0, ccw: ccwOut },
    { kind: "line", to: p0Outer },
  ];
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

function firstAnchor(cmds: PathCmd[]): Pt | null {
  for (const c of cmds) {
    if (c.kind === "move" || c.kind === "line") return c.to;
    if (c.kind === "arc") return { x: c.c.x + Math.cos(c.a0) * c.r, y: c.c.y + Math.sin(c.a0) * c.r };
  }
  return null;
}

/** Samples a contour path to a plain point polyline — arcs at ~0.2 rad steps. For tests /
 *  export-margin measurement; the renderer traces the real `line`/`arc` commands. */
export function contourToPolyline(path: ContourPath): Pt[] {
  const out: Pt[] = [];
  for (const cmd of path.cmds) {
    if (cmd.kind === "move" || cmd.kind === "line") {
      out.push(cmd.to);
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
      else target.arc(cmd.c.x, cmd.c.y, cmd.r, cmd.a0, cmd.a1, cmd.ccw);
    }
    target.closePath();
  }
}
