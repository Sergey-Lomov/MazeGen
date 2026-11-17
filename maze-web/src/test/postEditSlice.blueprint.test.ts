import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { n, es, node, bridgeFace, seedPostEdit, resetPostEditStore } from "./postEditSliceKit";
import { splitEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import { noticeCodes } from "./notificationTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));
vi.mock("../wasm/wasmLoader", async (importActual) =>
  (await import("./postEditSliceMocks")).wasmLoaderMock(await importActual<typeof import("../wasm/wasmLoader")>()));

beforeEach(resetPostEditStore);

describe("mazeStore applySplitBlueprint", () => {
  const square: SplitNodeBlueprint = { id: 0, degree: 4, nodeFaces: [[0, 2], [1, 3]], titleKey: "split_pattern_title.bridge" };

  // `activeFieldConfig` square field is centered on the origin (`ox = floor(width/2)`,
  // see `configAllCells`) - width 9 covers x,y in [-4, 4], comfortably wide enough for a point
  // at the origin plus every one of its 4 neighbors.
  const wideField = fieldOf("square", { shape: "rect", cols: 9, rows: 9 });

  it("mints one slot per extra blueprint node and wires passages to existing neighbors", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0),
        node(2, -1, 0), node(3, 0, 1), node(4, 0, -1),
      ],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField });
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
        node(0, 0, 0), node(1, 1, 0),
        node(2, -1, 0), node(3, 0, 1), node(4, 0, -1),
      ],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField });
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
        node(0, 0, 0), node(1, 1, 0),
        node(2, -1, 0), node(3, 0, 1), node(4, 0, -1),
      ],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField, postEditTool: "wall" });
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
        node(0, 0, 0), node(1, 1, 0),
        node(2, -1, 0), node(3, 0, 1), node(4, 0, -1),
      ],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField });
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
        node(0, 0, 0), node(1, 1, 0),
        node(2, -1, 0), node(3, 0, 1), node(4, 0, -1),
      ],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField });
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
      nodes: [node(0, 0, 0)],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), staleTarget, "basic") },
      ],
      nextSplitSlotId: { "0,0": 6 },
    }, { activeFieldConfig: wideField });
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
      nodes: [node(0, 0, 0)],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5, pointId: "s1" },
        { kind: "addSplitNode", point: [0, 0], slotId: 6, pointId: "s1" },
        { kind: "setEdge", edge: es(n(0), target5, "basic") },
        { kind: "setEdge", edge: es(n(0), target6, "basic") },
      ],
      nextSplitSlotId: { "0,0": 7 },
    }, { activeFieldConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([5]);
  });

  it("preserves a start marker assigned to a slot while applying a blueprint", () => {
    const target = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [node(0, 0, 0)],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "setMeta", slot: "start", endpoint: target },
      ],
    }, { activeFieldConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.postEditDraftMeta?.start).toEqual(target);
    expect(noticeCodes()).toEqual([]);
  });

  it("preserves a finish marker assigned to a slot while applying a blueprint", () => {
    const target = splitEndpoint([0, 0], 0);
    seedPostEdit({
      nodes: [node(0, 0, 0)],
      edges: [],
      start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" },
        { kind: "setMeta", slot: "finish", endpoint: target },
      ],
    }, { activeFieldConfig: wideField });
    useMazeStore.getState().applySplitBlueprint([0, 0], square);
    const s = useMazeStore.getState();
    expect(s.postEditDraftSplitPoints["0,0"]).toEqual([0]);
    expect(s.postEditDraftMeta?.finish).toEqual(target);
    expect(noticeCodes()).toEqual([]);
  });

  it("moves every occupied post-edit element from a dropped slot onto Node 0", () => {
    const oldSlot = splitEndpoint([0, 0], 5);
    const singleNode: SplitNodeBlueprint = { id: 1, degree: 4, nodeFaces: [[0, 2]] };
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [], start: null, finish: null,
      commands: [
        { kind: "addSplitNode", point: [0, 0], slotId: 5, pointId: "s1" },
        { kind: "setMeta", slot: "start", endpoint: oldSlot },
        { kind: "addTeleport", id: "t1", from: oldSlot, to: n(1), direction: "forward" },
        { kind: "addVerticalPassage", id: "v1", from: oldSlot, to: n(1), direction: "two_way" },
        { kind: "addElevator", id: "e1", floors: [oldSlot, n(1)] },
      ],
      nextSplitSlotId: { "0,0": 6 },
    }, { activeFieldConfig: wideField });

    useMazeStore.getState().applySplitBlueprint([0, 0], singleNode);
    const s = useMazeStore.getState();
    const original = n(0);
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
    expect(s.postEditDraftMeta?.start).toEqual(original);
    expect(s.postEditDraftTeleports[0]).toMatchObject({ from: original, to: n(1) });
    expect(s.postEditDraftVerticalPassages[0]).toMatchObject({ from: original, to: n(1) });
    expect(s.postEditDraftElevators[0].floors).toEqual([original, n(1)]);
    expect(s.postEditCommands.map((command) => command.kind)).toEqual([
      "addSplitNode", "setMeta", "addTeleport", "addVerticalPassage", "addElevator",
      "applySplitBlueprint", "setMeta", "moveTeleportEndpoint", "moveVerticalPassageEndpoint", "updateElevatorFloors",
    ]);
  });

  it("skips a face index beyond the tile's real degree instead of throwing (blueprint authored for a different degree)", () => {
    // Square tiles have 4 faces (offsets.length === 4) - a hex blueprint's face index 5 has
    // nothing to destructure from `offsets[5]` on a square tile.
    const oversized: SplitNodeBlueprint = { id: 0, degree: 6, nodeFaces: [[0, 5]] };
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [],
      start: null, finish: null,
    }, { activeFieldConfig: wideField });
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
        node(0, 0, 0), node(10, 0, 0, 1),
        node(1, 1, 0),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "setEdge", edge: es(n(10), n(1), "basic") }],
    }, { activeFieldConfig: wideField });
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
  const wideField = fieldOf("square", { shape: "rect", cols: 9, rows: 9 });

  it("records a single updateSplitNodeFaces command, not a setEdgePair, when wiring a freshly-added slot's face", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeFieldConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toEqual({
      kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: 0, pointId: "s1",
      faces: [bridgeFace(slot0, n(1))],
    });
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(1))]).toEqual({ from: slot0, to: n(1), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(1), slot0)]).toEqual({ from: n(1), to: slot0, kind: "basic" });
  });

  it("accumulates a second face onto the same slot's next updateSplitNodeFaces command instead of dropping the first", () => {
    seedPostEdit({
      nodes: [
        node(0, 0, 0), node(1, 1, 0), node(2, -1, 0),
      ],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeFieldConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(2)), slot0, n(2));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(3);
    expect(s.postEditCommands[2]).toMatchObject({
      kind: "updateSplitNodeFaces", point: [0, 0], slotId: 0,
      faces: expect.arrayContaining([
        bridgeFace(slot0, n(1)),
        bridgeFace(slot0, n(2)),
      ]),
    });
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(1))]).toBeDefined();
    expect(s.postEditDraftEdges?.[edgeKey(slot0, n(2))]).toBeDefined();
  });

  it("records updateSplitNodeFaces with slotId undefined, not setEdgePair, when wiring the split point's OWN original node (GitHub issue #564 follow-up)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeFieldConfig: wideField, postEditTool: "passage" });
    // Node 0 is the split point's original node (i:0) - editing ITS face is editing the split, same
    // as editing slot0's face above, and must log the same command kind.
    useMazeStore.getState().applyPostEditTool(edgeKey(n(0), n(1)), n(0), n(1));
    const s = useMazeStore.getState();
    expect(s.postEditCommands).toHaveLength(2);
    expect(s.postEditCommands[1]).toEqual({
      kind: "updateSplitNodeFaces", point: [0, 0], level: undefined, slotId: undefined, pointId: "s1",
      faces: [bridgeFace(n(0), n(1))],
    });
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toEqual({ from: n(0), to: n(1), kind: "basic" });
    expect(s.postEditDraftEdges?.[edgeKey(n(1), n(0))]).toEqual({ from: n(1), to: n(0), kind: "basic" });
  });

  it("resetPostEditPoint drops both addSplitNode and its original-node updateSplitNodeFaces commands together (shared point-scoped lifeline)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeFieldConfig: wideField, postEditTool: "passage" });
    useMazeStore.getState().applyPostEditTool(edgeKey(n(0), n(1)), n(0), n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addSplitNode", "removeSplitPoint"]);
    expect(s.postEditDraftEdges?.[edgeKey(n(0), n(1))]).toBeUndefined();
  });

  it("resetPostEditPoint drops both addSplitNode and its updateSplitNodeFaces commands together (shared lifeline)", () => {
    seedPostEdit({
      nodes: [node(0, 0, 0), node(1, 1, 0)],
      edges: [],
      start: null, finish: null,
      commands: [{ kind: "addSplitNode", point: [0, 0], slotId: 0, pointId: "s1" }],
      nextSplitSlotId: { "0,0": 1 },
    }, { activeFieldConfig: wideField, postEditTool: "passage" });
    const slot0 = splitEndpoint([0, 0], 0);
    useMazeStore.getState().applyPostEditTool(edgeKey(slot0, n(1)), slot0, n(1));
    expect(useMazeStore.getState().postEditCommands).toHaveLength(2);
    useMazeStore.getState().resetPostEditPoint([0, 0]);
    const s = useMazeStore.getState();
    expect(s.postEditCommands.map((c) => c.kind)).toEqual(["addSplitNode", "removeSplitPoint"]);
    expect(s.postEditDraftSplitPoints["0,0"]).toBeUndefined();
  });
});
