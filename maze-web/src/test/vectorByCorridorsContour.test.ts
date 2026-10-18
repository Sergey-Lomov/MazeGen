import { describe, expect, it, vi } from "vitest";
import { Graphics } from "pixi.js";
import {
  buildCorridorContour,
  buildCorridorGeometry,
  buildCorridorGeometryDebug,
  buildCorridorGeometryInstances,
  contourToPolyline,
  corridorSegmentsToGeometryInput,
  contourToSvgPath,
  traceCorridorContour,
  type ContourPath,
  type CorridorCell,
  type CorridorPort,
  type CorridorShapeCache,
} from "../pixi/imageExport/vectorByCorridorsContour";
import { convexPolygonOutsideDistance } from "./polygonTestHelpers";

describe("curved face ports", () => {
  // Square cell whose east face bulges outward as an arc through (10,-5), (12,0), (10,5).
  const east = [{ x: 10, y: -5 }, { x: 11.4, y: -2.5 }, { x: 12, y: 0 }, { x: 11.4, y: 2.5 }, { x: 10, y: 5 }];
  const polygon = [{ x: -10, y: -5 }, ...east, { x: -10, y: 5 }];
  const segment = { v0: { x: 0, y: 0 }, v1: { x: 24, y: 0 }, faceMidpoint: { x: 12, y: 0 }, faceNormal: { x: 1, y: 0 }, faceLength: 10, facePolyline: east, cellVertices0: polygon };

  it("takes the mouth ends from the face curve and its normal from the curve's tangent", () => {
    const { ports } = corridorSegmentsToGeometryInput([segment], 4);
    expect(ports[0].facePolyline).toBe(east);
    expect(ports[0].normal.x).toBeCloseTo(1);
    expect(ports[0].normal.y).toBeCloseTo(0);
    const input = corridorSegmentsToGeometryInput([segment], 4);
    const ribbon = buildCorridorGeometryDebug(input.cells, input.ports, 4, 1)[0].ribbons[0];
    // Half-width 2 along the curve from the apex: both ends sit on the bulge, not on the x = 12 tangent line.
    for (const end of [ribbon.left[0], ribbon.right[0]]) {
      expect(end.x).toBeLessThan(12 - 1e-6);
      expect(Math.abs(end.y)).toBeGreaterThan(1.5);
    }
  });

  it("matches the mirrored mouth of the neighbouring cell", () => {
    const neighbour = {
      ...segment,
      v0: segment.v1,
      v1: segment.v0,
      faceNormal: { x: -1, y: 0 },
      // The neighbour's west side is the same curve, concave from its side.
      cellVertices0: [...east, { x: 34, y: 5 }, { x: 34, y: -5 }],
    };
    const mouth = (input: typeof segment) => {
      const { cells, ports } = corridorSegmentsToGeometryInput([input], 4);
      const ribbon = buildCorridorGeometryDebug(cells, ports, 4, 1)[0].ribbons[0];
      return [ribbon.left[0], ribbon.right[0]].map((p) => p.x.toFixed(6) + "," + p.y.toFixed(6)).sort();
    };
    expect(mouth(neighbour)).toEqual(mouth(segment));
  });
});

describe("universal corridor contour", () => {
  const cell: CorridorCell = {
    id: "square",
    center: { x: 0, y: 0 },
    polygon: [
      { x: -50, y: -50 },
      { x: 50, y: -50 },
      { x: 50, y: 50 },
      { x: -50, y: 50 },
    ],
  };

  const port = (midpoint: { x: number; y: number }, normal: { x: number; y: number }): CorridorPort => ({
    cellId: "square",
    midpoint,
    normal,
  });

  it("turns two side-by-side ports facing the same way in a U without folding the ribbon", () => {
    // The two half faces of a brick edge: collinear, 20 apart, both looking out of the cell.
    const brick: CorridorCell = {
      id: "square",
      center: { x: 0, y: 0 },
      polygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }],
    };
    const ports = [port({ x: -10, y: 20 }, { x: 0, y: 1 }), port({ x: 10, y: 20 }, { x: 0, y: 1 })];
    for (const thickness of [4, 10, 16]) {
      const [debug] = buildCorridorGeometryDebug([brick], ports, thickness);
      // Half a circle over the chord: the target sits one radius (10) below the faces.
      expect(debug.target.y).toBeCloseTo(10, 6);
      for (const ribbon of debug.rawRibbons) {
        for (const side of [ribbon.left, ribbon.right]) {
          // Each side only ever goes down and towards the middle, never back out past its port.
          for (const point of side) expect(point.y).toBeLessThanOrEqual(20 + 1e-9);
          for (let index = 1; index < side.length; index++) {
            expect(side[index].y).toBeLessThanOrEqual(side[index - 1].y + 1e-9);
          }
        }
      }
    }
  });

  it("keeps the pass through the cell centre when another port faces the same way as one of its ends", () => {
    // Half faces of one brick: south ports at x = ±10 and a north port at x = -10. The north port
    // is opposite both south ports; the pair mirrored through the centre (x = 10 and x = -10)
    // is the straight pass and the other south port branches off it.
    const brick: CorridorCell = {
      id: "square",
      center: { x: 0, y: 0 },
      polygon: [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }],
    };
    const south = (x: number) => port({ x, y: -20 }, { x: 0, y: -1 });
    const north = port({ x: -10, y: 20 }, { x: 0, y: 1 });
    const [debug] = buildCorridorGeometryDebug([brick], [south(10), south(-10), north], 6);
    expect(debug.target.x).toBeCloseTo(0, 6);
    expect(debug.target.y).toBeCloseTo(0, 6);
    // The straight pass meets the target from opposite sides along one tangent.
    const arrivals = debug.centerCurves.map((curve) => {
      const bezier = curve.path[1];
      return bezier.kind === "bezier" ? { from: bezier.cp2, to: bezier.to } : undefined;
    });
    const tangents = arrivals.map((arrival) => arrival && { x: arrival.to.x - arrival.from.x, y: arrival.to.y - arrival.from.y });
    const smoothPairs = tangents.flatMap((a, i) => tangents.slice(i + 1).map((b) => ({ a, b })))
      .filter(({ a, b }) => a && b && Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y < 0);
    expect(smoothPairs).toHaveLength(1);
  });

  it("serializes every universal command without changing its geometry type", () => {
    const d = contourToSvgPath([{
      hole: false,
      cmds: [
        { kind: "move", to: { x: 0, y: 0 } },
        { kind: "quadratic", cp: { x: 4, y: 6 }, to: { x: 10, y: 0 } },
        { kind: "bezier", cp1: { x: 12, y: -2 }, cp2: { x: 18, y: -2 }, to: { x: 20, y: 0 } },
        { kind: "arc", c: { x: 20, y: 10 }, r: 10, a0: -Math.PI / 2, a1: 0, ccw: false },
        { kind: "line", to: { x: 0, y: 20 } },
      ],
    }]);

    expect(d).toContain("Q 4 6 10 0");
    expect(d).toContain("C 12 -2 18 -2 20 0");
    expect(d).toContain("A 10 10 0 0 1 30 10");
    expect(d).toContain("L 0 20 Z");
  });

  it.each([
    ["one port", [port({ x: 0, y: -40 }, { x: 0, y: -1 })]],
    ["two ports", [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 0, y: 40 }, { x: 0, y: 1 }),
    ]],
    ["three ports", [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
      port({ x: 0, y: 40 }, { x: 0, y: 1 }),
    ]],
  ])("runs %s through target, center curves, ribbons, and contour", (_name, ports) => {
    const debug = buildCorridorGeometryDebug([cell], ports, 20, 4);
    const production = buildCorridorGeometry([cell], ports, 20, 4);

    expect(debug).toHaveLength(1);
    expect(Number.isFinite(debug[0].target.x)).toBe(true);
    expect(Number.isFinite(debug[0].target.y)).toBe(true);
    expect(debug[0].centerCurves).toHaveLength(ports.length);
    expect(debug[0].centerCurves.every((curve) => curve.path.some((command) => command.kind === "bezier"))).toBe(true);
    expect(debug[0].ribbons).toHaveLength(ports.length);
    expect(debug[0].ribbons.every((ribbon) => ribbon.left.length > 2 && ribbon.right.length > 2)).toBe(true);
    expect(debug[0].contour).toEqual(production);

    const contour = debug[0].contour[0];
    expect(contour).toBeDefined();
    expect(contour!.cmds.length).toBeGreaterThan(2);
    for (const point of contourToPolyline(contour!)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("closes a one-port ribbon with a target-centered arc", () => {
    const [result] = buildCorridorGeometry([cell], [port({ x: 0, y: -40 }, { x: 0, y: -1 })], 20, 8);
    expect(result).toBeDefined();
    const arc = result!.cmds.find((command) => command.kind === "arc");
    expect(arc).toBeDefined();
    expect(arc && arc.kind === "arc" ? arc.c : undefined).toEqual(cell.center);
  });

  it("places the target at the center of the direct pair curve", () => {
    const ports = [
      port({ x: 20, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 10 }, { x: 1, y: 0 }),
    ];
    const [debug] = buildCorridorGeometryDebug([cell], ports, 20);
    expect(debug.target.x).toBeGreaterThan(20);
    expect(debug.target.y).toBeLessThan(0);
  });

  it("moves a square two-port turn target away from the cell center", () => {
    const ports = [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
    ];
    const [debug] = buildCorridorGeometryDebug([cell], ports, 20);
    expect(debug.target.x).toBeGreaterThan(0);
    expect(debug.target.y).toBeLessThan(0);
  });

  it("uses opposite target tangents for the most opposite pair", () => {
    const ports = [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
    ];
    const [debug] = buildCorridorGeometryDebug([cell], ports, 20);
    const curves = debug.centerCurves.map((curve) => curve.path.find((command) => command.kind === "bezier"));
    expect(curves.every((curve) => curve?.kind === "bezier")).toBe(true);
    const first = curves[0];
    const second = curves[1];
    if (first?.kind !== "bezier" || second?.kind !== "bezier") return;
    const firstTangent = { x: debug.target.x - first.cp2.x, y: debug.target.y - first.cp2.y };
    const secondTangent = { x: debug.target.x - second.cp2.x, y: debug.target.y - second.cp2.y };
    const firstLength = Math.hypot(firstTangent.x, firstTangent.y);
    const secondLength = Math.hypot(secondTangent.x, secondTangent.y);
    const tangentDot = (firstTangent.x * secondTangent.x + firstTangent.y * secondTangent.y) / (firstLength * secondLength);
    expect(tangentDot).toBeCloseTo(-1, 5);
  });

  it("draws both sides of a thick adjacent-face turn as concentric arcs around the shared corner", () => {
    const hex = Array.from({ length: 6 }, (_, index) => ({
      x: 100 * Math.cos(index * Math.PI / 3),
      y: 100 * Math.sin(index * Math.PI / 3),
    }));
    const facePort = (index: number): CorridorPort => {
      const a = hex[index];
      const b = hex[(index + 1) % 6];
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const length = Math.hypot(midpoint.x, midpoint.y);
      return { cellId: "hex", midpoint, normal: { x: midpoint.x / length, y: midpoint.y / length }, face: [a, b] };
    };
    const corner = hex[1];
    const [result] = buildCorridorGeometry([{ id: "hex", center: { x: 0, y: 0 }, polygon: hex }], [facePort(0), facePort(1)], 70);
    const radii = contourToPolyline(result!, 1).map((point) => Math.hypot(point.x - corner.x, point.y - corner.y));
    // The port midpoints are 50 away from the corner: the inner side follows radius 15, the outer 85.
    const inner = radii.filter((radius) => radius < 49);
    const outer = radii.filter((radius) => radius > 51);
    expect(Math.min(...inner)).toBeGreaterThan(14.9);
    expect(Math.max(...inner)).toBeLessThan(15.1);
    expect(Math.min(...outer)).toBeGreaterThan(84.8);
    expect(Math.max(...outer)).toBeLessThan(85.2);
  });

  it("bends neighboring faces more than faces separated by one side", () => {
    const rootThree = Math.sqrt(3);
    const adjacent = [
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
      port({ x: 20, y: 20 * rootThree }, { x: 0.5, y: rootThree / 2 }),
    ];
    const separated = [
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
      port({ x: -20, y: 20 * rootThree }, { x: -0.5, y: rootThree / 2 }),
    ];
    const handleRatios = (ports: CorridorPort[]) => buildCorridorGeometryDebug([cell], ports, 8)[0].centerCurves.map((curve) => {
      const move = curve.path.find((command) => command.kind === "move");
      const bezier = curve.path.find((command) => command.kind === "bezier");
      if (move?.kind !== "move" || bezier?.kind !== "bezier") return 0;
      const distance = Math.hypot(bezier.to.x - move.to.x, bezier.to.y - move.to.y);
      return distance > 0 ? Math.hypot(bezier.cp1.x - move.to.x, bezier.cp1.y - move.to.y) / distance : 0;
    });

    expect(Math.max(...handleRatios(adjacent))).toBeGreaterThan(Math.max(...handleRatios(separated)));
  });

  it("does not collapse a thick turn bridge into an endpoint control point", () => {
    const [result] = buildCorridorGeometry([cell], [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
    ], 30, 4);
    expect(result).toBeDefined();
    let current = result!.cmds[0]?.kind === "move" ? result!.cmds[0].to : undefined;
    for (const command of result!.cmds.slice(1)) {
      if (command.kind === "quadratic") {
        expect(command.cp).not.toEqual(command.to);
        expect(command.cp).not.toEqual(current);
      }
      if (command.kind !== "arc") current = command.to;
      else current = { x: command.c.x + Math.cos(command.a1) * command.r, y: command.c.y + Math.sin(command.a1) * command.r };
    }
  });

  it("keeps radius zero sharp and applies positive radius only in the final contour stage", () => {
    const ports = [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
      port({ x: 0, y: 40 }, { x: 0, y: 1 }),
    ];
    const [sharp] = buildCorridorGeometry([cell], ports, 20, 0);
    const [rounded] = buildCorridorGeometry([cell], ports, 20, 8);

    expect(sharp.cmds.some((command) => command.kind === "arc")).toBe(false);
    expect(contourToSvgPath([{ cmds: sharp.cmds, hole: false }]))
      .not.toBe(contourToSvgPath([{ cmds: rounded.cmds, hole: false }]));
  });

  it("uses the same pipeline for segment adapters and emits one path per touched tile", () => {
    const paths = buildCorridorContour([
      { v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } },
      { v0: { x: 40, y: 0 }, v1: { x: 40, y: 40 } },
    ], 20);

    expect(paths).toHaveLength(3);
    expect(paths.every((path) => path.hole === false && path.cmds.length > 2)).toBe(true);
  });

  it("shares one shape object per key across tiles and calls through the shape cache", () => {
    const square = (id: string, x: number): CorridorCell => ({
      id, center: { x, y: 0 },
      polygon: [{ x: x - 50, y: -50 }, { x: x + 50, y: -50 }, { x: x + 50, y: 50 }, { x: x - 50, y: 50 }],
    });
    const deadEnd = (id: string, x: number): CorridorPort => ({ cellId: id, midpoint: { x, y: -50 }, normal: { x: 0, y: -1 } });
    const cells = [square("a", 0), square("b", 300)];
    const ports = [deadEnd("a", 0), deadEnd("b", 300)];
    const cache: CorridorShapeCache = new Map();

    const first = buildCorridorGeometryInstances(cells, ports, 20, 4, cache);
    expect(first.map((instance) => instance.offset)).toEqual([{ x: 0, y: 0 }, { x: 300, y: 0 }]);
    expect(first[0].key).toBe(first[1].key);
    expect(first[0].shape).toBe(first[1].shape);
    expect(cache.size).toBe(1);

    // A later call reuses the cached shape object; another thickness or radius is a new key.
    expect(buildCorridorGeometryInstances(cells, ports, 20, 4, cache)[0].shape).toBe(first[0].shape);
    expect(buildCorridorGeometryInstances(cells, ports, 24, 4, cache)[0].key).not.toBe(first[0].key);
    expect(buildCorridorGeometryInstances(cells, ports, 20, 6, cache)[0].key).not.toBe(first[0].key);
    expect(cache.size).toBe(3);
  });

  it("reuses one shape per tile type, matching the per-tile build translated to each tile", () => {
    // Square grid at a non-trivial offset; edges chosen so tiles cover dead ends, straights, turns,
    // T-junctions and crossings, each type repeated in several places.
    const size = 6;
    const step = 37.3;
    const origin = { x: 1234.567, y: -987.65 };
    const id = (i: number, j: number) => `${i},${j}`;
    const cells: CorridorCell[] = [];
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const c = { x: origin.x + i * step, y: origin.y + j * step };
        const h = step / 2;
        cells.push({ id: id(i, j), center: c, polygon: [
          { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
        ] });
      }
    }
    const ports: CorridorPort[] = [];
    const connect = (i: number, j: number, di: number, dj: number) => {
      const a = { x: origin.x + i * step, y: origin.y + j * step };
      const midpoint = { x: a.x + di * step / 2, y: a.y + dj * step / 2 };
      const face = [
        { x: midpoint.x - dj * step / 2, y: midpoint.y - di * step / 2 },
        { x: midpoint.x + dj * step / 2, y: midpoint.y + di * step / 2 },
      ] as const;
      ports.push({ cellId: id(i, j), midpoint, normal: { x: di, y: dj }, face });
      ports.push({ cellId: id(i + di, j + dj), midpoint, normal: { x: -di, y: -dj }, face });
    };
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (i + 1 < size && (i * 7 + j * 3) % 5 < 3) connect(i, j, 1, 0);
        if (j + 1 < size && (i * 2 + j * 5) % 4 < 2) connect(i, j, 0, 1);
      }
    }

    const cached = buildCorridorGeometry(cells, ports, 14, 5);
    const reference = buildCorridorGeometryDebug(cells, ports, 14, 5)
      .map((tile) => tile.contour[0])
      .filter((path): path is ContourPath => path !== undefined && path.cmds.length >= 2);

    // The same closed shape may start at a different port: a port at angle ±π sorts first or last
    // depending on float noise. So compare sampled outlines as point sets, plus signed area.
    expect(cached).toHaveLength(reference.length);
    const area = (points: { x: number; y: number }[]) =>
      points.reduce((sum, p, k) => { const q = points[(k + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
    const covers = (from: { x: number; y: number }[], to: { x: number; y: number }[]) =>
      from.every((p) => to.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6));
    cached.forEach((path, index) => {
      const actual = contourToPolyline(path);
      const expected = contourToPolyline(reference[index]);
      expect(area(actual)).toBeCloseTo(area(expected), 6);
      expect(covers(actual, expected)).toBe(true);
      expect(covers(expected, actual)).toBe(true);
    });
  });

  it("supports irregular convex cells without producing non-finite contour points", () => {
    const irregular: CorridorCell = {
      id: "irregular",
      center: { x: 0, y: 0 },
      polygon: [
        { x: -24, y: -12 },
        { x: 18, y: -18 },
        { x: 28, y: 10 },
        { x: 4, y: 24 },
        { x: -26, y: 14 },
      ],
    };
    const ports: CorridorPort[] = [
      { cellId: "irregular", midpoint: { x: -3, y: -15 }, normal: { x: -6, y: -42 } },
      { cellId: "irregular", midpoint: { x: 23, y: -4 }, normal: { x: 28, y: -10 } },
      { cellId: "irregular", midpoint: { x: -11, y: 19 }, normal: { x: -10, y: 30 } },
    ];
    const [path] = buildCorridorGeometry([irregular], ports, 10);
    expect(path).toBeDefined();
    for (const point of contourToPolyline(path)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });


  describe("dead-end cap", () => {
    // A 64x24 cell with its port in the middle of the top face. A 40px corridor gives a cap of
    // radius 20, which needs 20px of depth ahead of its centre.
    const shallow: CorridorCell = { id: "shallow", center: { x: 0, y: 0 }, polygon: [{ x: -32, y: -12 }, { x: 32, y: -12 }, { x: 32, y: 12 }, { x: -32, y: 12 }] };
    const topPort: CorridorPort = { cellId: "shallow", midpoint: { x: 0, y: -12 }, normal: { x: 0, y: -1 }, face: [{ x: -32, y: -12 }, { x: 32, y: -12 }] };

    it("stays centred on the cell centre when it fits there", () => {
      const [debug] = buildCorridorGeometryDebug([shallow], [topPort], 20);
      expect(debug.target).toEqual(shallow.center);
    });

    it("moves back along the centre curve to the farthest point where it fits", () => {
      const [debug] = buildCorridorGeometryDebug([shallow], [topPort], 40);
      // The cell is 24px deep, so the cap centre sits 24 - 20 = 4px below the port.
      expect(debug.target.x).toBeCloseTo(0, 6);
      expect(debug.target.y).toBeCloseTo(-8, 6);
      const contour = debug.contour[0];
      const arc = contour.cmds.find((command) => command.kind === "arc");
      expect(arc?.kind === "arc" ? arc.r : 0).toBeCloseTo(20, 6);
      for (const point of contourToPolyline(contour, 0.5)) {
        expect(Math.abs(point.x)).toBeLessThanOrEqual(32 + 1e-6);
        expect(Math.abs(point.y)).toBeLessThanOrEqual(12 + 1e-6);
      }
    });

    it("still bulges into the cell when it fits only just past the port", () => {
      // An irregular triangle whose dead-end cap fits only right next to its port: the ribbon is then
      // too short for its sampled sides to give a direction, and the cap used to flip out through the
      // port's own face (10px outside the cell).
      const polygon = [{ x: 0.8, y: 31.1 }, { x: -24.5, y: 24.7 }, { x: -33.6, y: -17.1 }];
      const centre = { x: -19.1, y: 12.9 };
      const [a, b] = [polygon[2], polygon[0]];
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      let normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
      if (normal.x * (midpoint.x - centre.x) + normal.y * (midpoint.y - centre.y) < 0) normal = { x: -normal.x, y: -normal.y };
      const [debug] = buildCorridorGeometryDebug(
        [{ id: "triangle", center: centre, polygon }],
        [{ cellId: "triangle", midpoint, normal, face: [a, b] }],
        20,
      );
      const worst = Math.max(...contourToPolyline(debug.contour[0], 0.5).map((point) => convexPolygonOutsideDistance(point, polygon)));
      expect(worst).toBeLessThan(1e-6);
    });

    it("bends into the deepest arc through the mouth ends when it does not fit even at the port", () => {
      // 14px deep: the round cap would need 20px, so the arc through the mouth ends (±20 on the face)
      // has a 14px sagitta, radius (20² + 14²) / (2 · 14), and meets the mouth at an angle.
      const thin: CorridorCell = { ...shallow, polygon: [{ x: -32, y: -7 }, { x: 32, y: -7 }, { x: 32, y: 7 }, { x: -32, y: 7 }] };
      const port: CorridorPort = { ...topPort, midpoint: { x: 0, y: -7 }, face: [{ x: -32, y: -7 }, { x: 32, y: -7 }] };
      const [debug] = buildCorridorGeometryDebug([thin], [port], 40);
      expect(debug.target).toEqual(port.midpoint);
      const cmds = debug.contour[0].cmds;
      expect(cmds.map((command) => command.kind)).toEqual(["move", "arc", "line"]);
      const [move, arc] = cmds;
      if (move.kind !== "move" || arc.kind !== "arc") return;
      expect(Math.abs(move.to.x)).toBeCloseTo(20, 9);
      expect(move.to.y).toBeCloseTo(-7, 9);
      const radius = (20 * 20 + 14 * 14) / (2 * 14);
      expect(arc.r).toBeCloseTo(radius, 9);
      expect(arc.c.x).toBeCloseTo(0, 9);
      expect(arc.c.y).toBeCloseTo(-7 + 14 - radius, 9);
      expect(arc.c.y + arc.r).toBeCloseTo(7, 9); // the apex touches the far face
      for (const point of contourToPolyline(debug.contour[0], 0.5)) expect(Math.abs(point.y)).toBeLessThanOrEqual(7 + 1e-9);
    });
  });

  it("skips ports whose cell is unknown", () => {
    const known = port({ x: 0, y: -40 }, { x: 0, y: -1 });
    const orphan = { ...port({ x: 40, y: 0 }, { x: 1, y: 0 }), cellId: "missing" };
    expect(buildCorridorGeometry([cell], [known, orphan], 20)).toEqual(buildCorridorGeometry([cell], [known], 20));
  });

  it("segment adapter ignores zero-length segments", () => {
    const segments = [{ v0: { x: 0, y: 0 }, v1: { x: 40, y: 0 } }];
    expect(buildCorridorContour([...segments, { v0: { x: 0, y: 0 }, v1: { x: 0, y: 0 } }], 20))
      .toEqual(buildCorridorContour(segments, 20));
  });

  it("segment adapter takes a cell polygon from whichever segment supplies it", () => {
    // Without a polygon the adapter falls back to a square of half-side `thickness` (16), which
    // cuts the mouths at x = 20 / y = -20 short; the real 40px cell lets them reach its faces.
    const square = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }];
    const centre = { x: 0, y: 0 };
    const east = { v0: centre, v1: { x: 20, y: 0 }, v1TouchesSplit: true };
    const north = { v0: centre, v1: { x: 0, y: -20 }, v1TouchesSplit: true };
    const reachEast = (paths: ContourPath[]) => Math.max(...paths.flatMap((path) => contourToPolyline(path, 1)).map((point) => point.x));
    expect(reachEast(buildCorridorContour([east, north], 16))).toBeLessThanOrEqual(16 + 1e-6);
    expect(reachEast(buildCorridorContour([east, { ...north, cellVertices0: square }], 16))).toBeCloseTo(20, 6);
    expect(reachEast(buildCorridorContour([{ ...east, cellVertices0: square }, north], 16))).toBeCloseTo(20, 6);
  });

  it("traces every command kind onto the graphics and closes each path", () => {
    const graphics = {
      moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), bezierCurveTo: vi.fn(), arc: vi.fn(), closePath: vi.fn(),
    };
    traceCorridorContour(graphics as unknown as Graphics, [{
      hole: false,
      cmds: [
        { kind: "move", to: { x: 0, y: 0 } },
        { kind: "line", to: { x: 1, y: 0 } },
        { kind: "quadratic", cp: { x: 2, y: 1 }, to: { x: 3, y: 0 } },
        { kind: "bezier", cp1: { x: 4, y: 1 }, cp2: { x: 5, y: 1 }, to: { x: 6, y: 0 } },
        { kind: "arc", c: { x: 6, y: 1 }, r: 1, a0: -Math.PI / 2, a1: 0, ccw: false },
      ],
    }]);
    expect(graphics.moveTo).toHaveBeenCalledWith(0, 0);
    expect(graphics.lineTo).toHaveBeenCalledWith(1, 0);
    expect(graphics.quadraticCurveTo).toHaveBeenCalledWith(2, 1, 3, 0);
    expect(graphics.bezierCurveTo).toHaveBeenCalledWith(4, 1, 5, 1, 6, 0);
    expect(graphics.arc).toHaveBeenCalledWith(6, 1, 1, -Math.PI / 2, 0, false);
    expect(graphics.closePath).toHaveBeenCalledTimes(1);
  });

  it("samples quadratic segments along the curve", () => {
    const points = contourToPolyline({
      hole: false,
      cmds: [{ kind: "move", to: { x: 0, y: 0 } }, { kind: "quadratic", cp: { x: 2, y: 4 }, to: { x: 4, y: 0 } }],
    }, 1);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 4, y: 0 });
    expect(points).toContainEqual({ x: 2, y: 2 }); // t = 1/2
  });

  it("serializes open paths without Z, splits long arcs, and drops empty arcs", () => {
    const d = contourToSvgPath([{
      hole: false,
      cmds: [
        { kind: "move", to: { x: -0, y: 0 } },
        { kind: "arc", c: { x: 0, y: 0 }, r: 5, a0: 0, a1: 0, ccw: false },
        { kind: "arc", c: { x: 1, y: 0 }, r: 1, a0: Math.PI, a1: 0, ccw: true },
        { kind: "arc", c: { x: 1, y: 0 }, r: 1, a0: 0, a1: -Math.PI / 2, ccw: false },
      ],
    }], false);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d).not.toContain("Z");
    expect(d).not.toContain("A 5 5");
    // The 270-degree clockwise arc is split into two SVG arc segments of at most 180 degrees each.
    expect(d.match(/A 1 1 0 0 1 /g)).toHaveLength(2);
    expect(d.match(/A 1 1 0 0 0 /g)).toHaveLength(1);
  });

  describe("SVG and pixi output draw the same arcs", () => {
    type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
    const boundsOf = (points: { x: number; y: number }[]): Bounds => ({
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    });

    /** Samples an SVG path of `M` and circular `A` commands (rotation 0, rx = ry) by the SVG spec's
     *  endpoint-to-centre conversion, independently of the engine's own arc model. */
    const sampleSvgPath = (d: string): { x: number; y: number }[] => {
      const tokens = d.trim().split(/\s+/);
      const points: { x: number; y: number }[] = [];
      let current = { x: 0, y: 0 };
      for (let index = 0; index < tokens.length;) {
        const command = tokens[index++];
        if (command === "M") {
          current = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
          points.push(current);
        } else if (command === "A") {
          const r = Number(tokens[index]);
          const largeArc = tokens[index + 3] === "1";
          const sweep = tokens[index + 4] === "1";
          const end = { x: Number(tokens[index + 5]), y: Number(tokens[index + 6]) };
          index += 7;
          const half = { x: (current.x - end.x) / 2, y: (current.y - end.y) / 2 };
          const halfSq = half.x * half.x + half.y * half.y;
          const factor = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, (r * r - halfSq) / halfSq));
          const centre = { x: factor * half.y + (current.x + end.x) / 2, y: -factor * half.x + (current.y + end.y) / 2 };
          const start = Math.atan2(current.y - centre.y, current.x - centre.x);
          let delta = Math.atan2(end.y - centre.y, end.x - centre.x) - start;
          if (sweep && delta < 0) delta += Math.PI * 2;
          if (!sweep && delta > 0) delta -= Math.PI * 2;
          for (let step = 1; step <= 64; step++) {
            const angle = start + delta * step / 64;
            points.push({ x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r });
          }
          current = end;
        } else if (command === "Z") {
          continue;
        } else {
          throw new Error("unexpected SVG command " + command);
        }
      }
      return points;
    };

    const angles = [0, Math.PI / 3, Math.PI / 2, (5 * Math.PI) / 6, Math.PI, (-2 * Math.PI) / 3];
    const arcs = angles.flatMap((a0) => angles.filter((a1) => a1 !== a0).flatMap((a1) => [true, false].map((ccw) => ({ a0, a1, ccw }))));

    it.each(arcs)("a0=$a0 a1=$a1 ccw=$ccw", ({ a0, a1, ccw }) => {
      const c = { x: 5, y: -3 };
      const r = 10;
      const path: ContourPath = {
        hole: false,
        cmds: [{ kind: "move", to: { x: c.x + Math.cos(a0) * r, y: c.y + Math.sin(a0) * r } }, { kind: "arc", c, r, a0, a1, ccw }],
      };
      const model = boundsOf(contourToPolyline(path, 0.1));
      const svg = boundsOf(sampleSvgPath(contourToSvgPath([path])));
      const graphics = new Graphics();
      traceCorridorContour(graphics, [path]);
      graphics.stroke({ width: 1e-6 });
      const pixi = graphics.bounds;
      // All three sample the arc differently (the engine every 0.2 rad, short of the true extent by up
      // to r * (1 - cos 0.1) ≈ 0.05), so allow small noise; a wrong sweep direction moves a bound by
      // a sizeable part of the radius.
      for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
        expect(Math.abs(svg[key] - model[key]), `svg ${key}`).toBeLessThan(0.25);
        expect(Math.abs(pixi[key] - model[key]), `pixi ${key}`).toBeLessThan(0.25);
      }
    });
  });
});
