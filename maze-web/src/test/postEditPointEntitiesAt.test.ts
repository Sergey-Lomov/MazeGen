import { describe, it, expect } from "vitest";
import { buildPostEditPointEntitiesAt, type PostEditPointEntitiesSourceState } from "../store/slices/postEditBaselineBuilders";
import { nodeEndpoint, edgeKey, type PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto } from "../wasm/types";
import { baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

const n = (id: number, x: number, y: number, level?: number, i = 0): NodeDto =>
  (level === undefined ? { id, x, y, i } : { id, x, y, i, level }) as NodeDto;

/** Same "bridge" split-node layout `postEditCommandLabels.test.ts` uses (right/left through
 *  corridor on the original node, up/down crossing on the slot) — but reached through
 *  `buildPostEditPointEntitiesAt` (the live-state assembly `PostEditEntityDeleteDialog`/
 *  `requestPostEditEntityDelete` actually call), not a hand-built `SplitLabelContext`. Regression
 *  coverage for GitHub issue #611's bug class at its actual root: `cfgAt`/`inFieldCellsAt` inside
 *  `buildPostEditPointEntitiesAt` must resolve each floor's OWN `fieldConfig`
 *  (`state.floorFields[floor.id]`), not the maze-wide `state.activeFieldConfig` snapshot.
 *  Point (0, 0) — a square field's cells are centered on the origin (`configAllCells`/
 *  `configOriginOffset`), so (0, 0) and its 4 cardinal neighbors are guaranteed in-field for any
 *  square/triangle size used here, unlike an arbitrary off-center point. */
describe("buildPostEditPointEntitiesAt", () => {
  it("resolves a non-active floor's split-node topology through that floor's own field config, not the maze-wide activeFieldConfig", () => {
    const floor0Id = TEST_FLOOR_ID;
    const floor1Id = "floor_2";

    const original = n(0, 0, 0, 1, 0);
    const slot = n(1, 0, 0, 1, 1);
    const right = n(2, 1, 0, 1);
    const left = n(3, -1, 0, 1);
    const down = n(4, 0, 1, 1);
    const up = n(5, 0, -1, 1);
    const nodes = [original, slot, right, left, down, up];

    const originalEp = nodeEndpoint(0);
    const rightEp = nodeEndpoint(2);
    const leftEp = nodeEndpoint(3);
    const downEp = nodeEndpoint(4);
    const upEp = nodeEndpoint(5);
    const slotSplitEp: PostEditEndpoint = { kind: "split", point: [0, 0], slotId: 0, level: 1 };

    const postEditDraftEdges: PostEditPointEntitiesSourceState["postEditDraftEdges"] = {
      [edgeKey(originalEp, rightEp)]: { from: originalEp, to: rightEp, kind: "basic" },
      [edgeKey(originalEp, leftEp)]: { from: originalEp, to: leftEp, kind: "basic" },
      [edgeKey(slotSplitEp, downEp)]: { from: slotSplitEp, to: downEp, kind: "basic" },
      [edgeKey(slotSplitEp, upEp)]: { from: slotSplitEp, to: upEp, kind: "basic" },
    };

    const state: PostEditPointEntitiesSourceState = {
      nodes,
      postEditDraftSplitPoints: { "0,0@1": [0] },
      // `start` anchored on the split point's original node — the delete picker's `start` entity
      // bubble goes through `endpointBubble`/`resolveSplitNodeShortLabel`, same as every other
      // entity kind, so it exercises `facesOf`'s `cfgAt(level)` call.
      postEditDraftMeta: { start: originalEp, finish: null },
      postEditDraftTeleports: [],
      postEditDraftVerticalPassages: [],
      postEditDraftElevators: [],
      postEditDraftEdges,
      floors: [{ id: floor0Id, title: "Floor 1" }, { id: floor1Id, title: "Floor 2" }],
      floorFields: {
        // Floor 0's own config is irrelevant here (the split point lives on floor 1) — its
        // presence just makes `activeFieldConfig`'s square shape ALSO the "if the bug
        // regressed" wrong answer for floor 1's own lookup, so a regression can't accidentally
        // pass by coincidence.
        [floor0Id]: baseFloorFieldConfig(),
        // Floor 1's OWN config is a triangle field — `detectSplitSpecialShapeKind` only ever
        // recognizes degree 4 or 6 offsets (see `splitFaceLayout.ts`), so a triangle field's
        // degree-3 tile never matches "bridge", unlike the square field this point would resolve
        // against if `cfgAt`/`inFieldCellsAt` fell back to a shared/active config instead of this
        // floor's own.
        [floor1Id]: baseFloorFieldConfig({ fieldConfig: fieldOf("tri", { shape: "rect", cols: 10, rows: 10 }) }),
      },
      activeFieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
      postEditActiveSplitNode: {},
    };

    const entities = buildPostEditPointEntitiesAt(state, [0, 0], 1);
    const start = entities.find((e) => e.kind === "start");
    expect(start).toBeDefined();
    // Plain slot numbering ("N1"), not the "bridge" semantic name ("Brg") a square field would
    // recognize here — proves floor 1's own triangle config was actually used.
    expect(start?.bubbles.map((b) => b.text)).toEqual(["L2 0:0 (N1)"]);
  });
});
