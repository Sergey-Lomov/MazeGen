import { describe, it, expect } from "vitest";
import { TeleportConnectorRouter, axisIntersection, pointToSegmentDistance } from "../pixi/renderers/teleportConnectorRouter";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import type { TeleportEdge } from "../pixi/renderers/types";
import type { FieldConfig } from "../fieldConfig";

function edge(from: [number, number], to: [number, number]): TeleportEdge {
  return { from, to, oneWay: false };
}

describe("axisIntersection", () => {
  it("returns null for parallel axes (no single bend point connects them)", () => {
    expect(axisIntersection([0, 0], { ux: 1, uy: 0 }, [10, 10], { ux: 1, uy: 0 })).toBeNull();
  });

  it("finds the corner of an axis-aligned h-then-v path", () => {
    expect(axisIntersection([0, 0], { ux: 1, uy: 0 }, [10, 20], { ux: 0, uy: 1 })).toEqual([10, 0]);
  });

  it("lands within floating-point noise of `from` when `from`/`to` are collinear with `axisB` (degenerate first leg) — the real case (GitHub issue #297 follow-up) where `axisIntersection`'s own division used to leave a stray sub-epsilon offset that drew as a spike", () => {
    // `from`/`to` here sit exactly on a 120° line — `axisB` (120°) is the degenerate axis, so the
    // 0°-then-120° candidate's first leg should collapse to (near) zero length.
    const axis120 = { ux: Math.cos((120 * Math.PI) / 180), uy: Math.sin((120 * Math.PI) / 180) };
    const bend = axisIntersection([60, -92.37604307034012], { ux: 1, uy: 0 }, [-20, 46.18802153517006], axis120);
    expect(bend).not.toBeNull();
    // Not asserting exact equality with `from` here — `TeleportConnectorRouter`'s own snapping (in
    // `candidatePaths`) is what guarantees the exact match; this test only pins down that the raw
    // intersection lands within floating-point noise of it, which is the condition that snapping keys off.
    expect(Math.hypot(bend![0] - 60, bend![1] - (-92.37604307034012))).toBeLessThan(1e-6);
  });
});

describe("pointToSegmentDistance", () => {
  it("is zero for a point exactly on the segment", () => {
    expect(pointToSegmentDistance([5, 0], [0, 0], [10, 0])).toBe(0);
  });

  it("clamps to the nearest endpoint when the projection falls outside the segment", () => {
    expect(pointToSegmentDistance([-5, 3], [0, 0], [10, 0])).toBeCloseTo(Math.hypot(5, 3));
  });

  it("measures perpendicular distance for a point off to the side, independent of the segment's own axis", () => {
    // The core fix this session: this must be correct for a segment on ANY axis, not just axis-aligned
    // ones, since a diagonal candidate leg can cut through another connector's endpoint at an angle.
    expect(pointToSegmentDistance([5, 5], [0, 0], [10, 0])).toBe(5);
  });

  it("falls back to point-to-point distance for a zero-length segment", () => {
    expect(pointToSegmentDistance([3, 4], [0, 0], [0, 0])).toBe(5);
  });
});

describe("TeleportConnectorRouter.route", () => {
  it("a single connector with no collisions bends on-grid with zero offset", () => {
    const [routed] = new TeleportConnectorRouter().route([edge([0, 0], [10, 20])], 4);
    // Either bend orientation is valid with nothing to collide against — bend is either (10,0) or (0,20).
    expect(routed.points[0]).toBe(0);
    expect(routed.points[1]).toBe(0);
    expect(routed.points[4]).toBe(10);
    expect(routed.points[5]).toBe(20);
    const [, , bendX, bendY] = routed.points;
    expect([bendX, bendY]).toSatisfy(([bx, by]: [number, number]) => (bx === 10 && by === 0) || (bx === 0 && by === 20));
  });

  it("a hex/triangle connector whose from/to are collinear with one candidate axis draws a clean two-point line, not a spike (GitHub issue #297 follow-up)", () => {
    // Same from/to as the real bug report: collinear with the 0° axis, so the h-then-v candidate's
    // first leg is degenerate. Before the fix, `axisIntersection`'s division landed the bend a few
    // ULPs off `from` instead of exactly on it, leaving a near-zero-length first segment with its own
    // (numerically noisy) direction — round line-join drew that as a visible spike jutting sideways.
    const [routed] = new TeleportConnectorRouter().route(
      [edge([60, -92.37604307034012], [-20, 46.18802153517006])],
      4,
      Infinity,
      { type: "hex_parallelogram", cols: 1, rows: 1, orientation: "pointy_top" },
    );
    const [startX, startY, bendX, bendY] = routed.points;
    // The degenerate leg's bend must snap exactly onto `from` — not just close to it — since any
    // nonzero gap still draws as a direction-bearing segment under a stroke.
    expect(bendX === startX && bendY === startY).toBe(true);
  });

  it("two connectors sharing an overlapping horizontal corridor get offset apart, symmetric around the original line", () => {
    // Both from y=0 straight across to y=0 at different x spans that overlap on x — forces a
    // horizontal segment overlap regardless of bend choice, since both are already flat lines.
    const edges = [edge([0, 0], [10, 0]), edge([2, 0], [12, 0])];
    const routed = new TeleportConnectorRouter().route(edges, 4);
    // Two connectors in one cluster: offsets are -2 and +2 (gap=4, symmetric around 0).
    const ys = routed.map((r) => r.points[1]);
    expect(new Set(ys.map((y) => Math.abs(y)))).toEqual(new Set([2]));
    expect(ys[0]).not.toBe(ys[1]);
  });

  it("non-overlapping connectors on the same axis/coordinate but disjoint spans get zero offset each", () => {
    const edges = [edge([0, 0], [5, 0]), edge([10, 0], [15, 0])];
    const routed = new TeleportConnectorRouter().route(edges, 4);
    expect(routed[0].points[1]).toBe(0);
    expect(routed[1].points[1]).toBe(0);
  });

  it("start and end points always land on the original from/to coordinates on the non-offset axis", () => {
    const edges = [edge([0, 0], [10, 0]), edge([2, 0], [12, 0]), edge([4, 0], [14, 0])];
    const routed = new TeleportConnectorRouter().route(edges, 4);
    routed.forEach((r, i) => {
      expect(r.points[0]).toBe(edges[i].from[0]);
      expect(r.points[4]).toBe(edges[i].to[0]);
    });
  });

  it("a cluster of 3 overlapping connectors gets 3 distinct symmetric offsets", () => {
    const edges = [edge([0, 0], [10, 0]), edge([1, 0], [11, 0]), edge([2, 0], [12, 0])];
    const routed = new TeleportConnectorRouter().route(edges, 4);
    const ys = routed.map((r) => r.points[1]).sort((a, b) => a - b);
    expect(ys).toEqual([-4, 0, 4]);
  });

  it("orthogonal path always has exactly 3 points (start, bend, end)", () => {
    const routed = new TeleportConnectorRouter().route([edge([0, 0], [5, 5])], 4);
    expect(routed[0].points).toHaveLength(6);
  });

  it("bends along the tessellation's own face axes, not a fixed 90°, for hex/triangle configs (GitHub issue #297)", () => {
    const hexCfg: FieldConfig = { type: "hex_hexagon", radius: 3 };
    const [routed] = new TeleportConnectorRouter().route([edge([0, 0], [10, 4])], 4, Infinity, hexCfg);
    const [, , bendX, bendY] = routed.points;
    // A square (h/v) bend would land the corner exactly on (10, 0) or (0, 4) — neither axis-aligned
    // grid point is reachable via hex's 0°/60°/120° axes for this from/to pair.
    expect([bendX, bendY]).not.toEqual([10, 0]);
    expect([bendX, bendY]).not.toEqual([0, 4]);
  });

  it("falls back to square (h/v) axes when no tessellation config is given", () => {
    const [withoutCfg] = new TeleportConnectorRouter().route([edge([0, 0], [10, 20])], 4);
    const [withSquareCfg] = new TeleportConnectorRouter().route([edge([0, 0], [10, 20])], 4, Infinity, { type: "square", width: 10, height: 10 });
    expect(withoutCfg.points).toEqual(withSquareCfg.points);
  });

  it("with 3+ axes and no collisions to break the tie, picks the shortest of the equally-uncontested candidate paths", () => {
    // A lone connector never collides with anything, so every one of hex's 6 candidate paths ties
    // at 0 collisions — the length tie-break must then pick the geometrically shortest bend.
    const hexCfg: FieldConfig = { type: "hex_hexagon", radius: 3, orientation: "pointy_top" };
    const [routed] = new TeleportConnectorRouter().route([edge([0, 0], [7, 3])], 4, Infinity, hexCfg);
    const [sx, sy, bx, by, ex, ey] = routed.points;
    const length = Math.hypot(bx - sx, by - sy) + Math.hypot(ex - bx, ey - by);
    // Straight-line distance is a lower bound; the shortest valid 2-axis bend for this pair should
    // land close to it (well under the ~12.2 length of this hex axis set's longest candidate).
    expect(length).toBeLessThan(9);
  });

  it("with 3+ axes, a larger interacting cluster still routes every connector to a valid non-degenerate path (refinement passes don't crash, drop connectors, or produce malformed polylines)", () => {
    const hexCfg: FieldConfig = { type: "hex_hexagon", radius: 3, orientation: "pointy_top" };
    const edges = [
      edge([0, 0], [8, 0]),
      edge([1, 0], [9, 0]),
      edge([0, 1], [8, 1]),
      edge([2, -1], [10, 3]),
      edge([1, -2], [9, 2]),
    ];
    const routed = new TeleportConnectorRouter().route(edges, 4, Infinity, hexCfg);
    expect(routed).toHaveLength(edges.length);
    routed.forEach((r) => expect(r.points).toHaveLength(6));
  });

  it("caches by structural equality — a freshly-rebuilt but equal-by-value edges array reuses the previous result instead of recomputing", () => {
    const router = new TeleportConnectorRouter();
    const first = router.route([edge([0, 0], [10, 0]), edge([2, 0], [12, 0])], 4);
    // A brand-new array, same content — simulates a caller that rebuilds `TeleportEdge[]` from
    // scratch every render (e.g. `buildTeleportEdges`) without keeping a stable reference.
    const second = router.route([edge([0, 0], [10, 0]), edge([2, 0], [12, 0])], 4);
    expect(second).toBe(first);
  });

  it("cache invalidates when the edges, gap, maxEndpointOffset, or cfg actually change", () => {
    const router = new TeleportConnectorRouter();
    const base = router.route([edge([0, 0], [10, 20])], 4);
    const differentGap = router.route([edge([0, 0], [10, 20])], 8);
    expect(differentGap).not.toBe(base);
    const differentEdges = router.route([edge([0, 0], [10, 21])], 4);
    expect(differentEdges).not.toBe(base);
    const differentCfg = router.route([edge([0, 0], [10, 20])], 4, Infinity, { type: "hex_hexagon", radius: 3 });
    expect(differentCfg).not.toBe(base);
  });

  it("cache invalidates when endpointStyle changes even if every other argument stays the same", () => {
    const router = new TeleportConnectorRouter();
    const edges = [edge([0, 0], [10, 0]), edge([2, 0], [8, -6])];
    const base = router.route(edges, 4, Infinity, undefined, { markerRadius: 2, markerBorderWidth: 1, connectorBorderWidth: 1, connectorWidth: 2 });
    const differentStyle = router.route(edges, 4, Infinity, undefined, { markerRadius: 5, markerBorderWidth: 1, connectorBorderWidth: 1, connectorWidth: 2 });
    expect(differentStyle).not.toBe(base);
  });

  it("with endpointStyle given, a candidate that would cut through another connector's marker is weighted heavier and avoided in favor of an equally-raw-colliding mid-path-only overlap (GitHub issue #297 follow-up)", () => {
    // Square axes (h/v) so each connector has exactly 2 candidates, both fully predictable.
    // A: (0,0)->(10,0), h-axis segment y=0, x in [0,10] — its own endpoint sits at x=10.
    // C: (9,-30)->(9,30), v-axis segment x=9, y in [-30,30] — long enough that any overlap with it
    // lands well clear of C's own endpoints (-30/30).
    // B: (9,0)->(20,5) has 2 candidates, each raw-colliding exactly once and of equal length (16):
    //  - h-then-v: h-leg y=0, x in [9,20] — overlaps A on x in [9,10], touching A's own endpoint
    //    (x=10, A's own `hi`). v-leg x=20 doesn't overlap C (fixed 20 vs 9).
    //  - v-then-h: v-leg x=9, y in [0,5] — overlaps C on y in [0,5], well inside C's [-30,30] span,
    //    nowhere near either of C's own endpoints. h-leg y=5 doesn't overlap A (fixed 5 vs 0).
    // Without endpoint weighting these tie on both collision count and length, so plain candidate
    // order picks h-then-v (first in `axes × axes`). With a large-enough `endpointStyle` radius,
    // h-then-v's collision is weighted 3x (endpoint-touching) against v-then-h's 1x
    // (mid-path-only), flipping the choice to v-then-h.
    const edgeA = edge([0, 0], [10, 0]);
    const edgeC = edge([9, -30], [9, 30]);
    const edgeB = edge([9, 0], [20, 5]);
    const endpointStyle = { markerRadius: 0.2, markerBorderWidth: 0.1, connectorBorderWidth: 0.1, connectorWidth: 0.2 };

    const withoutEndpointStyle = new TeleportConnectorRouter().route([edgeA, edgeC, edgeB], 1);
    const withEndpointStyle = new TeleportConnectorRouter().route([edgeA, edgeC, edgeB], 1, Infinity, undefined, endpointStyle);

    // Without weighting: h-then-v (bend near (20,0), nudged slightly by the A/B collision-cluster
    // offset — its exact value isn't the point here, only which axis pairing got picked).
    expect(withoutEndpointStyle[2].points[1]).toBeCloseTo(withoutEndpointStyle[2].points[3]); // bend's y ≈ start's y → h-leg first
    // With weighting: v-then-h — avoids cutting through A's endpoint (bend's x stays close to
    // start's x, meaning the v-leg ran first).
    expect(withEndpointStyle[2].points[0]).toBeCloseTo(withEndpointStyle[2].points[2], 0); // bend's x ≈ start's x → v-leg first
  });
});

describe("getConnectorAxes", () => {
  it("square has 2 perpendicular axes (horizontal/vertical)", () => {
    const axes = getConnectorAxes({ type: "square", width: 1, height: 1 });
    expect(axes).toEqual([{ ux: 1, uy: 0 }, { ux: 0, uy: 1 }]);
  });

  it("hex has 3 axes, 60° apart, perpendicular to that orientation's own face directions", () => {
    const flat = getConnectorAxes({ type: "hex_hexagon", radius: 1, orientation: "flat_top" });
    const pointy = getConnectorAxes({ type: "hex_hexagon", radius: 1, orientation: "pointy_top" });
    expect(flat).toHaveLength(3);
    // pointy_top is flat_top rotated 30° — its faces (and thus its normals) land on a different
    // 3-axis set, not the same one (GitHub issue #297 follow-up: axes must be face *normals*, and
    // flat_top's/pointy_top's face directions don't coincide).
    expect(flat).not.toEqual(pointy);
  });

  it("triangle uses the same axis set regardless of orientation", () => {
    const r0 = getConnectorAxes({ type: "triangle_rect", cols: 1, rows: 1, orientation: "r0" });
    const r90 = getConnectorAxes({ type: "triangle_rect", cols: 1, rows: 1, orientation: "r90" });
    const r180 = getConnectorAxes({ type: "triangle_rect", cols: 1, rows: 1, orientation: "r180" });
    const r270 = getConnectorAxes({ type: "triangle_rect", cols: 1, rows: 1, orientation: "r270" });
    expect(r0).toHaveLength(3);
    expect(r0).toEqual(r90);
    expect(r0).toEqual(r180);
    expect(r0).toEqual(r270);
  });
});
