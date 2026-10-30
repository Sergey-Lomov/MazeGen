import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { faceIndexTo, faceNeighborCell, faceNeighborCells, resolveFaceNeighbor, resolveFaceNeighbors } from "../pixi/faceNeighbors";
import { collectRotateMoves } from "../pixi/postEditRotation";
import { rotatePresetSplitPoint, presetEdgeKey } from "../pixi/presetSplitResolve";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { PresetConnectionEntry } from "../pixi/fieldEditUtils";
import { splitPointFaceKindsByNode } from "../pixi/splitNodeGeometry";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditEdge } from "../store/postEditTypes";
import type { NodeDto, WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";

// Face order on a square: 0 east, 1 north, 2 west, 3 south.
const COLUMNS = 4;
const ROWS = 3;
const cells: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
const field = fieldOf("square", { shape: "custom", points: cells });
const inField = new Set(cells.map(([x, y]) => `${x},${y}`));

const cylinder: WireTopology = {
  fingerprint: "square{}",
  folds: Array.from({ length: ROWS }, (_, y) => ({
    a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 },
    b: { cell: [0, y] as [number, number], face_idx: 2 },
    twist: false,
    group: 0,
  })),
  groups: [{ id: 0, folds: Array.from({ length: ROWS }, (_, y) => y) }],
};

describe("faceNeighborCell", () => {
  it("returns the base offset cell outside the field for an unglued edge face, and null for a missing face", () => {
    warmCartesianCache(field, null);
    expect(faceNeighborCell(field, [0, 1], 2)).toEqual([-1, 1]);
    expect(faceNeighborCell(field, [0, 1], 9)).toBeNull();
  });
});

describe("resolveFaceNeighbors", () => {
  it("reads a glued face as a field edge without seams", () => {
    warmCartesianCache(field, null);
    expect(resolveFaceNeighbor(field, [COLUMNS - 1, 1], 0, inField)).toBeNull();
    expect(resolveFaceNeighbor(field, [0, 1], 2, inField)).toBeNull();
  });

  it("resolves a seam face to its partner cell", () => {
    warmCartesianCache(field, cylinder);
    expect(resolveFaceNeighbor(field, [COLUMNS - 1, 1], 0, inField)).toEqual([0, 1]);
    expect(resolveFaceNeighbor(field, [0, 1], 2, inField)).toEqual([COLUMNS - 1, 1]);
  });

  it("keeps ordinary faces and real field edges", () => {
    warmCartesianCache(field, cylinder);
    const neighbors = resolveFaceNeighbors(field, [1, 0], inField);
    expect(neighbors[0]).toEqual([2, 0]);
    expect(neighbors[1]).toEqual([1, 1]);
    expect(neighbors[2]).toEqual([0, 0]);
    expect(neighbors[3]).toBeNull();
  });
});

describe("face neighbor cells", () => {
  it("returns the seam partner and keeps cells outside the field", () => {
    warmCartesianCache(field, cylinder);
    expect(faceNeighborCell(field, [COLUMNS - 1, 1], 0)).toEqual([0, 1]);
    expect(faceNeighborCell(field, [1, 0], 3)).toEqual([1, -1]);
    expect(faceNeighborCell(field, [1, 0], 9)).toBeNull();
    expect(faceNeighborCells(field, [0, 1])).toEqual([[1, 1], [0, 2], [COLUMNS - 1, 1], [0, 0]]);
  });

  it("finds the face leading to a cell, across a seam too", () => {
    warmCartesianCache(field, cylinder);
    expect(faceIndexTo(field, [COLUMNS - 1, 1], [0, 1])).toBe(0);
    expect(faceIndexTo(field, [0, 1], [COLUMNS - 1, 1])).toBe(2);
    expect(faceIndexTo(field, [1, 1], [3, 1])).toBe(-1);
  });
});

describe("rotation across a seam", () => {
  const nodes: NodeDto[] = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const idOf = ([x, y]: [number, number]) => nodes.find((n) => n.x === x && n.y === y)!.id;

  it("moves a connection through a glued face to the next face", () => {
    warmCartesianCache(field, cylinder);
    const east: [number, number] = [COLUMNS - 1, 1];
    const edge: PostEditEdge = { kind: "basic", from: nodeEndpoint(idOf(east)), to: nodeEndpoint(idOf([0, 1])) };
    const moves = collectRotateMoves({ e: edge }, east, [], 1, field, inField, nodes, undefined);
    expect(moves).toHaveLength(1);
    expect(moves![0].newNeighbor).not.toEqual([0, 1]);
    expect(inField.has(`${moves![0].newNeighbor[0]},${moves![0].newNeighbor[1]}`)).toBe(true);
  });

  it("ignores a glued connection without the seam", () => {
    warmCartesianCache(field, null);
    const east: [number, number] = [COLUMNS - 1, 1];
    const edge: PostEditEdge = { kind: "basic", from: nodeEndpoint(idOf(east)), to: nodeEndpoint(idOf([0, 1])) };
    expect(collectRotateMoves({ e: edge }, east, [], 1, field, inField, nodes, undefined)).toEqual([]);
  });
});

describe("preset rotation and node face kinds across a seam", () => {
  const east: [number, number] = [COLUMNS - 1, 1];
  const west: [number, number] = [0, 1];

  it("moves a preset connection through a glued face off that face", () => {
    warmCartesianCache(field, cylinder);
    const from = presetEndpoint(east);
    const to = presetEndpoint(west);
    const key = presetEdgeKey(from, to);
    const connections = new Map<string, PresetConnectionEntry>([[key, { from, to, state: "passage", source: "user" }]]);
    const rotated = rotatePresetSplitPoint(connections, east, [], 1, field, inField, {}, {});
    expect(rotated.refusalReason).toBeUndefined();
    expect(rotated.has(key)).toBe(false);
    expect([...rotated.values()]).toHaveLength(1);
  });

  it("reads the face kind of a split node through the seam", () => {
    warmCartesianCache(field, cylinder);
    const a = { id: 1, x: east[0], y: east[1] };
    const b = { id: 2, x: west[0], y: west[1] };
    const byTile = new Map([[`${west[0]}:${west[1]}`, [b]]]);
    const kinds = splitPointFaceKindsByNode([a], byTile, new Set(["1->2", "2->1"]), field);
    expect(kinds[0][0]).toBe("passage");
    expect(kinds[0].slice(1)).toEqual(["wall", "wall", "wall"]);
  });
});
