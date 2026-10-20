import { describe, it, expect } from "vitest";
import { shortestCorridorFace, shortestCorridorFaceAcrossFloors, type CorridorSegment } from "../pixi/selectors/mazeSelectors/corridors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

const n = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const segment = (faceLength: number | undefined) => ({ faceLength }) as CorridorSegment;

describe("shortest corridor face", () => {
  it("is the minimum positive face length, or Infinity without faces", () => {
    expect(shortestCorridorFace([segment(10), segment(8), segment(undefined), segment(0)])).toBe(8);
    expect(shortestCorridorFace([segment(undefined)])).toBe(Infinity);
    expect(shortestCorridorFace([])).toBe(Infinity);
  });

  it("covers floors other than the first one", () => {
    const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const floors = [{ id: "a" }, { id: "b" }];
    const nodes = [n(0, 0, 0, 0), n(1, 1, 0, 0), n(2, 0, 0, 1), n(3, 1, 0, 1)];
    const onlySecondFloor = shortestCorridorFaceAcrossFloors(nodes, [e(2, 3)], floors, cfg);
    expect(Number.isFinite(onlySecondFloor)).toBe(true);
    expect(shortestCorridorFaceAcrossFloors(nodes, [e(0, 1), e(2, 3)], floors, cfg)).toBe(onlySecondFloor);
    expect(shortestCorridorFaceAcrossFloors(nodes, [], floors, cfg)).toBe(Infinity);
  });
});
