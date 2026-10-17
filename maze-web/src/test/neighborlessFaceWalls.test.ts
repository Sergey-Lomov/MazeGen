import { describe, it, expect } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { buildPresetWallGroups } from "../pixi/selectors/presetSelectors";
import { buildMazeWalls } from "../pixi/selectors/mazeSelectors/walls";
import { getFaceEdgeSegment, getNeighborData } from "../pixi/tessellationGeometry";
import type { NodeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

/// A face with no neighbor has offset [0,0]; its outer wall must still be drawn.
const cells = TESSELLATION_UI.test.finiteCells!.map(([x, y]) => [x, y] as [number, number]);
const cfg = fieldOf("test", { shape: "custom", points: cells }, "r0");

const neighborlessFaces = cells.reduce(
  (n, [x, y]) => n + getNeighborData(cfg, x, y).offsets.filter(([dx, dy]) => dx === 0 && dy === 0).length,
  0,
);

describe("neighborless faces draw outer walls", () => {
  it("preset view", () => {
    const { preset } = buildPresetWallGroups(cells, new Map(), cfg);
    const outer = preset.filter((w) => w.face !== undefined);
    expect(outer.length).toBeGreaterThan(0);
    expect(outer).toHaveLength(neighborlessFaces);
    for (const wall of outer) expect(getFaceEdgeSegment(wall.a, wall.face!, cfg)).not.toBeNull();
  });

  it("maze view", () => {
    const nodes = cells.map(([x, y], id) => ({ id, x, y }) as NodeDto);
    const outer = buildMazeWalls(nodes, [], cfg).filter((w) => w.face !== undefined);
    expect(outer).toHaveLength(neighborlessFaces);
  });
});
