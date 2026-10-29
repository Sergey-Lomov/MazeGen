import { describe, it, expect, vi } from "vitest";
import { buildTeleportWidenMarkers, buildVerticalWidenMarkers, computeDiagonalGapPatchGeometry } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { clipStrokeToConvexPolygon, computeMiterJunctionPatch, selectInwardJunctionWedge, corridorCellStep } from "../pixi/imageExport/vectorByCorridorsGeometry";
import { buildCorridorContour, contourToPolyline, type ContourPath, type PathCmd } from "../pixi/imageExport/vectorByCorridorsContour";
import { computeSquareCapPatch } from "../pixi/renderers/wallUtils";
import { buildTeleportGroups } from "../pixi/selectors/teleportGroups";
import { buildVerticalConnectionStyle } from "../pixi/imageExport/exportStyleBuilders";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import type { VectorByCorridorsSettings } from "../store/storeTypes";
import { settingsA } from "./vbcKit";


vi.mock("../pixi/selectors/mazeSelectors", async () => (await import("./vbcMocks")).mazeSelectorsMock());
vi.mock("../pixi/renderers/WallRenderer", async () => (await import("./vbcMocks")).wallRendererMock());
vi.mock("../pixi/renderers/TeleportRenderer", async () => (await import("./vbcMocks")).teleportRendererMock());
vi.mock("../pixi/renderers/VerticalConnectionRenderer", async () => (await import("./vbcMocks")).verticalConnectionRendererMock());
vi.mock("../pixi/renderers/GridRenderer", async () => (await import("./vbcMocks")).gridRendererMock());
vi.mock("../store/mazeStore", async () => (await import("./vbcMocks")).mazeStoreMock());
vi.mock("pixi.js", async () => (await import("./vbcMocks")).pixiMock());

describe("buildTeleportWidenMarkers", () => {
  it("emits one marker per unique teleport point, deduping shared endpoints across edges", () => {
    const edges = [
      { from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false },
      { from: [1, 1] as [number, number], to: [2, 2] as [number, number], oneWay: false },
    ];
    const markers = buildTeleportWidenMarkers(edges, settingsA, []);
    expect(markers.map((m) => m.pos)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("uses the base teleportMarker.shape/cornerStyle/border/gap when group customization is off", () => {
    const [marker] = buildTeleportWidenMarkers([{ from: [0, 0], to: [1, 1], oneWay: false }], settingsA, []);
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.teleportMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.teleportMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.teleportMarker.gapWidth);
    expect(marker.radius).toBe(settingsA.teleportMarker.size / 2);
  });

  it("uses a group's own override shape for its points when group customization is on", () => {
    const groupKey = "0-1";
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: true,
      teleportGroupOverrides: { [groupKey]: { shape: "square" } },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false, fromNode: 0, toNode: 1 }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(marker.shape).toBe("square");
  });

  it("falls back to the base shape for a group with no override, even with customization on", () => {
    const settings: VectorByCorridorsSettings = { ...settingsA, teleportGroupCustomization: true, teleportGroupOverrides: {} };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
  });

  it("ignores teleportGroupOverrides entirely when group customization is off", () => {
    const groupKey = "0-1";
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: false,
      teleportGroupOverrides: { [groupKey]: { shape: "square" } },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: false, fromNode: 0, toNode: 1 }];
    const [marker] = buildTeleportWidenMarkers(edges, settings, []);
    expect(marker.shape).toBe(settingsA.teleportMarker.shape);
  });

  it("returns an empty list for no teleport edges", () => {
    expect(buildTeleportWidenMarkers([], settingsA, [])).toEqual([]);
  });

  it("gives a badge widen marker teleportFloorBadge.shape, not teleportMarker.shape (GitHub issue #485)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, shape: "square" },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "hexagon" },
    };
    const markers = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }],
      settings,
      [],
    );
    const badge = markers.find((m) => m.pos[0] === 10 && m.pos[1] === 10);
    const real = markers.find((m) => m.pos[0] === 0 && m.pos[1] === 0);
    // The badge marker carries the badge's own shape/corners; `markerWidenShape` still governs the
    // actual patch shape in `drawMarkerWidenPatches` (copied only under `"match_marker"`).
    expect(badge?.shape).toBe("hexagon");
    expect(badge?.cornerStyle).toBe("round");
    expect(real?.shape).toBe("square");
  });

  it("sizes a badge widen patch to teleportFloorBadge.size, not teleportMarker.size (GitHub issue #485)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, size: 0.16 },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, size: 0.4 },
    };
    const [real, badge] = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, toFloor: 1 }],
      settings,
      [],
    );
    expect(real.radius).toBe(0.16 / 2);
    expect(badge.radius).toBe(0.4 / 2);
  });

  it("shapes a fromFloor-tagged badge endpoint patch as teleportFloorBadge.shape too", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, shape: "square" },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "diamond" },
    };
    const [badge] = buildTeleportWidenMarkers(
      [{ from: [0, 0], to: [10, 10], oneWay: true, fromFloor: 1 }],
      settings,
      [],
    );
    expect(badge.pos).toEqual([0, 0]);
    expect(badge.shape).toBe("diamond");
  });

  it("ignores a group override shape for a badge endpoint (uses teleportFloorBadge.shape)", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportGroupCustomization: true,
      teleportGroupOverrides: { "0-1": { shape: "square" } },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, shape: "pentagon" },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [10, 10] as [number, number], oneWay: true, fromNode: 0, toNode: 1, toFloor: 1 }];
    const [, badge] = buildTeleportWidenMarkers(edges, settings, buildTeleportGroups(edges));
    expect(badge.pos).toEqual([10, 10]);
    expect(badge.shape).toBe("pentagon");
  });
});

describe("selectInwardJunctionWedge", () => {
  it("keeps the wedge furthest toward the tile interior", () => {
    const rays = [
      { dir: { x: -1, y: -1 }, width: 10 },
      { dir: { x: 1, y: 0 }, width: 10 },
    ];
    const wedges = computeMiterJunctionPatch(rays);
    expect(wedges).toHaveLength(2);
    const inward = { x: 0, y: 1 };
    const score = (wedge: (typeof wedges)[number]) => wedge.points.reduce(
      (sum, point) => sum + point.x * inward.x + point.y * inward.y,
      0,
    );
    const selected = selectInwardJunctionWedge(rays, inward);
    expect(selected).not.toBeNull();
    expect(score(selected!)).toBe(Math.max(...wedges.map(score)));
  });
});

describe("buildTeleportWidenMarkers scale", () => {
  it("scales each point by its own fromScale/toScale", () => {
    const edges = [{ from: [0, 0] as [number, number], to: [100, 0] as [number, number], oneWay: false, fromNode: 1, toNode: 2, fromScale: 0.5 }];
    const [a, b] = buildTeleportWidenMarkers(edges, settingsA, buildTeleportGroups(edges));
    expect(a.radius).toBe(settingsA.teleportMarker.size / 2 * 0.5);
    expect(a.borderWidth).toBe(settingsA.teleportMarker.borderWidth * 0.5);
    expect(b.radius).toBe(settingsA.teleportMarker.size / 2);
  });
});

describe("buildVerticalWidenMarkers", () => {
  function makeMarker(overrides: Partial<VerticalConnectionMarker>): VerticalConnectionMarker {
    return { pos: [0, 0], fromNode: 0, kind: "vertical_passage", filled: true, arrowFilled: true, ...overrides };
  }

  it("scales radius, border and gap by the layout scale", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "elevator", scale: 0.5 })], settingsA);
    expect(marker.radius).toBe(settingsA.elevatorMarker.size / 2 * 0.5);
    expect(marker.borderWidth).toBe(settingsA.elevatorMarker.borderWidth * 0.5);
    expect(marker.gapWidth).toBe(settingsA.elevatorMarker.gapWidth * 0.5);
  });

  it("uses elevatorMarker's size/shape/cornerStyle for an elevator marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "elevator" })], settingsA);
    expect(marker.radius).toBe(settingsA.elevatorMarker.size / 2);
    expect(marker.shape).toBe(settingsA.elevatorMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.elevatorMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.elevatorMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.elevatorMarker.gapWidth);
  });

  it("uses twoWayPassageMarker's size/shape/cornerStyle for a filled vertical_passage marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "vertical_passage", filled: true })], settingsA);
    expect(marker.radius).toBe(settingsA.twoWayPassageMarker.size / 2);
    expect(marker.shape).toBe(settingsA.twoWayPassageMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.twoWayPassageMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.twoWayPassageMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.twoWayPassageMarker.gapWidth);
  });

  it("uses oneWayPassageMarker's size/shape/cornerStyle for an unfilled vertical_passage marker", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "vertical_passage", filled: false })], settingsA);
    expect(marker.radius).toBe(settingsA.oneWayPassageMarker.size / 2);
    expect(marker.shape).toBe(settingsA.oneWayPassageMarker.shape);
    expect(marker.cornerStyle).toBe(settingsA.oneWayPassageMarker.cornerStyle);
    expect(marker.borderWidth).toBe(settingsA.oneWayPassageMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.oneWayPassageMarker.gapWidth);
  });

  it("carries the resolved marker's own borderWidth/gapWidth through (GitHub issue #551)", () => {
    const [marker] = buildVerticalWidenMarkers([makeMarker({ kind: "elevator" })], settingsA);
    expect(marker.borderWidth).toBe(settingsA.elevatorMarker.borderWidth);
    expect(marker.gapWidth).toBe(settingsA.elevatorMarker.gapWidth);
  });

  it("carries each marker's own pos through unchanged", () => {
    const markers = [makeMarker({ pos: [3, 4] }), makeMarker({ pos: [5, 6], kind: "elevator" })];
    expect(buildVerticalWidenMarkers(markers, settingsA).map((m) => m.pos)).toEqual([[3, 4], [5, 6]]);
  });

  it("returns an empty list for no markers", () => {
    expect(buildVerticalWidenMarkers([], settingsA)).toEqual([]);
  });
});

describe("buildVerticalConnectionStyle (Vector by corridors call site, no decorative arg)", () => {
  it("always resolves style to 'abstract' when called without a third (decorative) argument", () => {
    const style = buildVerticalConnectionStyle(settingsA, settingsA.color);
    expect(style.style).toBe("abstract");
  });

  it("carries the caller's own marker/arrow settings through unchanged", () => {
    const style = buildVerticalConnectionStyle(settingsA, settingsA.color);
    expect(style.twoWayArrowColor).toBe(settingsA.twoWayArrowColor);
    expect(style.elevatorArrowStyle).toBe(settingsA.elevatorArrowStyle);
    expect(style.elevatorBadges).toBe(settingsA.elevatorBadges);
  });
});

describe("computeSquareCapPatch", () => {
  it("extends width/2 past freeEnd along the path's own direction, centered on the perpendicular", () => {
    const freeEnd = { x: 10, y: 0 };
    const neighbor = { x: 0, y: 0 }; // path runs along +x, so freeEnd's own direction is +x
    const [p0, p1, p2, p3] = computeSquareCapPatch(freeEnd, neighbor, 4);
    // half = 2: two corners at freeEnd +/- perpendicular, two at the tip (freeEnd + 2 along +x) +/- perpendicular.
    expect(p0).toEqual({ x: 10, y: 2 });
    expect(p1).toEqual({ x: 12, y: 2 });
    expect(p2).toEqual({ x: 12, y: -2 });
    expect(p3).toEqual({ x: 10, y: -2 });
  });

  it("falls back to a unit direction when freeEnd and neighbor coincide, instead of producing NaN", () => {
    const p = { x: 5, y: 5 };
    const [p0, p1, p2, p3] = computeSquareCapPatch(p, p, 2);
    for (const corner of [p0, p1, p2, p3]) {
      expect(Number.isFinite(corner.x)).toBe(true);
      expect(Number.isFinite(corner.y)).toBe(true);
    }
  });
});

describe("computeDiagonalGapPatchGeometry", () => {
  it("pulls gapFrom/gapTo inward from from/to by gridInset, along each face's own perpendicular", () => {
    // Two faces both running along +x (a straight-through connector, parallel faces) — the inward
    // direction is then perpendicular to +x, i.e. along +/-y.
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 };
    const fromFaceDir = { x: 1, y: 0 };
    const toFaceDir = { x: 1, y: 0 };
    const { gapFrom, gapTo } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 3, 10);
    expect(gapFrom.x).toBeCloseTo(0, 5);
    expect(Math.abs(gapFrom.y)).toBeCloseTo(3, 5);
    expect(gapTo.x).toBeCloseTo(20, 5);
    expect(Math.abs(gapTo.y)).toBeCloseTo(3, 5);
  });

  it("does not clamp gapWidth for parallel faces (never intersect, so the ray-intersection cap is a no-op)", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 20, y: 0 };
    const fromFaceDir = { x: 1, y: 0 };
    const toFaceDir = { x: 1, y: 0 };
    const { clampedGapWidth } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 0, 10);
    expect(clampedGapWidth).toBe(10);
  });

  it("clamps gapWidth so the patch's own short ends never cross their own lines' intersection point", () => {
    // Two faces at a right angle, meeting close to from/to (a sharp corner) — the intersection of
    // the two short-end lines is nearby, so a large requested gapWidth must be clamped down.
    const from = { x: 0, y: 0 };
    const to = { x: 1, y: 0 };
    const fromFaceDir = { x: 0, y: 1 };
    const toFaceDir = { x: 1, y: 0 };
    const { clampedGapWidth } = computeDiagonalGapPatchGeometry(from, to, fromFaceDir, toFaceDir, 0, 1000);
    expect(clampedGapWidth).toBeLessThan(1000);
    expect(clampedGapWidth).toBeGreaterThanOrEqual(0);
  });

  it("keeps bridge gap ends independent when clipping a strip to a skewed cell", () => {
    const cell = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 10, y: 100 }];
    const clipped = clipStrokeToConvexPolygon({ x: 0, y: 50 }, { x: 100, y: 50 }, 40, cell, 1);
    expect(clipped).not.toBeNull();
    const minX = Math.min(...clipped!.map((point) => point.x));
    const maxX = Math.max(...clipped!.map((point) => point.x));
    expect(minX).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(100);
    expect(minX).not.toBeCloseTo(100 - maxX, 5);
  });
});

describe("corridorCellStep", () => {
  it("returns the shortest full-length segment as the grid step", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 69.3 } },
    ];
    expect(corridorCellStep(segs, 40)).toBeCloseTo(40, 5);
  });

  it("ignores split-touching segments (they stop at a face midpoint, ~half a step)", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 69.3, y: 0 } },
      { v0: { x: 69.3, y: 0 }, v1: { x: 104, y: 0 }, v1TouchesSplit: true }, // ~half step
    ];
    expect(corridorCellStep(segs, 40)).toBeCloseTo(69.3, 5);
  });

  it("falls back to the given value when no full segment survives", () => {
    expect(corridorCellStep([], 40)).toBe(40);
    expect(corridorCellStep([{ v0: { x: 1, y: 1 }, v1: { x: 1, y: 1 } }], 40)).toBe(40);
  });
});

const allPts = (paths: ContourPath[]): { x: number; y: number }[] => paths.flatMap((p) => contourToPolyline(p));

describe("buildCorridorContour", () => {
  it("returns nothing for no segments", () => {
    expect(buildCorridorContour([], 10)).toEqual([]);
  });

  // The contour is now built per tile: one closed, non-hole path for every cell that has a passage,
  // shapes meeting edge-to-edge on shared borders (the per-tile rework). No path is ever a hole.
  const arcsOf = (paths: ContourPath[]): { c: { x: number; y: number }; r: number }[] =>
    paths.flatMap((p) => p.cmds).filter((c): c is Extract<PathCmd, { kind: "arc" }> => c.kind === "arc");
  const smoothCurvesOf = (paths: ContourPath[]) =>
    paths.flatMap((p) => p.cmds).filter((c) => c.kind === "quadratic" || c.kind === "bezier");
  const pointDistance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const expectContinuousPath = (path: ContourPath) => {
    let current: { x: number; y: number } | null = null;
    for (const [index, cmd] of path.cmds.entries()) {
      if (cmd.kind === "move") {
        current = cmd.to;
      } else if (cmd.kind === "line") {
        current = cmd.to;
      } else if (cmd.kind === "quadratic") {
        current = cmd.to;
      } else if (cmd.kind === "bezier") {
        current = cmd.to;
      } else {
        const start = { x: cmd.c.x + Math.cos(cmd.a0) * cmd.r, y: cmd.c.y + Math.sin(cmd.a0) * cmd.r };
        const end = { x: cmd.c.x + Math.cos(cmd.a1) * cmd.r, y: cmd.c.y + Math.sin(cmd.a1) * cmd.r };
        expect(current).not.toBeNull();
        expect(pointDistance(current!, start), `disconnected arc at command ${index}`).toBeLessThan(1e-6);
        current = end;
      }
    }
  };

  it("draws a straight corridor tile by tile, no bulge past the walls", () => {
    // Three cells in a row (step 40), corridor width 20.
    const paths = buildCorridorContour(
      [{ v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } }, { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } }],
      20,
    );
    expect(paths.length).toBe(3);
    expect(paths.some((p) => p.hole)).toBe(false);
    // The middle (straight-through) tile never crosses y = +-10.
    const midYs = allPts([paths[1]]).map((p) => p.y);
    expect(Math.min(...midYs)).toBeGreaterThanOrEqual(-10.01);
    expect(Math.max(...midYs)).toBeLessThanOrEqual(10.01);
  });

  it("emits one path per tile for an S-bend, all finite, none a hole", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
      { v0: { x: 40, y: 40 }, v1: { x: 80, y: 40 } },
    ];
    const paths = buildCorridorContour(segs, 20);
    expect(paths.length).toBe(4); // two dead ends + two turns
    expect(paths.some((p) => p.hole)).toBe(false);
    for (const p of allPts(paths)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("keeps diagonal segment-adapter output finite", () => {
    const dir = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) }; // 30deg stub axis
    const centre = { x: 0, y: 0 };
    const border = { x: dir.x * 30, y: dir.y * 30 };
    for (const thickness of [7, 8, 8.5, 9, 10, 11, 13, 14, 17, 20, 23, 40]) {
      const paths = buildCorridorContour([{ v0: centre, v1: border }], thickness);
      for (const path of paths) {
        expect(path.hole).toBe(false);
        expectContinuousPath(path);
      }
      for (const point of allPts(paths)) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    }
  });

  it("builds a 90-degree turn tile with smooth offset rails (#493)", () => {
    // Middle cell of an L (step 40): passages west and north, corridor width 20.
    const paths = buildCorridorContour(
      [{ v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } }, { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } }],
      20,
    );
    const turn = paths[1]; // the turn tile (centre 40,0)
    // The universal contour renderer uses tangent-controlled smooth segments per rail. This keeps
    // both rails tied to the same centreline construction without tangent-intersection kinks.
    expect(smoothCurvesOf([turn]).length).toBeGreaterThan(2);
    // And the bend stays inside the tile — no bulge past its borders.
    const pts = allPts([turn]);
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThanOrEqual(19.99);
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThanOrEqual(-10.02);
  });

  it("builds a 120-degree hex turn tile with smooth offset rails (#493)", () => {
    // Hex step 60: passages at 0deg and at 120deg from a shared centre.
    const c = { x: 0, y: 0 };
    const a = { x: 60, y: 0 };
    const b = { x: -30, y: 51.96 };
    const paths = buildCorridorContour(
      [{ v0: a, v1: c }, { v0: c, v1: b }],
      20,
    );
    const turn = paths.find((p) => smoothCurvesOf([p]).length > 2)!;
    expect(turn).toBeDefined();
    expect(smoothCurvesOf([turn]).length).toBeGreaterThan(2);
  });

  it("draws a closed loop as four turn tiles, none a hole", () => {
    const p = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 },
    ];
    const segs = [
      { v0: p[0], v1: p[1] }, { v0: p[1], v1: p[2] },
      { v0: p[2], v1: p[3] }, { v0: p[3], v1: p[0] },
    ];
    const paths = buildCorridorContour(segs, 12);
    expect(paths.length).toBe(4);
    expect(paths.some((p) => p.hole)).toBe(false);
    // Every tile is a turn with smooth tangent-controlled segments on both rails.
    for (const path of paths) expect(smoothCurvesOf([path]).length).toBeGreaterThan(2);
  });

  it("draws a T-junction as one path per tile, none a hole", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
    ];
    const paths = buildCorridorContour(segs, 12);
    expect(paths.length).toBe(4); // three dead ends + the junction tile
    expect(paths.some((p) => p.hole)).toBe(false);
    const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    expect(junction.cmds.length).toBeGreaterThan(2);
    for (const p of allPts(paths)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("keeps a hex junction on 3 adjacent faces continuous at every width", () => {
    const c = { x: 0, y: 0 };
    const nb = (deg: number) => ({ x: 60 * Math.cos((deg * Math.PI) / 180), y: 60 * Math.sin((deg * Math.PI) / 180) });
    for (const h of [8, 12, 16, 20, 22]) {
      const paths = buildCorridorContour(
        [{ v0: c, v1: nb(0) }, { v0: c, v1: nb(60) }, { v0: c, v1: nb(120) }],
        h * 2,
      );
      const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
      expectContinuousPath(junction);
      for (const p of contourToPolyline(junction)) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it("draws a 4-way junction as one path per tile, none a hole (#493)", () => {
    const c = { x: 40, y: 40 };
    const segs = [
      { v0: c, v1: { x: 0, y: 40 } },
      { v0: c, v1: { x: 80, y: 40 } },
      { v0: c, v1: { x: 40, y: 0 } },
      { v0: c, v1: { x: 40, y: 80 } },
    ];
    const paths = buildCorridorContour(segs, 20);
    expect(paths.length).toBe(5); // four dead ends + the centre junction
    expect(paths.some((p) => p.hole)).toBe(false);
    const junction = paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    expectContinuousPath(junction);
  });

  it("junctionRadius 0 leaves junction corners sharp; the default radius rounds them", () => {
    const segs = [
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 80, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
    ];
    const junctionOf = (paths: ContourPath[]) => paths.reduce((a, b) => (b.cmds.length > a.cmds.length ? b : a));
    const rounded = junctionOf(buildCorridorContour(segs, 12));
    const sharp = junctionOf(buildCorridorContour(segs, 12, 0));
    expect(arcsOf([sharp])).toHaveLength(0);
    expect(arcsOf([rounded]).length).toBeGreaterThan(0);
  });
});

// corner style / border / gap, not the edge marker's.
describe("buildTeleportWidenMarkers floor badges (GitHub issue #701)", () => {
  it("uses teleportFloorBadge's own size, corner style, border and gap for a cross-floor badge point", () => {
    const settings: VectorByCorridorsSettings = {
      ...settingsA,
      teleportMarker: { ...settingsA.teleportMarker, cornerStyle: "round", borderWidth: 1, gapWidth: 1 },
      teleportFloorBadge: { ...settingsA.teleportFloorBadge, size: 14, cornerStyle: "miter", borderWidth: 4, gapWidth: 5 },
    };
    const edges = [{ from: [0, 0] as [number, number], to: [1, 1] as [number, number], oneWay: true, toFloor: 1 }];
    const markers = buildTeleportWidenMarkers(edges, settings, []);
    const badge = markers.find((m) => m.pos[0] === 1 && m.pos[1] === 1);
    expect(badge).toMatchObject({ radius: 7, cornerStyle: "miter", borderWidth: 4, gapWidth: 5 });
    const ordinary = markers.find((m) => m.pos[0] === 0);
    expect(ordinary).toMatchObject({ cornerStyle: "round", borderWidth: 1, gapWidth: 1 });
  });
});