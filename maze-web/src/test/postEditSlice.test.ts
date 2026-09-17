import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import {
  baseStoreState, baseFloorFieldConfig, mockSnapshot, TEST_FLOOR_ID, postEditStatePatch,
} from "./storeTestHelpers";
import type { PostEditSeed } from "./storeTestHelpers";
import { nodeEndpoint, splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import { suppressionPairKey } from "../pixi/postEditReplay";
import { configAllCells } from "../pixi/tessellationCells";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { computeAnalytics } from "../wasm/mazeService";

const n = nodeEndpoint;
const key01 = edgeKey(n(0), n(1));
/** Suppression-set key for a generation-time node-to-node pair. Built via the real
 *  `suppressionPairKey` (not a hand-written `"a,b"` literal) so these assertions can't drift from
 *  the production key format again (GitHub issue #543 — the keys are `endpointKey`-based now). */
const vpPair = (a: number, b: number) => suppressionPairKey(n(a), n(b));
const elevPair = vpPair;

/** The default generation snapshot every test starts from: two floor-0 nodes with a single
 *  one-directional `basic` edge 0->1 (so `buildPostEditBaseline` derives a `one_way_forward` draft
 *  edge from it, matching what the old hand-written `beforeEach` relied on for the `reset`-tool
 *  and `resetPostEdit` tests). */
const BASE_NODES = [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }];
const BASE_EDGES = [{ from: 0, to: 1, kind: "basic" as const }];

/** Seeds a full, self-consistent post-edit scenario: a real `postEditBaseline` built from the
 *  generation snapshot plus a replayed command log, with the legacy `postEditDraft*` mirror fields
 *  derived from it (GitHub issue #543 — actions read the baseline, never the mirror fields, so
 *  seeding the mirror fields alone silently desyncs the two). `extra` carries any non-post-edit
 *  store fields the scenario also needs (floors, tessellation, tool, ...). */
function seedPostEdit(
  seed: Partial<PostEditSeed> = {},
  extra: Partial<ReturnType<typeof useMazeStore.getState>> = {},
) {
  useMazeStore.setState({
    ...postEditStatePatch({
      nodes: BASE_NODES, edges: BASE_EDGES, start: 0, finish: 1, ...seed,
    }),
    postEditActiveSplitNode: {},
    postEditEdges: null,
    postEditMeta: null,
    postEditAnalytics: null,
    postEditDirty: false,
    postEditDraftTeleports: [],
    ...extra,
  } as Partial<ReturnType<typeof useMazeStore.getState>>);
}

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  vi.mocked(computeAnalytics).mockReset();
  vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
  useMazeStore.setState({
    activeTessellationConfig: { type: "square", width: 2, height: 1 },
    postEditAutoConfirm: false,
    _nextPostEditTeleportId: 1,
    _nextPostEditVerticalPassageId: 1,
    _nextPostEditElevatorId: 1,
    postEditTeleportPendingFrom: null,
    postEditVerticalPassagePending: null,
    postEditElevatorPending: null,
    postEditSplitTargetPrompt: null,
    error: null,
  });
  // The shared default scenario: generation produced a single directed 0->1 `basic` edge (so a
  // `reset`/`resetPostEdit` restores it as `one_way_forward`), which the user has since upgraded
  // to a full two-way passage — matching the `{ key01: basic }` default draft the pre-command-log
  // `beforeEach` wrote into `postEditDraftEdges` by hand. `setEdge` sets exactly one directed key
  // (GitHub issue #543 — it never touches the reverse key as a side effect), so a full two-way
  // passage needs both directions seeded explicitly. Start is node 0, finish is node 1.
  seedPostEdit({
    commands: [
      { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
      { kind: "setEdge", from: n(1), to: n(0), edgeKind: "basic" },
    ],
  });
});

describe("mazeStore post-edit actions", () => {
  it("setPostEditAutoConfirm / setPostEditTool update their fields", () => {
    useMazeStore.getState().setPostEditAutoConfirm(true);
    useMazeStore.getState().setPostEditTool("passage");
    const s = useMazeStore.getState();
    expect(s.postEditAutoConfirm).toBe(true);
    expect(s.postEditTool).toBe("passage");
  });

  it("applyPostEditTool('wall') deletes the draft edge entry and marks postEditDirty", () => {
    useMazeStore.setState({ postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toBeUndefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("applyPostEditTool('passage') sets a basic edge entry", () => {
    // Generation left the two nodes unconnected, so the draft starts with no 0-1 entry at all.
    seedPostEdit({ edges: [] }, { postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("basic");
  });

  it("applyPostEditTool('reset') restores the edge from _generatedEdges, not the current (edited) state.edges (GitHub issue #323)", () => {
    // Simulates state after a confirmed manual edit: state.edges no longer has 0-1 (a wall was
    // confirmed there), while _generatedEdges still holds the original generation output.
    seedPostEdit(
      { liveEdges: [], commands: [{ kind: "setEdge", from: n(0), to: n(1), edgeKind: "wall" }] },
      { postEditTool: "reset" },
    );
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]).toBeUndefined();
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
  });

  it("applyPostEditTool is no-op when there is no draft yet", () => {
    useMazeStore.setState({ postEditBaseline: null, postEditDraftEdges: null, postEditDirty: false });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDirty).toBe(false);
  });

  it("applyPostEditToolAt triggers confirmPostEdit when postEditAutoConfirm is on (GitHub issue #241)", async () => {
    seedPostEdit({ edges: [] }, { postEditAutoConfirm: true });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    await Promise.resolve();
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("applyPostEditToolAt does not call confirmPostEdit when postEditAutoConfirm is off", () => {
    seedPostEdit({ edges: [] }, { postEditAutoConfirm: false });
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("confirmPostEdit computes analytics from the current draft and stores a snapshot", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const s = useMazeStore.getState();
    expect(computeAnalytics).toHaveBeenCalled();
    expect(s.postEditAnalytics).not.toBeNull();
    // A two-way `basic` passage is two directed draft entries (see `applyPostEditEdgeTool`'s
    // "passage" branch) — the snapshot carries both, unchanged from the draft.
    expect(s.postEditEdges).toEqual({
      [key01]: { from: n(0), to: n(1), kind: "basic" },
      [edgeKey(n(1), n(0))]: { from: n(1), to: n(0), kind: "basic" },
    });
    expect(s.postEditMeta).toEqual({ start: n(0), finish: n(1) });
  });

  it("confirmPostEdit refreshes state.nodes from the snapshot (a confirmed split node must become resolvable on the next confirm)", async () => {
    const nodesWithSplit = [...mockSnapshot.nodes, { id: 2, x: 0, y: 0, i: 1 }];
    vi.mocked(computeAnalytics).mockReturnValueOnce({ ...mockSnapshot, nodes: nodesWithSplit });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().nodes).toEqual(nodesWithSplit);
  });

  it("confirmPostEdit resolves start/finish endpoints to plain node ids on the wire", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.start).toBe(0);
    expect(call?.finish).toBe(1);
  });

  it("confirmPostEdit passes non-wall edges and excludes wall edges to computeAnalytics", async () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        [key01]: { from: n(0), to: n(1), kind: "basic" },
        [edgeKey(n(1), n(2))]: { from: n(1), to: n(2), kind: "wall" },
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([{ from: { kind: "node", id: 0 }, to: { kind: "node", id: 1 }, kind: "basic" }]);
  });

  it("confirmPostEdit excludes individually disabled checks even when their rule is enabled (GitHub issue #264)", async () => {
    useMazeStore.setState({
      rules: [{
        id: "r1",
        name: "Rule 1",
        kind: "missing_endpoints",
        checks: [
          { localId: 0, typeId: "missing_endpoints", params: {}, disabled: false },
          { localId: 1, typeId: "unreachable_finish", params: {}, disabled: true },
        ],
        nextLocalCheckId: 2,
        strategyId: null,
        disabled: false,
        ruleDisabled: false,
        params: {}, nestedStrategies: [], collapsed: false,
      }],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "missing_endpoints", params: {} }], params: {} }]);
  });

  it("confirmPostEdit sends teleport edges to computeAnalytics with kind \"teleport\", separate from postEditDraftEdges", async () => {
    useMazeStore.setState({
      postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "basic" } },
      postEditDraftTeleports: [{ id: 1, from: n(0), to: n(2), direction: "forward" }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.edges).toEqual([
      { from: { kind: "node", id: 0 }, to: { kind: "node", id: 1 }, kind: "basic" },
      { from: { kind: "node", id: 0 }, to: { kind: "node", id: 2 }, kind: "teleport" },
    ]);
    expect(useMazeStore.getState().postEditTeleportEdges).toEqual([{ from: 0, to: 2, kind: "teleport" }]);
  });

  it("confirmPostEdit sends split_points built from postEditDraftSplitPoints", async () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "3,4": [0, 1] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0, 0], [[3, 4], 1, 0]]));
  });

  it("confirmPostEdit parses the \"@level\" suffix from postEditDraftSplitPoints keys into split_points' own level entry (GitHub issue #359)", async () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "3,4": [0], "3,4@1": [2] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.split_points).toEqual(expect.arrayContaining([[[3, 4], 0, 0], [[3, 4], 2, 1]]));
  });

  it("confirmPostEdit sends level_fields derived from state.floors (GitHub issue #359)", async () => {
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.level_fields).toEqual([configAllCells({ type: "square", width: 10, height: 10 })]);
  });

  it("confirmPostEdit sends one level_fields entry per floor, in floors order (GitHub issue #359)", async () => {
    const SECOND_FLOOR_ID = "floor-2";
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: SECOND_FLOOR_ID, title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 1 } }),
        [SECOND_FLOOR_ID]: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 4 } }),
      },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.level_fields).toEqual([
      configAllCells({ type: "square", width: 2, height: 1 }),
      configAllCells({ type: "square", width: 3, height: 4 }),
    ]);
  });

  it("confirmPostEdit sends every floor's preset connections/split points with their own level (GitHub issue #359)", async () => {
    useMazeStore.setState({
      presetSplitPoints: { "5,6": [0], "5,6@1": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.preset_split_points).toEqual(expect.arrayContaining([[[5, 6], 0, 0], [[5, 6], 0, 1]]));
    expect(call?.preset_split_points).toHaveLength(2);
  });

  it("confirmPostEdit prunes a non-floor-0 split node whose slot was removed client-side, keyed by its own \"@level\" point (GitHub issue #358)", async () => {
    useMazeStore.setState({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 3, x: 0, y: 0, i: 0, level: 1 },
        { id: 6, x: 0, y: 0, i: 1, level: 1 }, // removed client-side: no "0,0@1" entry below
      ],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes.map((n: { id: number }) => n.id)).toEqual([0, 1, 3]);
  });

  it("confirmPostEdit sends a passage edge drawn to a split node's own endpoint, not the original node's", () => {
    // Reproduces the reported flow: add a split node at (0,0) (auto-activates it - addSplitNode's
    // own behavior), then draw a passage from node 1 to whatever is "active" at (0,0) - exactly
    // what PostEditController's edge-tool click does via `resolveActiveEndpointAt`/`applyPostEditTool`.
    useMazeStore.getState().addSplitNode([0, 0]);
    const active = useMazeStore.getState().postEditActiveSplitNode["0,0"];
    expect(active).toEqual(splitEndpoint([0, 0], 0));

    useMazeStore.setState({ postEditTool: "passage" });
    const key = edgeKey(n(1), active!);
    useMazeStore.getState().applyPostEditTool(key, n(1), active!);

    const draftEdge = useMazeStore.getState().postEditDraftEdges?.[key];
    expect(draftEdge?.to).toEqual(splitEndpoint([0, 0], 0));
    expect(draftEdge?.to).not.toEqual(n(0)); // must not silently fall back to the original node

    void useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    // Wire DTO uses `slot_id` (snake_case, matching Rust's `PostEditEndpointDto`), not the
    // TS-side `PostEditEndpoint`'s `slotId` - this mismatch was the actual bug (serde rejected
    // the whole config with "missing field `slot_id`"), so pin the wire shape explicitly here.
    const sentEdge = call?.edges.find((e: { to: unknown }) =>
      JSON.stringify(e.to) === JSON.stringify({ kind: "split", point: [0, 0], slot_id: 0, level: 0 }));
    expect(sentEdge).toBeDefined();
  });

  it("resetPostEdit repopulates postEditDraftTeleports from generated edges", () => {
    useMazeStore.setState({
      _generatedNodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 2, y: 0, i: 0 }, { id: 3, x: 3, y: 0, i: 0 }],
      _generatedEdges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 3, kind: "teleport" }],
      postEditDraftTeleports: [],
    });
    useMazeStore.getState().resetPostEdit();
    expect(useMazeStore.getState().postEditDraftTeleports).toEqual([{ id: 1, from: n(2), to: n(3), direction: "forward" }]);
  });

  it("resetPostEdit restores nodes/edges/draft from _generatedNodes/_generatedEdges, not the current (edited) state.nodes/edges (GitHub issue #323)", () => {
    // Simulates state after a confirmed manual edit: state.edges/nodes reflect the edited graph
    // (edge 0-1 removed by a wall), while _generatedNodes/_generatedEdges still hold the original
    // generation output - GenerationRenderer must show the latter, and reset must restore from it.
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.nodes).toEqual(s._generatedNodes);
    expect(s.edges).toEqual(s._generatedEdges);
    expect(s.postEditDraftEdges).toEqual({ [key01]: { from: n(0), to: n(1), kind: "one_way_forward" } });
    expect(s.postEditDirty).toBe(false);
  });

  it("resetPostEdit keeps floor-1 nodes/edges and doesn't conflate a floor-1 node with a same-(x,y) floor-0 node into a split point (GitHub issue #358)", () => {
    // A floor-1 node at the same (x,y) as floor-0's node 1 must not be treated as a second split
    // slot at that point (GitHub issue #337's original conflation risk) - post-edit is now
    // floor-aware, so both floors' nodes/edges survive the reset, just grouped separately.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 1, y: 0, i: 0, level: 1 },
      ],
      _generatedEdges: [
        { from: 0, to: 1, kind: "basic" },
      ],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s._generatedNodes.map((n) => n.id).sort()).toEqual([0, 1, 2]);
    expect(s.postEditDraftEdges).toEqual({ [key01]: { from: n(0), to: n(1), kind: "one_way_forward" } });
    expect(s.postEditDraftSplitPoints).toEqual({});
  });

  it("resetPostEdit keeps a cross-floor teleport instead of dropping it (GitHub issue #363)", () => {
    // Node 1 (floor 0) and node 2 (floor 1) are teleport-linked. The per-floor loop filters
    // `_generatedEdges` to edges whose *both* endpoints belong to the floor being processed, which
    // drops this edge on every iteration unless it's separately re-derived across floors.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 5, y: 5, i: 0, level: 1 },
      ],
      _generatedEdges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 1, to: 2, kind: "teleport" },
      ],
      postEditDraftEdges: {},
      postEditDraftTeleports: [],
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toEqual([
      { id: 1, from: n(1), to: n(2), direction: "forward" },
    ]);
  });

  it("resetPostEdit assigns unique ids across a same-floor teleport and a cross-floor teleport (GitHub issue #363)", () => {
    // Each `extractPostEditTeleports` call numbers its own batch starting at 1 - merging the
    // per-floor batch (which finds the 0-1 same-floor teleport) with the separately-derived
    // cross-floor batch (1-2) without renumbering would give both entries id 1, and every by-id
    // lookup (drag handling, removePostEditTeleport, ...) resolves to the *first* match on a
    // collision, silently operating on the wrong teleport.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 5, y: 5, i: 0, level: 1 },
      ],
      _generatedEdges: [
        { from: 0, to: 1, kind: "teleport" },
        { from: 1, to: 2, kind: "teleport" },
      ],
      postEditDraftEdges: {},
      postEditDraftTeleports: [],
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    const ids = s.postEditDraftTeleports.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([1, 2]);
    expect(s._nextPostEditTeleportId).toBe(3);
  });

  it("resetPostEdit derives separate split points for same-(x,y) split nodes on different floors, each stamped with its own level (GitHub issue #358)", () => {
    // Point (0,0) is split on both floor 0 (extra node id 2) and floor 1 (extra node id 5) -
    // each floor's own slot must land in the flat postEditDraftSplitPoints under its own
    // "@level"-suffixed key, and the draft edges referencing each slot must carry that same level.
    useMazeStore.setState({
      _generatedNodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 1, level: 0 },
        { id: 3, x: 0, y: 0, i: 0, level: 1 },
        { id: 4, x: 1, y: 0, i: 0, level: 1 },
        { id: 5, x: 0, y: 0, i: 1, level: 1 },
      ],
      _generatedEdges: [
        { from: 2, to: 1, kind: "basic" },
        { from: 5, to: 4, kind: "basic" },
      ],
      postEditDraftEdges: {},
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints).toEqual({ "0,0": [0], "0,0@1": [0] });
    const floor0Key = edgeKey(splitEndpoint([0, 0], 0), n(1));
    const floor1Key = edgeKey(splitEndpoint([0, 0], 0, 1), n(4));
    expect(s.postEditDraftEdges?.[floor0Key]).toEqual({ from: splitEndpoint([0, 0], 0), to: n(1), kind: "one_way_forward" });
    expect(s.postEditDraftEdges?.[floor1Key]).toEqual({ from: splitEndpoint([0, 0], 0, 1), to: n(4), kind: "one_way_forward" });
  });

  it("resetPostEdit clears split-point draft state", () => {
    useMazeStore.setState({
      postEditDraftSplitPoints: { "0,0": [0] },
      postEditActiveSplitNode: { "0,0": splitEndpoint([0, 0], 0) },
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints).toEqual({});
    expect(s.postEditActiveSplitNode).toEqual({});
  });

  it("confirmPostEdit excludes rules belonging to a disabled stage from checks", async () => {
    useMazeStore.setState({
      rules: [
        { id: "rule_1", name: "Rule 1", kind: "unreachable", checks: [{ localId: 0, typeId: "check_a", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
        { id: "rule_2", name: "Rule 2", kind: "unreachable", checks: [{ localId: 0, typeId: "check_b", params: {}, disabled: false }], nextLocalCheckId: 1, strategyId: null, disabled: false, ruleDisabled: false, params: {}, nestedStrategies: [], collapsed: false },
      ],
      stages: [
        { id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false },
        { id: "stage_2", name: "Stage 2", ruleIds: ["rule_2"], disabled: true, collapsed: false },
      ],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{ checks: [{ local_id: "0", type_id: "check_a", params: {} }], params: {} }]);
  });

  it("confirmPostEdit forwards a rule's protect_route param onto its rule_groups entry (GitHub issue #245)", async () => {
    useMazeStore.setState({
      availableRuleParams: [{ id: "protect_route", label: "Protect route", kind: { type: "bool", default: true }, applies_to: ["teleport_duplicates_connection"] }],
      rules: [{
        id: "r1",
        name: "Rule 1",
        kind: "teleport",
        checks: [{ localId: 0, typeId: "teleport_duplicates_connection", params: {}, disabled: false }],
        nextLocalCheckId: 1,
        strategyId: null,
        disabled: false,
        ruleDisabled: false,
        params: { protect_route: "false" },
        nestedStrategies: [],
        collapsed: false,
      }],
      stages: [{ id: "s1", name: "Stage 1", ruleIds: ["r1"], disabled: false, collapsed: false }],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.rule_groups).toEqual([{
      checks: [{ local_id: "0", type_id: "teleport_duplicates_connection", params: {} }],
      params: { protect_route: "false" },
    }]);
  });

  it("confirmPostEdit is no-op when there is no draft", async () => {
    useMazeStore.setState({ postEditDraftEdges: null });
    await useMazeStore.getState().confirmPostEdit();
    expect(computeAnalytics).not.toHaveBeenCalled();
  });

  it("confirmPostEdit stores error message when computeAnalytics throws", async () => {
    vi.mocked(computeAnalytics).mockImplementation(() => { throw new Error("analytics failed"); });
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState().error).toBe("analytics failed");
  });

  it("confirmPostEdit increments the request id on every call", async () => {
    vi.mocked(computeAnalytics).mockReturnValue(mockSnapshot);
    const before = useMazeStore.getState()._postEditRequestId;
    await useMazeStore.getState().confirmPostEdit();
    await useMazeStore.getState().confirmPostEdit();
    expect(useMazeStore.getState()._postEditRequestId).toBe(before + 2);
  });

  it("resetPostEdit rebuilds draft from generated edges and restores generated endpoints", () => {
    useMazeStore.setState({
      postEditDraftEdges: { [key01]: { from: n(0), to: n(1), kind: "wall" } },
      postEditDirty: true,
    });
    useMazeStore.getState().resetPostEdit();
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta).toEqual({ start: n(0), finish: n(1) });
    expect(s.postEditDirty).toBe(false);
  });

  it("setPostEditEndpoint updates draft meta and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().setPostEditEndpoint("start", n(5));
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toEqual(n(5));
    expect(s.postEditDirty).toBe(true);
  });

  it("setPostEditEndpoint triggers confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().setPostEditEndpoint("finish", n(1));
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("clearPostEditEndpoint sets the endpoint to null and marks dirty", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.finish).toBeNull();
    expect(s.postEditDirty).toBe(true);
  });

  it("confirmPostEdit prunes a node whose split slot was removed client-side, so it's not resent to WASM (GitHub issue #327)", async () => {
    // (0,0) was auto-split at generation into original (i=0, id 0) + one extra node (i=1, id 2) -
    // removeSplitNode already dropped slot 0 from postEditDraftSplitPoints, but state.nodes still
    // carries the removed node's NodeDto (see confirmPostEdit's own pruning comment).
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }, { id: 1, x: 1, y: 0, i: 0 }],
      postEditDraftSplitPoints: {},
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes).toEqual([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }]);
  });

  it("confirmPostEdit keeps a node whose split slot is still declared", async () => {
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }, { id: 1, x: 1, y: 0, i: 0 }],
      postEditDraftSplitPoints: { "0,0": [0] },
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.nodes).toEqual(expect.arrayContaining([{ id: 2, x: 0, y: 0, i: 1 }]));
  });

  it("confirmPostEdit passes vertical_passage/elevator edges through unchanged from _generatedEdges", async () => {
    // VerticalPassage/Elevator edges are only user-editable via their own post-edit tools (GitHub
    // issue #341) - a generation-time one is otherwise resent verbatim from the frozen
    // `_generatedEdges` snapshot, not the live `state.edges` (which a later confirm overwrites), so
    // compute_analytics doesn't silently drop it from the rebuilt graph, and a point-reset's
    // un-suppression has something to restore even after an earlier edit.
    useMazeStore.setState({
      _generatedEdges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 1, to: 2, kind: "vertical_passage" },
        { from: 2, to: 0, kind: "elevator" },
      ],
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.vertical_edges).toEqual(expect.arrayContaining([
      { from: 1, to: 2, kind: "vertical_passage" },
      { from: 2, to: 0, kind: "elevator" },
    ]));
    expect(call?.vertical_edges).toHaveLength(2);
  });

  it("resetPostEditPoint resets one point's draft edges to generation-time state and marks dirty", () => {
    // The user walled off the generated 0-1 passage; resetting (0,0) must prune that edit out of
    // the log, leaving the generation-time `one_way_forward` edge the baseline carries.
    seedPostEdit({ commands: [{ kind: "setEdge", from: n(0), to: n(1), edgeKind: "wall" }] });
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]).toBeUndefined();
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(s.postEditDirty).toBe(true);
  });

  it("resetPostEditPoint excludes a floor-1 node sharing the reset point's (x,y) when the active floor is floor 0 (GitHub issue #337, #358)", () => {
    // Floor-0 nodes are (0,0)->id 0 and (1,0)->id 1, plus a floor-1 node also at (0,0) (id 2) -
    // resetting point (0,0) on the active floor (floor 0 here) must never pull that floor-1 node's
    // edges/teleports in, even though post-edit tools now work on any floor.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 2, to: 1, kind: "vertical_passage" }],
      commands: [{ kind: "setEdge", from: n(0), to: n(1), edgeKind: "wall" }],
    });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
    expect(Object.keys(s.postEditDraftEdges ?? {})).toHaveLength(1);
  });

  it("resetPostEditPoint restores a generation-time teleport the user had removed, and a later addPostEditTeleport can't collide with its id (GitHub issue #327)", () => {
    // Generation put a teleport 0->5 at the reset point; the user removed it. The reset must prune
    // that `removeTeleport` command out of the log (restoring the baseline teleport), and the next
    // `addPostEditTeleport` must still mint a free id.
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 5, y: 5, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" }, { from: 0, to: 5, kind: "teleport" }],
      commands: [{ kind: "removeTeleport", id: 1 }],
    }, { _nextPostEditTeleportId: 2 });
    expect(useMazeStore.getState().postEditDraftTeleports).toHaveLength(0);

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    const restoredId = s.postEditDraftTeleports[0].id;
    expect(s._nextPostEditTeleportId).toBeGreaterThan(restoredId);

    useMazeStore.getState().addPostEditTeleport(n(1), n(5), "forward");
    const ids = useMazeStore.getState().postEditDraftTeleports.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collision
  });

  it("resetPostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("resetPostEditPoint's elevator un-suppress covers the full mesh, not just pairs naming the point's own node (GitHub issue #341 follow-up)", () => {
    // A three-floor generation-time elevator mesh at (0,0) which the user then deleted from floor 2
    // (activeFloorId "f1", level 1, node 11) — that delete suppressed the *entire* component
    // (BFS over `_generatedEdges`, see `deletePoint`'s own reducer case), including the 10-12 pair
    // that never names node 11. Resetting that same point must prune the whole delete command back
    // out, un-suppressing all three pairs — not just the two naming node 11.
    seedPostEdit({
      nodes: [
        { id: 10, x: 0, y: 0, i: 0, level: 0 },
        { id: 11, x: 0, y: 0, i: 0, level: 1 },
        { id: 12, x: 0, y: 0, i: 0, level: 2 },
      ],
      edges: [
        { from: 10, to: 11, kind: "elevator" }, { from: 11, to: 10, kind: "elevator" },
        { from: 10, to: 12, kind: "elevator" }, { from: 12, to: 10, kind: "elevator" },
        { from: 11, to: 12, kind: "elevator" }, { from: 12, to: 11, kind: "elevator" },
      ],
      start: null, finish: null,
      commands: [{ kind: "deletePoint", point: [0, 0], level: 1 }],
    }, {
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }, { id: "f2", title: "Floor 3" }],
      activeFloorId: "f1",
    });
    expect(useMazeStore.getState().postEditSuppressedElevatorPairs).toEqual(
      new Set([elevPair(10, 11), elevPair(10, 12), elevPair(11, 12)]),
    );

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    expect(useMazeStore.getState().postEditSuppressedElevatorPairs).toEqual(new Set());
  });

  it("deletePostEditPoint clears start/finish, teleports, vertical passages and elevators touching the point, but leaves draft edges untouched (GitHub issue #386)", () => {
    seedPostEdit({
      commands: [
        { kind: "setEdge", from: n(0), to: n(1), edgeKind: "basic" },
        { kind: "addTeleport", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "addElevator", id: 1, floors: [n(0), n(1)] },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toBeNull();
    expect(s.postEditDraftMeta?.finish).toEqual(n(1));
    expect(s.postEditDraftTeleports).toHaveLength(0);
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "basic" });
    expect(s.postEditDirty).toBe(true);
  });

  it("deletePostEditPoint clears finish alone when only finish addresses the point", () => {
    seedPostEdit({ start: 1, finish: 0 });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftMeta?.start).toEqual(n(1));
    expect(s.postEditDraftMeta?.finish).toBeNull();
  });

  it("deletePostEditPoint suppresses a generation-time vertical passage/elevator touching the point, so it isn't resent on confirm", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 5, x: 0, y: 0, i: 0, level: 1 }, { id: 6, x: 0, y: 0, i: 0, level: 2 },
      ],
      edges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 0, to: 5, kind: "vertical_passage" },
        { from: 0, to: 6, kind: "elevator" }, { from: 6, to: 0, kind: "elevator" },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditSuppressedVerticalPassagePairs).toEqual(new Set([vpPair(0, 5)]));
    expect(s.postEditSuppressedElevatorPairs).toEqual(new Set([elevPair(0, 6)]));
  });

  it("deletePostEditPoint normalizes a suppressed pair the same way regardless of which side the generated edge names first (reversed from/to)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 5, x: 0, y: 0, i: 0, level: 1 }, { id: 6, x: 0, y: 0, i: 0, level: 2 },
      ],
      edges: [
        { from: 5, to: 0, kind: "vertical_passage" },
        { from: 6, to: 0, kind: "elevator" },
      ],
    });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    // Same keys as the non-reversed variant above — `suppressionPairKey` sorts its two endpoints.
    expect(s.postEditSuppressedVerticalPassagePairs).toEqual(new Set([vpPair(0, 5)]));
    expect(s.postEditSuppressedElevatorPairs).toEqual(new Set([elevPair(0, 6)]));
  });

  it("deletePostEditPoint clears content on an unconfirmed split slot too, not just the point's live nodes (GitHub issue #221's unresolved-endpoint window)", () => {
    const slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0 },
        { kind: "addTeleport", id: 1, from: n(1), to: slot0, direction: "forward" },
        { kind: "setMeta", slot: "start", endpoint: slot0 },
      ],
    });
    expect(useMazeStore.getState().postEditDraftSplitPoints["0,0"]).toEqual([0]);
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(0);
    expect(s.postEditDraftMeta?.start).toBeNull();
  });

  it("deletePostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().deletePostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
  });
});

describe("mazeStore post-edit vertical-passage/elevator actions (GitHub issue #341)", () => {
  /** Two floors' worth of `floors`/`floorFields`, with `activeFloorId` on floor index 1 — the
   *  geometry `startPostEditVerticalPassagePlacement`'s own available-direction probe reads. */
  const floorsExtra = (count: number, activeIndex: number) => ({
    activeFloorId: `f${activeIndex}`,
    floors: Array.from({ length: count }, (_, i) => ({ id: `f${i}`, title: `Floor ${i + 1}` })),
    floorFields: Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, baseFloorFieldConfig()])),
  });

  it("startPostEditVerticalPassagePlacement on a node with an existing generation-time forward edge seeds a draft entry with that direction, instead of creating a duplicate", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
    // The generation-time pair must be suppressed, or the old edge would keep coexisting with the
    // new draft entry on the next confirm (see the doc comment on this code path).
    expect(s.postEditSuppressedVerticalPassagePairs.has(vpPair(0, 1))).toBe(true);
  });

  it("startPostEditVerticalPassagePlacement detects a bidirectional generation-time pair (both directed edges present) as two_way", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }, { from: 1, to: 0, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });

  it("startPostEditVerticalPassagePlacement detects a bidirectional pair as two_way even when the reverse edge is the one matched first (GitHub issue #385)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 1, to: 0, kind: "vertical_passage" }, { from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });

  it("startPostEditVerticalPassagePlacement is a no-op on a node that already has a draft entry to the same partner, instead of minting a duplicate (GitHub issue #385)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
      commands: [
        { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "suppressGenerationPair", entity: "verticalPassage", a: n(0), b: n(1) },
      ],
    });
    // A click landing in the same cell as the node's own marker, but outside the marker's own hit
    // radius, still resolves to this action rather than the pick-endpoint/cycle path - see the
    // doc comment on this guard.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: 1, direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement still seeds a second draft entry for a different generation-time partner (a cell with an up passage and a down passage are independent connections)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 1 },
        { id: 1, x: 0, y: 0, i: 0, level: 2 },
        { id: 2, x: 0, y: 0, i: 0, level: 0 },
      ],
      edges: [
        { from: 0, to: 2, kind: "vertical_passage" },
        { from: 0, to: 1, kind: "vertical_passage" },
      ],
      start: null, finish: null,
      commands: [
        { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "suppressGenerationPair", entity: "verticalPassage", a: n(0), b: n(1) },
      ],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages[1]).toMatchObject({ from: n(0), to: n(2), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement calls confirmPostEdit when seeding from a generation-time edge and postEditAutoConfirm is true", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, { postEditAutoConfirm: true });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("startPostEditVerticalPassagePlacement falls through to the new-placement flow once every generation-time partner is already drafted", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 1 },
        { id: 1, x: 0, y: 0, i: 0, level: 2 },
        { id: 2, x: 0, y: 0, i: 0, level: 0 },
      ],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
      commands: [
        { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "suppressGenerationPair", entity: "verticalPassage", a: n(0), b: n(1) },
      ],
    }, { ...floorsExtra(3, 1), _nextPostEditVerticalPassageId: 2 });
    // Level 2 ("up") is already drafted; level 0 ("down") has neither a generation-time edge nor a
    // draft entry. Both directions are geometrically available from the field, but "up" is filtered
    // out as already-drafted, leaving "down" as the only free direction — so this commits "down"
    // directly instead of opening the direction dialog for a choice that's really forced.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    const s = useMazeStore.getState();
    expect(s.postEditVerticalPassagePending).toBeNull();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages[1]).toMatchObject({ from: n(0), to: n(2), direction: "two_way" });
  });

  it("startPostEditVerticalPassagePlacement cycles a within-session draft entry's direction instead of minting a duplicate when the cell is re-clicked outside the marker radius (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 1 }, { id: 1, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: 7, from: n(0), to: n(1), direction: "forward" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    // origin (level 1) can only go "down" here (no level 2 floor), and "down" is already drafted →
    // this cell click cycles that entry instead of adding a second passage for the same pair.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: 7, direction: "backward" });
  });

  it("startPostEditVerticalPassagePlacement cycles a within-session draft entry even after its own edge was echoed into state.edges by an auto-confirm (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 1 }, { id: 1, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      // The draft's own forward edge is now in `state.edges` (post auto-confirm), but the pair was
      // never suppressed (the create path doesn't suppress) — the #385 guard would treat this as a
      // generation-time edge and fall through to a duplicate.
      liveEdges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: 7, from: n(0), to: n(1), direction: "forward" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: 7, direction: "backward" });
  });

  it("startPostEditVerticalPassagePlacement is a no-op when a re-clicked cell holds two independent within-session draft passages (up and down), rather than guessing or duplicating (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 1 },
        { id: 1, x: 0, y: 0, i: 0, level: 2 },
        { id: 2, x: 0, y: 0, i: 0, level: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: 2, from: n(0), to: n(2), direction: "forward" },
      ],
    }, { ...floorsExtra(3, 1), _nextPostEditVerticalPassageId: 3 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages.map((p) => p.direction)).toEqual(["forward", "forward"]);
    expect(s.postEditVerticalPassagePending).toBeNull();
  });

  it("startPostEditVerticalPassagePlacement leaves a two_way within-session draft entry unchanged when its cell is re-clicked with only one direction available (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 1 }, { id: 1, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: 7, from: n(0), to: n(1), direction: "two_way" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: 7, direction: "two_way" });
  });

  it("startPostEditVerticalPassagePlacement on a node whose generation-time edge only arrives (backward) detects it as backward", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 1, to: 0, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("backward");
  });

  it("cyclePostEditVerticalPassageDirection suppresses the pair unconditionally, including on a second cycle of an already-confirmed entry", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().cyclePostEditVerticalPassageDirection(1);
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("backward");
    expect(useMazeStore.getState().postEditSuppressedVerticalPassagePairs.has(vpPair(0, 1))).toBe(true);

    // Second cycle on the same (now already-"confirmed" by convention) entry - suppression must
    // still hold afterwards, not be skipped/lost as "already done once" (GitHub issue #341
    // follow-up bug: a second direction cycle without this left the old edge from the first
    // cycle's own confirm coexisting with the new one, reading as two-way).
    useMazeStore.getState().cyclePostEditVerticalPassageDirection(1);
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("forward");
    expect(useMazeStore.getState().postEditSuppressedVerticalPassagePairs.has(vpPair(0, 1))).toBe(true);
  });

  it("removePostEditVerticalPassage removes the draft entry and marks dirty", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: 1, from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().removePostEditVerticalPassage(1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });

  it("startPostEditElevatorPlacement on a node with an existing generation-time elevator mesh seeds pending floors from every reachable node, with sourceNodeIds for later suppression", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 0, level: 2 },
      ],
      edges: [
        { from: 0, to: 1, kind: "elevator" }, { from: 1, to: 0, kind: "elevator" },
        { from: 0, to: 2, kind: "elevator" }, { from: 2, to: 0, kind: "elevator" },
        { from: 1, to: 2, kind: "elevator" }, { from: 2, to: 1, kind: "elevator" },
      ],
      start: null, finish: null,
    });
    useMazeStore.getState().startPostEditElevatorPlacement(n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending).not.toBeNull();
    expect(pending!.floors).toEqual(new Set([0, 1, 2]));
    expect(pending!.editingId).toBeUndefined();
    expect(new Set(pending!.sourceNodeIds)).toEqual(new Set([0, 1, 2]));
  });

  it("startPostEditElevatorPlacement on a node already in a draft elevator edits that entry (editingId set) instead of creating a duplicate", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: 7, floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 8 });
    useMazeStore.getState().startPostEditElevatorPlacement(n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending!.editingId).toBe(7);
    expect(pending!.floors).toEqual(new Set([0, 1]));
  });

  it("confirmPostEditElevatorPlacement suppresses every pairwise combination of the previous mesh's sourceNodeIds", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 0, level: 2 },
      ],
      edges: [],
      start: null, finish: null,
    }, {
      postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]), sourceNodeIds: [0, 1, 2] },
    });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditSuppressedElevatorPairs).toEqual(
      new Set([elevPair(0, 1), elevPair(0, 2), elevPair(1, 2)]),
    );
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditElevatorPending).toBeNull();
  });

  it("confirmPostEditElevatorPlacement with fewer than 2 selected floors is a no-op", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      start: null, finish: null,
    }, { postEditElevatorPending: { origin: n(0), floors: new Set([0]) } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditElevatorPending).not.toBeNull();
  });

  it("removePostEditElevator removes the draft entry and marks dirty", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: 1, floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().removePostEditElevator(1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });
});

describe("mazeStore applyPostEditSplitTargetPick (GitHub issue #474)", () => {
  const openPrompt = (action: NonNullable<ReturnType<typeof useMazeStore.getState>["postEditSplitTargetPrompt"]>["action"]) =>
    useMazeStore.getState().requestPostEditSplitTarget({ point: [0, 0], nodeIds: [0, 1], action });

  it("set_start dispatches setPostEditEndpoint('start') to the picked node and clears the prompt", () => {
    openPrompt({ tool: "set_start" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftMeta?.start).toEqual(n(1));
  });

  it("set_finish dispatches setPostEditEndpoint('finish') to the picked node", () => {
    openPrompt({ tool: "set_finish" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditDraftMeta?.finish).toEqual(n(1));
  });

  it("elevator opens an elevator placement anchored on the picked node", () => {
    openPrompt({ tool: "elevator" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditElevatorPending?.origin).toEqual(n(1));
  });

  it("teleport first pick sets the pending origin, second pick completes the link", () => {
    openPrompt({ tool: "teleport_two_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(0);
    expect(useMazeStore.getState().postEditTeleportPendingFrom).toBe(0);

    openPrompt({ tool: "teleport_two_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditTeleportPendingFrom).toBeNull();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    expect(s.postEditDraftTeleports[0]).toMatchObject({ from: n(0), to: n(1), direction: "two_way" });
  });

  it("vertical passage dispatches startPostEditVerticalPassagePlacement to the picked node", () => {
    // Seed a generation-time vertical passage from node 1 so the placement takes its
    // "seed from existing edge" branch (no adjacent-floor field needed) and we can assert the
    // deferred tool reached node 1, not the point's original node.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 1, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [{ from: 1, to: 2, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    openPrompt({ tool: "vertical_passage_one_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(1), direction: "forward" });
  });

  it("is a no-op when no prompt is open", () => {
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    expect(useMazeStore.getState().postEditDraftMeta?.start).toEqual(n(0));
  });

  it("cancelPostEditSplitTarget drops the prompt without placing anything", () => {
    openPrompt({ tool: "set_start" });
    useMazeStore.getState().cancelPostEditSplitTarget();
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftMeta?.start).toEqual(n(0));
  });
});

describe("mazeStore split-node actions", () => {
  it("addSplitNode mints slot 0 for a fresh point and makes it active", () => {
    useMazeStore.getState().addSplitNode([2, 2]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));
    expect(s.postEditDirty).toBe(true);
  });

  it("addSplitNode on a non-floor-0 active floor stamps the slot's level and keys it with an \"@level\" suffix (GitHub issue #358)", () => {
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_2",
    });
    useMazeStore.getState().addSplitNode([2, 2]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2@1"]).toEqual([0]);
    expect(s.postEditDraftSplitPoints["2,2"]).toBeUndefined();
    expect(s.postEditActiveSplitNode["2,2@1"]).toEqual(splitEndpoint([2, 2], 0, 1));
  });

  it("addSplitNode mints from the point's next-slot high-water mark, never reusing an id", () => {
    // Slot ids come from `_nextSplitSlotId` (GitHub issue #543 plan section 7), not "max existing
    // + 1" — a point that has already issued ids up to 3 (two of which the user has since removed)
    // mints 4, not 1, so a pruned high id can never be reissued to a different node.
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "addSplitNode", point: [2, 2], slotId: 3 },
      ],
    }, { _nextSplitSlotId: { "2,2": 4 } });
    useMazeStore.getState().addSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 3, 4]);
    expect(useMazeStore.getState()._nextSplitSlotId["2,2"]).toBe(5);
  });

  it("removeSplitNode removes the slot and any edges/teleports referencing it", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit({
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "setEdge", from: n(0), to: target, edgeKind: "basic" },
        { kind: "addTeleport", id: 1, from: target, to: n(1), direction: "forward" },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toBeUndefined();
    expect(Object.keys(s.postEditDraftEdges ?? {})).toEqual([]);
    expect(s.postEditDraftTeleports).toEqual([]);
  });

  it("removeSplitNode rejects removal when the target is assigned as start", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "setMeta", slot: "start", endpoint: target },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.error).toContain("start/finish");
  });

  it("removeSplitNode resets the active node to the original when the removed slot was active", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit(
      { commands: [{ kind: "addSplitNode", point: [2, 2], slotId: 0 }] },
      { postEditActiveSplitNode: { "2,2": target } },
    );
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("removeSplitNode does not disturb a sibling slot's edges", () => {
    const target = splitEndpoint([2, 2], 0);
    const sibling = splitEndpoint([2, 2], 1);
    seedPostEdit({
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "addSplitNode", point: [2, 2], slotId: 1 },
        { kind: "setEdge", from: n(0), to: target, edgeKind: "basic" },
        { kind: "setEdge", from: n(0), to: sibling, edgeKind: "basic" },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([1]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), sibling)]).toBeDefined();
  });

  it("cycleActiveSplitNode cycles original -> slot0 -> slot1 -> original", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "addSplitNode", point: [2, 2], slotId: 1 },
      ],
    });
    const store = useMazeStore.getState();

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 1));

    store.cycleActiveSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("cycleActiveSplitNode is a no-op for a point with no split nodes", () => {
    useMazeStore.getState().cycleActiveSplitNode([9, 9]);
    expect(useMazeStore.getState().postEditActiveSplitNode["9,9"]).toBeUndefined();
  });

  it("setActiveSplitNode sets a specific split endpoint active", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0 },
        { kind: "addSplitNode", point: [2, 2], slotId: 1 },
      ],
    });
    useMazeStore.getState().setActiveSplitNode([2, 2], splitEndpoint([2, 2], 1));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 1));
  });

  it("setActiveSplitNode with a node endpoint clears the active entry (means original)", () => {
    useMazeStore.setState({ postEditActiveSplitNode: { "2,2": splitEndpoint([2, 2], 0) } });
    useMazeStore.getState().setActiveSplitNode([2, 2], n(5));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("setPostEditFocusedPoint sets and clears the focused point", () => {
    useMazeStore.getState().setPostEditFocusedPoint([1, 1]);
    expect(useMazeStore.getState().postEditFocusedPoint).toEqual([1, 1]);
    useMazeStore.getState().setPostEditFocusedPoint(null);
    expect(useMazeStore.getState().postEditFocusedPoint).toBeNull();
  });
});

describe("mazeStore applySplitBlueprint", () => {
  const square: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]] };

  // `activeTessellationConfig` square field is centered on the origin (`ox = floor(width/2)`,
  // see `configAllCells`) - width 9 covers x,y in [-4, 4], comfortably wide enough for a point
  // at the origin plus every one of its 4 neighbors.
  const wideField = { type: "square" as const, width: 9, height: 9 };

  it("mints one slot per extra blueprint node and wires passages to existing neighbors", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: -1, y: 0, i: 0 }, { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: -1, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    const original = n(0);
    const slot0 = splitEndpoint([0, 0], 0);
    // node0 faces [0,2] = E,W -> neighbors (1,0)=id1, (-1,0)=id2
    expect(s.postEditDraftEdges?.[edgeKey(original, n(1))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(original, n(2))]).toBeDefined();
    // node1 (slot0) faces [1,3] = N,S -> neighbors (0,1)=id3, (0,-1)=id4
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(3))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(4))]).toBeDefined();
    expect(s.postEditDirty).toBe(true);
  });

  it("replaces an existing split point entirely, dropping stale slots/edges", () => {
    const staleTarget = splitEndpoint([0, 0], 5);
    // The point has already issued slot ids up to 5; the blueprint's own slot is minted from the
    // high-water mark (6), never by reusing the stale id it is replacing (GitHub issue #543 plan
    // section 7) — what matters here is that slot 5 and its edge are gone afterwards.
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5 },
        { kind: "setEdge", from: n(0), to: staleTarget, edgeKind: "basic" },
      ],
      nextSplitSlotId: { "0,0": 6 },
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([6]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), staleTarget)]).toBeUndefined();
  });

  it("rejects applying a blueprint while an existing slot is assigned as start/finish", () => {
    const target = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0 },
        { kind: "setMeta", slot: "start", endpoint: target },
      ],
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.error).toContain("start/finish");
  });

  it("skips a face index beyond the tile's real degree instead of throwing (blueprint authored for a different degree)", () => {
    // Square tiles have 4 faces (offsets.length === 4) - a hex blueprint's face index 5 has
    // nothing to destructure from `offsets[5]` on a square tile.
    const oversized: SplitNodeBlueprint = { id: 0, degree: 6, nodeFaces: [[0, 5]] };
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
    }, { activeTessellationConfig: wideField });
    expect(() => useMazeStore.getState().applySplitBlueprint([0, 0], oversized)).not.toThrow();
    const s = useMazeStore.getState();
    // Face 0 (in range) still wires normally; face 5 (out of range) is silently skipped.
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeDefined();
  });

  it("wires a newly-blueprinted split cell to its neighbor's real connecting slot, not the neighbor's active one (GitHub issue #243)", () => {
    // C1 at (0,0) is already split: id0 = original, id10 = slot0 - and id10 is the one with the
    // real (pre-existing) connection east, toward C2. C2 at (1,0) is still a plain point (id1),
    // about to be blueprinted with a slot of its own that requires a passage west, toward C1.
    // C1's split slot is already confirmed into the snapshot (node id 10, i:1). Generation itself
    // left the two cells unconnected; the user then drew the C1-slot0 -> C2 passage by hand, which
    // (unlike a generation-derived edge) is recorded against the slot's real `nodeEndpoint(10)` —
    // exactly the edge `resolvePostEditPartnerAt` has to find.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 10, x: 0, y: 0, i: 1 },
        { id: 1, x: 1, y: 0, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "setEdge", from: n(10), to: n(1), edgeKind: "basic" }],
    }, { activeTessellationConfig: wideField });
    expect(useMazeStore.getState().postEditDraftSplitPoints["0,0"]).toEqual([0]);

    // Square offsets: index0=E(1,0) index2=W(-1,0). node0(original) has no faces here; node1(slot0)
    // requires the west face - the one actually facing C1.
    const westOnly: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[], [2]] };
    useMazeStore.getState().applySplitBlueprint([1, 0], westOnly);
    const s = useMazeStore.getState();

    // C1's slot0 already has a real confirmed id (10) - the partner resolves to `nodeEndpoint(10)`,
    // not C1's original node, since that's the node actually holding the pre-existing connection
    // east (GitHub issue #243).
    const c2Slot0 = splitEndpoint([1, 0], 0);
    expect(s.postEditDraftEdges?.[edgeKey(n(10), c2Slot0)]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(c2Slot0, n(10))]).toBeDefined();
    // The original nodes on either side must not end up wrongly linked to each other.
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(n(0), c2Slot0)]).toBeUndefined();
  });
});
