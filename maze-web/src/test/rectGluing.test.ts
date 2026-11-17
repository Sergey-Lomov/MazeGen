import { describe, expect, it } from "vitest";
import { type FieldShape } from "../fieldConfig";
import { rectCloses, snapRectToClose, withoutRectGluing } from "../pixi/rectGluing";
import { configAllCells } from "../pixi/tessellationCells";
import { presetTopologyOf } from "../store/presetTopology";
import { buildPredefinedConfig } from "../store/storeHelpers";
import { tessellationConfigOf } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

const rect = (cols: number, rows: number): FieldShape => ({ shape: "rect", cols, rows });
const cylinder = (cols: number, rows: number, axis: 0 | 1): FieldShape => ({ shape: "cylinder", cols, rows, axis });
const torus = (cols: number, rows: number): FieldShape => ({ shape: "torus", cols, rows });

describe("rectCloses", () => {
  it("accepts a plain rectangle at every size", () => {
    expect(rectCloses(fieldOf("hex", rect(3, 3)))).toBe(true);
  });

  it("asks core whether a cylinder or torus closes up", () => {
    expect(rectCloses(fieldOf("square", torus(5, 4)))).toBe(true);
    expect(rectCloses(fieldOf("square", cylinder(2, 5, 0)))).toBe(false);
    expect(rectCloses(fieldOf("hex", cylinder(5, 6, 0)))).toBe(false);
    expect(rectCloses(fieldOf("hex", cylinder(6, 5, 0)))).toBe(true);
    expect(rectCloses(fieldOf("hex", cylinder(5, 5, 1)))).toBe(true);
  });
});

describe("snapRectToClose", () => {
  it("leaves a plain rectangle and a closing size alone", () => {
    const plane = fieldOf("hex", rect(5, 5));
    expect(snapRectToClose(plane)).toBe(plane);
    const closing = fieldOf("hex", cylinder(6, 5, 0));
    expect(snapRectToClose(closing)).toBe(closing);
  });

  it("moves the changed dimension to the nearest size that closes up", () => {
    const snapped = snapRectToClose(fieldOf("hex", cylinder(7, 5, 0)), "cols");
    expect(snapped?.shape).toMatchObject({ shape: "cylinder", cols: 8, rows: 5, axis: 0 });
  });

  it("moves the other dimension when the changed one cannot help", () => {
    const snapped = snapRectToClose(fieldOf("square", cylinder(2, 2, 1)), "cols");
    expect(snapped && rectCloses(snapped)).toBe(true);
  });

  it("never grows a side when asked to go down", () => {
    const snapped = snapRectToClose(fieldOf("hex", cylinder(7, 9, 0)), "both", "down");
    expect(snapped?.shape).toMatchObject({ cols: 6, rows: 9 });
  });

  it("gives up when no size within reach closes up", () => {
    expect(snapRectToClose(fieldOf("square", torus(1, 1)), "both", "down")).toBeNull();
  });
});

describe("withoutRectGluing", () => {
  it("turns a cylinder into a plain rectangle of its size", () => {
    expect(withoutRectGluing(fieldOf("square", cylinder(5, 4, 1))).shape).toEqual({ shape: "rect", cols: 5, rows: 4 });
    const plane = fieldOf("square", rect(5, 4));
    expect(withoutRectGluing(plane)).toBe(plane);
  });
});

describe("cylinder and torus as field shapes", () => {
  it("keeps the cells of the plane and defines the topology", () => {
    const plane = fieldOf("square", rect(5, 4));
    const glued = fieldOf("square", torus(5, 4));
    expect(configAllCells(glued)).toEqual(configAllCells(plane));
    expect(presetTopologyOf(plane)).toBeUndefined();
    const topology = presetTopologyOf(glued);
    expect(topology?.groups).toHaveLength(2);
    expect(topology?.folds).toHaveLength(9);
  });

  it("is an empty field at a size that does not close up", () => {
    expect(configAllCells(fieldOf("hex", cylinder(5, 6, 0)))).toEqual([]);
    expect(presetTopologyOf(fieldOf("hex", cylinder(5, 6, 0)))).toBeUndefined();
  });
});

describe("default cylinder and torus", () => {
  it("close up in every tessellation that offers them", () => {
    for (const kind of ["square", "hex", "tri", "cairo", "square_octagon", "brick", "elongated_triangular", "curved_quadrilateral", "trihexagonal", "snub_hexagonal", "rhombitrihexagonal", "truncated_hexagonal", "truncated_trihexagonal", "snub_square"] as const) {
      for (const name of ["cylinder", "torus"] as const) {
        const config = buildPredefinedConfig(tessellationConfigOf(kind), name, "flat_top", "r0");
        expect(config.shape.shape, `${kind} ${name}`).toBe(name);
        expect(rectCloses(config), `${kind} ${name}`).toBe(true);
      }
    }
  });
});
