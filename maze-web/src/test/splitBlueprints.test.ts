import { describe, it, expect, vi } from "vitest";
import { blueprintsFor, fittingRotation, orientationsOf, blueprintToSplitPattern, tileNodesForBlueprint } from "../pixi/splitBlueprints";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeTessellationShapes } from "./tessellationShapesFake";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)) }));

describe("blueprintsFor", () => {
  it("returns the built-in set for a known degree", () => {
    expect(blueprintsFor(null, 3)).toHaveLength(1);
    expect(blueprintsFor(null, 4)).toHaveLength(2);
    expect(blueprintsFor(null, 5)).toHaveLength(3);
    expect(blueprintsFor(null, 6)).toHaveLength(7);
  });

  it("includes the hex diagonal divider with two opposite adjacent-face triples", () => {
    expect(blueprintsFor(null, 6)).toContainEqual({
      id: 6,
      degree: 6,
      nodeFaces: [[0, 1, 2], [3, 4, 5]],
      titleKey: "split_pattern_title.diagonal_divider",
    });
  });

  it("includes the Cairo 2x2 divider in canonical face order", () => {
    expect(blueprintsFor(null, 5)).toContainEqual({
      id: 0,
      degree: 5,
      nodeFaces: [[2, 3], [1, 4]],
      titleKey: "split_pattern_title.parallel_divider",
    });
  });

  it("includes the Cairo adjacent divider in canonical face order", () => {
    expect(blueprintsFor(null, 5)).toContainEqual({
      id: 1,
      degree: 5,
      nodeFaces: [[1, 2], [3, 4]],
      titleKey: "split_pattern_title.adjacent_divider",
    });
  });

  it("includes the Cairo 2x3 bridge in canonical face order", () => {
    expect(blueprintsFor(null, 5)).toContainEqual({
      id: 2,
      degree: 5,
      nodeFaces: [[0, 2, 3], [1, 4]],
      titleKey: "split_pattern_title.bridge_2x3",
    });
  });
});

describe("fittingRotation", () => {
  const square = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };

  it("returns the blueprint unrotated when it already fits", () => {
    expect(fittingRotation(square, () => false)).toEqual(square);
  });

  it("returns a rotated blueprint that avoids a boundary face", () => {
    // A triangle blueprint needs only faces 0/1 (2 of its 3) — a 1-step rotation moves both off
    // face 0 (0->1, 1->2), avoiding the boundary declared there.
    const triangle = { id: 0, degree: 3, nodeFaces: [[0, 1]] };
    const isBoundary = (f: number) => f === 0;
    const fitted = fittingRotation(triangle, isBoundary);
    expect(fitted).not.toBeNull();
    expect(fitted!.nodeFaces.flat().every((f) => !isBoundary(f))).toBe(true);
  });

  it("returns null when every rotation still hits a boundary", () => {
    expect(fittingRotation(square, () => true)).toBeNull();
  });

  it("returns null when a blueprint's combined required faces always cover every face of the tile", () => {
    // square's two nodes together require all 4 faces (0,2 and 1,3) — no rotation can avoid a
    // boundary declared on even one face, since every rotation still uses all 4.
    expect(fittingRotation(square, (f) => f === 0)).toBeNull();
  });
});

describe("blueprintToSplitPattern", () => {
  it("converts each node's required faces into a passage requirement, others absent", () => {
    const blueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };
    expect(blueprintToSplitPattern(blueprint, fieldOf("square", { shape: "rect", cols: 3, rows: 3 }))).toEqual({
      shape: "regular:4",
      node_count: 2,
      faces: [
        [{ face_index: 0, requirement: { kind: "passage" } }, { face_index: 2, requirement: { kind: "passage" } }],
        [{ face_index: 1, requirement: { kind: "passage" } }, { face_index: 3, requirement: { kind: "passage" } }],
      ],
      weight: 1.0,
    });
  });

  it("handles a node with no required faces (empty face list)", () => {
    const blueprint = { id: 0, degree: 3, nodeFaces: [[0, 1], []] };
    const pattern = blueprintToSplitPattern(blueprint, fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }));
    expect(pattern.shape).toBe("regular:3");
    expect(pattern.node_count).toBe(2);
    expect(pattern.faces[1]).toEqual([]);
  });

  it("stores Cairo blueprint faces unrotated", () => {
    const blueprint = blueprintsFor(null, 5)[0];
    const pattern = blueprintToSplitPattern(blueprint, fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 }));
    expect(pattern.shape).toBe("cairo_pentagon");
    expect(pattern.faces[0].map((face) => face.face_index)).toEqual([2, 3]);
    expect(pattern.faces[1].map((face) => face.face_index)).toEqual([1, 4]);
  });
});

describe("tileNodesForBlueprint", () => {
  it("marks every declared face as passage and every other face as wall", () => {
    const blueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };
    const nodes = tileNodesForBlueprint(blueprint);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].faces.map((f) => f.kind)).toEqual(["passage", "wall", "passage", "wall"]);
    expect(nodes[1].faces.map((f) => f.kind)).toEqual(["wall", "passage", "wall", "passage"]);
  });

  it("builds a Cairo tile preview", () => {
    const blueprint = blueprintsFor(null, 5)[0];
    const nodes = tileNodesForBlueprint(blueprint);
    expect(nodes[0].faces.map((f) => f.kind)).toEqual(["wall", "wall", "passage", "passage", "wall"]);
    expect(nodes[1].faces.map((f) => f.kind)).toEqual(["wall", "passage", "wall", "wall", "passage"]);
  });
});

describe("curved quadrilateral blueprints (GitHub issue #800)", () => {
  const shape = "curved_quadrilateral:curved_quadrilateral";
  // Identity, both axis mirrors and the half turn on `[E, N, W, S]`; a quarter turn is not there.
  const binding = {
    shape,
    canonicalOfLocal: [0, 1, 2, 3],
    localOfCanonical: [0, 1, 2, 3],
    group: [[0, 1, 2, 3], [2, 1, 0, 3], [0, 3, 2, 1], [2, 3, 0, 1]],
  };

  it("has its own set, distinct from the square's", () => {
    expect(blueprintsFor(shape, 4)).toHaveLength(2);
    expect(blueprintsFor("regular:4", 4)).toHaveLength(2);
  });

  it("fits a boundary by mirroring, never by a quarter turn", () => {
    // Needs faces 0 and 1 with the boundary on face 0. The default rotations answer with a quarter
    // turn ({1, 2}); the curved quadrilateral's group answers with the east-west mirror ({2, 1}).
    const pair = { id: 0, degree: 4, nodeFaces: [[0, 1]] };
    const isBoundary = (f: number) => f === 0;
    expect(fittingRotation(pair, isBoundary)).toEqual({ ...pair, nodeFaces: [[1, 2]] });
    expect(fittingRotation(pair, isBoundary, orientationsOf(binding))).toEqual({ ...pair, nodeFaces: [[2, 1]] });
  });

  it("keeps the blueprint when the identity fits and rejects what no group element fits", () => {
    const [bridge] = blueprintsFor(shape, 4);
    expect(fittingRotation(bridge, () => false, orientationsOf(binding))).toBe(bridge);
    expect(fittingRotation(bridge, (f) => f === 0, orientationsOf(binding))).toBeNull();
  });

  it("orientationsOf maps faces through the cell's group, identity first", () => {
    const maps = orientationsOf(binding);
    expect([0, 1, 2, 3].map(maps[0])).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map(maps[1])).toEqual([2, 1, 0, 3]);
  });
});
