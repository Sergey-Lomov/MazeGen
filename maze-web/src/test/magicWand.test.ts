import { describe, expect, it } from "vitest";
import { connectedMagicWandCells } from "../pixi/magicWand";
import { encodePoint } from "../pixi/tessellationProjection";
import { fieldOf } from "./fieldConfigFixtures";

describe("connectedMagicWandCells", () => {
  it("follows the occupied component in a square tessellation", () => {
    const occupied = new Set([
      encodePoint(0, 0),
      encodePoint(1, 0),
      encodePoint(0, 1),
      encodePoint(3, 3),
    ]);

    expect(connectedMagicWandCells([0, 0], fieldOf("square", { shape: "rect", cols: 1, rows: 1 }), occupied))
      .toEqual(expect.arrayContaining([[0, 0], [1, 0], [0, 1]]));
  });

  it("recognizes bounded empty components", () => {
    const occupied = new Set<number>();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        if (x !== 1 || y !== 1) occupied.add(encodePoint(x, y));
      }
    }

    expect(connectedMagicWandCells([1, 1], fieldOf("square", { shape: "rect", cols: 1, rows: 1 }), occupied))
      .toEqual([[1, 1]]);
  });

  it("rejects the unbounded empty component", () => {
    expect(connectedMagicWandCells(
      [2, 0],
      fieldOf("square", { shape: "rect", cols: 1, rows: 1 }),
      new Set([encodePoint(0, 0)]),
    )).toBeNull();
  });

  it("uses hex and triangle adjacency", () => {
    expect(connectedMagicWandCells(
      [0, 0],
      fieldOf("hex", { shape: "custom", points: [] }, "flat_top"),
      new Set([encodePoint(0, 0), encodePoint(1, 0)]),
    )).toHaveLength(2);
    expect(connectedMagicWandCells(
      [0, 0],
      fieldOf("tri", { shape: "custom", points: [] }, "r0"),
      new Set([encodePoint(0, 0), encodePoint(0, -1)]),
    )).toHaveLength(2);
  });
});
