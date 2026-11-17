import { describe, it, expect } from "vitest";
import { BOX_NET_COMPACT, POLYHEDRON_SHAPES, isSwitchedShape, tessellationConfigOf, type PolyhedronShapeName } from "../fieldConfig";
import { compactNetOf, polyhedronFaceCount, polyhedronNetCount } from "../pixi/fieldOps";
import { configCellCount } from "../components/features/FieldSetupFeature";
import { fieldOf } from "./fieldConfigFixtures";

const tri = tessellationConfigOf("tri");
const NETS: Record<PolyhedronShapeName, number> = { tetrahedron: 2, octahedron: 2, icosahedron: 1 };
const FACES: Record<PolyhedronShapeName, number> = { tetrahedron: 4, octahedron: 8, icosahedron: 20 };

describe("switched field shapes", () => {
  it("recognises the box and the polyhedra, not the plain shapes", () => {
    expect(isSwitchedShape({ shape: "box", width: 1, height: 1, depth: 1, net: 0, mode: 0, aspect: 100 })).toBe(true);
    expect(isSwitchedShape({ shape: "icosahedron", side: 1, net: 0, mode: 0, aspect: 100 })).toBe(true);
    expect(isSwitchedShape({ shape: "triangle", side: 3 })).toBe(false);
    expect(isSwitchedShape({ shape: "custom", points: [] })).toBe(false);
  });

  it.each(POLYHEDRON_SHAPES)("core publishes the net and face counts of a %s", (shape) => {
    expect(polyhedronNetCount(tri, shape)).toBe(NETS[shape]);
    expect(polyhedronFaceCount(tri, shape)).toBe(FACES[shape]);
  });

  it("the compact net is the one after the unfolded nets", () => {
    expect(compactNetOf(tessellationConfigOf("square"), { shape: "box", width: 1, height: 1, depth: 1, net: 0, mode: 0, aspect: 100 })).toBe(BOX_NET_COMPACT);
    for (const shape of POLYHEDRON_SHAPES) {
      expect(compactNetOf(tri, { shape, side: 1, net: 0, mode: 0, aspect: 100 })).toBe(NETS[shape]);
    }
  });

  it.each(POLYHEDRON_SHAPES)("a %s has its faces of side² cells", (shape) => {
    const field = fieldOf("tri", { shape, side: 3, net: 0, mode: 0, aspect: 100 });
    expect(configCellCount(field)).toBe(FACES[shape] * 9);
  });
});
