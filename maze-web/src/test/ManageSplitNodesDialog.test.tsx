import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen, fireEvent } from "@testing-library/react";
import { ManageSplitNodesDialog } from "../components/features/ManageSplitNodesDialog";
import { SidePanel } from "../components/SidePanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, postEditStatePatch } from "./storeTestHelpers";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import { fieldOf } from "./fieldConfigFixtures";
import { TileFaceEditor } from "../components/features/TileFaceEditor";
import { resetNotifications } from "../notifications/notificationStore";
import { noticeCodes } from "./notificationTestHelpers";
import { SPLIT_BOUNDARY_FACE } from "../notifications/editRefusalNotifications";

beforeEach(() => {
  resetNotifications();
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    // Node 5 is the split point (2,2)'s original node — the dialog resolves the "Node 1" row to
    // its real NodeId from this snapshot, not from the point's coordinates (see the fixed bug
    // where it was mistakenly built as `nodeEndpoint(point[0])`). Two split slots (0, 1) are
    // added via the command log (GitHub issue #543) so `postEditBaseline`/`_nextSplitSlotId`
    // stay consistent with `postEditDraftSplitPoints` — the dialog's actions mint new slot ids
    // from `_nextSplitSlotId`, not from the mirror field alone.
    ...postEditStatePatch({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 2, y: 2, i: 0 }],
      edges: [],
      commands: [
        { kind: "addSplitNode", point: [2, 2], slotId: 0, pointId: "s1" },
        { kind: "addSplitNode", point: [2, 2], slotId: 1, pointId: "s1" },
      ],
      nextSplitSlotId: { "2,2": 2 },
    }),
    postEditActiveSplitNode: {},
    postEditDraftTeleports: [],
    postEditDraftMeta: null,
  });
});

describe("ManageSplitNodesDialog", () => {
  it("moves face hit zones with the active node anchor", () => {
    const onFaceClick = vi.fn();
    const onFaceRightClick = vi.fn();
    const props = {
      point: [1, 1] as [number, number],
      cfg: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }),
      nodes: [
        { color: "#fff", faces: Array.from({ length: 4 }, () => ({ kind: "wall" as const, boundary: false })) },
        { color: "#000", faces: Array.from({ length: 4 }, () => ({ kind: "wall" as const, boundary: false })) },
      ],
      onFaceClick,
      onFaceRightClick,
      onRotate: vi.fn(),
    };
    const { rerender } = render(
      <TileFaceEditor
        {...props}
        activeIndex={0}
      />,
    );

    for (let index = 0; index < 4; index += 1) {
      const hitZone = screen.getByTestId(`tile-face-hit-${index}`);
      fireEvent.click(hitZone);
      fireEvent.contextMenu(hitZone);
    }

    expect(onFaceClick.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
    expect(onFaceRightClick.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
    const firstAnchor = screen.getByTestId("tile-face-hit-0").querySelector("polygon")?.getAttribute("points")?.split(" ")[0];
    rerender(<TileFaceEditor {...props} activeIndex={1} />);
    const secondAnchor = screen.getByTestId("tile-face-hit-0").querySelector("polygon")?.getAttribute("points")?.split(" ")[0];
    expect(firstAnchor).not.toBe("0,0");
    expect(secondAnchor).not.toBe(firstAnchor);
  });

  it("reports boundary-face left/right clicks as one deduplicated notice", () => {
    render(
      <TileFaceEditor
        point={[0, 0]}
        cfg={fieldOf("square", { shape: "rect", cols: 1, rows: 1 })}
        nodes={[{ color: "#fff", faces: Array.from({ length: 4 }, () => ({ kind: "wall" as const, boundary: true })) }]}
        activeIndex={0}
        onFaceClick={vi.fn()}
        onFaceRightClick={vi.fn()}
        onRotate={vi.fn()}
        notificationSource="post_edit"
      />,
    );
    const face = document.body.querySelector("svg g")!;
    fireEvent.click(face);
    fireEvent.contextMenu(face);
    expect(noticeCodes()).toEqual([`post_edit/${SPLIT_BOUNDARY_FACE}`]);
    expect(screen.queryByText("This side has no neighboring tile in the field.")).toBeNull();
  });
  it.each([
    ["preset_connections" as const, "preset_connections"],
    [undefined, null],
  ])("boundary-face click with notificationSource %s notifies under %s", (notificationSource, expectedSource) => {
    render(
      <TileFaceEditor
        point={[0, 0]}
        cfg={fieldOf("square", { shape: "rect", cols: 1, rows: 1 })}
        nodes={[{ color: "#fff", faces: Array.from({ length: 4 }, () => ({ kind: "wall" as const, boundary: true })) }]}
        activeIndex={0}
        onFaceClick={vi.fn()}
        onFaceRightClick={vi.fn()}
        onRotate={vi.fn()}
        notificationSource={notificationSource}
      />,
    );
    fireEvent.click(document.body.querySelector("svg g")!);
    expect(noticeCodes()).toEqual(expectedSource ? [`${expectedSource}/${SPLIT_BOUNDARY_FACE}`] : []);
  });
  it("renders one card for the original node plus one per slot, coordinates in the modal header", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Manage split nodes: 2:2")).toBeInTheDocument();
    expect(screen.getByText("Node 1")).toBeInTheDocument();
    expect(screen.getByText("Node 2")).toBeInTheDocument();
    expect(screen.getByText("Node 3")).toBeInTheDocument();
  });

  it("Remove is disabled while the original node is active (defaults active)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Remove")).toBeDisabled();
  });

  it("Remove is enabled once a slot becomes active", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 2"));
    expect(screen.getByText("Remove")).not.toBeDisabled();
  });

  it("the currently active card shows an Active badge (defaults to the original node)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("clicking a non-active card calls setActiveSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 2"));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toEqual(splitEndpoint([2, 2], 0));
  });

  // GitHub issue #425: `endpointsMatch` used to resolve a level-tagged split endpoint straight
  // against this floor's own bare-keyed `resolveSplit`, silently failing on any floor above the
  // first. `endpointsMatch` falls back to plain `endpointsEqual` when resolution fails, so a
  // start/finish badge on the *dialog's own* split node (same point/slotId/level, matched
  // structurally) still worked even with the bug — but a *cross-endpoint* comparison against a
  // resolved id (the required-links path below) would have silently failed. This test pins the
  // start-badge path via the dialog's rendered output on floor 1; the resolution logic itself
  // (used identically by the required-links path) is covered directly in postEditEndpoint.test.ts's
  // "floorScopedEndpoint" suite.
  it("recognizes the active split node as start on a non-zero floor", () => {
    useMazeStore.setState({
      floors: [{ id: "floor_0", title: "Floor 1" }, { id: "floor_1", title: "Floor 2" }],
      activeFloorId: "floor_1",
      nodes: [{ id: 5, x: 2, y: 2, i: 0, level: 1 }, { id: 6, x: 2, y: 2, i: 1, level: 1 }],
      postEditDraftSplitPoints: { "2,2@1": [0] },
      postEditDraftMeta: { start: splitEndpoint([2, 2], 0, 1), finish: null },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 2"));
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("clicking the already-active card is a no-op (not clickable)", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 1"));
    expect(useMazeStore.getState().postEditActiveSplitNode["2,2"]).toBeUndefined();
  });

  it("clicking + Add node calls addSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Add node"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1, 2]);
  });

  it("clicking Remove (on the active slot) then confirming calls removeSplitNode", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 2"));
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Ok"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([1]);
  });

  it("clicking Remove then cancelling leaves the slot untouched", () => {
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Node 2"));
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMazeStore.getState().postEditDraftSplitPoints["2,2"]).toEqual([0, 1]);
  });

  it("shows a link bubble naming both this node and the other endpoint, with a Node N suffix on the split side", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "n0-s0": { from: nodeEndpoint(0), to: splitEndpoint([2, 2], 0), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    // Slot 0 is the edge's `to`, so from its perspective the link is incoming ("<-"), not "->".
    // Every card's own coordinates ("2,2") lead the bubble, then the arrow, then the partner's —
    // slot 0's own side gets a compact "(N2)" suffix (row order: original = Node 1, slot 0 =
    // Node 2). The partner (0,0) is a plain node on a non-split point, so it gets no suffix.
    expect(screen.getByText("2:2 (N2) <- 0:0")).toBeInTheDocument();
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
    // (2,2) is a split point, so its original node's own side gets a compact "(N1)" suffix too.
    expect(screen.getByText("2:2 (N1) -> 1:0")).toBeInTheDocument();
  });

  it("collapses a passage's matched forward+backward basic pair into a single <-> link", () => {
    useMazeStore.setState({
      postEditDraftEdges: {
        "n5-n1": { from: nodeEndpoint(5), to: nodeEndpoint(1), kind: "basic" },
        "n1-n5": { from: nodeEndpoint(1), to: nodeEndpoint(5), kind: "basic" },
      },
    });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(screen.getByText("2:2 (N1) <-> 1:0")).toBeInTheDocument();
    expect(screen.queryByText("2:2 (N1) -> 1:0")).not.toBeInTheDocument();
    expect(screen.queryByText("2,2 (N1) <- 1,0")).not.toBeInTheDocument();
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
    // compact "(N2)" suffix (row order: original = Node 1, slot 0 = Node 2).
    expect(screen.getByText("2:2 (N2) -> 1:0")).toBeInTheDocument();
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
    // Original node's card (row "Node 1"): both nodes of the bubble belong to this split point,
    // so each side gets its compact "(N{N})" suffix — the original node included (slot 0 is not a
    // special node any more, GitHub issue #468).
    expect(screen.getByText("2:2 (N1) -> 2:2 (N2)")).toBeInTheDocument();
    // Slot 0's card (row "Node 2"): same bubble seen from the other side.
    expect(screen.getByText("2:2 (N2) <- 2:2 (N1)")).toBeInTheDocument();
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

  // GitHub issue #426: the panel's kind switcher only offered Passage/One-way, leaving Wall
  // reachable only via the face's right-click shortcut. This pins the left-click path once "Wall"
  // is selected in the switcher, distinct from `handleFaceRightClick`'s always-wall behavior —
  // asserts on the `applyPostEditToolAt` call itself (spied via the store) rather than the
  // resulting edge state, since post-edit's "wall" tool just deletes any edge (no explicit
  // `wall`-kind entry — see `applyPostEditEdgeTool`), making the tool argument the only direct
  // signal that the switcher's selection actually reached the click handler.
  it("clicking a non-boundary face applies the wall tool when the Wall switcher is active", () => {
    useMazeStore.setState({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 5, x: 2, y: 2, i: 0 },
        // A node at every geometric neighbor of (2,2) on the 10x10 square field — ensures the
        // clicked face resolves to a real neighbor regardless of the tessellation's own offset
        // order, so the test doesn't depend on `getNeighborData`'s internal ordering.
        { id: 6, x: 3, y: 2, i: 0 }, { id: 7, x: 1, y: 2, i: 0 }, { id: 8, x: 2, y: 3, i: 0 }, { id: 9, x: 2, y: 1, i: 0 },
      ],
    });
    const applyPostEditToolAt = vi.fn();
    useMazeStore.setState({ applyPostEditToolAt });
    render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByText("Wall")[0]);
    const faceGroups = document.body.querySelectorAll("svg g");
    faceGroups.forEach((g) => fireEvent.click(g));
    expect(applyPostEditToolAt).toHaveBeenCalled();
    expect(applyPostEditToolAt.mock.calls.every(([tool]) => tool === "wall")).toBe(true);
  });

  // GitHub issue #629 follow-up: another `SidePanel` (e.g. the color picker) stacked on top of
  // this dialog covers it without unmounting it — `postEditFocusedPointCovered` must flip so
  // `PostEditRenderer`'s on-canvas cell outline stops highlighting a cell for a dialog the user can
  // no longer see, and flip back once uncovered.
  it("marks postEditFocusedPointCovered while another SidePanel is stacked on top, clears it when uncovered", () => {
    const { rerender } = render(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(useMazeStore.getState().postEditFocusedPointCovered).toBe(false);

    rerender(
      <>
        <ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />
        <SidePanel title="Overlay" onClose={vi.fn()} overlay>overlay content</SidePanel>
      </>,
    );
    expect(useMazeStore.getState().postEditFocusedPointCovered).toBe(true);

    rerender(<ManageSplitNodesDialog point={[2, 2]} onClose={vi.fn()} />);
    expect(useMazeStore.getState().postEditFocusedPointCovered).toBe(false);
  });
});
