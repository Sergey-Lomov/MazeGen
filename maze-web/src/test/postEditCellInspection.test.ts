import { describe, it, expect } from "vitest";
import { buildPostEditMazeSource, resolveCellInspection } from "../pixi/cellInspectionResolver";
import { buildCellInspection } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/postEditTypes";
import { useMazeStore } from "../store/mazeStore";
import { fieldOf } from "./fieldConfigFixtures";

type MazeState = ReturnType<typeof useMazeStore.getState>;

const node = (id: number, x: number, y: number, extra: Partial<NodeDto> = {}): NodeDto =>
  ({ id, x, y, i: 0, level: 0, ...extra });

/** Minimal `MazeState` slice the cell-inspection resolver actually reads — every other field is
 *  irrelevant to it (GitHub issue #488). */
function state(over: Partial<MazeState>): MazeState {
  return {
    openCard: "post_edit",
    nodes: [],
    edges: [],
    start: null,
    finish: null,
    floors: [{ id: "f0" }],
    activeFloorId: "f0",
    activeFieldConfig: fieldOf("square", { shape: "rect", cols: 8, rows: 8 }),
    _generatedEdges: [] as EdgeDto[],
    postEditDraftEdges: {} as Record<string, PostEditEdge>,
    postEditDraftTeleports: [],
    postEditDraftSplitPoints: {},
    postEditDraftMeta: null,
    postEditMeta: null,
    postEditDraftVerticalPassages: [],
    postEditDraftElevators: [],
    ...over,
  } as MazeState;
}

function inspect(st: MazeState, x: number, y: number): string {
  const src = buildPostEditMazeSource(st);
  return buildCellInspection(src.nodeById, src.edges, x, y, 0, src.start, src.finish, null);
}

describe("buildPostEditMazeSource (GitHub issue #488)", () => {
  it("start/finish come from postEditDraftMeta, not the stale confirmed state.start/state.finish", () => {
    const nodes = [node(1, 0, 0), node(2, 1, 0)];
    // Generation put Start on node 1; the user moved it to node 2 in post-edit (draft meta only —
    // confirmPostEdit never writes state.start back).
    const st = state({
      nodes,
      start: 1,
      finish: null,
      postEditDraftMeta: { start: nodeEndpoint(2), finish: null },
    });
    expect(inspect(st, 0, 0)).toBe("x:0, y:0");
    expect(inspect(st, 1, 0)).toBe("x:1, y:0 | Start");
  });

  it("falls back to confirmed state.start/state.finish when no draft meta exists yet", () => {
    const st = state({ nodes: [node(1, 0, 0)], start: 1, postEditDraftMeta: null });
    expect(inspect(st, 0, 0)).toBe("x:0, y:0 | Start");
  });

  it("an uncommitted draft teleport is reported before confirm", () => {
    const nodes = [node(1, 0, 0), node(2, 3, 2)];
    const st = state({
      nodes,
      postEditDraftTeleports: [{ id: "t1", from: nodeEndpoint(1), to: nodeEndpoint(2), direction: "two_way" }],
    });
    expect(inspect(st, 0, 0)).toBe("x:0, y:0 | Teleport <-> (3:2)");
    expect(inspect(st, 3, 2)).toBe("x:3, y:2 | Teleport <-> (0:0)");
  });

  it("a draft teleport anchored on a confirmed split slot resolves to that node", () => {
    // Split point at (0,0): original node (i:0) + one confirmed slot (i:1, slotId 0).
    const nodes = [
      node(1, 0, 0, { i: 0 }),
      node(2, 0, 0, { i: 1 }),
      node(3, 3, 2),
    ];
    const st = state({
      nodes,
      postEditDraftSplitPoints: { "0,0": [0] },
      postEditDraftTeleports: [
        { id: "t1", from: splitEndpoint([0, 0], 0), to: nodeEndpoint(3), direction: "forward" },
      ],
    });
    // The teleport departs the split slot (Node 2), not the original node (Node 1).
    expect(inspect(st, 0, 0)).toBe("x:0, y:0 | [Node 1: empty] | [Node 2: Teleport -> (3:2)]");
  });

  it("generation-time vertical passage is shown — a full baseline draft entry (GitHub issue #564)", () => {
    const nodes = [node(1, 0, 0, { level: 0 }), node(2, 0, 0, { level: 1 })];
    const shown = state({
      nodes,
      postEditDraftVerticalPassages: [{ id: "v1", from: nodeEndpoint(1), to: nodeEndpoint(2), direction: "two_way" }],
    });
    expect(inspect(shown, 0, 0)).toBe("x:0, y:0 | Vertical passage <-> (L2)");
  });

  it("generation-time elevator is shown — a full baseline draft entry (GitHub issue #564)", () => {
    const nodes = [
      node(1, 0, 0, { level: 0 }), node(2, 0, 0, { level: 1 }), node(3, 0, 0, { level: 2 }),
    ];
    const shown = state({
      nodes,
      postEditDraftElevators: [{ id: "e1", floors: [nodeEndpoint(1), nodeEndpoint(2), nodeEndpoint(3)] }],
    });
    expect(inspect(shown, 0, 0)).toBe("x:0, y:0 | Elevator (L2, L3)");
  });

  it("a user-placed draft vertical passage (not yet confirmed) is reported", () => {
    const nodes = [node(1, 0, 0, { level: 0 }), node(2, 0, 0, { level: 1 })];
    const st = state({
      nodes,
      postEditDraftVerticalPassages: [
        { id: "v1", from: nodeEndpoint(1), to: nodeEndpoint(2), direction: "forward" },
      ],
    });
    expect(inspect(st, 0, 0)).toBe("x:0, y:0 | Vertical passage -> (L2)");
  });
});

describe("resolveCellInspection — Analytics / image-export cards (GitHub issue #303 fallback)", () => {
  it("Analytics inspector resolves start/finish through postEditMeta, not the stale state.start", () => {
    const nodes = [node(1, 0, 0), node(2, 1, 0)];
    // Post-edit moved Start from node 1 to node 2 and confirmed — postEditMeta reflects it,
    // state.start still points at the generation-time node.
    const st = state({
      openCard: "analytics",
      nodes,
      edges: [],
      start: 1,
      finish: null,
      postEditMeta: { start: nodeEndpoint(2), finish: null },
    });
    expect(resolveCellInspection(st, 0, 0)).toBe("x:0, y:0");
    expect(resolveCellInspection(st, 1, 0)).toBe("x:1, y:0 | Start");
  });

  it("Analytics inspector falls back to state.start/state.finish when post-edit never confirmed", () => {
    const st = state({
      openCard: "image_export",
      nodes: [node(1, 0, 0)],
      edges: [],
      start: 1,
      postEditMeta: null,
    });
    expect(resolveCellInspection(st, 0, 0)).toBe("x:0, y:0 | Start");
  });
});
