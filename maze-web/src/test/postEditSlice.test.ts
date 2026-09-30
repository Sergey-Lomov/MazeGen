import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import {
  baseStoreState, baseFloorFieldConfig, mockSnapshot, TEST_FLOOR_ID, postEditStatePatch,
} from "./storeTestHelpers";
import type { PostEditSeed } from "./storeTestHelpers";
import { nodeEndpoint, splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import { configAllCells } from "../pixi/tessellationCells";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import type { PostEditEdgeState } from "../store/postEditTypes";
import { parsePostEditIdNumber } from "../pixi/postEditIdFormat";
import { compactPostEditCommands } from "../pixi/postEditCompaction";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalyticsAsync: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

import { computeAnalyticsAsync as computeAnalytics } from "../wasm/mazeService";

const n = nodeEndpoint;
const key01 = edgeKey(n(0), n(1));
/** Builds a `PostEditEdgeState` for a hand-written command/expectation literal — a one-way kind
 *  carries `id` (default "o1"), wall/basic doesn't (GitHub issue #564's discriminated union). */
const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"], _id = "o1"): PostEditEdgeState => ({ kind, from, to });

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
  vi.mocked(computeAnalytics).mockResolvedValue(mockSnapshot);
  useMazeStore.setState({
    activeTessellationConfig: { type: "square", width: 2, height: 1 },
    postEditAutoConfirm: false,
    postEditAutoCompact: false,
    _nextPostEditTeleportId: 1,
    _nextPostEditVerticalPassageId: 1,
    _nextPostEditElevatorId: 1,
    postEditTeleportPendingFrom: null,
    postEditVerticalPassagePending: null,
    postEditElevatorPending: null,
    postEditSplitTargetPrompt: null,
    error: null,
    postEditFocusedPoint: null,
  });
  // The shared default scenario: generation produced a single directed 0->1 `basic` edge (so a
  // `reset`/`resetPostEdit` restores it as `one_way_forward`), which the user has since upgraded
  // to a full two-way passage — matching the `{ key01: basic }` default draft the pre-command-log
  // `beforeEach` wrote into `postEditDraftEdges` by hand. `setEdge` sets exactly one directed key
  // (GitHub issue #543 — it never touches the reverse key as a side effect), so a full two-way
  // passage needs both directions seeded explicitly. Start is node 0, finish is node 1.
  seedPostEdit({
    commands: [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "setEdge", edge: es(n(1), n(0), "basic") },
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

  it("setPostEditAutoCompact updates its field, off by default", () => {
    expect(useMazeStore.getState().postEditAutoCompact).toBe(false);
    useMazeStore.getState().setPostEditAutoCompact(true);
    expect(useMazeStore.getState().postEditAutoCompact).toBe(true);
  });

  it("setPostEditAutoCompact(true) compacts the log immediately, not just after the next command", () => {
    useMazeStore.setState({ postEditAutoCompact: false, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // create
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // flip 1
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // flip 2 (cancels flip 1)
    const beforeToggle = useMazeStore.getState().postEditCommands;
    const baseline = useMazeStore.getState().postEditBaseline;
    if (baseline === null) throw new Error("expected a baseline");
    const compactedNow = compactPostEditCommands(baseline, beforeToggle);

    useMazeStore.getState().setPostEditAutoCompact(true);
    // The toggle itself runs the same compaction pass right away — matches what manually compacting
    // the pre-toggle log would produce, no further command needed to trigger it.
    expect(useMazeStore.getState().postEditCommands).toEqual(compactedNow);
    expect(useMazeStore.getState().postEditCommands.length).toBeLessThan(beforeToggle.length);
  });

  it("postEditAutoCompact off: two direction-cancelling one-way flips stay in the log uncompacted", () => {
    useMazeStore.setState({ postEditAutoCompact: false, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterWall = useMazeStore.getState().postEditCommands.length;

    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // create
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // flip 1
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1)); // flip 2 (would cancel flip 1)
    // With auto-compact off, all three one_way clicks stay in the log uncompacted — the two
    // cancelling flips are NOT dropped just because compaction (GitHub issue #548) could drop them.
    expect(useMazeStore.getState().postEditCommands.length).toBe(afterWall + 3);
  });

  it("postEditAutoCompact on: appending a command auto-compacts the log right away (GitHub issue #548 follow-up)", () => {
    // Start from a plain wall (not the seeded two-way passage) so `one_way` clicks are: 1) create a
    // fresh one-way, 2) flip it, 3) flip it back — the second and third clicks form a cancelling
    // pair (GitHub issue #548), while the creation itself always survives (GitHub issue #548
    // follow-up: creation is only dropped if the entity is later actually destroyed). The setup
    // wall is obsolete once the one-way replaces it. Auto-compact
    // is on from the very first click, so every intermediate count below is already compacted.
    seedPostEdit({ edges: [] }, { postEditAutoCompact: true, postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterWall = useMazeStore.getState().postEditCommands.length;

    useMazeStore.setState({ postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterCreate = useMazeStore.getState().postEditCommands.length;
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterFirstFlip = useMazeStore.getState().postEditCommands.length;
    // Second flip cancels the first — auto-compact drops both right after this append, leaving only
    // the original creation on top of the wall command.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    const afterSecondFlip = useMazeStore.getState().postEditCommands.length;

    expect(afterCreate).toBeGreaterThan(afterWall);
    expect(afterFirstFlip).toBe(afterCreate);
    expect(afterSecondFlip).toBe(afterCreate);
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
      { liveEdges: [], commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] },
      { postEditTool: "reset" },
    );
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]).toBeUndefined();
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
  });

  it("applyPostEditTool('reset') removes the command(s) that touched this edge instead of appending a restoring command, and repeat clicks stay a no-op (GitHub issue #545)", () => {
    // A wall set via `setEdge` (single-direction command, the shape the delete/legacy paths can
    // still produce) must be REMOVED by reset, not countered with a new `setEdgePair`.
    seedPostEdit(
      { commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] },
      { postEditTool: "reset" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");

    // Clicking reset again on the now-already-generation-state edge must not append anything either
    // - repeated resets used to keep piling up duplicate "restore" commands.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
  });

  it("applyPostEditTool('reset') removes a setEdgePair (wall/passage/one_way tool click) that touched this edge (GitHub issue #545)", () => {
    seedPostEdit(
      { commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "reset" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([]);
    expect(useMazeStore.getState().postEditDraftEdges?.[key01]?.kind).toBe("one_way_forward");
  });

  it("applyPostEditTool('reset') is a genuine no-op (no command touched, log unchanged by reference) on an edge that was never edited", () => {
    seedPostEdit({ commands: [] }, { postEditTool: "reset" });
    const before = useMazeStore.getState().postEditCommands;
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toBe(before);
  });

  it("applyPostEditTool records wall/passage/one_way edge-tool clicks as a single setEdgePair command, not two setEdge commands (GitHub issue #545)", () => {
    // Untouched face already reads as wall - seed it as a passage first so the wall click below is
    // an actual change, not the no-op GitHub issue #545 now blocks.
    seedPostEdit(
      { edges: [], commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "wall" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "wall"),
    });

    seedPostEdit({ edges: [] }, { postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic"),
      },
    ]);

    seedPostEdit({ edges: [] }, { postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
      },
    ]);
  });

  it("applyPostEditTool is a no-op when the face is already (effectively) wall/passage (GitHub issue #545)", () => {
    // An untouched face has no draft record at all, but reads as wall (a generation-time wall) -
    // clicking wall on it changes nothing and must not log anything either.
    seedPostEdit({ edges: [] }, { postEditTool: "wall" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(0);

    // Passage click changes it, then a second passage click on the now-passage face is a no-op too.
    useMazeStore.getState().setPostEditTool("passage");
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);

    // Wall click now changes it back (from passage to wall) - not a no-op.
    useMazeStore.getState().setPostEditTool("wall");
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
  });

  it("applyPostEditTool rewrites one-way face state on repeated clicks", () => {
    seedPostEdit({ edges: [] }, { postEditTool: "one_way" });
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toEqual([
      {
        kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
      },
    ]);

    // Second click writes the opposite face state.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "wall"), bToA: es(n(1), n(0), "one_way_forward"),
    });

    // Third click swaps back to `aToB: one_way_forward`, not re-emit the same
    // `bToA: one_way_forward` the second click already produced (GitHub issue #575: the flip branch
    // used to always normalize its result to `bToA: one_way_forward` regardless of which side was
    // one-way going in, so every flip after the first was a no-op on the actual edge state while
    // still appending a new command. Face states have no identity or minting lifecycle.
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[2]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    });
  });

  it("applyPostEditTool('one_way') on an already-two-way passage creates a fresh forward one-way instead of flipping (GitHub issue #545)", () => {
    // A `basic` face has a record on BOTH sides, same as a one-way face does on one side - the
    // branch must key off which side is actually one-way, not just "does a record exist here".
    seedPostEdit(
      { edges: [], commands: [{ kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "basic"), bToA: es(n(1), n(0), "basic") }] },
      { postEditTool: "one_way" },
    );
    useMazeStore.getState().applyPostEditTool(key01, n(0), n(1));
    expect(useMazeStore.getState().postEditCommands[1]).toEqual({
      kind: "setEdgePair", a: n(0), b: n(1), aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    });
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
    vi.mocked(computeAnalytics).mockResolvedValueOnce({ ...mockSnapshot, nodes: nodesWithSplit });
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
      postEditDraftTeleports: [{ id: "t1", from: n(0), to: n(2), direction: "forward" }],
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
    expect(useMazeStore.getState().postEditDraftTeleports).toEqual([{ id: "t1", from: n(2), to: n(3), direction: "forward" }]);
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
      { id: "t1", from: n(1), to: n(2), direction: "forward" },
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
    expect(ids.sort()).toEqual(["t1", "t2"]);
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

  it("setPostEditChangesEntityFilter sets/clears the Changes panel's entity-id filter (GitHub issue #574)", () => {
    useMazeStore.getState().setPostEditChangesEntityFilter("o5");
    expect(useMazeStore.getState().postEditChangesEntityFilter).toBe("o5");
    useMazeStore.getState().setPostEditChangesEntityFilter(null);
    expect(useMazeStore.getState().postEditChangesEntityFilter).toBeNull();
  });

  it("resetPostEdit clears a stale entity-id filter (GitHub issue #574)", () => {
    useMazeStore.setState({ postEditChangesEntityFilter: "o5" });
    useMazeStore.getState().resetPostEdit();
    expect(useMazeStore.getState().postEditChangesEntityFilter).toBeNull();
  });

  it("reset() clears a stale entity-id filter (GitHub issue #574)", () => {
    useMazeStore.setState({ postEditChangesEntityFilter: "o5" });
    useMazeStore.getState().reset();
    expect(useMazeStore.getState().postEditChangesEntityFilter).toBeNull();
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
    vi.mocked(computeAnalytics).mockResolvedValue(mockSnapshot);
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

  it("creates finish with id f after the existing finish was removed", () => {
    useMazeStore.setState({ postEditAutoConfirm: false });
    useMazeStore.getState().clearPostEditEndpoint("finish");
    useMazeStore.getState().setPostEditEndpoint("finish", n(5));
    const commands = useMazeStore.getState().postEditCommands;
    expect(commands.at(-1)).toEqual({ kind: "addMeta", slot: "finish", id: "f", endpoint: n(5) });
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

  it("confirmPostEdit sends a generation-baked vertical passage/elevator through as an ordinary draft entry (GitHub issue #564)", async () => {
    // VerticalPassage/Elevator edges are only user-editable via their own post-edit tools (GitHub
    // issue #341) - a generation-time one is a full baseline draft entry (its own stable id) from
    // the start, and `confirmPostEdit` sends the whole merged draft list, so compute_analytics
    // doesn't silently drop it from the rebuilt graph.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 0, i: 0, level: 0 },
        { id: 2, x: 1, y: 0, i: 0, level: 1 },
        { id: 3, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [
        { from: 0, to: 1, kind: "basic" },
        { from: 1, to: 2, kind: "vertical_passage" },
        { from: 3, to: 0, kind: "elevator" }, { from: 0, to: 3, kind: "elevator" },
      ],
      start: null, finish: null,
    });
    await useMazeStore.getState().confirmPostEdit();
    const calls = vi.mocked(computeAnalytics).mock.calls;
    const call = calls[calls.length - 1]?.[0];
    expect(call?.vertical_edges).toEqual(expect.arrayContaining([
      { from: 1, to: 2, kind: "vertical_passage" },
      { from: 3, to: 0, kind: "elevator" }, { from: 0, to: 3, kind: "elevator" },
    ]));
    expect(call?.vertical_edges).toHaveLength(3);
  });

  it("resetPostEditPoint resets one point's draft edges to generation-time state and marks dirty", () => {
    // The user walled off the generated 0-1 passage; resetting (0,0) must prune that edit out of
    // the log, leaving the generation-time `one_way_forward` edge the baseline carries.
    seedPostEdit({ commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }] });
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
      commands: [{ kind: "setEdge", edge: es(n(0), n(1), "wall") }],
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
      commands: [{ kind: "removeTeleport", id: "t1", from: n(0), to: n(5), direction: "two_way" }],
    }, { _nextPostEditTeleportId: 2 });
    expect(useMazeStore.getState().postEditDraftTeleports).toHaveLength(0);

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftTeleports).toHaveLength(1);
    const restoredId = s.postEditDraftTeleports[0].id;
    expect(s._nextPostEditTeleportId).toBeGreaterThan(parsePostEditIdNumber("teleport", restoredId));

    useMazeStore.getState().addPostEditTeleport(n(1), n(5), "forward");
    const ids = useMazeStore.getState().postEditDraftTeleports.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no id collision
  });

  it("resetPostEditPoint calls confirmPostEdit when postEditAutoConfirm is true", () => {
    useMazeStore.setState({ postEditAutoConfirm: true });
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    expect(computeAnalytics).toHaveBeenCalled();
  });

  it("resetPostEditPoint restores a generation-baked elevator mesh removed by the Delete tool, with its original id (GitHub issue #564)", () => {
    // A three-floor generation-time elevator mesh at (0,0) is a full baseline draft entry (single
    // id) from the start — the Delete tool, clicked on floor 2 (activeFloorId "f1", level 1, node
    // 11), removes it with exactly one `removeElevator` command (the issue's own follow-up fix, no
    // more per-pair `suppressGenerationPair` flood). Resetting that same point must prune that one
    // command back out, restoring the whole mesh under its original baseline id.
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
    }, {
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }, { id: "f2", title: "Floor 3" }],
      activeFloorId: "f1",
    });
    expect(useMazeStore.getState().postEditDraftElevators).toHaveLength(1);
    const originalId = useMazeStore.getState().postEditDraftElevators[0].id;

    useMazeStore.getState().deletePostEditPoint([0, 0]);
    expect(useMazeStore.getState().postEditDraftElevators).toHaveLength(0);
    expect(useMazeStore.getState().postEditCommands).toHaveLength(1);
    expect(useMazeStore.getState().postEditCommands[0]).toMatchObject({ kind: "removeElevator", id: originalId });

    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0].id).toBe(originalId);
  });

  it("deletePostEditPoint clears start/finish, teleports, vertical passages and elevators touching the point, but leaves draft edges untouched (GitHub issue #386)", () => {
    seedPostEdit({
      commands: [
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addElevator", id: "e1", floors: [n(0), n(1)] },
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

  it("deletePostEditPoint records deletion events for co-located start and finish", () => {
    seedPostEdit({ start: 0, finish: 0 });
    useMazeStore.getState().requestPostEditEntityDelete([0, 0], undefined, true);
    const commands = useMazeStore.getState().postEditCommands;

    expect(commands).toEqual([
      { kind: "removeMeta", slot: "start", id: "s", endpoint: n(0) },
      { kind: "removeMeta", slot: "finish", id: "f", endpoint: n(0) },
    ]);
  });

  it("delete tool ignores one-way face state and does not open the entity picker", () => {
    seedPostEdit({ commands: [{
      kind: "setEdgePair", a: n(0), b: n(1),
      aToB: es(n(0), n(1), "one_way_forward"), bToA: es(n(1), n(0), "wall"),
    }] });
    useMazeStore.getState().requestPostEditEntityDelete([0, 0], undefined, false);
    const s = useMazeStore.getState();
    expect(s.postEditEntityDeletePrompt).toBeNull();
    expect(s.postEditDraftEdges?.[key01]).toEqual({ from: n(0), to: n(1), kind: "one_way_forward" });
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
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
    const kinds = s.postEditCommands.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["removeVerticalPassage", "removeElevator"]));
    // One command per entity (GitHub issue #564's own follow-up fix), not a per-pair flood.
    expect(kinds.filter((k) => k === "removeVerticalPassage")).toHaveLength(1);
    expect(kinds.filter((k) => k === "removeElevator")).toHaveLength(1);
  });

  it("deletePostEditPoint removes a generation-baked vertical passage/elevator the same way regardless of which side the generated edge names first (reversed from/to)", () => {
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
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDraftElevators).toHaveLength(0);
  });

  it("deletePostEditPoint clears content on an unconfirmed split slot too, not just the point's live nodes (GitHub issue #221's unresolved-endpoint window)", () => {
    const slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "addTeleport", id: "t1", from: n(1), to: slot0, direction: "forward" },
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

describe("mazeStore reset-dialog actions (GitHub issue #549)", () => {
  it("requestPostEditReset is a no-op when nothing touches the point", () => {
    useMazeStore.getState().requestPostEditReset([5, 5], undefined, false);
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
  });

  it("requestPostEditReset resets the single command directly, without opening the dialog, when exactly one lifeline is affected", () => {
    seedPostEdit({ commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }] });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands).toHaveLength(0);
  });

  it("requestPostEditReset opens the dialog when more than one lifeline is affected, and cancelPostEditReset closes it without changing the log", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    const before = useMazeStore.getState().postEditCommands;
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    expect(useMazeStore.getState().postEditResetPrompt).toMatchObject({ point: [0, 0], level: undefined });
    expect(useMazeStore.getState().postEditResetPrompt?.lifelines).toHaveLength(2);
    useMazeStore.getState().cancelPostEditReset();
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
    expect(useMazeStore.getState().postEditCommands).toBe(before);
  });

  it("requestPostEditReset with bulk (held Shift) skips the dialog and resets the whole point directly", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, true);
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addTeleport", "removeTeleport"]);
    expect(s.postEditDraftTeleports).toHaveLength(0);
  });

  it("resetPostEditPointLifeline resets only the clicked row's own command, leaving the other lifeline's command intact (Delete semantics, not truncate-after)", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const rows = useMazeStore.getState().postEditCommands;
    const teleportIndex = rows.findIndex((c) => c.kind === "addTeleport");
    useMazeStore.getState().resetPostEditPointLifeline(teleportIndex);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.some((c) => c.kind === "addTeleport")).toBe(false);
    expect(s.postEditCommands.some((c) => c.kind === "setEdge")).toBe(true);
    // The other lifeline still touches the point, so the dialog stays open for it.
    expect(s.postEditResetPrompt).toMatchObject({ point: [0, 0], level: undefined });
    expect(s.postEditResetPrompt?.lifelines.map((row) => row.command.kind)).toEqual(["setEdge"]);
  });

  it("keeps the reset dialog snapshot instead of promoting an older command from the same lifeline", () => {
    seedPostEdit({
      commands: [
        { kind: "addMeta", slot: "start", id: "s", endpoint: n(0) },
        { kind: "setMeta", slot: "start", id: "s", endpoint: n(1), previousEndpoint: n(0) },
        { kind: "removeMeta", slot: "start", id: "s", endpoint: n(1) },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const prompt = useMazeStore.getState().postEditResetPrompt!;
    expect(prompt.lifelines.map((row) => row.command.kind)).toEqual(["removeMeta", "setEdge"]);

    const removeStart = prompt.lifelines.find((row) => row.command.kind === "removeMeta")!;
    useMazeStore.getState().resetPostEditPointLifeline(removeStart.commandIndex, removeStart.command, removeStart.keys);

    expect(useMazeStore.getState().postEditResetPrompt?.lifelines.map((row) => row.command.kind)).toEqual(["setEdge"]);
  });

  it("resetPostEditPointLifeline auto-closes the dialog once no lifeline is left at the point", () => {
    seedPostEdit({ commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" }] });
    // Force the dialog open directly (bypassing the single-lifeline auto-resolve in requestPostEditReset)
    // to exercise resetPostEditPointLifeline's own closing check in isolation.
    useMazeStore.setState({ postEditResetPrompt: { point: [0, 0], level: undefined, lifelines: [] } });
    useMazeStore.getState().resetPostEditPointLifeline(0);
    expect(useMazeStore.getState().postEditResetPrompt).toBeNull();
  });

  it("resetAllPostEditPointLifelines closes the dialog and resets every lifeline touching the point at once", () => {
    seedPostEdit({
      commands: [
        { kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "forward" },
        { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      ],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    useMazeStore.getState().resetAllPostEditPointLifelines();
    const s = useMazeStore.getState();
    expect(s.postEditResetPrompt).toBeNull();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addTeleport", "removeTeleport"]);
    expect(s.postEditDraftTeleports).toHaveLength(0);
  });

  // Regression test for the multi-slot removeSplitPoint dedup bug found during review: two
  // lifelines whose latest command is the SAME shared removeSplitPoint must collapse into one
  // dialog row, so resetting one doesn't secretly also un-remove the other slot.
  it("clicking the single row for a shared removeSplitPoint command restores both of its slots at once, not just one", () => {
    seedPostEdit({
      commands: [{ kind: "removeSplitPoint", point: [0, 0], pointId: "p1", removedSlotIds: [0, 1] }],
    });
    useMazeStore.getState().requestPostEditReset([0, 0], undefined, false);
    const s0 = useMazeStore.getState();
    // A single shared command means exactly one lifeline reaches the dialog-opening threshold from
    // the caller's point of view only when there'd be >1 DISTINCT rows — here there's exactly one
    // row (one command), so requestPostEditReset resolves it directly without opening a dialog.
    expect(s0.postEditResetPrompt).toBeNull();
    expect(s0.postEditCommands).toHaveLength(0);
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

  it("a generation-time vertical passage is already a baseline draft entry with its own id, immediately after generate (GitHub issue #564)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
    expect(typeof s.postEditDraftVerticalPassages[0].id).toBe("string");
  });

  it("startPostEditVerticalPassagePlacement on a node with an existing generation-time forward edge cycles that baseline entry instead of creating a duplicate", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, floorsExtra(2, 0));
    const originalId = useMazeStore.getState().postEditDraftVerticalPassages[0].id;
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: originalId, direction: "backward" });
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

  it("startPostEditVerticalPassagePlacement is a no-op-minting on a node that already has a draft entry to the same partner, instead of minting a duplicate (GitHub issue #385)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, floorsExtra(2, 0));
    const originalId = useMazeStore.getState().postEditDraftVerticalPassages[0].id;
    // A click landing in the same cell as the node's own marker, but outside the marker's own hit
    // radius, still resolves to this action rather than the pick-endpoint/cycle path - see the
    // doc comment on this guard.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: originalId, direction: "backward" });
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
    }, floorsExtra(3, 1));
    const s0 = useMazeStore.getState();
    expect(s0.postEditDraftVerticalPassages).toHaveLength(2);
    // Both partners are already baseline draft entries (GitHub issue #564) — cycling on node 0
    // (which sits between both) is ambiguous (two directions both already drafted) and is a no-op.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_two_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages).toEqual(s0.postEditDraftVerticalPassages);
  });

  it("startPostEditVerticalPassagePlacement calls confirmPostEdit when cycling a generation-baked baseline entry and postEditAutoConfirm is true", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 0, to: 1, kind: "vertical_passage" }],
      start: null, finish: null,
    }, { ...floorsExtra(2, 0), postEditAutoConfirm: true });
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

  it("startPostEditVerticalPassagePlacement defers to a split-target prompt when the destination is split, ignoring any active slot (GitHub issue #567 second follow-up, supersedes #546 fifth follow-up's silent active-node resolve)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 1, level: 1 }, // level 1's split slot
      ],
      edges: [],
      start: null, finish: null,
    }, { ...floorsExtra(3, 0), postEditActiveSplitNode: { "0,0@1": n(2) } });
    // Origin is level 0 — only "up" (level 1) is available (`originLevel > 0` gates "down"), so
    // this would have committed directly instead of opening the direction dialog. The active slot
    // (node 2) no longer silently decides the destination — `postEditActiveSplitNode` must not
    // decide which of a split point's nodes a connection attaches to (Specs/post-edit.md), so the
    // split-target prompt opens instead, same as if nothing had ever been picked there.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    let s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    // Picking the slot node commits with a proper `splitEndpoint(...)` `to` (GitHub issue #550
    // ninth follow-up round-trip contract), matching what a confirmed extraction already produces.
    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: splitEndpoint([0, 0], 0, 1), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement commits directly when the destination isn't split", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
    }, floorsExtra(3, 0));
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1), direction: "forward" });
  });

  it("startPostEditVerticalPassagePlacement cycles a within-session draft entry's direction instead of minting a duplicate when the cell is re-clicked outside the marker radius (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 1 }, { id: 1, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v7", from: n(0), to: n(1), direction: "forward" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    // origin (level 1) can only go "down" here (no level 2 floor), and "down" is already drafted →
    // this cell click cycles that entry instead of adding a second passage for the same pair.
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: "v7", direction: "backward" });
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
      commands: [{ kind: "addVerticalPassage", id: "v7", from: n(0), to: n(1), direction: "forward" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: "v7", direction: "backward" });
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
        { kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: "v2", from: n(0), to: n(2), direction: "forward" },
      ],
    }, { ...floorsExtra(3, 1), _nextPostEditVerticalPassageId: 3 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(2);
    expect(s.postEditDraftVerticalPassages.map((p) => p.direction)).toEqual(["forward", "forward"]);
    expect(s.postEditVerticalPassagePending).toBeNull();
  });

  it("movePostEditVerticalPassageEndpoint appends exactly one command and syncs both ends (GitHub issue #546 sixth follow-up, GitHub issue #566)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 0, i: 0, level: 1 },
        { id: 3, x: 1, y: 0, i: 0, level: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "to", n(2));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toMatchObject({
      kind: "moveVerticalPassageEndpoint", id: "v1", end: "to", endpoint: n(2), from: n(3), to: n(2),
    });
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(3), to: n(2) });
  });

  it("movePostEditVerticalPassageEndpoint reverts the whole move and sets a failure message when the other end's floor has no node at the target (x, y) (GitHub issue #566)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "to", n(2));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: n(1) });
    expect(s.postEditDragFailureMessage).toMatchObject({ entityKind: "vertical_passage", level: 0, point: [1, 0] });
  });

  it("startPostEditVerticalPassagePlacement leaves a two_way within-session draft entry unchanged when its cell is re-clicked with only one direction available (GitHub issue #491)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 1 }, { id: 1, x: 0, y: 0, i: 0, level: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v7", from: n(0), to: n(1), direction: "two_way" }],
    }, { ...floorsExtra(2, 1), _nextPostEditVerticalPassageId: 8 });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ id: "v7", direction: "two_way" });
  });

  it("a single-direction generation-time vertical passage is extracted into the baseline as forward, from its edge's own from/to", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [{ from: 1, to: 0, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const vp = useMazeStore.getState().postEditDraftVerticalPassages[0];
    expect(vp).toMatchObject({ from: n(1), to: n(0), direction: "forward" });
  });

  it("cyclePostEditVerticalPassageDirection appends one command per click, including a second cycle of an already-confirmed entry", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().cyclePostEditVerticalPassageDirection("v1");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("backward");
    // One click = one log entry (GitHub issue #545).
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
    expect(useMazeStore.getState().postEditCommands[1]).toMatchObject({ kind: "setVerticalPassageDirection", id: "v1" });

    // Second cycle on the same (now already-"confirmed" by convention) entry works the same way
    // (GitHub issue #341 follow-up bug: a second direction cycle used to leave the old edge from the
    // first cycle's own confirm coexisting with the new one, reading as two-way).
    useMazeStore.getState().cyclePostEditVerticalPassageDirection("v1");
    expect(useMazeStore.getState().postEditDraftVerticalPassages[0].direction).toBe("forward");
    expect(useMazeStore.getState().postEditCommands).toHaveLength(3);
  });

  it("cyclePostEditVerticalPassageDirection is a total no-op on a two-way passage — nothing appended to the log (GitHub issue #545)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "two_way" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    const before = useMazeStore.getState().postEditCommands;
    useMazeStore.getState().cyclePostEditVerticalPassageDirection("v1");
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toBe(before);
    expect(s.postEditDraftVerticalPassages[0].direction).toBe("two_way");
  });

  it("removePostEditVerticalPassage removes the draft entry and marks dirty", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 1, x: 0, y: 0, i: 0, level: 1 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "forward" }],
    }, { _nextPostEditVerticalPassageId: 2 });
    useMazeStore.getState().removePostEditVerticalPassage("v1");
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });

  it("startPostEditElevatorPlacement on a node with an existing generation-time elevator mesh edits that baseline draft entry (editingId set), since it's already a full draft entry with its own id (GitHub issue #564)", () => {
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
    const baselineId = useMazeStore.getState().postEditDraftElevators[0].id;
    useMazeStore.getState().startPostEditElevatorPlacement(n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending).not.toBeNull();
    expect(pending!.floors).toEqual(new Set([0, 1, 2]));
    expect(pending!.editingId).toBe(baselineId);
  });

  it("startPostEditElevatorPlacement on a node already in a draft elevator edits that entry (editingId set) instead of creating a duplicate", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e7", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 8 });
    useMazeStore.getState().startPostEditElevatorPlacement(n(0));
    const pending = useMazeStore.getState().postEditElevatorPending;
    expect(pending!.editingId).toBe("e7");
    expect(pending!.floors).toEqual(new Set([0, 1]));
  });

  it("confirmPostEditElevatorPlacement on a generation-baked mesh's editingId updates that baseline entry in place with exactly one command", () => {
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
    const baselineId = useMazeStore.getState().postEditDraftElevators[0].id;
    useMazeStore.setState({ postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]), editingId: baselineId } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0]).toMatchObject({ id: baselineId, floors: [n(0), n(1)] });
    expect(s.postEditElevatorPending).toBeNull();
    // One floor edit is one log entry (GitHub issue #545) — editing an existing draft entry
    // (baseline-seeded or not), not a bundled create + N-pair suppression.
    expect(s.postEditCommands).toHaveLength(1);
    expect(s.postEditCommands[0]).toMatchObject({ kind: "updateElevatorFloors", id: baselineId, floors: [n(0), n(1)] });
  });

  it("confirmPostEditElevatorPlacement defers to a split-target prompt for a split floor, ignoring any active slot (GitHub issue #567 second follow-up, supersedes #546 fifth follow-up's silent active-node resolve)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 1, level: 1 }, // level 1's split slot
      ],
      edges: [],
      start: null, finish: null,
    }, {
      postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) },
      postEditActiveSplitNode: { "0,0@1": n(2) },
    });
    // The active slot (node 2) no longer silently decides the floor — the split-target prompt
    // opens instead, same as if nothing had ever been picked there.
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    let s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    // Picking the slot node commits `floors[1]` as a proper `splitEndpoint(...)` (GitHub issue #550
    // ninth follow-up round-trip contract), matching what a confirmed extraction already produces.
    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditCommands[0]).toMatchObject({ kind: "addElevator", floors: [n(0), splitEndpoint([0, 0], 0, 1)] });
  });

  it("confirmPostEditElevatorPlacement commits directly when no selected floor is split", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
    }, {
      postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) },
    });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditCommands[0]).toMatchObject({ kind: "addElevator", floors: [n(0), n(1)] });
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
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().removePostEditElevator("e1");
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditDirty).toBe(true);
  });

  it("movePostEditElevatorEndpoint moves EVERY floor endpoint to the dragged node's (x, y) (GitHub issue #566)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 1, i: 0, level: 0 },
        { id: 3, x: 1, y: 1, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators[0].floors).toEqual([n(2), n(3)]);
  });

  it("movePostEditElevatorEndpoint reverts and reports a failure when an OTHER floor has no node at the dragged point", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 1, i: 0, level: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditDraftElevators[0].floors).toEqual([n(0), n(1)]);
    expect(s.postEditDragFailureMessage).toEqual({ level: 1, point: [1, 1], entityKind: "elevator" });
  });

  it("movePostEditElevatorEndpoint moves a split-addressed OTHER floor instead of leaving it stale (GitHub issue #566, split-floor regression)", () => {
    // Level 1 at (0,0) is a split point (nodes 1 and 2 share that point/level) — floor 1 of the
    // elevator is split-addressed (`splitEndpoint([0, 0], 0, 1)`, pointing at node 2, the non-original
    // slot). Before this fix, `resolveElevatorMove` filtered out non-"node"-kind floors entirely, so
    // this floor was never validated against the new point and never updated — desyncing the
    // elevator exactly like the original issue #566 bug, just for the split-floor case.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 1, level: 1 },
        { id: 3, x: 1, y: 1, i: 0, level: 0 },
        { id: 4, x: 1, y: 1, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), splitEndpoint([0, 0], 0, 1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().movePostEditElevatorEndpoint("e1", 0, n(3));
    const s = useMazeStore.getState();
    // Floor 1 must move to (1, 1) — not stay pinned to the old (0, 0) split endpoint.
    expect(s.postEditDraftElevators[0].floors).toEqual([n(3), n(4)]);
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
    // Seed a generation-time vertical passage from node 1 (a split slot) — a full baseline draft
    // entry from the start (GitHub issue #564), addressed via its split endpoint since that's what
    // `endpointFor` resolves a non-zero-`i` node to. `applyPostEditSplitTargetPick` correctly
    // resolves the dispatched `origin` to that same split endpoint too (GitHub issue #550 ninth
    // follow-up), and `findPostEditVerticalPassageForPair` matches split-addressed entries as well
    // — but this test's minimal seed never sets up `state.floors`/multi-floor field config, so
    // `cellExistsAt` finds no up/down direction available regardless, and the click is a no-op for
    // that unrelated reason — the baseline entry is left exactly as extracted.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 1, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [{ from: 1, to: 2, kind: "vertical_passage" }],
      start: null, finish: null,
    });
    const before = useMazeStore.getState().postEditDraftVerticalPassages;
    openPrompt({ tool: "vertical_passage_one_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages).toEqual(before);
  });

  it("vertical passage placed on a split slot records a splitEndpoint origin, not the resolved node id (GitHub issue #550 ninth follow-up)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 1, level: 0 },
        { id: 2, x: 0, y: 0, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
    }, {
      activeFloorId: "f0",
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      floorFields: { f0: baseFloorFieldConfig(), f1: baseFloorFieldConfig() },
    });
    openPrompt({ tool: "vertical_passage_one_way" });
    useMazeStore.getState().applyPostEditSplitTargetPick(1);
    const s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: splitEndpoint([0, 0], 0), to: n(2), direction: "forward" });
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

describe("mazeStore applyPostEditSplitTargetPick move_* actions (GitHub issue #567)", () => {
  it("move_teleport_endpoint: single-target queue resolves and dispatches movePostEditTeleportEndpoint on the one pick", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 },
        { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: 2, y: 0, i: 0 },
        { id: 3, x: 2, y: 0, i: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addTeleport", id: "t1", from: n(0), to: n(1), direction: "two_way" }],
    }, { _nextPostEditTeleportId: 2, postEditDraftTeleports: [{ id: "t1", from: n(0), to: n(1), direction: "two_way" }] });
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [2, 0], nodeIds: [2, 3],
      action: { tool: "move_teleport_endpoint", id: "t1", end: "to" },
      queue: [{ targetIndex: 0, point: [2, 0], nodeIds: [2, 3] }],
      picks: [undefined],
    });
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftTeleports[0]).toMatchObject({ from: n(0), to: splitEndpoint([2, 0], 0) });
  });

  it("move_vertical_passage_endpoint: two queued targets both resolve before movePostEditVerticalPassageEndpoint dispatches", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 1, i: 0, level: 0 },
        { id: 3, x: 1, y: 1, i: 1, level: 0 },
        { id: 4, x: 1, y: 1, i: 0, level: 1 },
        { id: 5, x: 1, y: 1, i: 1, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: n(1), direction: "two_way" }],
    }, {
      _nextPostEditVerticalPassageId: 2,
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
    });
    // Both the dragged end's landing point (level 0) and the other end's own point (level 1) are
    // split — queued as two separate targets, targetIndex 0 and 1, resolved one dialog at a time.
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [1, 1], level: 0, nodeIds: [2, 3],
      action: { tool: "move_vertical_passage_endpoint", id: "v1", end: "from" },
      queue: [
        { targetIndex: 0, point: [1, 1], level: 0, nodeIds: [2, 3] },
        { targetIndex: 1, point: [1, 1], level: 1, nodeIds: [4, 5] },
      ],
      picks: [undefined, undefined],
    });
    // First pick advances the prompt to the second queued target instead of dispatching yet.
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    let s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.point).toEqual([1, 1]);
    expect(s.postEditSplitTargetPrompt?.level).toBe(1);

    // Second pick fills the last slot and dispatches the deferred move with both resolved endpoints.
    useMazeStore.getState().applyPostEditSplitTargetPick(5);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({
      from: splitEndpoint([1, 1], 0, undefined),
      to: splitEndpoint([1, 1], 0, 1),
    });
  });

  it("movePostEditVerticalPassageEndpoint succeeds when the OTHER end is already split-addressed (not just node-kind)", () => {
    // Regression: dragging `from` on floor 0 used to always fail once `entry.to` (floor 1) was
    // already a `split`-kind endpoint — `resolveVerticalPassageMove` bailed out on
    // `otherEp.kind !== "node"` before ever consulting `otherEndpoint`, even on a plain,
    // non-split landing point that needs no dialog at all.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 1, y: 1, i: 0, level: 1 },
        { id: 2, x: 1, y: 1, i: 1, level: 1 },
        { id: 3, x: 2, y: 2, i: 0, level: 0 },
        { id: 4, x: 2, y: 2, i: 0, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addVerticalPassage", id: "v1", from: n(0), to: splitEndpoint([1, 1], 1, 1), direction: "two_way" }],
    }, { _nextPostEditVerticalPassageId: 2, postEditDragFailureMessage: null });
    useMazeStore.getState().movePostEditVerticalPassageEndpoint("v1", "from", n(3));
    const s = useMazeStore.getState();
    expect(s.postEditDragFailureMessage).toBeNull();
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(3), to: n(4) });
  });

  it("move_elevator_endpoint: multiple split floors each queue their own dialog, in ascending level order", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 1, y: 1, i: 0, level: 0 },
        { id: 3, x: 1, y: 1, i: 1, level: 0 },
        { id: 4, x: 1, y: 1, i: 0, level: 1 },
        { id: 5, x: 1, y: 1, i: 1, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addElevator", id: "e1", floors: [n(0), n(1)] }],
    }, { _nextPostEditElevatorId: 2 });
    useMazeStore.getState().requestPostEditSplitTarget({
      point: [1, 1], level: 0, nodeIds: [2, 3],
      action: { tool: "move_elevator_endpoint", id: "e1", levels: [0, 1] },
      queue: [
        { targetIndex: 0, point: [1, 1], level: 0, nodeIds: [2, 3] },
        { targetIndex: 1, point: [1, 1], level: 1, nodeIds: [4, 5] },
      ],
      picks: [undefined, undefined],
    });
    useMazeStore.getState().applyPostEditSplitTargetPick(3);
    expect(useMazeStore.getState().postEditSplitTargetPrompt).not.toBeNull();

    useMazeStore.getState().applyPostEditSplitTargetPick(5);
    const s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftElevators[0].floors).toEqual([
      splitEndpoint([1, 1], 0, undefined),
      splitEndpoint([1, 1], 0, 1),
    ]);
  });

  it("startPostEditVerticalPassagePlacement opens a split-target prompt instead of silently placing when the target floor is split (GitHub issue #567 second follow-up)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 1, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
    }, {
      floors: [{ id: "f0", title: "Floor 1" }, { id: "f1", title: "Floor 2" }],
      floorFields: { f0: baseFloorFieldConfig(), f1: baseFloorFieldConfig() },
    });
    useMazeStore.getState().startPostEditVerticalPassagePlacement(n(0), "vertical_passage_one_way");
    let s = useMazeStore.getState();
    expect(s.postEditDraftVerticalPassages).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.action).toMatchObject({ tool: "place_vertical_passage", direction: "up" });
    expect(s.postEditSplitTargetPrompt?.nodeIds).toEqual([1, 2]);

    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftVerticalPassages).toHaveLength(1);
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: n(0), to: splitEndpoint([0, 0], 0, 1), direction: "forward" });
  });

  it("confirmPostEditElevatorPlacement opens a split-target prompt for a split pending floor instead of silently placing (GitHub issue #567 second follow-up)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 },
        { id: 1, x: 0, y: 0, i: 0, level: 1 },
        { id: 2, x: 0, y: 0, i: 1, level: 1 },
      ],
      edges: [],
      start: null, finish: null,
    }, { postEditElevatorPending: { origin: n(0), floors: new Set([0, 1]) } });
    useMazeStore.getState().confirmPostEditElevatorPlacement();
    let s = useMazeStore.getState();
    expect(s.postEditDraftElevators).toHaveLength(0);
    expect(s.postEditSplitTargetPrompt).not.toBeNull();
    expect(s.postEditSplitTargetPrompt?.action).toMatchObject({ tool: "place_elevator", levels: [0, 1] });

    useMazeStore.getState().applyPostEditSplitTargetPick(2);
    s = useMazeStore.getState();
    expect(s.postEditSplitTargetPrompt).toBeNull();
    expect(s.postEditDraftElevators).toHaveLength(1);
    expect(s.postEditDraftElevators[0].floors).toEqual([n(0), splitEndpoint([0, 0], 0, 1)]);
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
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 3, pointId: "s1" },
      ],
    }, { _nextSplitSlotId: { "2,2": 4 } });
    useMazeStore.getState().addSplitNode([2, 2]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 3, 4]);
    expect(useMazeStore.getState()._nextSplitSlotId["2,2"]).toBe(5);
  });

  it("addSplitNode on a GENERATION-BAKED split point (GitHub issue #569) mints past the baseline's own slot, not slot 0 again", () => {
    // No `addSplitNode` command in the log at all — the point's slot 0 came straight from
    // generation (`i: 1` on the node, see `deriveSplitPointsFromNodes`), the same way a real
    // generator-produced split tile arrives. Before the fix, `_nextSplitSlotId` started empty
    // regardless, so this call minted slotId 0 again, collided with the baseline's own slot 0, and
    // `appendPostEditCommand` silently failed (`applied: false`) — "Add node" did nothing.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 },
      ],
      edges: [],
    });
    useMazeStore.getState().addSplitNode([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0, 1]);
    expect(s.postEditCommands).toEqual([{ kind: "addSplitNode", point: [0, 0], level: undefined, slotId: 1, pointId: "s1" }]);
  });

  it("reconfiguring a GENERATION-BAKED split node's face logs updateSplitNodeFaces, not a plain setEdgePair (GitHub issue #569)", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 },
      ],
      edges: [],
    });
    // The point's original node (slot undefined) is post-edit's default active node for an
    // untouched split point — reconfiguring its face to neighbor n(1) must be recorded against the
    // split node's own lifeline (`updateSplitNodeFaces`), not as an independent edge-pair command.
    useMazeStore.getState().applyPostEditToolAt("passage", key01, n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toEqual([
      { kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: undefined, pointId: "s1", faces: [{ neighbor: n(1), toNeighbor: es(n(0), n(1), "basic"), fromNeighbor: es(n(1), n(0), "basic") }] },
    ]);
  });

  it("removeSplitNode removes the slot and any edges/teleports referencing it", () => {
    const target = splitEndpoint([2, 2], 0);
    seedPostEdit({
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target, "basic") },
        { kind: "addTeleport", id: "t1", from: target, to: n(1), direction: "forward" },
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
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
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
      { commands: [{ kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" }] },
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
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target, "basic") },
        { kind: "setEdge", edge: es(n(0), sibling, "basic") },
      ],
    });
    useMazeStore.getState().removeSplitNode([2, 2], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([1]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), sibling)]).toBeDefined();
  });

  it("removing a generation-baked split's last slot redirects its bridge onto a still-split neighbor instead of reverting to the generation-time wall (GitHub issue #625)", () => {
    // P0 = (0,0): a GENERATION-BAKED split (original node0 + baked slot0 = node1), no generation
    // edges at all (both faces started as wall). P1 = (1,0): a plain generated node (node2).
    const p0Slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 0, y: 0, i: 1 }, { id: 2, x: 1, y: 0, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [
        // The post-edit bridge across the former wall was wired onto P0's SLOT (not its original
        // node) ...
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        // ... then P1 was split in post-edit, and its own new slot took over that same bridge from
        // the neighbor's side (its face now names P0's slot, not P0's original node).
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      ],
    }, { postEditTool: "passage" });
    const p1Slot0 = splitEndpoint([1, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(p1Slot0, p0Slot0), p1Slot0, p0Slot0);
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeDefined();

    // Removing P0's only (generation-baked) slot un-splits P0 entirely. P1 is still a split point —
    // its slot's own face must survive, redirected onto P0's surviving original node, not silently
    // reverted to the generation-time wall between P0 and P1.
    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), p1Slot0)]).toEqual({ from: n(0), to: p1Slot0, kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(0))]).toEqual({ from: p1Slot0, to: n(0), kind: "basic" });
    // The stale references to P0's removed slot must be gone.
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, p1Slot0)]).toBeUndefined();
  });

  it("removing a generation-baked split's last slot redirects its bridge onto a still-split neighbor whose ORIGINAL node held the connection (GitHub issue #625)", () => {
    // Same as the previous test, but the bridge is held on P1's ORIGINAL node (n(2)), not on a
    // slot of P1 -- P1 becomes split AFTER the bridge already exists, via a slot that gets some
    // OTHER face, while its original node keeps the P0-facing bridge untouched.
    const p0Slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 0, y: 0, i: 1 }, { id: 2, x: 1, y: 0, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [
        // Bridge across the former wall, held on P0's slot <-> P1's ORIGINAL node.
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        // P1 later gets split too (its own bridge elsewhere), but its original node's own face
        // toward P0 is untouched -- still the bridge above.
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      ],
    });
    const p1Slot0 = splitEndpoint([1, 0], 0);
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeDefined();

    // Removing P0's only (generation-baked) slot un-splits P0 entirely. P1 is still a split point —
    // its ORIGINAL node's own bridge face must survive, redirected onto P0's surviving original
    // node, not silently reverted to the generation-time wall between P0 and P1.
    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(2))]).toEqual({ from: n(0), to: n(2), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), n(0))]).toEqual({ from: n(2), to: n(0), kind: "basic" });
    // The stale reference to P0's removed slot must be gone.
    expect(s.postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, n(2))]).toBeUndefined();
    void p1Slot0;
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's own face onto the original node (GitHub issue #625)", () => {
    // P0 = (0,0) was a plain node, split entirely in POST-EDIT (addSplitNode, no baseline slot at
    // all) — removal goes through the CASCADE path, not the explicit `removeSplitPoint` path the
    // two tests above cover. P1 = (1,0) is itself split in post-edit too, and its own slot's face
    // (recorded via its OWN `updateSplitNodeFaces` command) names P0's original node directly.
    const p0Slot0 = splitEndpoint([0, 0], 0);
    const p1Slot0 = splitEndpoint([1, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        // Bridge across the former wall, held on P0's slot <-> P0's original node's neighbor P1.
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
        // P1's own slot is the one actually wired to P0's slot (its OWN face command, own lifeline).
        { kind: "updateSplitNodeFaces", point: [1, 0], slotId: 0, pointId: "s2", faces: [{ neighbor: p0Slot0, toNeighbor: es(p1Slot0, p0Slot0, "basic"), fromNeighbor: es(p0Slot0, p1Slot0, "basic") }] },
      ],
    });
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeDefined();

    // Removing P0's only (post-edit-created) slot cascades its own creation/face commands out of
    // the log entirely. P1 is still split — its slot's face must be redirected onto P0's ORIGINAL
    // node (its one permanent node), not left naming the now-nonexistent p0Slot0.
    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), p1Slot0)]).toEqual({ from: n(0), to: p1Slot0, kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(0))]).toEqual({ from: p1Slot0, to: n(0), kind: "basic" });
    // The stale reference to P0's removed slot must be gone.
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, p1Slot0)]).toBeUndefined();
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's ORIGINAL-node face onto the original node (GitHub issue #625)", () => {
    // Same as the previous test, but the bridge is held on P1's ORIGINAL node (n(2)), not on a
    // slot of P1 -- mirrors the generation-baked "ORIGINAL node held the connection" test above,
    // but for the CASCADE path (P0 split entirely in post-edit).
    const p0Slot0 = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        // Bridge across the former wall, held on P0's slot <-> P1's ORIGINAL node.
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        // P1 later gets split too (its own bridge elsewhere), but its original node's own face
        // toward P0 is untouched -- still the bridge above.
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      ],
    });
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeDefined();

    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(2))]).toEqual({ from: n(0), to: n(2), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), n(0))]).toEqual({ from: n(2), to: n(0), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, n(2))]).toBeUndefined();
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's own face onto the original node even when the neighbor's shape was set via rotateSplitPoint (GitHub issue #625)", () => {
    // P1's whole shape (both its original node and its slot) is carried by ONE `rotateSplitPoint`
    // command, whose own lifeline is `point:1,0` -- covering the WHOLE point in one command, unlike
    // `updateSplitNodeFaces`'s per-slot lifeline. One of P1 slot0's faces names P0's (post-edit-
    // created) slot. Removing P0's slot must redirect that one face onto P0's original node without
    // cascading P1's entire `rotateSplitPoint` lifeline away (which would erase P1's whole shape).
    const p0Slot0 = splitEndpoint([0, 0], 0);
    const p1Slot0 = splitEndpoint([1, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 1, y: 0, i: 0 }, { id: 3, x: 2, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: p1Slot0, toNeighbor: es(p0Slot0, p1Slot0, "basic"), fromNeighbor: es(p1Slot0, p0Slot0, "basic") }] },
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
        {
          kind: "rotateSplitPoint", point: [1, 0],
          nodes: [
            { faces: [{ neighbor: p0Slot0, toNeighbor: es(n(2), p0Slot0, "basic"), fromNeighbor: es(p0Slot0, n(2), "basic") }] },
            { slotId: 0, faces: [
              { neighbor: p0Slot0, toNeighbor: es(p1Slot0, p0Slot0, "basic"), fromNeighbor: es(p0Slot0, p1Slot0, "basic") },
              { neighbor: n(3), toNeighbor: es(p1Slot0, n(3), "basic"), fromNeighbor: es(n(3), p1Slot0, "basic") },
            ] },
          ],
        },
      ],
    });
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeDefined();

    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), p1Slot0)]).toEqual({ from: n(0), to: p1Slot0, kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(0))]).toEqual({ from: p1Slot0, to: n(0), kind: "basic" });
    // P1 slot0's OTHER face (toward n(3), unrelated to P0) must survive untouched.
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(3))]).toEqual({ from: p1Slot0, to: n(3), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, p1Slot0)]).toBeUndefined();
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects the neighbor's ORIGINAL-node face even when the neighbor's OWN SLOT shows a wall on the same face (GitHub issue #625)", () => {
    // P1's original node holds a LIVE basic connection to P0's vanishing slot, while P1's own slot0
    // independently shows a WALL toward that exact same vanishing slot (both nodes of P1 face P0's
    // point, but only one of them is actually connected). `buildNeighborRedirectCommands` used to
    // collapse both of P1's nodes into a single "one entry per neighbor POINT" map entry, so
    // whichever node was iterated last silently overwrote the other -- if that was the wall-holding
    // slot, the redirect got built for it (a no-op) while the real live connection on P1's original
    // node was dropped entirely, then swept away by the cascade with no redirect to save it.
    const p0Slot0 = splitEndpoint([0, 0], 0);
    const p1Slot0 = splitEndpoint([1, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 2, x: 1, y: 0, i: 0 }, { id: 3, x: 2, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        // P0's slot connects to P1's ORIGINAL node (n(2)) -- the one live connection.
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
        {
          kind: "rotateSplitPoint", point: [1, 0],
          nodes: [
            // Original node: LIVE basic connection to P0's vanishing slot.
            { faces: [{ neighbor: p0Slot0, toNeighbor: es(n(2), p0Slot0, "basic"), fromNeighbor: es(p0Slot0, n(2), "basic") }] },
            // Slot0: WALL on the very same face, plus an unrelated live connection to n(3).
            { slotId: 0, faces: [
              { neighbor: p0Slot0, toNeighbor: es(p1Slot0, p0Slot0, "wall"), fromNeighbor: es(p0Slot0, p1Slot0, "wall") },
              { neighbor: n(3), toNeighbor: es(p1Slot0, n(3), "basic"), fromNeighbor: es(n(3), p1Slot0, "basic") },
            ] },
          ],
        },
      ],
    });
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeDefined();

    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    // The live connection, redirected from P0's slot onto P0's surviving original node.
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(2))]).toEqual({ from: n(0), to: n(2), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), n(0))]).toEqual({ from: n(2), to: n(0), kind: "basic" });
    // P1 slot0's unrelated face (toward n(3)) survives untouched.
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(3))]).toEqual({ from: p1Slot0, to: n(3), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, n(2))]).toBeUndefined();
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's face even when the neighbor's node carries an EXPLICIT level:0 (GitHub issue #625)", () => {
    // `NodeDto.level` is a plain `number` from WASM, always `0` (never `undefined`) for a
    // single-floor maze -- unlike this test file's usual node fixtures, which omit `level` entirely
    // (leaving it `undefined` in JS). `endpointFieldPoint` used to pass a node's raw `level` straight
    // through, so a node with `level: 0` built a "x,y@0" split-point key that never matched the
    // "x,y" key `splitPoints`/`splitPointIds` actually use for level 0 -- silently failing to
    // recognize the neighbor as split at all, building NO redirect, and letting the cascade below
    // sweep the neighbor's whole shape away with nothing to save it.
    const p0Slot0 = splitEndpoint([0, 0], 0);
    const p1Slot0 = splitEndpoint([1, 0], 0);
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0, level: 0 }, { id: 2, x: 1, y: 0, i: 0, level: 0 }, { id: 3, x: 2, y: 0, i: 0, level: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [{ neighbor: n(2), toNeighbor: es(p0Slot0, n(2), "basic"), fromNeighbor: es(n(2), p0Slot0, "basic") }] },
        { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
        {
          kind: "rotateSplitPoint", point: [1, 0],
          nodes: [
            { faces: [{ neighbor: p0Slot0, toNeighbor: es(n(2), p0Slot0, "basic"), fromNeighbor: es(p0Slot0, n(2), "basic") }] },
            { slotId: 0, faces: [{ neighbor: n(3), toNeighbor: es(p1Slot0, n(3), "basic"), fromNeighbor: es(n(3), p1Slot0, "basic") }] },
          ],
        },
      ],
    });
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(useMazeStore.getState().postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeDefined();

    useMazeStore.getState().removeSplitNode([0, 0], 0);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]); // P1's split shape survives untouched
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(2))]).toEqual({ from: n(0), to: n(2), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), n(0))]).toEqual({ from: n(2), to: n(0), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(p1Slot0, n(3))]).toEqual({ from: p1Slot0, to: n(3), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(2), p0Slot0)]).toBeUndefined();
    expect(s.postEditDraftEdges?.[edgeKey(p0Slot0, n(2))]).toBeUndefined();
  });

  it("cycleActiveSplitNode cycles original -> slot0 -> slot1 -> original", () => {
    seedPostEdit({
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
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
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
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

  // GitHub issue #629: `postEditFocusedPoint` ("Manage split nodes") and `postEditChangesOpen`
  // ("Changes") are independent toggles — either setter used to force-clear the other so only one
  // could ever be true. Now both may be open at once; which panel is actually visible is decided
  // by `SidePanel`'s own mount-order stack (`SidePanel.test.tsx`), not by this store coupling.
  it("setPostEditFocusedPoint and setPostEditChangesOpen no longer clobber each other", () => {
    useMazeStore.getState().setPostEditFocusedPoint([1, 1]);
    useMazeStore.getState().setPostEditChangesOpen(true);
    expect(useMazeStore.getState().postEditFocusedPoint).toEqual([1, 1]);
    expect(useMazeStore.getState().postEditChangesOpen).toBe(true);
  });

  // Reproduces the reported flow (GitHub issue #548 rotate/compaction follow-up): create a split
  // node, rotate it, then compact — the slot's `addSplitNode` must survive compaction, since
  // `rotateSplitPoint`'s replay case only re-wires edges, it never re-registers `splitPoints`/
  // `splitPointIds` (only `applySplitBlueprint` recreates a point's slot list from scratch).
  it("addSplitNode -> rotateSplitPoint -> compactPostEditLog keeps the slot registered", () => {
    const gridNodes = [];
    for (let x = 0; x <= 4; x++) for (let y = 0; y <= 4; y++) gridNodes.push({ id: (x + 1) * 100 + y, x, y, i: 0 });
    seedPostEdit({
      nodes: gridNodes,
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        {
          kind: "setEdgePair", a: n(301), b: splitEndpoint([2, 2], 0),
          aToB: es(n(301), splitEndpoint([2, 2], 0), "basic"),
          bToA: es(splitEndpoint([2, 2], 0), n(301), "basic"),
        },
      ],
    }, { activeTessellationConfig: { type: "square", width: 5, height: 5 } });

    useMazeStore.getState().rotateSplitPoint([2, 2], 1);
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0]);

    useMazeStore.getState().compactPostEditLog();
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["2,2"]).toEqual([0]);
    expect(s.postEditDraftSplitPointIds["2,2"]).toBe("s1");
  });
});

describe("mazeStore applySplitBlueprint", () => {
  const square: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]], titleKey: "split_pattern_title.bridge" };

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

  it("records the original node's own faces on the same applySplitBlueprint command, not trailing setEdge commands (GitHub issue #545)", () => {
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
    expect(s.postEditCommands).toHaveLength(1);
    expect(s.postEditCommands[0]).toMatchObject({
      kind: "applySplitBlueprint",
      originalFaces: expect.arrayContaining([
        { faceIndex: 0, neighbor: n(1) },
        { faceIndex: 2, neighbor: n(2) },
      ]),
      blueprintTitleKey: "split_pattern_title.bridge",
    });
  });

  it("activates the blueprint's first minted slot, so a later face-tool click on it routes through updateSplitNodeFaces instead of a bare setEdgePair (GitHub issue #545)", () => {
    // Reproduces the reported bug: after applying a blueprint, `PostEditController`'s
    // `resolveActiveEndpointAt` had no active split entry for this point (`applySplitBlueprint`
    // used to unconditionally clear it) and fell back to the plain original-node endpoint for every
    // click — so editing a face logged "Set wall"/"Set passage" (setEdgePair) instead of one
    // "Reconfigure split node faces" (updateSplitNodeFaces) entry, exactly like a manually-created
    // split node (`addSplitNode`) already does correctly.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: -1, y: 0, i: 0 }, { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: -1, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
    }, { activeTessellationConfig: wideField, postEditTool: "wall" });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const slot0 = splitEndpoint([0, 0], 0);
    expect(useMazeStore.getState().postEditActiveSplitNode["0,0"]).toEqual(slot0);

    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(3)), slot0, n(3));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toMatchObject({ kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0 });
  });

  it("applyPostEditTool('reset') on a split node's own face is a no-op (GitHub issue #545)", () => {
    // `updateSplitNodeFaces`'s lifeline covers the WHOLE slot, not one face - if reset fell through
    // to the ordinary split-face branch it would append a fresh "restore" command whose later
    // removal (point-reset) would wipe every other face of the slot too, not just this one. No
    // caller reaches this combination today; this guards against a future one hitting it silently.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: -1, y: 0, i: 0 }, { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: -1, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const slot0 = splitEndpoint([0, 0], 0);
    const before = useMazeStore.getState().postEditCommands;

    useMazeStore.getState().setPostEditTool("reset");
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(3)), slot0, n(3));
    expect(useMazeStore.getState().postEditCommands).toBe(before);
  });

  it("re-applying a bridge blueprint on top of itself reuses the same slot id for both nodes, leaving no orphaned node behind (GitHub issue #545)", () => {
    // Exact reported scenario: apply a bridge (top-bottom / left-right), then apply another
    // blueprint needing the same node count on top. Before the fix, slot 0's faces got correctly
    // rewired but a brand-new slot 1 was minted for the second node's faces, leaving slot 0's
    // ORIGINAL neighbor wiring (from the first apply) as a separate orphaned all-wall node — the
    // point rendered as a plain passage off Node 0 alone, every other node's connection ignored.
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
        { id: 2, x: -1, y: 0, i: 0 }, { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: -1, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    expect(useMazeStore.getState().postEditDraftSplitPoints["0,0"]).toEqual([0]);

    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    // Still exactly one slot, same id - reapplying never mints a second one for the same node count.
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s._nextSplitSlotId["0,0"]).toBe(1);
    const slot0 = splitEndpoint([0, 0], 0);
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(3))]?.kind).toBe("basic");
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(4))]?.kind).toBe("basic");
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]?.kind).toBe("basic");
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(2))]?.kind).toBe("basic");
  });

  it("reuses a pre-existing slot's id for the new blueprint's own slot instead of minting a fresh one (GitHub issue #545)", () => {
    // A blueprint applied to an already-split point must reuse the point's existing slot ids for
    // as many of its own nodes as it needs, not mint fresh ones on top - minting fresh ones left
    // the reused-looking survivor as an orphaned, all-wall node while the blueprint's face list
    // landed on a brand-new id, so the maze visibly kept "one connected node plus a floating empty
    // one" instead of properly rewiring both existing nodes.
    const staleTarget = splitEndpoint([0, 0], 5);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), staleTarget, "basic") },
      ],
      nextSplitSlotId: { "0,0": 6 },
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    // `square` needs exactly one slot (2 nodes total: original + 1) - the existing slot 5 is reused
    // verbatim, nothing new is minted, and the high-water mark stays put.
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([5]);
    expect(s._nextSplitSlotId["0,0"]).toBe(6);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), staleTarget)]).toBeUndefined();
  });

  it("drops an existing slot the new blueprint no longer needs, instead of leaving it orphaned (GitHub issue #545)", () => {
    // The point has two existing slots (5 and 6); a blueprint needing only one slot must drop the
    // second one entirely (removed from the slot list, its edges already stripped as stale) rather
    // than leave it dangling as an all-wall node nobody references.
    const target5 = splitEndpoint([0, 0], 5);
    const target6 = splitEndpoint([0, 0], 6);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5, pointId: "s1" },
        { kind: "addSplitNode", point: [0, 0], slotId: 6, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target5, "basic") },
        { kind: "setEdge", edge: es(n(0), target6, "basic") },
      ],
      nextSplitSlotId: { "0,0": 7 },
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([5]);
  });

  it("rejects applying a blueprint while an existing slot is assigned as start/finish", () => {
    const target = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "setMeta", slot: "start", endpoint: target },
      ],
    }, { activeTessellationConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.error).toContain("start/finish");
  });

  it("rejects applying a blueprint while an existing slot is assigned as finish", () => {
    const target = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "setMeta", slot: "finish", endpoint: target },
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
      commands: [{ kind: "setEdge", edge: es(n(10), n(1), "basic") }],
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

describe("mazeStore applyPostEditTool on a split node's own face (GitHub issue #545)", () => {
  const wideField = { type: "square" as const, width: 9, height: 9 };

  it("records a single updateSplitNodeFaces command, not a setEdgePair, when wiring a freshly-added slot's face", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeTessellationConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toEqual({
      kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: 0, pointId: "s1",
      faces: [{ neighbor: n(1), toNeighbor: es(slot0, n(1), "basic"), fromNeighbor: es(n(1), slot0, "basic") }],
    });
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(1))]).toEqual({ from: slot0, to: n(1), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(1), slot0)]).toEqual({ from: n(1), to: slot0, kind: "basic" });
  });

  it("accumulates a second face onto the same slot's next updateSplitNodeFaces command instead of dropping the first", () => {
    seedPostEdit({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: -1, y: 0, i: 0 },
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeTessellationConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(2)), slot0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(3);
    expect(s.postEditCommands[2]).toMatchObject({
      kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0,
      faces: expect.arrayContaining([
        { neighbor: n(1), toNeighbor: es(slot0, n(1), "basic"), fromNeighbor: es(n(1), slot0, "basic") },
        { neighbor: n(2), toNeighbor: es(slot0, n(2), "basic"), fromNeighbor: es(n(2), slot0, "basic") },
      ]),
    });
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(1))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(2))]).toBeDefined();
  });

  it("records updateSplitNodeFaces with slotId undefined, not setEdgePair, when wiring the split point's OWN original node (GitHub issue #564 follow-up)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeTessellationConfig: wideField, postEditTool: "passage" });
    // Node 0 is the split point's original node (i:0) - editing ITS face is editing the split, same
    // as editing slot0's face above, and must log the same command kind.
    useMazeStore.getState().applyPostEditTool(edgeKey(n(0), n(1)), n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toEqual({
      kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: undefined, pointId: "s1",
      faces: [{ neighbor: n(1), toNeighbor: es(n(0), n(1), "basic"), fromNeighbor: es(n(1), n(0), "basic") }],
    });
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toEqual({ from: n(0), to: n(1), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(1), n(0))]).toEqual({ from: n(1), to: n(0), kind: "basic" });
  });

  it("resetPostEditPoint drops both addSplitNode and its original-node updateSplitNodeFaces commands together (shared point-scoped lifeline)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeTessellationConfig: wideField, postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(edgeKey(n(0), n(1)), n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addSplitNode", "removeSplitPoint"]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeUndefined();
  });

  it("resetPostEditPoint drops both addSplitNode and its updateSplitNodeFaces commands together (shared lifeline)", () => {
    seedPostEdit({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeTessellationConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addSplitNode", "removeSplitPoint"]);
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
  });
});
