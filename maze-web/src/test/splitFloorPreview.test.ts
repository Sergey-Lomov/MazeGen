import { describe, it, expect, vi } from "vitest";
import type { FieldConfig } from "../fieldConfig";
import type { NodeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTeleportEntry } from "../store/postEditTypes";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    cartesian_coords: (config: { points: [number, number][] }) => config.points,
  }),
  initWasm: vi.fn(() => Promise.resolve()),
}));

const { buildSplitFloorGeometry } = await import("../pixi/splitFloorPreview");
const { splitEndpoint, nodeEndpoint } = await import("../pixi/postEditEndpoint");

describe("buildSplitFloorGeometry", () => {
  it("resolves draft edges touching a split-node slot on floor 0 (GitHub issue #632 regression)", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    // Point (1,1) split into original node (id 0) + one slot (slotId 0, node id 1).
    const allNodes: NodeDto[] = [
      { id: 0, x: 1, y: 1, i: 0, level: 0 },
      { id: 1, x: 1, y: 1, i: 1, level: 0 },
      { id: 2, x: 1, y: 0, i: 0, level: 0 },
      { id: 3, x: 1, y: 2, i: 0, level: 0 },
      { id: 4, x: 0, y: 1, i: 0, level: 0 },
      { id: 5, x: 2, y: 1, i: 0, level: 0 },
    ];
    const splitPoints = { "1,1": [0] };

    const draftEdges: Record<string, PostEditEdge> = {};
    const put = (from: PostEditEdge["from"], to: PostEditEdge["to"]) => {
      draftEdges[`${JSON.stringify(from)}-${JSON.stringify(to)}`] = { kind: "basic", from, to };
    };
    put(nodeEndpoint(0), nodeEndpoint(2));
    put(nodeEndpoint(0), nodeEndpoint(3));
    // These two touch the split slot (node id 1) — the ones GitHub issue #632 silently dropped,
    // because floor 0 is stored unsuffixed and the old code asked `recordOnLevel` for "1,1@0".
    put(splitEndpoint([1, 1], 0), nodeEndpoint(4));
    put(splitEndpoint([1, 1], 0), nodeEndpoint(5));

    const geo = buildSplitFloorGeometry([1, 1], 0, allNodes, draftEdges, [], splitPoints, cfg);

    expect(geo?.edges).toHaveLength(4);
    expect(geo?.edges).toContainEqual({ from: 1, to: 4, kind: "basic" });
    expect(geo?.edges).toContainEqual({ from: 1, to: 5, kind: "basic" });
  });

  it("returns null when the point has fewer than 2 nodes on this floor (not actually split)", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const allNodes: NodeDto[] = [{ id: 0, x: 1, y: 1, i: 0, level: 0 }];

    const geo = buildSplitFloorGeometry([1, 1], 0, allNodes, {}, [], {}, cfg);

    expect(geo).toBeNull();
  });

  it("resolves teleport entries touching a split-node slot, respecting direction (forward/backward/two_way)", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const allNodes: NodeDto[] = [
      { id: 0, x: 1, y: 1, i: 0, level: 0 },
      { id: 1, x: 1, y: 1, i: 1, level: 0 },
      { id: 2, x: 1, y: 0, i: 0, level: 0 },
      { id: 3, x: 1, y: 2, i: 0, level: 0 },
    ];
    const splitPoints = { "1,1": [0] };

    const draftTeleports: PostEditTeleportEntry[] = [
      { id: "t-fwd", from: splitEndpoint([1, 1], 0), to: nodeEndpoint(2), direction: "forward" },
      { id: "t-back", from: splitEndpoint([1, 1], 0), to: nodeEndpoint(3), direction: "backward" },
      { id: "t-both", from: nodeEndpoint(2), to: splitEndpoint([1, 1], 0), direction: "two_way" },
    ];

    const geo = buildSplitFloorGeometry([1, 1], 0, allNodes, {}, draftTeleports, splitPoints, cfg);

    // forward: slot(1) -> node2, one directed edge.
    expect(geo?.edges).toContainEqual({ from: 1, to: 2, kind: "teleport" });
    // backward: slot(1) -> node3 declared, but only the reverse (node3 -> slot(1)) is emitted.
    expect(geo?.edges).toContainEqual({ from: 3, to: 1, kind: "teleport" });
    expect(geo?.edges).not.toContainEqual({ from: 1, to: 3, kind: "teleport" });
    // two_way: node2 -> slot(1) declared, both directions emitted.
    expect(geo?.edges).toContainEqual({ from: 2, to: 1, kind: "teleport" });
    expect(geo?.edges).toContainEqual({ from: 1, to: 2, kind: "teleport" });
    expect(geo?.edges).toHaveLength(4);
  });
});
