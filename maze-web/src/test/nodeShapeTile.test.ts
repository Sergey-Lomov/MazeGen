import { describe, it, expect } from "vitest";
import { shapeFaceIndices, shapeMiniMaze } from "../pixi/nodeShapeTile";
import { kindFieldConfig } from "../fieldConfig";

const cfgOf = (kind: "square" | "hex") => kindFieldConfig(kind);

describe("nodeShapeTile", () => {
  it("draws a junction on the faces whose ranks its key lists", () => {
    const cfg = cfgOf("square");
    // Ranks run opposite to the face order here: face i has rank 3 - i.
    expect(shapeFaceIndices("junction_4_0-1-2", cfg, undefined, [3, 2, 1, 0])).toEqual([3, 2, 1]);
    expect(shapeFaceIndices("junction_4_0-1-2", cfg)).toBeNull();
  });

  it("finds opposite faces for a straight shape on a square grid", () => {
    const faces = shapeFaceIndices("straight", cfgOf("square"));
    expect(faces).toHaveLength(2);
  });

  it("finds a 90 degree pair on squares and none for 60", () => {
    expect(shapeFaceIndices("turn_90", cfgOf("square"))).toHaveLength(2);
    expect(shapeFaceIndices("turn_60", cfgOf("square"))).toBeNull();
  });

  it("joins the origin to a neighbour per face of the shape", () => {
    const cfg = cfgOf("square");
    const faces = shapeFaceIndices("turn_90", cfg)!;
    const maze = shapeMiniMaze(faces, cfg);
    expect(maze.nodes).toHaveLength(3);
    expect(maze.edges).toHaveLength(4);
    expect(shapeFaceIndices("mystery", cfg)).toBeNull();
  });
});
