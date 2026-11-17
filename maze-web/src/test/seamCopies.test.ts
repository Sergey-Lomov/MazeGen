import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { getSeamModel } from "../pixi/selectors/seams";
import { planSeamCopies, type SeamCopy } from "../pixi/selectors/seamCopies";
import { applyTransform, isReflection } from "../pixi/geometry/worldTransform";
import { displayTransform, getCellVertices, pointInPolygon } from "../pixi/tessellationGeometry";
import type { WireFold, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// Runs against the real `maze-core` module loaded by `setup.ts`. A 6x5 square field; face 0 is east,
// 1 north, 2 west, 3 south.
const COLUMNS = 6;
const ROWS = 5;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function topologyOf(folds: Omit<WireFold, "group">[]): WireTopology {
  return { fingerprint: "square{}", folds: folds.map((fold) => ({ ...fold, group: 0 })), groups: [{ id: 0, folds: folds.map((_, i) => i) }] };
}

const cylinder = topologyOf(range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, y] as [number, number], face_idx: 2 }, twist: false })));
const mobius = topologyOf(range(ROWS).map((y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, ROWS - 1 - y] as [number, number], face_idx: 2 }, twist: true })));
// East side of the last column onto the north side of the first five columns: a quarter turn.
const corner = topologyOf(range(ROWS).map((i) => ({ a: { cell: [COLUMNS - 1, i] as [number, number], face_idx: 0 }, b: { cell: [i, ROWS - 1] as [number, number], face_idx: 1 }, twist: false })));

function plan(topology: WireTopology | null, disks: { x: number; y: number; r: number }[]): SeamCopy[] {
  warmCartesianCache(field, topology);
  return planSeamCopies(field, disks);
}

/** The display-space point just past a glued face of its own cell, outside the field. */
function pastFace(copy: SeamCopy, depth: number): [number, number] {
  const display = displayTransform(field);
  const [cx, cy] = applyTransform(display, copy.from.center);
  const [fx, fy] = applyTransform(display, copy.from.contact);
  return [fx + (fx - cx) * depth, fy + (fy - cy) * depth];
}

function insideCell(cell: [number, number], point: [number, number]): boolean {
  return pointInPolygon({ x: point[0], y: point[1] }, getCellVertices(cell[0], cell[1], field));
}

const display = () => displayTransform(field);
const diskAt = (cell: [number, number], face: number, r: number) => {
  const half = getSeamModel(field).halfEdgeAt(cell, face)!;
  const [x, y] = applyTransform(display(), half.contact);
  return { x, y, r };
};

describe("planSeamCopies", () => {
  it("plans nothing without a topology or without elements", () => {
    expect(plan(null, [{ x: 0, y: 0, r: 1000 }])).toEqual([]);
    expect(plan(cylinder, [])).toEqual([]);
  });

  it("carries an element past a cylinder seam into the partner's cell, in both directions", () => {
    warmCartesianCache(field, cylinder);
    const east = diskAt([COLUMNS - 1, 2], 0, 5);
    const west = diskAt([0, 2], 2, 5);
    const copies = plan(cylinder, [east, west]);
    const fromEast = copies.find((c) => c.from.cell[0] === COLUMNS - 1 && c.from.cell[1] === 2)!;
    const fromWest = copies.find((c) => c.from.cell[0] === 0 && c.from.cell[1] === 2)!;
    expect(fromEast.indices).toEqual([0]);
    expect(fromWest.indices).toEqual([1]);
    for (const copy of [fromEast, fromWest]) {
      expect(isReflection(copy.transform)).toBe(false);
      expect(insideCell(copy.to.cell, applyTransform(copy.transform, pastFace(copy, 0.1)) as [number, number])).toBe(true);
    }
  });

  it("skips elements away from every glued face", () => {
    warmCartesianCache(field, cylinder);
    const [x, y] = applyTransform(display(), getSeamModel(field).halfEdgeAt([0, 2], 2)!.center);
    // The centre of a cell in the first column is half a cell from its glued face.
    const copies = plan(cylinder, [{ x: x + 3 * Math.abs(x - applyTransform(display(), getSeamModel(field).halfEdgeAt([0, 2], 2)!.contact)[0]), y, r: 1 }]);
    expect(copies).toEqual([]);
  });

  it("turns the copy with a rotated seam", () => {
    warmCartesianCache(field, corner);
    const copies = plan(corner, [diskAt([COLUMNS - 1, 1], 0, 5)]);
    expect(copies).toHaveLength(1);
    const [copy] = copies;
    expect(isReflection(copy.transform)).toBe(false);
    // A quarter turn: the first column of the matrix is a unit axis that is not the x axis.
    expect(Math.abs(copy.transform.a)).toBeLessThan(1e-9);
    expect(Math.abs(copy.transform.b)).toBeGreaterThan(0.5);
    expect(insideCell(copy.to.cell, applyTransform(copy.transform, pastFace(copy, 0.1)) as [number, number])).toBe(true);
  });

  it("mirrors the copy with a twisted seam", () => {
    warmCartesianCache(field, mobius);
    const [copy] = plan(mobius, [diskAt([COLUMNS - 1, 1], 0, 5)]);
    expect(isReflection(copy.transform)).toBe(true);
    expect(insideCell(copy.to.cell, applyTransform(copy.transform, pastFace(copy, 0.1)) as [number, number])).toBe(true);
  });

  it("clips the copy to a strip inside the partner's cell", () => {
    const [copy] = plan(cylinder, [diskAt([COLUMNS - 1, 2], 0, 5)]);
    const xs = copy.clip.flatMap((polygon) => polygon.filter((_, i) => i % 2 === 0));
    const faceX = applyTransform(display(), copy.to.contact)[0];
    expect(xs.every((x) => x >= faceX - 1e-6)).toBe(true);
    expect(Math.max(...xs)).toBeGreaterThan(faceX);
  });
});
