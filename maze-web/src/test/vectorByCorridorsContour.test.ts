import { describe, expect, it } from "vitest";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors";
import { getCellVertices, getSharedEdgeSegment } from "../pixi/tessellationGeometry";
import { buildCorridorContour, contourToPolyline, type PathCmd } from "../pixi/imageExport/vectorByCorridorsContour";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

describe("buildCorridorContour", () => {
  const pointInConvexPolygon = (point: { x: number; y: number }, vertices: { x: number; y: number }[]): boolean => {
    let positive = false;
    let negative = false;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      if (cross > 1e-6) positive = true;
      if (cross < -1e-6) negative = true;
    }
    return !(positive && negative);
  };

  it("uses Cairo's face centre and perpendicular normal while preserving a 20px corridor", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const a: [number, number] = [2, 1];
    const b: [number, number] = [-1, 2];
    const nodes: NodeDto[] = [
      { id: 0, x: a[0], y: a[1], i: 0 },
      { id: 1, x: b[0], y: b[1], i: 0 },
    ];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" },
      { from: 1, to: 0, kind: "basic" },
    ];
    const [segment] = buildCorridorSegments(nodes, edges, cfg);
    const face = getSharedEdgeSegment(a, b, cfg);
    expect(segment?.faceMidpoint).toBeDefined();
    expect(face).not.toBeNull();
    const expected = segment!.faceMidpoint!;
    const paths = buildCorridorContour([segment], 20);
    expect(paths).toHaveLength(2);

    for (const path of paths) {
      // A one-port contour starts at one edge of the face and reaches the opposite edge before its
      // inward cap. Their midpoint is the port mouth, so it must be the face centre.
      const first = path.cmds[0];
      expect(first.kind).toBe("move");
      if (first.kind !== "move") continue;
      const opposite = path.cmds
        .filter((cmd): cmd is Extract<PathCmd, { kind: "quadratic" }> => cmd.kind === "quadratic")
        .map((cmd) => cmd.to)
        .find((point) => Math.abs((first.to.x + point.x) / 2 - expected.x) < 1e-6 && Math.abs((first.to.y + point.y) / 2 - expected.y) < 1e-6);
      expect(opposite).toBeDefined();
      expect(Math.hypot(first.to.x - opposite!.x, first.to.y - opposite!.y)).toBeCloseTo(20);
    }
  });

  it("keeps both endpoints of a Cairo turn arc on the two face mouths", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const centre: [number, number] = [2, 1];
    const neighbours: [number, number][] = [[2, 3], [-1, 2]];
    const nodes: NodeDto[] = [
      { id: 0, x: centre[0], y: centre[1], i: 0 },
      ...neighbours.map(([x, y], id) => ({ id: id + 1, x, y, i: 0 })),
    ];
    const edges: EdgeDto[] = neighbours.flatMap((_, id) => [
      { from: 0, to: id + 1, kind: "basic" as const },
      { from: id + 1, to: 0, kind: "basic" as const },
    ]);
    const segments = buildCorridorSegments(nodes, edges, cfg);
    const paths = buildCorridorContour(segments, 20);
    const turn = paths.find((path) => path.cmds.filter((cmd) => cmd.kind === "arc" || cmd.kind === "bezier").length === 2);
    expect(turn).toBeDefined();

    const mouthData = segments.map((segment) => {
      const tangent = { x: -segment.faceNormal!.y, y: segment.faceNormal!.x };
      return [
        { point: { x: segment.faceMidpoint!.x + tangent.x * 10, y: segment.faceMidpoint!.y + tangent.y * 10 }, normal: segment.faceNormal! },
        { point: { x: segment.faceMidpoint!.x - tangent.x * 10, y: segment.faceMidpoint!.y - tangent.y * 10 }, normal: segment.faceNormal! },
      ];
    }).flat();
    const mouthAt = (point: { x: number; y: number }) => mouthData.find((mouth) => Math.hypot(mouth.point.x - point.x, mouth.point.y - point.y) < 1e-6);
    const pointOfArc = (cmd: Extract<PathCmd, { kind: "arc" }>, angle: number): { x: number; y: number } => ({
      x: cmd.c.x + Math.cos(angle) * cmd.r,
      y: cmd.c.y + Math.sin(angle) * cmd.r,
    });
    let current: { x: number; y: number } | null = null;
    for (const cmd of turn!.cmds) {
      if (cmd.kind === "move" || cmd.kind === "line") {
        current = cmd.to;
        continue;
      }
      const start = current!;
      const end = cmd.kind === "arc" ? pointOfArc(cmd, cmd.a1) : cmd.to;
      for (const point of [start, end]) {
        expect(mouthAt(point), JSON.stringify({ point, mouthData, cmd })).toBeDefined();
      }
      if (cmd.kind === "bezier") {
        const startMouth = mouthAt(start)!;
        const endMouth = mouthAt(end)!;
        const startLength = Math.hypot(cmd.cp1.x - start.x, cmd.cp1.y - start.y);
        const endLength = Math.hypot(end.x - cmd.cp2.x, end.y - cmd.cp2.y);
        expect(Math.abs((cmd.cp1.x - start.x) * startMouth.normal.x + (cmd.cp1.y - start.y) * startMouth.normal.y) / startLength).toBeCloseTo(1);
        expect(Math.abs((end.x - cmd.cp2.x) * endMouth.normal.x + (end.y - cmd.cp2.y) * endMouth.normal.y) / endLength).toBeCloseTo(1);
      }
      current = end;
    }
  });

  it("keeps every Cairo three-way contour inside one cell polygon", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const centre: [number, number] = [2, 1];
    const offsets: [number, number][] = [[0, 2], [-3, 1], [1, -3], [3, 1], [-1, -3]];
    for (let i = 0; i < offsets.length; i++) {
      for (let j = i + 1; j < offsets.length; j++) {
        for (let k = j + 1; k < offsets.length; k++) {
          const neighbours: [number, number][] = [offsets[i], offsets[j], offsets[k]].map(([dx, dy]) => [centre[0] + dx, centre[1] + dy]);
          const cells = [centre, ...neighbours];
          const nodes: NodeDto[] = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
          const edges: EdgeDto[] = neighbours.flatMap((_, id) => [
            { from: 0, to: id + 1, kind: "basic" as const },
            { from: id + 1, to: 0, kind: "basic" as const },
          ]);
          const segments = buildCorridorSegments(nodes, edges, cfg);
          const paths = buildCorridorContour(segments, 20);
          const polygons = cells.map(([x, y]) => getCellVertices(x, y, cfg)!);

          if (i === 0 && j === 1 && k === 2) {
            expect(paths.some((path) => path.cmds.filter((cmd) => cmd.kind === "bezier").length === 3)).toBe(true);
          }

          for (const [pathIndex, path] of paths.entries()) {
            const points = contourToPolyline(path);
            const scores = polygons.map((polygon) => points.filter((point) => pointInConvexPolygon(point, polygon)).length);
            expect(scores.some((score) => score === points.length), `combo ${i},${j},${k}, path ${pathIndex}, scores ${scores}, cells ${JSON.stringify(cells)}, cmds ${JSON.stringify(path.cmds)}`).toBe(true);
          }
        }
      }
    }
  });

  it("keeps Cairo dead-end caps centred on the tile centre", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const centre: [number, number] = [2, 1];
    const neighbour: [number, number] = [-1, 2];
    const nodes: NodeDto[] = [
      { id: 0, x: centre[0], y: centre[1], i: 0 },
      { id: 1, x: neighbour[0], y: neighbour[1], i: 0 },
    ];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "basic" },
      { from: 1, to: 0, kind: "basic" },
    ];
    const segment = buildCorridorSegments(nodes, edges, cfg)[0];
    const paths = buildCorridorContour([segment], 20);
    const expectedCentres = [segment.v0, segment.v1];
    const polygons = [getCellVertices(...neighbour, cfg)!, getCellVertices(...centre, cfg)!];
    for (const [path, expectedCentre] of paths.map((path, index) => [path, expectedCentres[index]] as const)) {
      const cap = path.cmds.find((cmd): cmd is Extract<PathCmd, { kind: "arc" }> => cmd.kind === "arc");
      expect(cap).toBeDefined();
      expect(cap!.c.x).toBeCloseTo(expectedCentre.x);
      expect(cap!.c.y).toBeCloseTo(expectedCentre.y);
      const pathIndex = paths.indexOf(path);
      const capDirection = pathIndex === 0
        ? { x: segment.v0.x - segment.faceMidpoint!.x, y: segment.v0.y - segment.faceMidpoint!.y }
        : { x: segment.v1.x - segment.faceMidpoint!.x, y: segment.v1.y - segment.faceMidpoint!.y };
      const capDirectionLength = Math.hypot(capDirection.x, capDirection.y);
      const sweep = cap!.ccw ? -Math.PI : Math.PI;
      const apexDirection = { x: Math.cos(cap!.a0 + sweep / 2), y: Math.sin(cap!.a0 + sweep / 2) };
      expect((apexDirection.x * capDirection.x + apexDirection.y * capDirection.y) / capDirectionLength).toBeGreaterThan(0);
      const quadratics = path.cmds.filter((cmd): cmd is Extract<PathCmd, { kind: "quadratic" }> => cmd.kind === "quadratic");
      expect(quadratics).toHaveLength(2);
      const outward = pathIndex === 0 ? segment.faceNormal! : { x: -segment.faceNormal!.x, y: -segment.faceNormal!.y };
      const inward = { x: -outward.x, y: -outward.y };
      const firstStart = path.cmds[0];
      expect(firstStart.kind).toBe("move");
      if (firstStart.kind === "move") {
        const firstControl = { x: quadratics[0].cp.x - firstStart.to.x, y: quadratics[0].cp.y - firstStart.to.y };
        const firstLength = Math.hypot(firstControl.x, firstControl.y);
        expect((firstControl.x * inward.x + firstControl.y * inward.y) / firstLength).toBeGreaterThan(0);
      }
      const secondControl = { x: quadratics[1].to.x - quadratics[1].cp.x, y: quadratics[1].to.y - quadratics[1].cp.y };
      const secondLength = Math.hypot(secondControl.x, secondControl.y);
      expect((secondControl.x * outward.x + secondControl.y * outward.y) / secondLength).toBeGreaterThan(0);
      const arcStartTangent = cap!.ccw
        ? { x: Math.sin(cap!.a0), y: -Math.cos(cap!.a0) }
        : { x: -Math.sin(cap!.a0), y: Math.cos(cap!.a0) };
      const arcEndTangent = cap!.ccw
        ? { x: Math.sin(cap!.a1), y: -Math.cos(cap!.a1) }
        : { x: -Math.sin(cap!.a1), y: Math.cos(cap!.a1) };
      const firstArcDirection = { x: quadratics[0].to.x - quadratics[0].cp.x, y: quadratics[0].to.y - quadratics[0].cp.y };
      const firstArcLength = Math.hypot(firstArcDirection.x, firstArcDirection.y);
      expect((firstArcDirection.x * arcStartTangent.x + firstArcDirection.y * arcStartTangent.y) / firstArcLength).toBeGreaterThan(0.99);
      const arcEnd = { x: cap!.c.x + Math.cos(cap!.a1) * cap!.r, y: cap!.c.y + Math.sin(cap!.a1) * cap!.r };
      const secondArcDirection = { x: quadratics[1].cp.x - arcEnd.x, y: quadratics[1].cp.y - arcEnd.y };
      const secondArcLength = Math.hypot(secondArcDirection.x, secondArcDirection.y);
      expect((secondArcDirection.x * arcEndTangent.x + secondArcDirection.y * arcEndTangent.y) / secondArcLength).toBeGreaterThan(0.99);
      for (const point of contourToPolyline(path)) expect(pointInConvexPolygon(point, polygons[pathIndex]), JSON.stringify({ pathIndex, point, cmds: path.cmds })).toBe(true);
    }
  });

  it("uses curved, cell-safe joins for every Cairo four-way opening", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const centre: [number, number] = [2, 1];
    const offsets: [number, number][] = [[0, 2], [-3, 1], [1, -3], [3, 1], [-1, -3]];
    for (let missing = 0; missing < offsets.length; missing++) {
      const neighbours = offsets.filter((_, index) => index !== missing).map(([dx, dy]) => [centre[0] + dx, centre[1] + dy] as [number, number]);
      const cells = [centre, ...neighbours];
      const nodes: NodeDto[] = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
      const edges: EdgeDto[] = neighbours.flatMap((_, id) => [
        { from: 0, to: id + 1, kind: "basic" as const },
        { from: id + 1, to: 0, kind: "basic" as const },
      ]);
      const paths = buildCorridorContour(buildCorridorSegments(nodes, edges, cfg), 20);
      const junction = paths.reduce((a, b) => b.cmds.length > a.cmds.length ? b : a);
      expect(junction.cmds.filter((cmd) => cmd.kind === "bezier")).toHaveLength(4);
      const polygon = getCellVertices(...centre, cfg)!;
      for (const point of contourToPolyline(junction)) {
        expect(pointInConvexPolygon(point, polygon)).toBe(true);
      }
    }
  });
});
