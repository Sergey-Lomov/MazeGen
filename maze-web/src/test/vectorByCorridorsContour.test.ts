import { describe, expect, it } from "vitest";
import {
  buildCorridorContour,
  buildCorridorGeometry,
  buildCorridorGeometryDebug,
  contourToPolyline,
  contourToSvgPath,
  type CorridorCell,
  type CorridorPort,
  type PathCmd,
} from "../pixi/imageExport/vectorByCorridorsContour";

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
    const debug = buildCorridorGeometryDebug([cell], ports, 20, true, 4);
    const production = buildCorridorGeometry([cell], ports, 20, true, 4);

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
    const [result] = buildCorridorGeometry([cell], [port({ x: 0, y: -40 }, { x: 0, y: -1 })], 20, true, 8);
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
    ], 30, true, 4);
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
    const [sharp] = buildCorridorGeometry([cell], ports, 20, true, 0);
    const [rounded] = buildCorridorGeometry([cell], ports, 20, true, 8);

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

  it("keeps production output equal to the debug final contour", () => {
    const ports = [
      port({ x: 0, y: -40 }, { x: 0, y: -1 }),
      port({ x: 40, y: 0 }, { x: 1, y: 0 }),
      port({ x: 0, y: 40 }, { x: 0, y: 1 }),
    ];
    const [debug] = buildCorridorGeometryDebug([cell], ports, 20, true, 6);
    const [production] = buildCorridorGeometry([cell], ports, 20, true, 6);
    expect(debug.contour).toEqual([production]);
  });

  it("keeps command typing explicit for lab and renderer consumers", () => {
    const commands: PathCmd[] = [
      { kind: "move", to: { x: 0, y: 0 } },
      { kind: "line", to: { x: 1, y: 0 } },
    ];
    expect(commands[0].kind).toBe("move");
  });
});
