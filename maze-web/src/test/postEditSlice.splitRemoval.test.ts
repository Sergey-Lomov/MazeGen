import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, node, bridgeFace, seedPostEdit, resetPostEditStore } from "./postEditSliceKit";
import { splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto } from "../wasm/types";
import type { PostEditCommand } from "../store/postEditCommandTypes";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

const p0Slot0 = splitEndpoint([0, 0], 0);
const p1Slot0 = splitEndpoint([1, 0], 0);

/** Every scenario here starts from a graph with no generation edges and no start/finish. */
const seedBare = (nodes: NodeDto[], commands: PostEditCommand[], extra: Parameters<typeof seedPostEdit>[1] = {}) =>
  seedPostEdit({ nodes, edges: [], start: null, finish: null, commands }, extra);

const draftEdge = (from: PostEditEndpoint, to: PostEditEndpoint) =>
  useMazeStore.getState().postEditDraftEdges?.[edgeKey(from, to)];

/** `from -> to` exists as a plain `basic` draft edge. */
const expectLive = (from: PostEditEndpoint, to: PostEditEndpoint) =>
  expect(draftEdge(from, to)).toEqual({ from, to, kind: "basic" });

/** A live two-way passage between `a` and `b`. */
const expectBridge = (a: PostEditEndpoint, b: PostEditEndpoint) => { expectLive(a, b); expectLive(b, a); };

/** No draft edge references the `a`/`b` pair in either direction. */
const expectGone = (a: PostEditEndpoint, b: PostEditEndpoint) => {
  expect(draftEdge(a, b)).toBeUndefined();
  expect(draftEdge(b, a)).toBeUndefined();
};

/** Removes P0's only slot, then checks P0 is un-split while P1's split shape survives untouched. */
function removeP0AndExpectP1StillSplit() {
  useMazeStore.getState().removeSplitNode([0, 0], 0);
  const s = useMazeStore.getState();
  expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
  expect(s.postEditDraftSplitPoints["1,0"]).toEqual([0]);
}

describe("mazeStore removeSplitNode neighbor redirect (GitHub issue #625)", () => {
  it("removing a generation-baked split's last slot redirects its bridge onto a still-split neighbor instead of reverting to the generation-time wall (GitHub issue #625)", () => {
    // P0 = (0,0): a GENERATION-BAKED split (original node0 + baked slot0 = node1), no generation
    // edges at all (both faces started as wall). P1 = (1,0): a plain generated node (node2).
    seedBare([node(0, 0, 0), node(1, 0, 0, 1), node(2, 1, 0)], [
      // The post-edit bridge across the former wall was wired onto P0's SLOT (not its original node) ...
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      // ... then P1 was split in post-edit, and its own new slot took over that same bridge from
      // the neighbor's side (its face now names P0's slot, not P0's original node).
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
    ], { postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(edgeKey(p1Slot0, p0Slot0), p1Slot0, p0Slot0);
    expect(draftEdge(p1Slot0, p0Slot0)).toBeDefined();

    // Removing P0's only (generation-baked) slot un-splits P0 entirely. P1 is still a split point:
    // its slot's own face must survive, redirected onto P0's surviving original node, not silently
    // reverted to the generation-time wall between P0 and P1.
    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), p1Slot0);
    expectGone(p1Slot0, p0Slot0);
  });

  it("removing a generation-baked split's last slot redirects its bridge onto a still-split neighbor whose ORIGINAL node held the connection (GitHub issue #625)", () => {
    // Same as the previous test, but the bridge is held on P1's ORIGINAL node (n(2)), not on a
    // slot of P1: P1 becomes split AFTER the bridge already exists, via a slot that gets some
    // OTHER face, while its original node keeps the P0-facing bridge untouched.
    seedBare([node(0, 0, 0), node(1, 0, 0, 1), node(2, 1, 0)], [
      // Bridge across the former wall, held on P0's slot <-> P1's ORIGINAL node.
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
    ]);
    expect(draftEdge(n(2), p0Slot0)).toBeDefined();

    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), n(2));
    expectGone(n(2), p0Slot0);
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's own face onto the original node (GitHub issue #625)", () => {
    // P0 = (0,0) was a plain node, split entirely in POST-EDIT (addSplitNode, no baseline slot at
    // all): removal goes through the CASCADE path, not the explicit `removeSplitPoint` path the
    // two tests above cover. P1 = (1,0) is itself split in post-edit too, and its own slot's face
    // (recorded via its OWN `updateSplitNodeFaces` command) names P0's slot.
    seedBare([node(0, 0, 0), node(2, 1, 0)], [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      // P1's own slot is the one actually wired to P0's slot (its OWN face command, own lifeline).
      { kind: "updateSplitNodeFaces", point: [1, 0], slotId: 0, pointId: "s2", faces: [bridgeFace(p1Slot0, p0Slot0)] },
    ]);
    expect(draftEdge(p1Slot0, p0Slot0)).toBeDefined();

    // Removing P0's only (post-edit-created) slot cascades its own creation/face commands out of
    // the log entirely. P1's slot face must be redirected onto P0's ORIGINAL node (its one
    // permanent node), not left naming the now-nonexistent p0Slot0.
    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), p1Slot0);
    expectGone(p1Slot0, p0Slot0);
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's ORIGINAL-node face onto the original node (GitHub issue #625)", () => {
    // Same as the previous test, but the bridge is held on P1's ORIGINAL node (n(2)), not on a
    // slot of P1: mirrors the generation-baked "ORIGINAL node held the connection" test above,
    // but for the CASCADE path (P0 split entirely in post-edit).
    seedBare([node(0, 0, 0), node(2, 1, 0)], [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      // Bridge across the former wall, held on P0's slot <-> P1's ORIGINAL node.
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
    ]);
    expect(draftEdge(n(2), p0Slot0)).toBeDefined();

    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), n(2));
    expectGone(n(2), p0Slot0);
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's own face onto the original node even when the neighbor's shape was set via rotateSplitPoint (GitHub issue #625)", () => {
    // P1's whole shape (both its original node and its slot) is carried by ONE `rotateSplitPoint`
    // command, whose own lifeline is `point:1,0`: it covers the WHOLE point in one command, unlike
    // `updateSplitNodeFaces`'s per-slot lifeline. One of P1 slot0's faces names P0's (post-edit-
    // created) slot. Removing P0's slot must redirect that one face onto P0's original node without
    // cascading P1's entire `rotateSplitPoint` lifeline away (which would erase P1's whole shape).
    seedBare([node(0, 0, 0), node(2, 1, 0), node(3, 2, 0)], [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, p1Slot0)] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      {
        kind: "rotateSplitPoint", point: [1, 0],
        nodes: [
          { faces: [bridgeFace(n(2), p0Slot0)] },
          { slotId: 0, faces: [bridgeFace(p1Slot0, p0Slot0), bridgeFace(p1Slot0, n(3))] },
        ],
      },
    ]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(draftEdge(p1Slot0, p0Slot0)).toBeDefined();

    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), p1Slot0);
    // P1 slot0's OTHER face (toward n(3), unrelated to P0) must survive untouched.
    expectLive(p1Slot0, n(3));
    expectGone(p1Slot0, p0Slot0);
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects the neighbor's ORIGINAL-node face even when the neighbor's OWN SLOT shows a wall on the same face (GitHub issue #625)", () => {
    // P1's original node holds a LIVE basic connection to P0's vanishing slot, while P1's own slot0
    // independently shows a WALL toward that exact same vanishing slot (both nodes of P1 face P0's
    // point, but only one of them is actually connected). `buildNeighborRedirectCommands` used to
    // collapse both of P1's nodes into a single "one entry per neighbor POINT" map entry, so
    // whichever node was iterated last silently overwrote the other: if that was the wall-holding
    // slot, the redirect got built for it (a no-op) while the real live connection on P1's original
    // node was dropped entirely, then swept away by the cascade with no redirect to save it.
    seedBare([node(0, 0, 0), node(2, 1, 0), node(3, 2, 0)], [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      // P0's slot connects to P1's ORIGINAL node (n(2)): the one live connection.
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      {
        kind: "rotateSplitPoint", point: [1, 0],
        nodes: [
          // Original node: LIVE basic connection to P0's vanishing slot.
          { faces: [bridgeFace(n(2), p0Slot0)] },
          // Slot0: WALL on the very same face, plus an unrelated live connection to n(3).
          { slotId: 0, faces: [bridgeFace(p1Slot0, p0Slot0, "wall"), bridgeFace(p1Slot0, n(3))] },
        ],
      },
    ]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(draftEdge(n(2), p0Slot0)).toBeDefined();

    removeP0AndExpectP1StillSplit();
    // The live connection, redirected from P0's slot onto P0's surviving original node.
    expectBridge(n(0), n(2));
    // P1 slot0's unrelated face (toward n(3)) survives untouched.
    expectLive(p1Slot0, n(3));
    expectGone(n(2), p0Slot0);
  });

  it("removing a POST-EDIT-CREATED split's last slot redirects a still-split neighbor's face even when the neighbor's node carries an EXPLICIT level:0 (GitHub issue #625)", () => {
    // `NodeDto.level` is a plain `number` from WASM, always `0` (never `undefined`) for a
    // single-floor maze, unlike this suite's usual node fixtures, which omit `level` entirely.
    // `endpointFieldPoint` used to pass a node's raw `level` straight through, so a node with
    // `level: 0` built a "x,y@0" split-point key that never matched the "x,y" key
    // `splitPoints`/`splitPointIds` actually use for level 0: the neighbor was silently not
    // recognized as split, no redirect was built, and the cascade swept its whole shape away.
    seedBare([node(0, 0, 0, 0, 0), node(2, 1, 0, 0, 0), node(3, 2, 0, 0, 0)], [
      { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
      { kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0, pointId: "s1", faces: [bridgeFace(p0Slot0, n(2))] },
      { kind: "addSplitNode", point: [1, 0], slotId: 0, pointId: "s2" },
      {
        kind: "rotateSplitPoint", point: [1, 0],
        nodes: [
          { faces: [bridgeFace(n(2), p0Slot0)] },
          { slotId: 0, faces: [bridgeFace(p1Slot0, n(3))] },
        ],
      },
    ]);
    expect(useMazeStore.getState().postEditDraftSplitPoints["1,0"]).toEqual([0]);
    expect(draftEdge(n(2), p0Slot0)).toBeDefined();

    removeP0AndExpectP1StillSplit();
    expectBridge(n(0), n(2));
    expectLive(p1Slot0, n(3));
    expectGone(n(2), p0Slot0);
  });
});
