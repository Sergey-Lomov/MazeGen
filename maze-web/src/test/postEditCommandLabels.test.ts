import { describe, it, expect } from "vitest";
import {
  buildNodeByIdMap, entityIdOf, postEditCommandLabel,
} from "../pixi/postEditCommandLabels";
import type { SplitLabelContext } from "../pixi/postEditSplitLabels";
import { nodeEndpoint, splitEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditEdgeState } from "../store/postEditTypes";
import type { NodeDto } from "../wasm/types";

/** Builds a `PostEditEdgeState` (GitHub issue #564) — `id` is required exactly when `kind` is a
 *  one-way variant, defaulting to "o1" when omitted since most label-formatting tests don't care
 *  about the actual id value. */
const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"], _id = "o1"): PostEditEdgeState => ({ kind, from, to });

const n = (id: number, x: number, y: number, level?: number, i = 0): NodeDto =>
  (level === undefined ? { id, x, y, i } : { id, x, y, i, level }) as NodeDto;

// Minimal `SplitLabelContext` for a point with no recognized special-split topology (all-wall
// faces, since there's no field/edges configured) — `resolveSplitNodeShortLabel` then falls back
// to plain `splitNodeLabelShort` numbering, same as the no-context (`splitCtx: null`) case except
// it correctly recognizes the point AS a split tile via `splitPoints`.
const splitCtxFor = (allNodes: NodeDto[], splitPoints: Record<string, number[]>): SplitLabelContext => ({
  allNodes,
  splitPoints,
  activeSplitNode: {},
  draftEdges: null,
  cfg: { type: "square", width: 10, height: 10 },
  inFieldCellsAt: () => new Set(),
});

describe("postEditCommandLabel", () => {
  it("formats a setEdge wall as an undirected bubble pair", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "wall") };
    const label = postEditCommandLabel(command, nodeById, false);
    expect(label.showArrow).toBe(true);
    expect(label.arrow).toBe("<->");
    expect(label.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
  });

  it("formats a one-way setEdge with a directed arrow", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "one_way_forward") };
    const label = postEditCommandLabel(command, nodeById, false);
    expect(label.arrow).toBe("->");
  });

  it("uses Lf x:y coordinates once multiFloor is true", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0, 1), n(1, 1, 0, 1)]);
    const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "basic") };
    const label = postEditCommandLabel(command, nodeById, true);
    expect(label.bubbles.map((b) => b.text)).toEqual(["L2 0:0", "L2 1:0"]);
  });

  it("setEdge/setEdgePair row hover highlights the connecting line (same-floor link)", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "basic") };
    const label = postEditCommandLabel(command, nodeById, false);
    expect(label.rowHighlight).toEqual({
      kind: "link",
      from: { kind: "point", point: [0, 0], level: undefined },
      to: { kind: "point", point: [1, 0], level: undefined },
      highlightStyle: "boundary",
    });
  });

  it("setEdgePair keeps bubble order fixed as a,b regardless of which direction is one-way", () => {
    const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
    const forward: PostEditCommand = {
      kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1),
      aToB: es(nodeEndpoint(0), nodeEndpoint(1), "one_way_forward"), bToA: es(nodeEndpoint(1), nodeEndpoint(0), "wall"),
    };
    const backward: PostEditCommand = {
      kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1),
      aToB: es(nodeEndpoint(0), nodeEndpoint(1), "wall"), bToA: es(nodeEndpoint(1), nodeEndpoint(0), "one_way_forward"),
    };
    const forwardLabel = postEditCommandLabel(forward, nodeById, false);
    const backwardLabel = postEditCommandLabel(backward, nodeById, false);
    expect(forwardLabel.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
    expect(backwardLabel.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
    expect(forwardLabel.arrow).toBe("->");
    expect(backwardLabel.arrow).toBe("<-");
  });

  it("removeVerticalPassage shows its own denormalized from/to, not a live-entry lookup (GitHub issue #564 partial)", () => {
    const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
    const command: PostEditCommand = {
      kind: "removeVerticalPassage", id: "v99", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward",
    };
    const label = postEditCommandLabel(command, nodeById, true);
    expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5"]);
    expect(label.arrow).toBe("->");
    expect(label.rowHighlight?.danger).toBe(true);
    expect(label.bubbles.every((bubble) => bubble.highlight?.danger === true)).toBe(true);
  });

  it("removeElevator shows its own denormalized floors, not a live-entry lookup (GitHub issue #564 partial)", () => {
    const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1), n(2, 3, 5, 2)]);
    const command: PostEditCommand = {
      kind: "removeElevator", id: "e99", floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)],
    };
    const label = postEditCommandLabel(command, nodeById, true);
    expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5", "L3 3:5"]);
    expect(label.rowHighlight?.danger).toBe(true);
    expect(label.bubbles.every((bubble) => bubble.highlight?.danger === true)).toBe(true);
  });

  describe("vertical passage bubbles", () => {
    const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);

    it("one-way forward: two per-floor bubbles, arrow points FROM's floor -> TO's floor", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5"]);
      expect(label.showArrow).toBe(true);
      expect(label.arrow).toBe("->");
    });

    it("one-way backward: fixed FROM/TO bubble order, arrow glyph flips instead", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5"]);
      expect(label.arrow).toBe("<-");
    });

    it("two-way: bidirectional arrow", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.arrow).toBe("<->");
    });

    it("row hover highlights both floors' points, not a connecting line", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.rowHighlight).toEqual({
        kind: "points",
        points: [
          { kind: "point", point: [3, 5], level: 0 },
          { kind: "point", point: [3, 5], level: 1 },
        ],
      });
    });

    it("each bubble highlights only its own floor's point", () => {
      const command: PostEditCommand = {
        kind: "addVerticalPassage", id: "v1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles[0].highlight).toEqual({ kind: "point", point: [3, 5], level: 0 });
      expect(label.bubbles[1].highlight).toEqual({ kind: "point", point: [3, 5], level: 1 });
    });
  });

  describe("teleport direction arrow", () => {
    it("addTeleport backward: arrow is <-, not -> (GitHub issue #546 third follow-up)", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const command: PostEditCommand = {
        kind: "addTeleport", id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward",
      };
      const label = postEditCommandLabel(command, nodeById, false);
      expect(label.arrow).toBe("<-");
    });

    it("setTeleportDirection backward: arrow is <-, not ->", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const command: PostEditCommand = { kind: "setTeleportDirection", id: "t1", direction: "backward", from: nodeEndpoint(0), to: nodeEndpoint(1) };
      const label = postEditCommandLabel(command, nodeById, false);
      expect(label.arrow).toBe("<-");
    });

    it("moveTeleportEndpoint reads its own denormalized backward direction, not ->", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const command: PostEditCommand = {
        kind: "moveTeleportEndpoint", id: "t1", end: "from", endpoint: nodeEndpoint(0),
        from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward",
      };
      const label = postEditCommandLabel(command, nodeById, false);
      expect(label.arrow).toBe("<-");
    });

    it("setTeleportDirection/moveTeleportEndpoint/removeTeleport show their own denormalized from/to, not a live-entry lookup (GitHub issue #564 follow-up)", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const setDirCommand: PostEditCommand = { kind: "setTeleportDirection", id: "t99", direction: "forward", from: nodeEndpoint(0), to: nodeEndpoint(1) };
      const moveCommand: PostEditCommand = {
        kind: "moveTeleportEndpoint", id: "t99", end: "to", endpoint: nodeEndpoint(1),
        from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward",
      };
      const removeCommand: PostEditCommand = { kind: "removeTeleport", id: "t99", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "forward" };
      for (const command of [setDirCommand, moveCommand, removeCommand]) {
        const label = postEditCommandLabel(command, nodeById, false);
        expect(label.bubbles.map((b) => b.text)).toEqual(["0:0", "1:0"]);
      }
      const removeLabel = postEditCommandLabel(removeCommand, nodeById, false);
      expect(removeLabel.rowHighlight?.danger).toBe(true);
      expect(removeLabel.bubbles.every((bubble) => bubble.highlight?.danger === true)).toBe(true);
    });

    it("row hover highlights both endpoint points, never a connecting line", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const command: PostEditCommand = {
        kind: "addTeleport", id: "t1", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, false);
      expect(label.rowHighlight).toEqual({
        kind: "points",
        points: [
          { kind: "point", point: [0, 0], level: undefined },
          { kind: "point", point: [1, 0], level: undefined },
        ],
      });
    });
  });

  describe("vertical passage direction arrow", () => {
    // `command.direction` here is the entry's direction BEFORE the click (GitHub issue #546 fourth
    // follow-up — see `flippedVerticalPassageArrow`'s own doc comment), so a command logged with the
    // OLD "forward" must show the flipped, actually-resulting "<-" arrow, not "->".
    it("setVerticalPassageDirection: arrow reflects the flipped (post-click) direction, not the logged pre-click one", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
      const command: PostEditCommand = { kind: "setVerticalPassageDirection", id: "v1", direction: "forward", from: nodeEndpoint(0), to: nodeEndpoint(1) };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.arrow).toBe("<-");
    });

    it("setVerticalPassageDirection: pre-click backward flips to a post-click -> arrow", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
      const command: PostEditCommand = { kind: "setVerticalPassageDirection", id: "v1", direction: "backward", from: nodeEndpoint(0), to: nodeEndpoint(1) };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.arrow).toBe("->");
    });

    it("moveVerticalPassageEndpoint reads its own denormalized backward direction, not ->", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
      const command: PostEditCommand = {
        kind: "moveVerticalPassageEndpoint", id: "v1", end: "from", endpoint: nodeEndpoint(0),
        from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "backward",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.arrow).toBe("<-");
    });

    it("setVerticalPassageDirection shows its own denormalized from/to, not a live-entry lookup (GitHub issue #564 follow-up)", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
      const command: PostEditCommand = { kind: "setVerticalPassageDirection", id: "v99", direction: "forward", from: nodeEndpoint(0), to: nodeEndpoint(1) };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5"]);
    });

    it("moveVerticalPassageEndpoint shows its own denormalized from/to/direction, not a live-entry lookup (GitHub issue #564 follow-up)", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, 0), n(1, 3, 5, 1)]);
      const command: PostEditCommand = {
        kind: "moveVerticalPassageEndpoint", id: "v99", end: "to", endpoint: nodeEndpoint(1),
        from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way",
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 3:5", "L2 3:5"]);
      expect(label.arrow).toBe("<->");
    });
  });

  describe("split-node bubble suffix (GitHub issue #546 fourth follow-up)", () => {
    it("every node of a split tile gets a (N{n}) suffix, the ORIGINAL node (i=0) included", () => {
      // Node 1 is the point's 2nd node (i=1, the point's first extra slot) — same convention
      // debugRowText.ts's bubbleLabel uses. Node 0 is the SAME point's original node — it must get
      // its own suffix too (GitHub issue #546 eighth follow-up: a split tile's original node is
      // just as much a split node as any extra slot, `NodeDto.i === 0` is not a reason to omit it).
      const nodes = [n(0, 3, 5, undefined, 0), n(1, 3, 5, undefined, 1)];
      const nodeById = buildNodeByIdMap(nodes);
      const splitCtx = splitCtxFor(nodes, { "3,5": [0] });
      const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(1), nodeEndpoint(0), "basic") };
      const label = postEditCommandLabel(command, nodeById, false, splitCtx);
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5 (N2)", "3:5 (N1)"]);
    });

    it("a recognized 'bridge' topology's node names get the semantic short label, not a bare N{n}", () => {
      // Point (5,5), square field: node 0 (original) is the through corridor (right+left,
      // offsets 0/2), node 1 (slot 0) is the crossing bridge (down+up, offsets 1/3) — same
      // opposite-pair-per-node layout `detectSplitSpecialShapeKind` recognizes as "bridge".
      const original = n(0, 5, 5, undefined, 0);
      const slot = n(1, 5, 5, undefined, 1);
      const right = n(2, 6, 5);
      const left = n(3, 4, 5);
      const down = n(4, 5, 6);
      const up = n(5, 5, 4);
      const allNodes = [original, slot, right, left, down, up];
      const originalEp = nodeEndpoint(0);
      const slotEp = nodeEndpoint(1);
      const rightEp = nodeEndpoint(2);
      const leftEp = nodeEndpoint(3);
      const downEp = nodeEndpoint(4);
      const upEp = nodeEndpoint(5);
      const slotSplitEp = splitEndpoint([5, 5], 0);
      const draftEdges: SplitLabelContext["draftEdges"] = {
        [edgeKey(originalEp, rightEp)]: { from: originalEp, to: rightEp, kind: "basic" },
        [edgeKey(originalEp, leftEp)]: { from: originalEp, to: leftEp, kind: "basic" },
        // The slot's OWN edges are keyed by its `split` endpoint form, not the resolved `nodeEndpoint`
        // — matching `nodeEndpointsInOrder`'s own row-order convention below (`resolveSplitNodeShortLabel`
        // builds every extra slot's row as `splitEndpoint(...)`, mirroring `ManageSplitNodesDialog`'s
        // identical `nodeEndpointsInOrder`), and generation-time edges' own real-world keying
        // (`buildMultiFloorPostEditDraft`).
        [edgeKey(slotSplitEp, downEp)]: { from: slotSplitEp, to: downEp, kind: "basic" },
        [edgeKey(slotSplitEp, upEp)]: { from: slotSplitEp, to: upEp, kind: "basic" },
      };
      const splitCtx: SplitLabelContext = {
        allNodes,
        splitPoints: { "5,5": [0] },
        activeSplitNode: {},
        draftEdges,
        cfg: { type: "square", width: 10, height: 10 },
        inFieldCellsAt: () => new Set(["5,5", "6,5", "4,5", "5,6", "5,4"]),
      };
      const command: PostEditCommand = { kind: "setEdge", edge: es(originalEp, slotEp, "wall") };
      const label = postEditCommandLabel(command, buildNodeByIdMap(allNodes), false, splitCtx);
      expect(label.bubbles.map((b) => b.text)).toEqual(["5:5 (Cor)", "5:5 (Brg)"]);
    });

    it("shows the suffix for a floor-0 node whose NodeDto.level is a real 0, not undefined (GitHub issue #546 ninth follow-up)", () => {
      // `NodeDto.level` comes straight off the wasm snapshot as a real `0` for floor 0 (see
      // `maze-wasm/src/dto.rs`'s `pub level: u32`), never `undefined` — unlike every other test in
      // this file, which passes `level: undefined` for floor 0 by omitting the `n()` helper's
      // `level` argument. `postEditDraftSplitPoints` keys floor 0 bare (`"x,y"`, no `"@0"`), so a
      // caller that forgets to normalize `0` to `undefined` before building its own lookup key
      // silently misses every floor-0 split point.
      const nodes = [n(0, 3, 5, 0, 0), n(1, 3, 5, 0, 1)];
      const nodeById = buildNodeByIdMap(nodes);
      const splitCtx = splitCtxFor(nodes, { "3,5": [0] });
      const command: PostEditCommand = { kind: "setEdge", edge: es(nodeEndpoint(1), nodeEndpoint(0), "basic") };
      const label = postEditCommandLabel(command, nodeById, false, splitCtx);
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5 (N2)", "3:5 (N1)"]);
    });

    it("a node whose point is NOT a split tile (no splitPoints entry) gets no suffix", () => {
      const nodes = [n(0, 3, 5, undefined, 0)];
      const nodeById = buildNodeByIdMap(nodes);
      const splitCtx = splitCtxFor(nodes, {});
      const command: PostEditCommand = { kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) };
      const label = postEditCommandLabel(command, nodeById, false, splitCtx);
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5"]);
    });

    it("start and finish creation commands keep their fixed entity ids", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5, undefined, 0)]);
      const start = postEditCommandLabel({ kind: "addMeta", slot: "start", id: "s", endpoint: nodeEndpoint(0) }, nodeById, false);
      const finish = postEditCommandLabel({ kind: "addMeta", slot: "finish", id: "f", endpoint: nodeEndpoint(0) }, nodeById, false);
      expect(start.entityId).toBe("s");
      expect(finish.entityId).toBe("f");
      expect(start.action).toMatch(/Create start|Создан старт/);
      expect(finish.action).toMatch(/Create finish|Создан финиш/);
    });

    it("set start/finish row hover highlights the assigned point", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5)]);
      const label = postEditCommandLabel({ kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) }, nodeById, false);
      expect(label.rowHighlight).toEqual({ kind: "point", point: [3, 5], level: undefined });
    });

    it("deleting start/finish uses the danger highlight", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5)]);
      const label = postEditCommandLabel({ kind: "removeMeta", slot: "finish", id: "f", endpoint: nodeEndpoint(0) }, nodeById, false);
      expect(label.rowHighlight).toEqual({
        kind: "point", danger: true, point: [3, 5], level: undefined,
      });
      expect(label.bubbles[0].highlight).toEqual({ kind: "point", danger: true, point: [3, 5], level: undefined });
    });

    it("a split endpoint (not yet confirmed to a real node) gets the suffix from its own slotId", () => {
      const nodes = [n(0, 3, 5, undefined, 0)];
      const splitCtx = splitCtxFor(nodes, { "3,5": [0] });
      const command: PostEditCommand = { kind: "setEdge", edge: es(splitEndpoint([3, 5], 0), nodeEndpoint(0), "basic") };
      const label = postEditCommandLabel(command, buildNodeByIdMap(nodes), false, splitCtx);
      expect(label.bubbles[0].text).toBe("3:5 (N2)");
    });

    it("addSplitNode names the new slot's own number", () => {
      const command: PostEditCommand = { kind: "addSplitNode", point: [3, 5], slotId: 2, pointId: "s1" };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.bubbles[0].text).toBe("3:5 (N4)");
    });

    it("removeSplitNode names the removed slot's own number and carries its own entityId", () => {
      const command: PostEditCommand = { kind: "removeSplitNode", point: [3, 5], slotId: 2, pointId: "s1" };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.bubbles[0].text).toBe("3:5 (N4)");
      expect(label.entityId).toBe("s1");
    });

    it("rotateSplitPoint/applySplitBlueprint address the whole tile — no per-slot suffix", () => {
      const command: PostEditCommand = { kind: "rotateSplitPoint", point: [3, 5], nodes: [] };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.bubbles[0].text).toBe("3:5");
      expect(label.rowHighlight).toEqual({ kind: "point", point: [3, 5], level: undefined, highlightMode: "outset" });
      expect(label.bubbles[0].highlight).toEqual({ kind: "point", point: [3, 5], level: undefined, highlightMode: "outset" });
    });

    it("all split-entity bubbles use the expanded-cell mode and deletion bubbles are dangerous", () => {
      const nodeById = buildNodeByIdMap([n(0, 3, 5)]);
      const commands: PostEditCommand[] = [
        { kind: "addSplitNode", point: [3, 5], slotId: 0, pointId: "s1" },
        { kind: "removeSplitNode", point: [3, 5], slotId: 0, pointId: "s1" },
        { kind: "removeSplitPoint", point: [3, 5], pointId: "s1", removedSlotIds: [0] },
        { kind: "applySplitBlueprint", point: [3, 5], pointId: "s1", resolvedSlots: [] },
        { kind: "updateSplitNodeFaces", point: [3, 5], slotId: 0, pointId: "s1", faces: [] },
      ];
      for (const command of commands) {
        const label = postEditCommandLabel(command, nodeById, false);
        expect(label.bubbles[0].highlight?.highlightMode).toBe("outset");
        if (command.kind === "removeSplitNode" || command.kind === "removeSplitPoint") {
          expect(label.bubbles[0].highlight?.danger).toBe(true);
          expect(label.rowHighlight?.danger).toBe(true);
        }
      }
    });

    it("applySplitBlueprint uses the plain action text and carries its own entityId when unnamed", () => {
      const command: PostEditCommand = { kind: "applySplitBlueprint", point: [3, 5], pointId: "s1", resolvedSlots: [] };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.action).toBe("Add split-tile");
      expect(label.entityId).toBe("s1");
      expect(label.bubbles[0].text).toBe("3:5");
    });

    it("applySplitBlueprint interpolates the blueprint's own title when named", () => {
      const command: PostEditCommand = {
        kind: "applySplitBlueprint", point: [3, 5], pointId: "s1", resolvedSlots: [], blueprintTitleKey: "split_pattern_title.bridge",
      };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.action).toContain("Add");
      expect(label.entityId).toBe("s1");
    });
  });

  describe("updateSplitNodeFaces (GitHub issue #564 follow-up)", () => {
    it("a numbered slot's face edit shows that slot's own (N{n}) bubble and id", () => {
      const nodes = [n(0, 3, 5, undefined, 0), n(1, 3, 5, undefined, 1)];
      const nodeById = buildNodeByIdMap(nodes);
      const splitCtx = splitCtxFor(nodes, { "3,5": [0] });
      const command: PostEditCommand = {
        kind: "updateSplitNodeFaces", point: [3, 5], slotId: 0, pointId: "s1",
        faces: [{ neighbor: nodeEndpoint(2), toNeighbor: es(splitEndpoint([3, 5], 0), nodeEndpoint(2), "basic"), fromNeighbor: es(nodeEndpoint(2), splitEndpoint([3, 5], 0), "basic") }],
      };
      const label = postEditCommandLabel(command, nodeById, false, splitCtx);
      expect(label.action).toBe("Update split tile settings");
      expect(label.entityId).toBe("s1");
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5 (N2)"]);
    });

    it("the point's ORIGINAL node's face edit (slotId: undefined) resolves via its own node, not a split-endpoint suffix lookup", () => {
      // `slotId: undefined` addresses the point's original node (GitHub issue #564 follow-up) —
      // it has no `split`-kind endpoint of its own, so the label must resolve it by coordinates
      // through `nodeById` (`splitOriginalNodeBubble`) instead of `splitSlotBubble`'s slotId path.
      const nodes = [n(0, 3, 5, undefined, 0), n(1, 3, 5, undefined, 1)];
      const nodeById = buildNodeByIdMap(nodes);
      const splitCtx = splitCtxFor(nodes, { "3,5": [0] });
      const command: PostEditCommand = {
        kind: "updateSplitNodeFaces", point: [3, 5], slotId: undefined, pointId: "s1",
        faces: [{ neighbor: nodeEndpoint(2), toNeighbor: es(nodeEndpoint(0), nodeEndpoint(2), "basic"), fromNeighbor: es(nodeEndpoint(2), nodeEndpoint(0), "basic") }],
      };
      const label = postEditCommandLabel(command, nodeById, false, splitCtx);
      expect(label.action).toBe("Update split tile settings");
      expect(label.entityId).toBe("s1");
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5 (N1)"]);
    });

    it("the original node's face edit falls back to a bare point bubble when the node isn't in nodeById yet", () => {
      const command: PostEditCommand = {
        kind: "updateSplitNodeFaces", point: [3, 5], slotId: undefined, pointId: "s1", faces: [],
      };
      const label = postEditCommandLabel(command, buildNodeByIdMap([]), false);
      expect(label.bubbles.map((b) => b.text)).toEqual(["3:5"]);
    });
  });

  describe("elevator bubbles", () => {
    it("one bubble per floor instead of one combined bubble", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 2)]);
      const command: PostEditCommand = {
        kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)],
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 2:2", "L2 2:2", "L3 2:2"]);
    });

    it("no arrow glyph for a 3+ floor elevator", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 2)]);
      const command: PostEditCommand = {
        kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)],
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.showArrow).toBe(false);
    });

    it("no arrow glyph for a 2-floor elevator either — an elevator never has a single direction", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1)]);
      const command: PostEditCommand = { kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles).toHaveLength(2);
      expect(label.showArrow).toBe(false);
    });

    it("falls back to ? for a floor endpoint that hasn't resolved yet", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0)]);
      const command: PostEditCommand = {
        kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(999)],
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 2:2", "?"]);
    });

    it("row hover highlights every floor's own point", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1)]);
      const command: PostEditCommand = { kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.rowHighlight).toEqual({
        kind: "points",
        points: [
          { kind: "point", point: [2, 2], level: 0 },
          { kind: "point", point: [2, 2], level: 1 },
        ],
      });
    });

    it("updateElevatorFloors shows its own floor list and entityId, distinct from add/remove", () => {
      const nodeById = buildNodeByIdMap([n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 2)]);
      const command: PostEditCommand = {
        kind: "updateElevatorFloors", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1), nodeEndpoint(2)],
      };
      const label = postEditCommandLabel(command, nodeById, true);
      expect(label.bubbles.map((b) => b.text)).toEqual(["L1 2:2", "L2 2:2", "L3 2:2"]);
      expect(label.entityId).toBe("e1");
      expect(label.showArrow).toBe(false);
    });
  });

  describe("entityIdOf (GitHub issue #574)", () => {
    it("returns undefined for a wall/basic setEdge and setEdgePair", () => {
      expect(entityIdOf({ kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "wall") })).toBeUndefined();
      expect(entityIdOf({ kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "basic") })).toBeUndefined();
      expect(entityIdOf({
        kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1),
        aToB: es(nodeEndpoint(0), nodeEndpoint(1), "wall"), bToA: es(nodeEndpoint(1), nodeEndpoint(0), "wall"),
      })).toBeUndefined();
    });

    it("returns no id for one-way setEdge/setEdgePair variants", () => {
      expect(entityIdOf({ kind: "setEdge", edge: es(nodeEndpoint(0), nodeEndpoint(1), "one_way_forward", "o7") })).toBeUndefined();
      expect(entityIdOf({
        kind: "setEdgePair", a: nodeEndpoint(0), b: nodeEndpoint(1),
        aToB: es(nodeEndpoint(0), nodeEndpoint(1), "one_way_forward", "o8"), bToA: es(nodeEndpoint(1), nodeEndpoint(0), "wall"),
      })).toBeUndefined();
    });

    it("returns the entity's own id for teleport/vertical-passage/elevator commands", () => {
      expect(entityIdOf({ kind: "addTeleport", id: "t3", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" })).toBe("t3");
      expect(entityIdOf({ kind: "addVerticalPassage", id: "v2", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" })).toBe("v2");
      expect(entityIdOf({ kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] })).toBe("e1");
    });

    it("returns the split point's own pointId for split-structure commands", () => {
      expect(entityIdOf({ kind: "addSplitNode", point: [1, 1], slotId: 2, pointId: "s5" })).toBe("s5");
      expect(entityIdOf({
        kind: "updateSplitNodeFaces", point: [1, 1], slotId: 2, faces: [], pointId: "s5",
      })).toBe("s5");
    });

    it("returns undefined for setMeta and rotateSplitPoint", () => {
      expect(entityIdOf({ kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) })).toBeUndefined();
      expect(entityIdOf({ kind: "rotateSplitPoint", point: [1, 1], nodes: [] })).toBeUndefined();
    });

    it("agrees with postEditCommandLabel's own entityId field for every command kind that has an id (GitHub issue #573)", () => {
      // Pins the invariant the entity-id filter (GitHub issue #574) and the Changes panel's own id
      // bubble (GitHub issue #573) both depend on: whatever id `entityIdOf` reports for a command
      // must be the exact same id the row itself exposes via `label.entityId` — otherwise the filter,
      // the id bubble, and the row-hover cross-highlight would silently disagree about which id an
      // entity has. Covers every id-bearing command kind, including `setEdgePair` (whose id
      // resolution — `oneWaySideOf` — is shared code, not just parallel logic, but this still pins
      // the observable agreement rather than the sharing itself).
      const nodeById = buildNodeByIdMap([n(0, 0, 0), n(1, 1, 0)]);
      const idBearingCommands: PostEditCommand[] = [
        { kind: "addTeleport", id: "t3", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" },
        { kind: "addVerticalPassage", id: "v2", from: nodeEndpoint(0), to: nodeEndpoint(1), direction: "two_way" },
        { kind: "addElevator", id: "e1", floors: [nodeEndpoint(0), nodeEndpoint(1)] },
        { kind: "addSplitNode", point: [1, 1], slotId: 2, pointId: "s5" },
      ];
      for (const command of idBearingCommands) {
        const id = entityIdOf(command);
        expect(id).toBeDefined();
        const label = postEditCommandLabel(command, nodeById, false);
        expect(label.entityId).toBe(id);
      }
    });

    it("setMeta/rotateSplitPoint labels carry no entityId, matching entityIdOf's own undefined", () => {
      const nodeById = buildNodeByIdMap([n(0, 0, 0)]);
      const metaLabel = postEditCommandLabel({ kind: "setMeta", slot: "start", endpoint: nodeEndpoint(0) }, nodeById, false);
      const rotateLabel = postEditCommandLabel({ kind: "rotateSplitPoint", point: [1, 1], nodes: [] }, nodeById, false);
      expect(metaLabel.entityId).toBeUndefined();
      expect(rotateLabel.entityId).toBeUndefined();
    });
  });
});
