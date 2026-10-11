import { describe, expect, it } from "vitest";
import type { EdgeDto, NodeDto } from "../wasm/types";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors";
import { getCellVertices, getSharedEdgeSegment, getTileDiagram } from "../pixi/tessellationGeometry";
import { hexVertices } from "../pixi/hexGeometry";
import { cairoCanonicalFaceOrder, cairoCenter, cairoEdgeVerts, cairoVertices } from "../pixi/cairoGeometry";
import { buildCorridorContour, buildCorridorGeometry, contourToPolyline, contourToSvgPath, type PathCmd, type CorridorCell, type CorridorPort } from "../pixi/imageExport/vectorByCorridorsContour";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

describe("buildCorridorContour", () => {
  const pointInConvexPolygon = (point: { x: number; y: number }, vertices: readonly { x: number; y: number }[]): boolean => {
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

  it("preserves universal contour curves when serializing a lab preview", () => {
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
    const turn = paths.find((path) => path.cmds.filter((cmd) => cmd.kind === "quadratic").length === 4);
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
        const mouth = mouthAt(point);
        if (mouth) expect(mouth, JSON.stringify({ point, mouthData, cmd })).toBeDefined();
      }
      if (cmd.kind === "bezier" || cmd.kind === "quadratic") {
        const startMouth = mouthAt(start);
        const endMouth = mouthAt(end);
        if (startMouth) {
          const startControl = cmd.kind === "bezier" ? cmd.cp1 : cmd.cp;
          const startLength = Math.hypot(startControl.x - start.x, startControl.y - start.y);
          expect(Math.abs((startControl.x - start.x) * startMouth.normal.x + (startControl.y - start.y) * startMouth.normal.y) / startLength).toBeCloseTo(1);
        }
        if (endMouth) {
          const endControl = cmd.kind === "bezier" ? cmd.cp2 : cmd.cp;
          const endLength = Math.hypot(end.x - endControl.x, end.y - endControl.y);
          expect(Math.abs((end.x - endControl.x) * endMouth.normal.x + (end.y - endControl.y) * endMouth.normal.y) / endLength).toBeCloseTo(1);
        }
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
            expect(paths.some((path) => path.cmds.some((cmd) => cmd.kind === "arc"))).toBe(true);
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

  it("keeps every Cairo dead-end handoff tangent to its cap", () => {
    const point: [number, number] = [2, 1];
    const vertices = cairoVertices(...point)!;
    const center = cairoCenter(...point);
    const edgeVerts = cairoEdgeVerts(...point);
    const align = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
      const aLength = Math.hypot(a.x, a.y);
      const bLength = Math.hypot(b.x, b.y);
      return (a.x * b.x + a.y * b.y) / (aLength * bLength);
    };
    const arcTangent = (arc: Extract<PathCmd, { kind: "arc" }>, atStart: boolean) => {
      const angle = atStart ? arc.a0 : arc.a1;
      return arc.ccw
        ? { x: Math.sin(angle), y: -Math.cos(angle) }
        : { x: -Math.sin(angle), y: Math.cos(angle) };
    };
    for (const [from, to] of edgeVerts) {
      const v0 = vertices[from];
      const v1 = vertices[to];
      const face = [v0, v1] as const;
      const dx = v1.x - v0.x;
      const dy = v1.y - v0.y;
      const normalLength = Math.hypot(dx, dy);
      const port: CorridorPort = {
        cellId: "cairo",
        midpoint: { x: (v0.x + v1.x) / 2, y: (v0.y + v1.y) / 2 },
        normal: { x: -dy / normalLength, y: dx / normalLength },
        face,
      };
      const [path] = buildCorridorGeometry([{ id: "cairo", center, polygon: vertices }], [port], 20);
      const arcIndex = path.cmds.findIndex((command) => command.kind === "arc");
      expect(arcIndex).toBeGreaterThan(0);
      const arc = path.cmds[arcIndex] as Extract<PathCmd, { kind: "arc" }>;
      const before = path.cmds[arcIndex - 1];
      const after = path.cmds[arcIndex + 1];
      expect(before.kind === "quadratic" || before.kind === "bezier").toBe(true);
      expect(after.kind === "quadratic" || after.kind === "bezier").toBe(true);
      if ((before.kind !== "quadratic" && before.kind !== "bezier") || (after.kind !== "quadratic" && after.kind !== "bezier")) continue;
      const beforeTangent = before.kind === "quadratic"
        ? { x: before.to.x - before.cp.x, y: before.to.y - before.cp.y }
        : { x: before.to.x - before.cp2.x, y: before.to.y - before.cp2.y };
      const arcEnd = { x: arc.c.x + Math.cos(arc.a1) * arc.r, y: arc.c.y + Math.sin(arc.a1) * arc.r };
      const afterTangent = after.kind === "quadratic"
        ? { x: after.cp.x - arcEnd.x, y: after.cp.y - arcEnd.y }
        : { x: after.cp1.x - arcEnd.x, y: after.cp1.y - arcEnd.y };
      expect(align(beforeTangent, arcTangent(arc, true))).toBeGreaterThan(0.99);
      expect(align(afterTangent, arcTangent(arc, false))).toBeGreaterThan(0.99);
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
      expect(junction.cmds.filter((cmd) => cmd.kind === "arc" || cmd.kind === "bezier" || cmd.kind === "quadratic").length).toBeGreaterThanOrEqual(3);
      const polygon = getCellVertices(...centre, cfg)!;
      for (const point of contourToPolyline(junction)) {
        expect(pointInConvexPolygon(point, polygon)).toBe(true);
      }
    }
  });

  it("uses a coherent outer rail for Cairo visible ports 0-2-3", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const diagram = getTileDiagram(2, 1, cfg)!;
    const portsByFace = diagram.sides.map((side) => {
      const dx = side.v1.x - side.v0.x;
      const dy = side.v1.y - side.v0.y;
      const length = Math.hypot(dx, dy);
      const midpoint = { x: (side.v0.x + side.v1.x) / 2, y: (side.v0.y + side.v1.y) / 2 };
      let normal = { x: -dy / length, y: dx / length };
      if (normal.x * midpoint.x + normal.y * midpoint.y < 0) normal = { x: -normal.x, y: -normal.y };
      return {
        cellId: "cairo-0-2-3",
        midpoint,
        normal,
        face: [side.v0, side.v1] as const,
        useCubicMouth: true,
      } satisfies CorridorPort;
    });
    const faceOrder = cairoCanonicalFaceOrder(2, 1);
    const ports = faceOrder.map((faceIndex) => portsByFace[faceIndex]);
    const selected = [0, 2, 3].map((index) => ports[index]);
    const cell = [{ id: "cairo-0-2-3", center: { x: 0, y: 0 }, polygon: diagram.vertices } satisfies CorridorCell];

    const [sharp] = buildCorridorGeometry(cell, selected, 12, true, "shallowThreeWay", 0);
    expect(sharp.cmds.some((command) => command.kind === "bezier")).toBe(false);
    expect(sharp.cmds.filter((command) => command.kind === "quadratic").length).toBeGreaterThanOrEqual(4);
    for (const point of contourToPolyline(sharp)) expect(pointInConvexPolygon(point, diagram.vertices)).toBe(true);

    const [rounded] = buildCorridorGeometry(cell, selected, 12, true, "shallowThreeWay", 4);
    expect(rounded.cmds.filter((command) => command.kind === "quadratic").length).toBeGreaterThanOrEqual(4);
    for (const point of contourToPolyline(rounded)) expect(pointInConvexPolygon(point, diagram.vertices)).toBe(true);
  });

  it("promotes Cairo 3-0 to the outer rail when it is the only invalid mouth join", () => {
    const cfg: TessellationConfig = { type: "cairo", cols: 3, rows: 3 };
    const diagram = getTileDiagram(2, 1, cfg)!;
    const portsByFace = diagram.sides.map((side) => {
      const dx = side.v1.x - side.v0.x;
      const dy = side.v1.y - side.v0.y;
      const length = Math.hypot(dx, dy);
      const midpoint = { x: (side.v0.x + side.v1.x) / 2, y: (side.v0.y + side.v1.y) / 2 };
      let normal = { x: -dy / length, y: dx / length };
      if (normal.x * midpoint.x + normal.y * midpoint.y < 0) normal = { x: -normal.x, y: -normal.y };
      return {
        cellId: "cairo-0-1-3",
        midpoint,
        normal,
        face: [side.v0, side.v1] as const,
        useCubicMouth: true,
      } satisfies CorridorPort;
    });
    const faceOrder = cairoCanonicalFaceOrder(2, 1);
    const ports = faceOrder.map((faceIndex) => portsByFace[faceIndex]);
    const selected = [0, 1, 3].map((index) => ports[index]);
    const cell = [{ id: "cairo-0-1-3", center: { x: 0, y: 0 }, polygon: diagram.vertices } satisfies CorridorCell];

    const [path] = buildCorridorGeometry(cell, selected, 12, true, "shallowThreeWay", 0);
    // Radius zero keeps the Cairo outer rail curved and bends the intermediate-port join with a
    // single quadratic, avoiding a self-crossing cubic fallback.
    expect(path.cmds.filter((command) => command.kind === "bezier")).toHaveLength(0);
    expect(path.cmds.filter((command) => command.kind === "quadratic").length).toBeGreaterThanOrEqual(4);
    for (const point of contourToPolyline(path)) expect(pointInConvexPolygon(point, diagram.vertices)).toBe(true);

    const selected134 = [1, 3, 4].map((index) => ports[index]);
    const [path134] = buildCorridorGeometry(cell, selected134, 12, true, "shallowThreeWay", 0);
    // The 4-1 sector is a distinct wide gap even though every ordinary miter is forward-valid;
    // it must therefore use the shared 1-4 outer rail with port 3 attached to its inner rail.
    expect(path134.cmds.filter((command) => command.kind === "quadratic").length).toBeGreaterThanOrEqual(4);
    expect(path134.cmds.filter((command) => command.kind === "bezier")).toHaveLength(0);
    for (const point of contourToPolyline(path134)) expect(pointInConvexPolygon(point, diagram.vertices)).toBe(true);
  });
});

describe("buildCorridorGeometry", () => {
  const pointInConvexPolygon = (point: { x: number; y: number }, vertices: readonly { x: number; y: number }[]): boolean => {
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

  const square = (id: string, x: number): CorridorCell => ({
    id,
    center: { x, y: 0 },
    polygon: [
      { x: x - 20, y: -20 }, { x: x + 20, y: -20 },
      { x: x + 20, y: 20 }, { x: x - 20, y: 20 },
    ],
  });

  it("joins two generic square cells with identical shared-face mouths", () => {
    const cells = [square("left", 0), square("right", 40)];
    const ports: CorridorPort[] = [
      { cellId: "left", midpoint: { x: 20, y: 0 }, normal: { x: 1, y: 0 }, face: [{ x: 20, y: -20 }, { x: 20, y: 20 }] },
      { cellId: "right", midpoint: { x: 20, y: 0 }, normal: { x: -1, y: 0 }, face: [{ x: 20, y: -20 }, { x: 20, y: 20 }] },
    ];
    const paths = buildCorridorGeometry(cells, ports, 12);
    expect(paths).toHaveLength(2);

    const mouthEnds = paths.map((path) => {
      const move = path.cmds[0];
      const quadratic = path.cmds.filter((command): command is Extract<PathCmd, { kind: "quadratic" }> => command.kind === "quadratic").at(-1);
      expect(move.kind).toBe("move");
      expect(quadratic).toBeDefined();
      return [move.kind === "move" ? move.to : undefined, quadratic?.to];
    }).flat().filter((point): point is { x: number; y: number } => point !== undefined);
    expect(mouthEnds).toHaveLength(4);
    expect(Math.hypot(mouthEnds[0].x - mouthEnds[1].x, mouthEnds[0].y - mouthEnds[1].y)).toBeCloseTo(12);
    expect(Math.hypot(mouthEnds[2].x - mouthEnds[3].x, mouthEnds[2].y - mouthEnds[3].y)).toBeCloseTo(12);
    expect(new Set(mouthEnds.slice(0, 2).map((point) => point.y))).toEqual(new Set(mouthEnds.slice(2).map((point) => point.y)));
  });

  it("keeps a junction inside an arbitrary convex cell", () => {
    const cell: CorridorCell = {
      id: "skew",
      center: { x: 0, y: 0 },
      polygon: [{ x: -24, y: -12 }, { x: 18, y: -18 }, { x: 28, y: 10 }, { x: 4, y: 24 }, { x: -26, y: 14 }],
    };
    const ports: CorridorPort[] = [
      { cellId: "skew", midpoint: { x: -3, y: -15 }, normal: { x: -6, y: -42 }, face: [{ x: -24, y: -12 }, { x: 18, y: -18 }] },
      { cellId: "skew", midpoint: { x: 23, y: -4 }, normal: { x: 28, y: -10 }, face: [{ x: 18, y: -18 }, { x: 28, y: 10 }] },
      { cellId: "skew", midpoint: { x: -11, y: 19 }, normal: { x: -10, y: 30 }, face: [{ x: 4, y: 24 }, { x: -26, y: 14 }] },
    ];
    const paths = buildCorridorGeometry([cell], ports, 10);
    expect(paths).toHaveLength(1);
    for (const point of contourToPolyline(paths[0])) expect(pointInConvexPolygon(point, cell.polygon), JSON.stringify({ point, cmds: paths[0].cmds })).toBe(true);
  });

  it("keeps the requested rounding visible on adjacent hex junction faces", () => {
    const vertices = hexVertices(0, 0, "flat_top");
    const ports: CorridorPort[] = [[0, 1], [1, 2], [2, 3]].map(([from, to]) => {
      const side = { v0: vertices[from], v1: vertices[to] };
      return {
      cellId: "hex",
      midpoint: { x: (side.v0.x + side.v1.x) / 2, y: (side.v0.y + side.v1.y) / 2 },
      normal: { x: -(side.v1.y - side.v0.y), y: side.v1.x - side.v0.x },
      face: [side.v0, side.v1],
      };
    });
    const [path] = buildCorridorGeometry(
      [{ id: "hex", center: { x: 0, y: 0 }, polygon: vertices }],
      ports,
      12,
      true,
      "default",
      4,
    );
    const radii = path.cmds.filter((command): command is Extract<PathCmd, { kind: "arc" }> => command.kind === "arc").map((arc) => arc.r);
    expect(radii.some((radius) => radius >= 3.9)).toBe(true);

    const smallestArcRadius = (cornerRadius: number): number => {
      const [candidate] = buildCorridorGeometry(
        [{ id: "hex", center: { x: 0, y: 0 }, polygon: vertices }],
        ports,
        12,
        true,
        "default",
        cornerRadius,
      );
      return Math.min(...candidate.cmds
        .filter((command): command is Extract<PathCmd, { kind: "arc" }> => command.kind === "arc")
        .map((arc) => arc.r));
    };
    const sampledRadii = [4, 8, 12, 20].map(smallestArcRadius);
    const [maxCandidate] = buildCorridorGeometry([{ id: "hex", center: { x: 0, y: 0 }, polygon: vertices }], ports, 12, true, "default", 20);
    expect(maxCandidate.cmds.some((command) => command.kind === "bezier")).toBe(false);
    expect(maxCandidate.cmds.some((command) => command.kind === "arc")).toBe(true);
    for (let index = 1; index < sampledRadii.length; index++) {
      expect(sampledRadii[index]).toBeGreaterThanOrEqual(sampledRadii[index - 1] - 1e-6);
    }
  });

  it("honors an explicit radius for production-style cubic-mouth junction ports", () => {
    const vertices = hexVertices(0, 0, "flat_top");
    const ports: CorridorPort[] = [[0, 1], [1, 2], [2, 3]].map(([from, to]) => {
      const side = { v0: vertices[from], v1: vertices[to] };
      return {
        cellId: "hex-cubic",
        midpoint: { x: (side.v0.x + side.v1.x) / 2, y: (side.v0.y + side.v1.y) / 2 },
        normal: { x: -(side.v1.y - side.v0.y), y: side.v1.x - side.v0.x },
        face: [side.v0, side.v1] as const,
        useCubicMouth: true,
      };
    });
    const cell = { id: "hex-cubic", center: { x: 0, y: 0 }, polygon: vertices };
    const [sharp] = buildCorridorGeometry([cell], ports, 12, true, "shallowThreeWay", 0);
    const [rounded] = buildCorridorGeometry([cell], ports, 12, true, "shallowThreeWay", 4);

    const sharpCurves = sharp.cmds.filter((command) => command.kind === "arc" || command.kind === "bezier" || command.kind === "quadratic");
    const roundedCurves = rounded.cmds.filter((command) => command.kind === "arc" || command.kind === "bezier" || command.kind === "quadratic");
    // Radius zero keeps each active junction as curved approach → sharp connector → curved exit.
    // The outside bridge remains a natural circular arc. A positive radius replaces the two sharp
    // connectors with circular fillets while retaining the curved approaches.
    expect(sharpCurves.length).toBeGreaterThanOrEqual(4);
    expect(sharp.cmds.filter((command) => command.kind === "quadratic").length).toBeGreaterThanOrEqual(4);
    expect(roundedCurves.length).toBeGreaterThan(sharpCurves.length);
    const roundedArcs = rounded.cmds.filter((command): command is Extract<PathCmd, { kind: "arc" }> => command.kind === "arc");
    expect(roundedArcs).toHaveLength(2);
    expect(roundedArcs.every((arc) => Math.abs(arc.r - 4) < 1e-6)).toBe(true);
  });
});
