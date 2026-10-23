import { describe, expect, it } from "vitest";
import { snapEquilateralAngle } from "../pixi/primitiveGeometry";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { isIdentityLinear } from "../pixi/geometry/tessellationUi";
import { fieldOf } from "./fieldConfigFixtures";

const near = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-9;
const axisDegrees = (cfg: ReturnType<typeof fieldOf>) =>
  getConnectorAxes(cfg).map(({ ux, uy }) => Math.round(((Math.atan2(uy, ux) * 180) / Math.PI + 180) % 180));

describe("orientation as a display-transform instance", () => {
  it("snaps hexagon directions to the lattice, turned by the display orientation", () => {
    expect(near(snapEquilateralAngle(0.5, fieldOf("hex", { shape: "hexagon", radius: 2 }, "flat_top")), Math.PI / 6)).toBe(true);
    expect(near(snapEquilateralAngle(0.02, fieldOf("hex", { shape: "hexagon", radius: 2 }, "pointy_top")), 0)).toBe(true);
  });

  it("snaps triangle directions per orientation and leaves Cairo free", () => {
    expect(near(snapEquilateralAngle(-1.55, fieldOf("tri", { shape: "rect", cols: 2, rows: 2 }, "r0")), -Math.PI / 2)).toBe(true);
    expect(near(snapEquilateralAngle(0.02, fieldOf("tri", { shape: "rect", cols: 2, rows: 2 }, "r90")), 0)).toBe(true);
    expect(snapEquilateralAngle(0.3, fieldOf("cairo", { shape: "rect", cols: 2, rows: 2 }))).toBe(0.3);
  });

  it("derives the hex connector axes from the orientation", () => {
    expect(axisDegrees(fieldOf("hex", { shape: "hexagon", radius: 1 }, "flat_top"))).toEqual([30, 90, 150]);
    expect(axisDegrees(fieldOf("hex", { shape: "hexagon", radius: 1 }, "pointy_top"))).toEqual([0, 60, 120]);
  });

  it("recognises the identity orientation only", () => {
    expect(isIdentityLinear({ a: 1, b: 0, c: 0, d: 1 })).toBe(true);
    expect(isIdentityLinear({ a: 0, b: -1, c: -1, d: 0 })).toBe(false);
  });
});
