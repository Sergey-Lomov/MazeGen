import { describe, it, expect, vi, beforeEach } from "vitest";
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
    nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 5, x: 2, y: 2 }],
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

  it("the original node has no Remove button", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    // Two Remove icon buttons — one per slot, none for the original node.
    expect(screen.getAllByTitle("Remove")).toHaveLength(2);
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

  it("clicking Remove doesn't also activate the card underneath it (event doesn't bubble)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    const removeButtons = screen.getAllByTitle("Remove");
    fireEvent.click(removeButtons[0]);
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("clicking + Add node calls addSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("+ Add node"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1, 2]);
  });

  it("clicking Remove then confirming calls removeSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    const removeButtons = screen.getAllByTitle("Remove");
    fireEvent.click(removeButtons[0]);
    fireEvent.click(screen.getByText("Ok"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([1]);
  });

  it("clicking Remove then cancelling leaves the slot untouched", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    const removeButtons = screen.getAllByTitle("Remove");
    fireEvent.click(removeButtons[0]);
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
});
