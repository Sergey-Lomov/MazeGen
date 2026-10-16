import { describe, it, expect, vi } from "vitest";
import { fakeTessellationShapes } from "./tessellationShapesFake";
import { fieldOf } from "./fieldConfigFixtures";
import { getTessellationShapes } from "../wasm/mazeService";
import { patternShapeOf, shapeKeysOf, splitPatternsFor } from "../pixi/shapeTemplates";
import { patternAnchorPoint } from "../pixi/splitPatternTile";
import { tessellationConfigOf } from "../fieldConfig";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getTessellationShapes: vi.fn((config: Parameters<typeof fakeTessellationShapes>[0]) => fakeTessellationShapes(config)),
}));

describe("shapeTemplates", () => {
  it("asks core once per tessellation config", () => {
    const mock = vi.mocked(getTessellationShapes);
    mock.mockClear();
    expect(shapeKeysOf(tessellationConfigOf("hex"))).toEqual(["regular:6"]);
    expect(shapeKeysOf({ kind: "hex", params: {} })).toEqual(["regular:6"]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("keeps only patterns whose shape the tessellation provides", () => {
    const square = { shape: "regular:4", node_count: 1, faces: [[]], weight: 1 };
    const tri = { shape: "regular:3", node_count: 1, faces: [[]], weight: 1 };
    expect(splitPatternsFor([square, tri], tessellationConfigOf("tri"))).toEqual([tri]);
  });

  it("binds a new pattern to the template of the editor's anchor cell", () => {
    const mock = vi.mocked(getTessellationShapes);
    mock.mockClear();
    const cfg = fieldOf("cairo", { shape: "custom", points: [] });
    expect(patternShapeOf(cfg)).toBe("cairo_pentagon");
    expect(mock).toHaveBeenCalledWith({ tessellation: cfg.tessellation, points: [patternAnchorPoint(cfg)] });
  });

  it("fails loudly when the anchor cell has no template", () => {
    vi.mocked(getTessellationShapes).mockReturnValueOnce({ keys: ["regular:4"], point_shapes: [undefined] });
    expect(() => patternShapeOf({ ...fieldOf("square", { shape: "custom", points: [] }), tessellation: { kind: "square", params: { probe: 1 } } })).toThrow(/no shape template/);
  });
});
