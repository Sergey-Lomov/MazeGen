import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, node, resetPostEditStore, key01 } from "./postEditSliceKit";
import { splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore resetPostEdit", () => {
  it("resetPostEdit repopulates postEditDraftTeleports from generated edges", () => {
    useMazeStore.setState({
      _generatedNodes: [node(0, 0, 0), node(1, 1, 0), node(2, 2, 0), node(3, 3, 0)],
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
      nodes: [node(0, 0, 0), node(1, 1, 0)],
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
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 1, 0, 0, 1),
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
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 5, 5, 0, 1),
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
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 5, 5, 0, 1),
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
        node(0, 0, 0, 0, 0),
        node(1, 1, 0, 0, 0),
        node(2, 0, 0, 1, 0),
        node(3, 0, 0, 0, 1),
        node(4, 1, 0, 0, 1),
        node(5, 0, 0, 1, 1),
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
});
