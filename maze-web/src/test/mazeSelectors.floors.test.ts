import { describe, it, expect, vi } from "vitest";
import { selectFloorRemovalLosesFieldData, selectFloorChangeLosesGenerationData, selectFloorScopedMaze, createFloorNodesSelector } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


describe("selectFloorRemovalLosesFieldData", () => {
  it("false when the floor has no fieldDirty entry", () => {
    expect(selectFloorRemovalLosesFieldData({ floorFields: {} }, "floor_1")).toBe(false);
  });

  it("false when the floor's field is not dirty", () => {
    const state = { floorFields: { floor_1: { fieldDirty: false } } } as never;
    expect(selectFloorRemovalLosesFieldData(state, "floor_1")).toBe(false);
  });

  it("true when the floor's field is dirty", () => {
    const state = { floorFields: { floor_1: { fieldDirty: true } } } as never;
    expect(selectFloorRemovalLosesFieldData(state, "floor_1")).toBe(true);
  });
});

describe("selectFloorChangeLosesGenerationData", () => {
  it("false when neither maze nor post-edit is dirty", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: false, postEditDirty: false })).toBe(false);
  });

  it("true when a generation result exists (mazeDirty)", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: true, postEditDirty: false })).toBe(true);
  });

  it("true when post-edit changes exist", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: false, postEditDirty: true })).toBe(true);
  });

  it("true when both are dirty", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: true, postEditDirty: true })).toBe(true);
  });
});

describe("createFloorNodesSelector (GitHub issue #739)", () => {
  const floors = [{ id: "f1" }, { id: "f2" }];
  const nodes: NodeDto[] = [
    { id: 0, x: 0, y: 0, i: 0 },
    { id: 1, x: 0, y: 0, i: 0, level: 1 },
  ];

  it("returns the same array while inputs are unchanged", () => {
    const select = createFloorNodesSelector();
    const first = select(nodes, floors, "f1");
    expect(first.map((n) => n.id)).toEqual([0]);
    expect(select(nodes, floors, "f1")).toBe(first);
  });

  it("recomputes when the floor, the floor list or the node list changes", () => {
    const select = createFloorNodesSelector();
    const first = select(nodes, floors, "f1");
    expect(select(nodes, floors, "f2").map((n) => n.id)).toEqual([1]);
    expect(select(nodes, [...floors].reverse(), "f2").map((n) => n.id)).toEqual([0]);
    const next = select([...nodes], floors, "f1");
    expect(next).not.toBe(first);
    expect(next.map((n) => n.id)).toEqual([0]);
  });
});

describe("selectFloorScopedMaze", () => {
  const floors = [{ id: "floor_0" }, { id: "floor_1" }];
  const n = (id: number, level: number, x = id, y = 0): NodeDto => ({ id, x, y, i: 0, level });
  const e = (from: number, to: number, kind: EdgeDto["kind"] = "basic"): EdgeDto => ({ from, to, kind });

  it("keeps only nodes on the active floor", () => {
    const nodes = [n(1, 0), n(2, 0), n(3, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0");
    expect(result.nodes.map((x) => x.id)).toEqual([1, 2]);
  });

  it("keeps a basic edge only when both endpoints are on the active floor", () => {
    const nodes = [n(1, 0), n(2, 0), n(3, 1)];
    const edges = [e(1, 2), e(2, 3)];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toEqual([{ from: 1, to: 2, kind: "basic" }]);
  });

  it("keeps a vertical_passage/elevator edge whose `from` is on the active floor even though `to` is on another", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const edges = [e(1, 2, "vertical_passage"), e(1, 2, "elevator")];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toHaveLength(2);
  });

  it("drops a vertical_passage/elevator edge whose `from` is on another floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const edges = [e(2, 1, "vertical_passage")];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toEqual([]);
  });

  it("nulls out start/finish when their node isn't on the active floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0", 1, 2);
    expect(result.start).toBe(1);
    expect(result.finish).toBeNull();
  });

  it("treats a missing `level` as floor 0", () => {
    const nodes: NodeDto[] = [{ id: 1, x: 0, y: 0, i: 0 }];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0");
    expect(result.nodes.map((x) => x.id)).toEqual([1]);
  });

  it("falls back to floor 0 when activeFloorId doesn't match any floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "unknown_floor_id");
    expect(result.nodes.map((x) => x.id)).toEqual([1]);
  });
});