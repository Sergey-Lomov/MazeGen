import { describe, it, expect, vi } from "vitest";
import { buildProjectTeleportGroups, mergeTeleportGroupsAcrossFloors, resolveFloorGroupOverrides, resolveRendererGroupOverrides } from "../pixi/selectors/projectTeleportGroups";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { TeleportGroup } from "../pixi/selectors/teleportGroups";

// Cell centers resolve through wasm, unavailable in unit tests — canonical square formula.
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const group = (edgeKeys: string[], links: [number, number][], points: [number, number][]): TeleportGroup => ({
  key: edgeKeys.join("|"),
  edgeKeys,
  points,
  links: links.map(([from, to]) => ({ from, to, oneWay: false })),
});

describe("mergeTeleportGroupsAcrossFloors (GitHub issue #727 follow-up)", () => {
  it("unions the per-floor groups holding the same cross-floor teleport into one group", () => {
    // Teleport 1-10 crosses floors: floor 0 groups it with 1-2, floor 1 groups it with 10-11.
    const floor0 = [group(["1-10", "1-2"], [[1, 10], [1, 2]], [[0, 0], [5, 5]])];
    const floor1 = [group(["1-10", "10-11"], [[1, 10], [10, 11]], [[7, 7], [8, 8]])];
    const merged = mergeTeleportGroupsAcrossFloors([floor0, floor1]);
    expect(merged).toHaveLength(1);
    expect(merged[0].edgeKeys).toEqual(["1-10", "1-2", "10-11"]);
    expect(merged[0].links).toHaveLength(3);
    expect(merged[0].points).toHaveLength(4);
  });

  it("keeps unrelated groups and their keys untouched", () => {
    const a = group(["1-2"], [[1, 2]], [[0, 0], [1, 1]]);
    const b = group(["3-4"], [[3, 4]], [[2, 2], [3, 3]]);
    const merged = mergeTeleportGroupsAcrossFloors([[a], [b]]);
    expect(merged.map((g) => g.key)).toEqual(["1-2", "3-4"]);
  });
});

describe("resolveFloorGroupOverrides", () => {
  it("re-keys a project-wide override onto each floor's own group key", () => {
    const f0 = group(["1-10", "1-2"], [], []);
    const f1 = group(["1-10", "10-11"], [], []);
    const project = mergeTeleportGroupsAcrossFloors([[f0], [f1]]);
    const overrides = { [project[0].key]: { shape: "circle" as const } };
    expect(resolveFloorGroupOverrides([f0], project, overrides)[f0.key]).toEqual({ shape: "circle" });
    expect(resolveFloorGroupOverrides([f1], project, overrides)[f1.key]).toEqual({ shape: "circle" });
  });

  it("returns the overrides object itself when no group merged", () => {
    const g = group(["1-2"], [], []);
    const overrides = { "1-2": { shape: "circle" as const } };
    expect(resolveFloorGroupOverrides([g], [g], overrides)).toBe(overrides);
  });
});

describe("cross-floor teleports on a real two-floor maze (GitHub issue #727 follow-up)", () => {
  const cfg: TessellationConfig = { type: "square", width: 8, height: 8 };
  const floors = [{ id: "f1" }, { id: "f2" }];
  // 0-1 inside floor 0, 2-3 inside floor 1, 1<->2 crosses floors.
  const nodes = [
    { id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 3, y: 3, i: 0, level: 0 },
    { id: 2, x: 5, y: 5, i: 0, level: 1 }, { id: 3, x: 1, y: 1, i: 0, level: 1 },
  ] as NodeDto[];
  const edges = [
    { from: 0, to: 1, kind: "teleport" }, { from: 1, to: 0, kind: "teleport" },
    { from: 2, to: 3, kind: "teleport" }, { from: 3, to: 2, kind: "teleport" },
    { from: 1, to: 2, kind: "teleport" }, { from: 2, to: 1, kind: "teleport" },
  ] as EdgeDto[];
  const args = { nodes, edges, cfg, floors, avoidFieldExit: false, start: null, finish: null };

  it("lists the cross-floor teleport and the teleports it connects as one group", () => {
    const groups = buildProjectTeleportGroups(args);
    expect(groups).toHaveLength(1);
    expect(groups[0].edgeKeys).toEqual(["0-1", "1-2", "2-3"]);
  });

  it("applies an override stored under the project-wide key to a floor's own group", () => {
    const [project] = buildProjectTeleportGroups(args);
    const overrides = { [project.key]: { shape: "circle" as const } };
    const floorGroup = group(["0-1", "1-2"], [], []);
    expect(resolveRendererGroupOverrides([floorGroup], overrides, args)[floorGroup.key]).toEqual({ shape: "circle" });
    // Same inputs again — the cached project-wide groups are reused, result stays the same.
    expect(resolveRendererGroupOverrides([floorGroup], overrides, { ...args })[floorGroup.key]).toEqual({ shape: "circle" });
  });

  it("returns the overrides untouched when there are none", () => {
    const empty = {};
    expect(resolveRendererGroupOverrides([], empty, args)).toBe(empty);
  });
});
