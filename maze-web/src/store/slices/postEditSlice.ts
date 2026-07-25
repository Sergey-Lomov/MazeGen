import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto, PostEditEndpointWasmDto } from "../../wasm/types";
import {
  applyPostEditEdgeTool, buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports,
  postEditTeleportsToDto, cyclePostEditTeleportDirection, removePostEditTeleport, movePostEditTeleportEndpoint,
  rotatePostEditSplitPoint,
} from "../../pixi/postEditUtils";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
  resolverForNodeId,
} from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive, deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import type { MazeStore, PostEditState, PostEditActions, PostEditTool, PostEditTeleportEntry } from "../storeTypes";
import { fieldConfigToWasm } from "./generationSlice";

/** `PostEditEndpoint` → the WASM edge/teleport DTO's endpoint shape. Not a passthrough: the split
 * variant's field is `slotId` on the TS-side `PostEditEndpoint` but `slot_id` on the wire
 * (`PostEditEndpointDto` derives `Deserialize` with no per-field rename, so serde expects the
 * literal Rust field name). */
function toWasmEndpoint(ep: PostEditEndpoint): PostEditEndpointWasmDto {
  if (ep.kind === "split") {
    return { kind: "split", point: ep.point, slot_id: ep.slotId };
  }
  return ep;
}

/** Builds the `(x,y) -> NodeId[]` map (point → every real node at it, in snapshot order) that
 * `buildSplitNodeResolver` needs, from a confirmed `nodes` snapshot. */
function buildPointNodeMap(nodes: { id: number; x: number; y: number }[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = m.get(key);
    if (list) list.push(n.id);
    else m.set(key, [n.id]);
  }
  return m;
}

export const createPostEditSlice: StateCreator<MazeStore, [], [], PostEditState & PostEditActions> = (set, get) => ({
  postEditAutoConfirm: true,
  postEditTool: "wall" as PostEditTool,
  postEditDraftEdges: null,
  postEditDraftTeleports: [] as PostEditTeleportEntry[],
  postEditTeleportPendingFrom: null,
  _nextPostEditTeleportId: 1,
  postEditDraftMeta: null,
  postEditDraftSplitPoints: {},
  postEditActiveSplitNode: {},
  postEditFocusedPoint: null,
  postEditEdges: null,
  postEditTeleportEdges: [],
  postEditMeta: null,
  postEditAnalytics: null,
  _postEditRequestId: 0,
  _generatedStart: null,
  _generatedFinish: null,
  postEditDirty: false,

  setPostEditAutoConfirm: (v) => set({ postEditAutoConfirm: v }),
  setPostEditTool: (tool) => set({ postEditTool: tool }),

  applyPostEditTool: (edgeKey, from_, to_) => {
    get().applyPostEditToolAt(get().postEditTool, edgeKey, from_, to_);
  },

  applyPostEditToolAt: (tool, edgeKey, from_, to_) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      return {
        postEditDraftEdges: applyPostEditEdgeTool(
          state.postEditDraftEdges,
          tool,
          edgeKey,
          from_,
          to_,
          state.edges,
        ),
        postEditDirty: true,
      };
    });
  },

  confirmPostEdit: async () => {
    const requestId = get()._postEditRequestId + 1;
    set({ _postEditRequestId: requestId });

    const state = get();
    const {
      postEditDraftEdges, postEditDraftTeleports, postEditDraftMeta, postEditDraftSplitPoints,
      activeTessellationConfig, nodes, start, finish, stages,
    } = state;
    if (postEditDraftEdges === null) return;
    const edgesSnapshot = postEditDraftEdges;

    // Resolver for `split` endpoints, built from the *previous* confirmed snapshot — good enough
    // for dropping edges/teleports whose split node isn't confirmed yet (see postEditEndpoint.ts's
    // doc comment), and for start/finish below. WASM resolves `split` endpoints in edges/teleports
    // itself (via `split_points` sent in the same call) — this resolver is only used here for
    // start/finish, which stay a plain `Option<u32>` on the wire.
    const pointNodeMap = buildPointNodeMap(nodes);
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints);

    const teleportEdgesSnapshot = postEditTeleportsToDto(postEditDraftTeleports, resolveSplit);
    const metaSnapshot = postEditDraftMeta;

    const effectiveStart = postEditDraftMeta != null ? postEditDraftMeta.start : (start !== null ? nodeEndpoint(start) : null);
    const effectiveFinish = postEditDraftMeta != null ? postEditDraftMeta.finish : (finish !== null ? nodeEndpoint(finish) : null);
    const resolvedStart = effectiveStart !== null ? resolveEndpoint(effectiveStart, resolveSplit) : undefined;
    const resolvedFinish = effectiveFinish !== null ? resolveEndpoint(effectiveFinish, resolveSplit) : undefined;

    const wasmEdges: PostEditEdgeWasmDto[] = [
      ...Object.values(postEditDraftEdges)
        .filter(e => e.kind !== "wall")
        .map(e => ({
          from: toWasmEndpoint(e.from),
          to: toWasmEndpoint(e.to),
          kind: e.kind === "basic" ? "basic" as const : "one_way" as const,
        })),
      ...teleportEdgesSnapshot.map(e => ({ from: { kind: "node" as const, id: e.from }, to: { kind: "node" as const, id: e.to }, kind: "teleport" as const })),
    ];

    const splitPointsPayload: [[number, number], number][] = Object.entries(postEditDraftSplitPoints)
      .flatMap(([key, slots]) => {
        const [x, y] = key.split(",").map(Number) as [number, number];
        return slots.map((slotId): [[number, number], number] => [[x, y], slotId]);
      });

    // ruleDisabled rules and rules belonging to a disabled stage excluded — same semantics
    // as buildGenerateConfig (see generationSlice.ts).
    const enabledStageRuleIds = new Set(
      stages.filter((s) => !s.disabled).flatMap((s) => s.ruleIds),
    );
    const checks = state.rules
      .filter((g) => !g.ruleDisabled && enabledStageRuleIds.has(g.id))
      .flatMap((g) => g.checks.map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params })));

    const config = {
      tessellation: fieldConfigToWasm(activeTessellationConfig),
      nodes: nodes.map(n => [n.x, n.y] as [number, number]),
      edges: wasmEdges,
      split_points: splitPointsPayload,
      start: resolvedStart ?? null,
      finish: resolvedFinish ?? null,
      checks,
    };
    try {
      const snapshot = computeAnalytics(config);
      if (get()._postEditRequestId !== requestId) return;
      set((state) => ({
        // A confirmed split node (GitHub issue #221) exists only in the WASM-returned snapshot
        // until this update — `state.nodes` was otherwise never touched by post-edit (only set
        // once at generation time), so anything reading it afterwards (the split-node dialog,
        // PostEditController's per-cell node map used to resolve edge-tool clicks) kept seeing a
        // point's split node as permanently unconfirmed, and start/finish resolution here on the
        // *next* confirm (`resolveSplit`, built from `state.nodes`) silently dropped it — the split
        // node's own edges never reached the graph on a later confirm even though this one had
        // already created it.
        nodes: snapshot.nodes,
        // `compute_analytics` rebuilds the graph from scratch (see `resolverForNodeId`'s doc
        // comment), assigning every node its own fresh id — `state.edges` must be replaced from
        // this same snapshot, not left pointing at whatever ids the *previous* generate()/confirm
        // happened to use. `GenerationRenderer` reads `state.edges` directly (not through the
        // post-edit draft), so a stale value here silently drew edges to the wrong (or no) node —
        // this was the root cause of an auto-split node (GitHub issue #222) looking disconnected
        // right after a project load, even though the confirmed graph itself was correct.
        edges: snapshot.edges,
        postEditAnalytics: {
          nodeStats: snapshot.node_stats,
          edgeStats: snapshot.edge_stats,
          teleportEdgeStats: snapshot.teleport_edge_stats,
          routeInfo: snapshot.route_info,
          navNodes: snapshot.nav_nodes,
          navEdges: snapshot.nav_edges,
          graphAnalytics: snapshot.graph_analytics,
          issues: snapshot.issues,
        },
        postEditEdges: edgesSnapshot,
        postEditTeleportEdges: teleportEdgesSnapshot,
        postEditMeta: metaSnapshot,
        showRouteOverlay: snapshot.route_info != null ? state.showRouteOverlay : false,
      }));
    } catch (err) {
      if (get()._postEditRequestId !== requestId) return;
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  resetPostEdit: () => {
    set((state) => {
      // Re-derive split points from the generated snapshot (GitHub issue #222) rather than
      // clearing them — an auto-split node still exists in `state.nodes`/`state.edges`, and every
      // reference to it must be a `split` endpoint, not a stale raw id (see
      // `resolverForNodeId`'s doc comment). A manually `addSplitNode`-added slot doesn't survive
      // a reset either way (it was never real, being neither generated nor yet confirmed), so this
      // is a strict superset of the old "just clear it" behavior for anything that actually exists.
      const splitPoints = deriveSplitPointsFromNodes(state.nodes);
      const pointNodeMap = new Map<string, number[]>();
      for (const n of state.nodes) {
        const key = `${n.x},${n.y}`;
        const list = pointNodeMap.get(key);
        if (list) list.push(n.id); else pointNodeMap.set(key, [n.id]);
      }
      const endpointFor = resolverForNodeId(pointNodeMap, splitPoints);
      const { teleports, nextId } = extractPostEditTeleports(state.edges, endpointFor);
      return {
        postEditDraftEdges: buildPostEditDraftEdgesFromGenerated(state.edges, endpointFor),
        postEditDraftTeleports: teleports,
        _nextPostEditTeleportId: nextId,
        postEditTeleportPendingFrom: null,
        postEditDraftSplitPoints: splitPoints,
        postEditActiveSplitNode: {},
        postEditFocusedPoint: null,
        postEditEdges: null,
        postEditTeleportEdges: [],
        postEditMeta: null,
        postEditAnalytics: null,
        postEditDraftMeta: {
          start: state._generatedStart !== null ? endpointFor(state._generatedStart) : null,
          finish: state._generatedFinish !== null ? endpointFor(state._generatedFinish) : null,
        },
        postEditTool: "wall" as PostEditTool,
        postEditDirty: false,
      };
    });
    void get().confirmPostEdit();
  },

  setPostEditEndpoint: (kind, endpoint) => {
    set((state) => ({
      postEditDraftMeta: {
        ...(state.postEditDraftMeta ?? {
          start: state.start !== null ? nodeEndpoint(state.start) : null,
          finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
        }),
        [kind]: endpoint,
      },
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
  clearPostEditEndpoint: (kind) => {
    set((state) => ({
      postEditDraftMeta: {
        ...(state.postEditDraftMeta ?? {
          start: state.start !== null ? nodeEndpoint(state.start) : null,
          finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
        }),
        [kind]: null,
      },
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  setPostEditTeleportPendingFrom: (nodeId) => set({ postEditTeleportPendingFrom: nodeId }),

  addPostEditTeleport: (from, to, direction) => {
    set((state) => {
      const entry: PostEditTeleportEntry = { id: state._nextPostEditTeleportId, from, to, direction };
      return {
        postEditDraftTeleports: [...state.postEditDraftTeleports, entry],
        _nextPostEditTeleportId: state._nextPostEditTeleportId + 1,
        postEditTeleportPendingFrom: null,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cyclePostEditTeleportDirection: (id) => {
    set((state) => ({
      postEditDraftTeleports: cyclePostEditTeleportDirection(state.postEditDraftTeleports, id),
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditTeleport: (id) => {
    set((state) => ({
      postEditDraftTeleports: removePostEditTeleport(state.postEditDraftTeleports, id),
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditTeleportEndpoint: (id, end, endpoint) => {
    set((state) => ({
      postEditDraftTeleports: movePostEditTeleportEndpoint(state.postEditDraftTeleports, { id, end }, endpoint),
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  addSplitNode: (point) => {
    set((state) => {
      const { splitPoints, slotId } = addSlot(state.postEditDraftSplitPoints, point);
      return {
        postEditDraftSplitPoints: splitPoints,
        postEditActiveSplitNode: { ...state.postEditActiveSplitNode, [`${point[0]},${point[1]}`]: splitEndpoint(point, slotId) },
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removeSplitNode: (point, slotId) => {
    const state = get();
    const target = splitEndpoint(point, slotId);

    // Structural comparison (not a resolved id) — rejects the removal the same way whether or
    // not this split node has been confirmed yet.
    const meta = state.postEditDraftMeta;
    if (meta && ((meta.start && endpointsEqual(meta.start, target)) || (meta.finish && endpointsEqual(meta.finish, target)))) {
      set({ error: "Cannot remove a node assigned as start/finish — reassign start/finish first." });
      return;
    }

    set((state) => {
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointsEqual(e.from, target) || endpointsEqual(e.to, target);

      const nextDraftEdges = state.postEditDraftEdges === null ? null : Object.fromEntries(
        Object.entries(state.postEditDraftEdges).filter(([, e]) => !refsTarget(e)),
      );
      const nextTeleports = state.postEditDraftTeleports.filter((t) => !refsTarget(t));

      const { splitPoints, activeMap } = removeSlot(
        state.postEditDraftSplitPoints, state.postEditActiveSplitNode, point, slotId,
        (entry, point, slotId) => entry.kind === "split" && endpointsEqual(entry, splitEndpoint(point, slotId)),
      );

      return {
        postEditDraftEdges: nextDraftEdges,
        postEditDraftTeleports: nextTeleports,
        postEditDraftSplitPoints: splitPoints,
        postEditActiveSplitNode: activeMap,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cycleActiveSplitNode: (point) => {
    set((state) => ({
      postEditActiveSplitNode: cycleActive(
        state.postEditDraftSplitPoints, state.postEditActiveSplitNode, point,
        splitEndpoint, (entry) => (entry && entry.kind === "split" ? entry.slotId : undefined),
      ),
    }));
  },

  setActiveSplitNode: (point, endpoint) => {
    set((state) => ({
      postEditActiveSplitNode: setActive(state.postEditActiveSplitNode, point, endpoint, (e) => e.kind === "node"),
    }));
  },

  setPostEditFocusedPoint: (point) => set({ postEditFocusedPoint: point }),

  rotateSplitPoint: (point, direction) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      const key = `${point[0]},${point[1]}`;
      const slotIds = state.postEditDraftSplitPoints[key] ?? [];
      const cells = buildActiveCells(state.fieldPoints, state.fieldEditMode, state.activeTessellationConfig);
      const cellSet = buildCellSet(cells);
      const rotated = rotatePostEditSplitPoint(
        state.postEditDraftEdges, point, slotIds, direction, state.activeTessellationConfig,
        cellSet, state.nodes, state.postEditActiveSplitNode,
      );
      if (rotated === state.postEditDraftEdges) return {};
      return { postEditDraftEdges: rotated, postEditDirty: true };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
});
