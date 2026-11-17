import { vi } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState, baseFloorFieldConfig, mockSnapshot, postEditStatePatch } from "./storeTestHelpers";
import type { PostEditSeed } from "./storeTestHelpers";
import { nodeEndpoint, edgeKey } from "../pixi/postEditEndpoint";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { NodeDto } from "../wasm/types";
import type { PostEditEdgeState } from "../store/postEditTypes";
import { resetNotifications } from "../notifications/notificationStore";
import { computeAnalyticsAsync } from "../wasm/mazeService";
import { fieldOf } from "./fieldConfigFixtures";

/** Shared fixtures for the `postEditSlice.*.test.ts` files. Each test file must declare the
 *  `vi.mock` calls itself (see `postEditSliceMocks.ts`) — `computeAnalyticsAsync` here is that mock. */

export const n = nodeEndpoint;
export const key01 = edgeKey(n(0), n(1));

/** Builds a `PostEditEdgeState` for a hand-written command/expectation literal. */
export const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"]): PostEditEdgeState => ({ kind, from, to });

/** A `NodeDto` literal: floor-0 slot-0 node unless `i`/`level` say otherwise. `level` is omitted
 *  (left `undefined`) by default, matching the hand-written fixtures this replaces. */
export const node = (id: number, x: number, y: number, i = 0, level?: number): NodeDto =>
  (level === undefined ? { id, x, y, i } : { id, x, y, i, level });

/** One updateSplitNodeFaces/rotateSplitPoint face entry wiring `from` to `neighbor` in both directions. */
export const bridgeFace = (from: PostEditEndpoint, neighbor: PostEditEndpoint, kind: PostEditEdgeState["kind"] = "basic") =>
  ({ neighbor, toNeighbor: es(from, neighbor, kind), fromNeighbor: es(neighbor, from, kind) });

/** `floors`/`floorFields` for `count` floors with `activeFloorId` on `activeIndex` — the geometry
 *  vertical-passage/elevator placement probes read. */
export const floorsExtra = (count: number, activeIndex: number) => ({
  activeFloorId: `f${activeIndex}`,
  floors: Array.from({ length: count }, (_, i) => ({ id: `f${i}`, title: `Floor ${i + 1}` })),
  floorFields: Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, baseFloorFieldConfig()])),
});

/** The payload of the most recent `computeAnalyticsAsync` call (`undefined` if none was made). */
export function lastAnalyticsCall() {
  const calls = vi.mocked(computeAnalyticsAsync).mock.calls;
  return calls[calls.length - 1]?.[0];
}

type StoreState = ReturnType<typeof useMazeStore.getState>;

/** The default generation snapshot every test starts from: two floor-0 nodes with a single
 *  one-directional `basic` edge 0->1 (so `buildPostEditBaseline` derives a `one_way_forward` draft
 *  edge from it, matching what `reset`-tool and `resetPostEdit` tests rely on). */
const BASE_NODES = [node(0, 0, 0), node(1, 1, 0)];
const BASE_EDGES = [{ from: 0, to: 1, kind: "basic" as const }];

/** Seeds a full, self-consistent post-edit scenario: a real `postEditBaseline` built from the
 *  generation snapshot plus a replayed command log, with the legacy `postEditDraft*` mirror fields
 *  derived from it (GitHub issue #543 — actions read the baseline, never the mirror fields, so
 *  seeding the mirror fields alone silently desyncs the two). `extra` carries any non-post-edit
 *  store fields the scenario also needs (floors, tessellation, tool, ...).
 *
 *  Thin wrapper over `postEditStatePatch` (storeTestHelpers): adds this suite's default snapshot and
 *  the post-edit field resets. `PostEditController.test.ts` has its own wrapper with a different
 *  default snapshot, so the defaults deliberately stay local rather than moving into the shared patch. */
export function seedPostEdit(seed: Partial<PostEditSeed> = {}, extra: Partial<StoreState> = {}) {
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
  } as Partial<StoreState>);
}

/** Shared `beforeEach`: fresh store, working analytics mock, and the default scenario. */
export function resetPostEditStore() {
  resetNotifications();
  useMazeStore.setState(baseStoreState());
  vi.mocked(computeAnalyticsAsync).mockReset();
  vi.mocked(computeAnalyticsAsync).mockResolvedValue(mockSnapshot);
  useMazeStore.setState({
    activeFieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 1 }),
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
  // to a full two-way passage. `setEdge` sets exactly one directed key (GitHub issue #543 — it never
  // touches the reverse key as a side effect), so a full two-way passage needs both directions
  // seeded explicitly. Start is node 0, finish is node 1.
  seedPostEdit({
    commands: [
      { kind: "setEdge", edge: es(n(0), n(1), "basic") },
      { kind: "setEdge", edge: es(n(1), n(0), "basic") },
    ],
  });
}
