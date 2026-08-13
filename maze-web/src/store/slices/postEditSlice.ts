import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto, PostEditEndpointWasmDto } from "../../wasm/types";
import {
  applyPostEditEdgeTool, buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports,
  postEditTeleportsToDto, cyclePostEditTeleportDirection, removePostEditTeleport, movePostEditTeleportEndpoint,
  rotatePostEditSplitPoint, resetPostEditPoint as resetPostEditPointCore,
} from "../../pixi/postEditUtils";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
  resolverForNodeId, edgeKey, resolvePostEditPartnerAt,
} from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive, deriveSplitPointsFromNodes } from "../../pixi/splitPointsCore";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { MazeStore, PostEditState, PostEditActions, PostEditTool, PostEditTeleportEntry } from "../storeTypes";
import { fieldConfigToWasm, buildValidPresetConnections } from "./generationSlice";
import { relevantRuleParams, activeFloorField } from "../storeHelpers";

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
  postEditHoveredLink: null,
  postEditEdges: null,
  postEditTeleportEdges: [],
  postEditMeta: null,
  postEditAnalytics: null,
  _postEditRequestId: 0,
  _generatedStart: null,
  _generatedFinish: null,
  _generatedNodes: [],
  _generatedEdges: [],
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
          // `_generatedEdges`, not `state.edges` — the latter is overwritten by every
          // confirmPostEdit with the current (possibly manually-edited) graph, so the "reset"
          // tool would compare against whatever the last edit produced instead of the actual
          // generation output (GitHub issue #323).
          state._generatedEdges,
        ),
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
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
    // A node whose split slot has been removed client-side (`removeSplitNode`/`resetPostEditPoint`)
    // must not be resent — `apply_split_points` (maze-wasm/src/analytics/post_edit.rs) never prunes
    // a node on its own; every entry in `cfg.nodes` is rebuilt into the graph unconditionally, by
    // design (see that module's own test docs: "the client's state.nodes/i no longer carries it...
    // exactly as removeSplitNode leaves state.nodes before the next confirm resends a pruned
    // cfg.nodes"). Without this filter a removed split node stays in the graph (and in the point's
    // node count) forever — the point keeps rendering as split even after its last extra slot is
    // gone. Kept node: the point's original (`i === 0`), or an extra node whose slotId (`i - 1`)
    // is still declared in `postEditDraftSplitPoints`.
    const prunedNodes = nodes.filter((n) => {
      if (n.i === 0) return true;
      const slots = postEditDraftSplitPoints[`${n.x},${n.y}`];
      return slots !== undefined && slots.includes(n.i - 1);
    });

    const pointNodeMap = buildPointNodeMap(prunedNodes);
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

    // ruleDisabled rules, rules belonging to a disabled stage, and individually disabled checks
    // excluded — same semantics as buildGenerateConfig/ruleToConfig (see generateConfigBuilder.ts).
    const enabledStageRuleIds = new Set(
      stages.filter((s) => !s.disabled).flatMap((s) => s.ruleIds),
    );
    // Grouped by rule (not flattened), one group per still-active `QcRuleState`, each carrying its
    // own rule-level params (e.g. `protect_route`, GitHub issue #253) alongside its checks — the
    // wasm side wraps each group in its own synthetic rule (`analytics_only_stages`) so a
    // rule-level param actually reaches `resolve_rule_params` on this path too. Before this fix,
    // no rule-level param was forwarded at all here, so e.g. disabling "protect start/finish" had
    // no effect on post-edit's `teleport_duplicates_connection` check — it silently kept resolving
    // to its default (`true`) every time.
    const ruleGroups = state.rules
      .filter((g) => !g.ruleDisabled && enabledStageRuleIds.has(g.id))
      .map((g) => {
        const activeChecks = g.checks.filter((c) => !c.disabled);
        const activeCheckTypeIds = activeChecks.map((c) => c.typeId);
        const params: Record<string, string> = {};
        for (const p of relevantRuleParams(state.availableRuleParams, activeCheckTypeIds, null)) {
          if (g.params[p.id] !== undefined) params[p.id] = g.params[p.id];
        }
        return {
          checks: activeChecks.map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params })),
          params,
        };
      })
      .filter((g) => g.checks.length > 0);

    const config = {
      tessellation: fieldConfigToWasm(activeTessellationConfig),
      nodes: prunedNodes,
      edges: wasmEdges,
      split_points: splitPointsPayload,
      start: resolvedStart ?? null,
      finish: resolvedFinish ?? null,
      rule_groups: ruleGroups,
      // GitHub issue #245: lets the Rust side flag cycle/group issue elements composed entirely
      // of preset Passage/OneWay edges as `preset_locked`, even on this post-edit rebuild path.
      preset_connections: buildValidPresetConnections(state),
      // GitHub issue #245's split-node/route extension: same idea as `preset_connections`, but for
      // which split nodes the preset snapshot declares — lets the Rust side flag node/route-based
      // split issue elements as `preset_locked` too. No invalid-key filtering here (unlike
      // `generateConfigBuilder.ts`'s `split_points`) — the Rust side already silently skips a
      // point/slot it can't resolve, same contract as `preset_connections`.
      preset_split_points: Object.entries(state.presetSplitPoints)
        .flatMap(([key, slots]) => {
          const [x, y] = key.split(",").map(Number) as [number, number];
          return slots.map((slotId): [[number, number], number] => [[x, y], slotId]);
        }),
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
          splitAnalytics: snapshot.split_analytics,
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
      // clearing them — an auto-split node still exists in `_generatedNodes`/`_generatedEdges`,
      // and every reference to it must be a `split` endpoint, not a stale raw id (see
      // `resolverForNodeId`'s doc comment). A manually `addSplitNode`-added slot doesn't survive
      // a reset either way (it was never real, being neither generated nor yet confirmed), so this
      // is a strict superset of the old "just clear it" behavior for anything that actually exists.
      //
      // Must read `_generatedNodes`/`_generatedEdges`, not `state.nodes`/`state.edges` — the
      // latter are overwritten by every confirmPostEdit with the current (possibly manually
      // edited) graph, so once at least one edit has been confirmed they no longer reflect the
      // original generation and a reset built from them is a no-op (GitHub issue #323).
      //
      // Post-edit isn't multi-floor-aware yet (GitHub issue #333 epic — same as QC/repair/
      // analytics), but `_generatedNodes`/`_generatedEdges` can now span every floor (generation
      // is the one multi-level-aware path, GitHub issue #337). Restricted to floor 0 here — every
      // point-keyed grouping below (`deriveSplitPointsFromNodes`, `buildPointNodeMap`) would
      // otherwise conflate same-(x,y) nodes on different floors into bogus split-point groups.
      const floorZeroNodes = state._generatedNodes.filter((n) => (n.level ?? 0) === 0);
      const floorZeroIds = new Set(floorZeroNodes.map((n) => n.id));
      const floorZeroEdges = state._generatedEdges.filter((e) => floorZeroIds.has(e.from) && floorZeroIds.has(e.to));
      const splitPoints = deriveSplitPointsFromNodes(floorZeroNodes);
      const pointNodeMap = buildPointNodeMap(floorZeroNodes);
      const endpointFor = resolverForNodeId(pointNodeMap, splitPoints);
      const { teleports, nextId } = extractPostEditTeleports(floorZeroEdges, endpointFor);
      return {
        nodes: floorZeroNodes,
        edges: floorZeroEdges,
        postEditDraftEdges: buildPostEditDraftEdgesFromGenerated(floorZeroEdges, endpointFor),
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

  resetPostEditPoint: (point) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      const meta = state.postEditDraftMeta ?? {
        start: state.start !== null ? nodeEndpoint(state.start) : null,
        finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
      };
      // Post-edit only ever addresses floor 0 (GitHub issue #333 epic — same caveat as
      // `resetPostEdit`'s own comment): `_generatedNodes`/`_generatedEdges` can span every floor
      // now that generation is multi-level-aware (GitHub issue #337), so a same-(x,y) node on
      // another floor would otherwise be picked up as if it were at `point` on floor 0.
      const floorZeroNodes = state._generatedNodes.filter((n) => (n.level ?? 0) === 0);
      const floorZeroIds = new Set(floorZeroNodes.map((n) => n.id));
      const floorZeroEdges = state._generatedEdges.filter((e) => floorZeroIds.has(e.from) && floorZeroIds.has(e.to));
      const result = resetPostEditPointCore(
        point,
        state.postEditDraftEdges,
        state.postEditDraftTeleports,
        state.postEditDraftSplitPoints,
        state.postEditActiveSplitNode,
        meta,
        floorZeroNodes,
        floorZeroEdges,
        state._generatedStart,
        state._generatedFinish,
      );
      // Restored teleports (from generation) get fresh ids minted locally by
      // `resetPostEditPointCore` (it has no access to the store's own counter) — bump
      // `_nextPostEditTeleportId` past whatever it just used, or a later `addPostEditTeleport`
      // could mint a colliding id.
      const maxTeleportId = result.draftTeleports.reduce((max, t) => Math.max(max, t.id), 0);
      return {
        postEditDraftEdges: result.draftEdges,
        postEditDraftTeleports: result.draftTeleports,
        postEditDraftSplitPoints: result.splitPoints,
        postEditActiveSplitNode: result.activeSplitNode,
        postEditDraftMeta: result.draftMeta,
        _nextPostEditTeleportId: Math.max(state._nextPostEditTeleportId, maxTeleportId + 1),
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
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
  setPostEditHoveredLink: (link) => set({ postEditHoveredLink: link }),

  rotateSplitPoint: (point, direction) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      const key = `${point[0]},${point[1]}`;
      const slotIds = state.postEditDraftSplitPoints[key] ?? [];
      const field = activeFloorField(state);
      const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeTessellationConfig);
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

  applySplitBlueprint: (point, blueprint) => {
    const state = get();
    const key = `${point[0]},${point[1]}`;
    const meta = state.postEditDraftMeta;
    const originalId = state.nodes.find((n) => n.x === point[0] && n.y === point[1])?.id;
    const originalEndpoint: PostEditEndpoint | null = originalId !== undefined ? nodeEndpoint(originalId) : null;
    // Every node currently at this point — original plus every declared slot — is about to have
    // its faces fully rebuilt by the blueprint; bail out if start/finish still addresses any of
    // them, same guard as a manual `removeSplitNode` (reassign first).
    const existingSlots = state.postEditDraftSplitPoints[key] ?? [];
    const existingNodeEndpoints: PostEditEndpoint[] = [
      ...(originalEndpoint ? [originalEndpoint] : []),
      ...existingSlots.map((slotId) => splitEndpoint(point, slotId)),
    ];
    if (meta && existingNodeEndpoints.some((t) =>
      (meta.start && endpointsEqual(meta.start, t)) || (meta.finish && endpointsEqual(meta.finish, t)))) {
      set({ error: "Cannot apply a blueprint while an existing split node is assigned as start/finish — reassign it first." });
      return;
    }

    set((state) => {
      // Every edge/teleport touching any of this point's current nodes is dropped first — a face
      // the blueprint doesn't claim must end up with no connection at all (post-edit's own
      // default-to-wall convention, see `tileFaceKindOf`), not whatever stale connection the
      // point happened to have before.
      const refsExistingNode = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        existingNodeEndpoints.some((t) => endpointsEqual(e.from, t) || endpointsEqual(e.to, t));

      const nextDraftEdges: NonNullable<typeof state.postEditDraftEdges> =
        state.postEditDraftEdges === null ? {} : Object.fromEntries(
          Object.entries(state.postEditDraftEdges).filter(([, e]) => !refsExistingNode(e)),
        );
      const nextTeleports = state.postEditDraftTeleports.filter((t) => !refsExistingNode(t));
      const nextActiveSplitNode = { ...state.postEditActiveSplitNode };
      delete nextActiveSplitNode[key];

      // Original node (slot-less) stays addressable throughout — its own faces are governed by
      // the blueprint's node 0 like any other minted node.
      const slotEndpoints: PostEditEndpoint[] = blueprint.nodeFaces.slice(1).map((_, i) => splitEndpoint(point, i));
      const nodeEndpoints: PostEditEndpoint[] = [originalEndpoint, ...slotEndpoints].filter((e): e is PostEditEndpoint => e !== null);

      const { offsets } = getNeighborData(state.activeTessellationConfig, point[0], point[1]);
      const field = activeFloorField(state);
      const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeTessellationConfig);
      const inFieldCells = buildCellSet(cells);

      // Every one of the blueprint's declared faces gets a `passage` to its in-field neighbor;
      // every other face of the tile is left with no entry at all, which post-edit already reads
      // as `wall` by default — no separate "wall" pass needed.
      for (let nodeIndex = 0; nodeIndex < blueprint.nodeFaces.length; nodeIndex++) {
        const endpoint = nodeEndpoints[nodeIndex];
        if (!endpoint) continue;
        for (const faceIndex of blueprint.nodeFaces[nodeIndex]) {
          // Guards against a caller passing a blueprint authored for a different tile degree
          // (normal UI flow always picks one via `blueprintsForDegree`, so this only matters for
          // a direct/programmatic `applySplitBlueprint` call) — `offsets[faceIndex]` would
          // otherwise be `undefined` and the destructure below would throw.
          if (faceIndex >= offsets.length) continue;
          const [dx, dy] = offsets[faceIndex];
          const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
          if (!inFieldCells.has(`${neighbor[0]},${neighbor[1]}`)) continue;
          const neighborIds: number[] = [];
          for (const n of state.nodes) if (n.x === neighbor[0] && n.y === neighbor[1]) neighborIds.push(n.id);
          const neighborKey = `${neighbor[0]},${neighbor[1]}`;
          // The neighbor's real connecting node — not just its active UI slot (GitHub issue #243).
          // Resolved against the pre-cleanup snapshot (`state.postEditDraftEdges`) and `point`'s
          // *old* (pre-blueprint) endpoints: any pre-existing neighbor edge was recorded against
          // one of those, never against `endpoint` (a fresh node this call is about to mint).
          const neighborPartner = resolvePostEditPartnerAt(
            existingNodeEndpoints, neighbor, neighborIds, state.postEditDraftEdges ?? {}, state.postEditDraftSplitPoints[neighborKey] ?? [], nextActiveSplitNode,
          );
          if (!neighborPartner) continue;
          nextDraftEdges[edgeKey(endpoint, neighborPartner)] = { from: endpoint, to: neighborPartner, kind: "basic" };
          nextDraftEdges[edgeKey(neighborPartner, endpoint)] = { from: neighborPartner, to: endpoint, kind: "basic" };
        }
      }

      const nextSplitPoints = { ...state.postEditDraftSplitPoints };
      if (slotEndpoints.length === 0) delete nextSplitPoints[key];
      else nextSplitPoints[key] = slotEndpoints.map((_, i) => i);

      return {
        postEditDraftEdges: nextDraftEdges,
        postEditDraftTeleports: nextTeleports,
        postEditDraftSplitPoints: nextSplitPoints,
        postEditActiveSplitNode: nextActiveSplitNode,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
});
