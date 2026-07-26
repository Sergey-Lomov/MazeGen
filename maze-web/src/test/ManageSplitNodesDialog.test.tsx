import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    // Square tessellation's cartesian projection is the identity — see squareGeometry.ts's doc
    // comment on squareCenter.
    cartesian_coords: (config: { points: [number, number][] }) => config.points,
  }),
}));
import { render, screen, fireEvent } from "@testing-library/react";
import { ManageSplitNodesDialog } from "../components/features/ManageSplitNodesDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    // Node 5 is the split point (2,2)'s original node — the dialog resolves "Original node" to
    // its real NodeId from this snapshot, not from the point's coordinates (see the fixed bug
    // where it was mistakenly built as `nodeEndpoint(point[0])`).
    nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 2, y: 2, i: 0 }],
    postEditDraftSplitPoints: { "2,2": [0, 1] },
    postEditActiveSplitNode: {},
    postEditDraftEdges: {},
    postEditDraftTeleports: [],
    postEditDraftMeta: null,
  });
});

describe("ManageSplitNodesDialog", () => {
  it("renders one card for the original node plus one per slot, coordinates in the modal header", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Manage split nodes: 2, 2")).toBeInTheDocument();
    expect(screen.getByText("Original node")).toBeInTheDocument();
    expect(screen.getByText("Node 0")).toBeInTheDocument();
    expect(screen.getByText("Node 1")).toBeInTheDocument();
  });

  it("Remove is disabled while the original node is active (defaults active)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Remove")).toBeDisabled();
  });

  it("Remove is enabled once a slot becomes active", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 0"));
    expect(screen.getByText("Remove")).not.toBeDisabled();
  });

  it("the currently active card shows an Active badge (defaults to the original node)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("clicking a non-active card calls setActiveSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 0"));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));
  });

  it("clicking the already-active card is a no-op (not clickable)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Original node"));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("clicking + Add node calls addSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Add node"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1, 2]);
  });

  it("clicking Remove (on the active slot) then confirming calls removeSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 0"));
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Ok"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([1]);
  });

  it("clicking Remove then cancelling leaves the slot untouched", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 0"));
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1]);
  });

  it("shows a link bubble naming both this node and the other endpoint, with a title suffix on the non-original side", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "n0-s0": { from: nodeEndpoint(0), to: splitEndpoint([2, 2], 0), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    // Slot 0 is the edge's `to`, so from its perspective the link is incoming ("<-"), not "->".
    // Every card's own coordinates ("2,2") lead the bubble, then the arrow, then the partner's —
    // slot 0's own side gets a "(Node 0)" suffix since it isn't the original node.
    expect(screen.getByText("2,2 (Node 0) <- 0,0")).toBeInTheDocument();
  });

  it("shows the original node's own links, resolved by its real NodeId, not the point's coordinates", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        // Node 5 is (2,2)'s original node (see beforeEach) — this edge belongs to it, not to a
        // node "0" derived from the point's x coordinate.
        "n5-n1": { from: nodeEndpoint(5), to: nodeEndpoint(1), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("2,2 -> 1,0")).toBeInTheDocument();
  });

  it("collapses a passage's matched forward+backward basic pair into a single <-> link", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "n5-n1": { from: nodeEndpoint(5), to: nodeEndpoint(1), kind: "basic" },
        "n1-n5": { from: nodeEndpoint(1), to: nodeEndpoint(5), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("2,2 <-> 1,0")).toBeInTheDocument();
    expect(screen.queryByText("2,2 -> 1,0")).not.toBeInTheDocument();
    expect(screen.queryByText("2,2 <- 1,0")).not.toBeInTheDocument();
  });

  it("shows links for an auto-split node (GitHub issue #222) keyed by its real NodeId, not a split endpoint", () => {
    // Slot 0 already has a real node id (6) in the snapshot — an auto-split node minted by the
    // generator, unlike a manually `addSplitNode`-added slot which has no id until confirm.
    // `postEditDraftEdges` (built straight from wasm's `EdgeDto[]`) keys this edge by plain
    // `nodeEndpoint(6)`, never `splitEndpoint([2,2], 0)` — the dialog must still resolve slot 0's
    // row to this edge.
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 2, y: 2, i: 0 }, { id: 6, x: 2, y: 2, i: 1 }],
      postEditDraftEdges: {
        "n6-n1": { from: nodeEndpoint(6), to: nodeEndpoint(1), kind: "basic" },
      },
      postEditDraftMeta: { start: nodeEndpoint(6), finish: null },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    // The link belongs to slot 0 (node 6), not the original node — slot 0's own side gets its
    // usual "(Node 0)" title suffix.
    expect(screen.getByText("2,2 (Node 0) -> 1,0")).toBeInTheDocument();
    // Slot 0 (node 6) is also the run's start node — must resolve as such despite draftMeta
    // carrying a plain node endpoint, not a split one.
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("names the partner's card title in parentheses when the link is between two nodes of the same split point", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        // Node 5 is (2,2)'s original node — this basic edge connects it to slot 0, also at (2,2).
        "n5-s0": { from: nodeEndpoint(5), to: splitEndpoint([2, 2], 0), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    // Original node's card: own side has no suffix (it IS the original node), outgoing link to
    // slot 0 named by its title, not a bare slotId.
    expect(screen.getByText("2,2 -> 2,2 (Node 0)")).toBeInTheDocument();
    // Slot 0's card: own side gets a "(Node 0)" suffix too; the partner (the original node) never
    // gets a suffix, on either side of a bubble.
    expect(screen.getByText("2,2 (Node 0) <- 2,2")).toBeInTheDocument();
  });

  it("applies a blueprint immediately, with no confirm, when clicked right after the panel opens", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("blueprint-thumb-0"));
    // No confirm modal — the point's slots changed straight away.
    expect(screen.queryByText(/replace every existing node/i)).not.toBeInTheDocument();
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).not.toEqual([0, 1]);
  });

  it("asks for confirmation before applying a blueprint once the user has made a manual edit", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Add node")); // a manual edit on this point
    fireEvent.click(screen.getByTestId("blueprint-thumb-0"));
    expect(screen.getByText(/replace every existing node/i)).toBeInTheDocument();
    // Slots are untouched until the confirm is accepted.
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1, 2]);
  });
});
