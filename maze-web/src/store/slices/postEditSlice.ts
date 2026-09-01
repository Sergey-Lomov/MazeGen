import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto } from "../../wasm/types";
import {
  applyPostEditEdgeTool,
  postEditTeleportsToDto, cyclePostEditTeleportDirection, removePostEditTeleport, movePostEditTeleportEndpoint,
  rotatePostEditSplitPoint, resetPostEditPoint as resetPostEditPointCore,
  findPostEditVerticalPassageForPair,
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage, movePostEditVerticalPassageEndpoint,
  removePostEditElevator, postEditVerticalToDto, elevatorComponent, pruneRemovedSplitNodes,
} from "../../pixi/postEditUtils";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
  edgeKey, resolvePostEditPartnerAt,
} from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type {
  MazeStore, PostEditState, PostEditActions, PostEditTool, PostEditTeleportEntry,
  PostEditVerticalPassageEntry, PostEditElevatorEntry,
} from "../storeTypes";
import { fieldConfigToWasm, buildValidPresetConnections } from "./generationSlice";
import { relevantRuleParams, activeFloorField, activeFloorLevel, floorTessellationOf, resolveFieldAtOf } from "../storeHelpers";
import { configAllCells } from "../../pixi/tessellationCells";
import {
  toWasmEndpoint, buildMultiFloorPointNodeMap, commitPostEditVerticalPassage, buildMultiFloorPostEditDraft,
} from "./postEditSliceHelpers";

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
  postEditDraftVerticalPassages: [] as PostEditVerticalPassageEntry[],
  postEditVerticalPassagePending: null,
  _nextPostEditVerticalPassageId: 1,
  postEditDraftElevators: [] as PostEditElevatorEntry[],
  postEditElevatorPending: null,
  _nextPostEditElevatorId: 1,
  postEditSuppressedElevatorPairs: new Set<string>(),
  postEditSuppressedVerticalPassagePairs: new Set<string>(),
  postEditSplitTargetPrompt: null,

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
    // is still declared in `postEditDraftSplitPoints` — looked up by the node's own `(x,y)@level`
    // key (GitHub issue #358), since `postEditDraftSplitPoints` is now one flat, maze-wide
    // collection keyed with an `"@level"` suffix (`undefined`/floor 0 has no suffix, same
    // convention `presetSplitPoints` uses — see `Specs/preset-connections.md`'s "Multi-floor
    // presets"), not always the bare `"x,y"` key.
    const prunedNodes = pruneRemovedSplitNodes(nodes, postEditDraftSplitPoints, (n) => {
      const level = n.level ?? 0;
      return level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
    });

    const pointNodeMap = buildMultiFloorPointNodeMap(prunedNodes);
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

    // `VerticalPassage`/`Elevator` edges: generation-time ones are resent unchanged from the frozen
    // `_generatedEdges` snapshot, not `state.edges` — the latter is overwritten by every confirm
    // with the current (possibly manually-edited) graph, so resending from it would compare/rebuild
    // against whatever the last edit produced instead of the actual generation output, and a
    // point-reset's un-suppression (`resetPostEditPoint`) would have nothing left to restore once a
    // connection had been edited even once (same class of bug `applyPostEditToolAt`'s own
    // `_generatedEdges` doc comment describes for walls/passages, GitHub issue #323). Post-edit never
    // redirects/removes a *generated* vertical/elevator edge, only adds new user-placed links via its
    // own vertical-passage/elevator tools (GitHub issue #341) — see
    // `ComputeAnalyticsConfig.vertical_edges`'s own doc comment.
    // `postEditDraftVerticalPassages`/`postEditDraftElevators` are converted the same way
    // `postEditDraftTeleports` is, through the previous confirmed snapshot's resolver.
    // `postEditSuppressedElevatorPairs`/`postEditSuppressedVerticalPassagePairs` drop a
    // generation-time edge once the user has edited that connection (see
    // `confirmPostEditElevatorPlacement`'s/`commitPostEditVerticalPassage`'s own doc comments) —
    // otherwise the old generation-time edge would keep being resent forever, coexisting with (and
    // silently undoing) whatever the new draft entry says — e.g. cycling a one-way passage's
    // direction would leave the *old* forward edge alongside the *new* backward one, reading as
    // two-way instead of a direction flip.
    const generatedVerticalEdges = state._generatedEdges
      .filter((e): e is typeof e & { kind: "vertical_passage" | "elevator" } =>
        e.kind === "vertical_passage" || e.kind === "elevator")
      .filter((e) => {
        const [a, b] = [e.from, e.to].sort((x, y) => x - y);
        if (e.kind === "elevator") return !state.postEditSuppressedElevatorPairs.has(`${a},${b}`);
        return !state.postEditSuppressedVerticalPassagePairs.has(`${a},${b}`);
      })
      .map(e => ({ from: e.from, to: e.to, kind: e.kind }));
    const draftVerticalEdges = postEditVerticalToDto(state.postEditDraftVerticalPassages, state.postEditDraftElevators, resolveSplit);
    const verticalEdges = [...generatedVerticalEdges, ...draftVerticalEdges];

    // `ComputeAnalyticsConfig.split_points` is `[[x,y], slotId, level][]` (GitHub issue #359,
    // `compute_analytics` is now genuinely multi-level) — the `"@level"` suffix is parsed into its
    // own `level` entry instead of being stripped, so two floors' split points at the same `(x, y)`
    // resolve against their own floor's node, not collide on the wire.
    const splitPointsPayload: [[number, number], number, number][] = Object.entries(postEditDraftSplitPoints)
      .flatMap(([key, slots]) => {
        const [pointPart, levelPart] = key.split("@");
        const [x, y] = pointPart.split(",").map(Number) as [number, number];
        const level = levelPart === undefined ? 0 : Number(levelPart);
        return slots.map((slotId): [[number, number], number, number] => [[x, y], slotId, level]);
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

    // Each floor's own field points, in `floors` order (GitHub issue #359) — mirrors
    // `buildGenerateConfig`'s own `level_fields` derivation.
    const level_fields = state.floors.map((floor) => configAllCells(floorTessellationOf(state, floor.id)));

    const config = {
      tessellation: fieldConfigToWasm(activeTessellationConfig),
      level_fields,
      nodes: prunedNodes,
      edges: wasmEdges,
      vertical_edges: verticalEdges,
      split_points: splitPointsPayload,
      start: resolvedStart ?? null,
      finish: resolvedFinish ?? null,
      rule_groups: ruleGroups,
      // GitHub issue #245: lets the Rust side flag cycle/group issue elements composed entirely
      // of preset Passage/OneWay edges as `preset_locked`, even on this post-edit rebuild path.
      // `compute_analytics` is genuinely multi-level as of GitHub issue #359, so every floor's
      // presets resolve against their own floor's node.
      preset_connections: buildValidPresetConnections(state, false),
      // GitHub issue #245's split-node/route extension: same idea as `preset_connections`, but for
      // which split nodes the preset snapshot declares — lets the Rust side flag node/route-based
      // split issue elements as `preset_locked` too. No invalid-key filtering here (unlike
      // `generateConfigBuilder.ts`'s `split_points`) — the Rust side already silently skips a
      // point/slot it can't resolve, same contract as `preset_connections`. Every floor's declared
      // split points are sent, with their own `level` parsed out of the `"@level"` suffix the same
      // way `splitPointsPayload` above does (GitHub issue #359).
      preset_split_points: Object.entries(state.presetSplitPoints)
        .flatMap(([key, slots]) => {
          const [pointPart, levelPart] = key.split("@");
          const [x, y] = pointPart.split(",").map(Number) as [number, number];
          const level = levelPart === undefined ? 0 : Number(levelPart);
          return slots.map((slotId): [[number, number], number, number] => [[x, y], slotId, level]);
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
          statistics: snapshot.statistics,
          routeInfo: snapshot.route_info,
          navNodes: snapshot.nav_nodes,
          navEdges: snapshot.nav_edges,
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
      // Post-edit is now floor-aware (GitHub issue #358) — `postEditDraftEdges`/
      // `postEditDraftTeleports`/`postEditDraftSplitPoints`/`postEditActiveSplitNode` are one
      // flat, maze-wide collection covering every floor at once, mirroring how preset connections
      // did this (GitHub issue #340, `Specs/preset-connections.md`'s "Multi-floor presets").
      // `buildMultiFloorPostEditDraft` is shared with `generateConfigBuilder`'s fresh-generation
      // path (GitHub issue #425 — the two used to duplicate this logic, and drifted apart).
      const { draftEdges, draftTeleports, splitPoints, endpointFor } = buildMultiFloorPostEditDraft(
        state._generatedNodes,
        state._generatedEdges,
      );
      const nextTeleportId = draftTeleports.length + 1;

      return {
        nodes: state._generatedNodes,
        edges: state._generatedEdges,
        postEditDraftEdges: draftEdges,
        postEditDraftTeleports: draftTeleports,
        _nextPostEditTeleportId: nextTeleportId,
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
        postEditDraftVerticalPassages: [] as PostEditVerticalPassageEntry[],
        postEditVerticalPassagePending: null,
        _nextPostEditVerticalPassageId: 1,
        postEditDraftElevators: [] as PostEditElevatorEntry[],
        postEditElevatorPending: null,
        _nextPostEditElevatorId: 1,
        postEditSuppressedElevatorPairs: new Set<string>(),
        postEditSuppressedVerticalPassagePairs: new Set<string>(),
        postEditSplitTargetPrompt: null,
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
      // `point` addresses the active floor (GitHub issue #358) — `resetPostEditPointCore` scopes
      // every lookup to that floor's own nodes/edges internally, so the full multi-floor
      // `_generatedNodes`/`_generatedEdges` (GitHub issue #337) are passed through unfiltered here.
      const level = activeFloorLevel(state);
      const result = resetPostEditPointCore(
        point,
        state.postEditDraftEdges,
        state.postEditDraftTeleports,
        state.postEditDraftSplitPoints,
        state.postEditActiveSplitNode,
        meta,
        state._generatedNodes,
        state._generatedEdges,
        state._generatedStart,
        state._generatedFinish,
        level,
      );
      // Restored teleports (from generation) get fresh ids minted locally by
      // `resetPostEditPointCore` (it has no access to the store's own counter) — bump
      // `_nextPostEditTeleportId` past whatever it just used, or a later `addPostEditTeleport`
      // could mint a colliding id.
      const maxTeleportId = result.draftTeleports.reduce((max, t) => Math.max(max, t.id), 0);
      // User-placed vertical passages/elevators (GitHub issue #341) have no generation-time
      // counterpart to restore — a point reset just drops any draft entry touching this point on
      // the active floor, same as a wall/passage reset drops its draft edges.
      const touchesPoint = (ep: PostEditEndpoint) =>
        ep.kind === "node" ? false : endpointsEqual(ep, splitEndpoint(point, ep.slotId, level));
      const touchesPointNode = (ep: PostEditEndpoint) => {
        if (ep.kind !== "node") return false;
        const node = state._generatedNodes.find((n) => n.id === ep.id);
        return node !== undefined && node.x === point[0] && node.y === point[1] && (node.level ?? 0) === (level ?? 0);
      };
      const refsPoint = (ep: PostEditEndpoint) => touchesPoint(ep) || touchesPointNode(ep);
      const postEditDraftVerticalPassages = state.postEditDraftVerticalPassages.filter((p) => !refsPoint(p.from) && !refsPoint(p.to));
      const postEditDraftElevators = state.postEditDraftElevators.filter((e) => !e.floors.some(refsPoint));
      // A suppressed generation-time elevator pair naming a node at this point must un-suppress on
      // reset too — resetting this point is meant to restore its generation-time state in full,
      // which includes whatever elevator connection generation originally gave it.
      const pointNodeIds = new Set(state._generatedNodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0)).map((n) => n.id));
      // An Elevator's generation-time mesh spans every floor it connects, not just this point's own
      // node (GitHub issue #341 follow-up) — e.g. a 3-floor elevator edited down to 2 floors from
      // floor 1 suppresses the *whole* previous mesh (floor1-2, floor1-3, floor2-3, see
      // `confirmPostEditElevatorPlacement`'s own `sourceNodeIds` comment), so un-suppressing only
      // pairs naming floor 1's own node would leave floor2-3 suppressed forever — restoring floor 2
      // with no link onward to floor 3. Un-suppressing the *entire* generation-time elevator
      // component this point's node belongs to (BFS over `_generatedEdges`' own elevator edges)
      // restores the mesh in full, matching what a point reset is meant to guarantee.
      const elevatorComponentIds = elevatorComponent(state._generatedEdges, pointNodeIds);
      const postEditSuppressedElevatorPairs = new Set(
        [...state.postEditSuppressedElevatorPairs].filter((key) => {
          const [a, b] = key.split(",").map(Number);
          return !elevatorComponentIds.has(a) && !elevatorComponentIds.has(b);
        }),
      );
      // Same un-suppress on reset for vertical-passage pairs (see the elevator comment above).
      const postEditSuppressedVerticalPassagePairs = new Set(
        [...state.postEditSuppressedVerticalPassagePairs].filter((key) => {
          const [a, b] = key.split(",").map(Number);
          return !pointNodeIds.has(a) && !pointNodeIds.has(b);
        }),
      );
      return {
        postEditDraftEdges: result.draftEdges,
        postEditDraftTeleports: result.draftTeleports,
        postEditDraftSplitPoints: result.splitPoints,
        postEditActiveSplitNode: result.activeSplitNode,
        postEditDraftMeta: result.draftMeta,
        _nextPostEditTeleportId: Math.max(state._nextPostEditTeleportId, maxTeleportId + 1),
        postEditDraftVerticalPassages,
        postEditDraftElevators,
        postEditSuppressedElevatorPairs,
        postEditSuppressedVerticalPassagePairs,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  /** Delete tool (GitHub issue #386) — removes every generation-placed non-edge piece of content
   * touching `point`'s nodes (start/finish marker, teleport links, vertical passages, elevators),
   * regardless of split state (every one of the point's nodes loses its content in one click, per
   * the issue's own scope decision — not just the currently active split node). Unlike
   * `resetPostEditPoint`, this never restores anything from `_generatedEdges` — it's a pure removal,
   * and it never touches `postEditDraftEdges`/split points at all (the `wall`/`reset` tools already
   * own basic-edge removal).
   *
   * A generation-time vertical passage/elevator has no draft entry to filter out — it's resent
   * verbatim from `_generatedEdges` by `confirmPostEdit` unless suppressed (see
   * `postEditSuppressedElevatorPairs`/`postEditSuppressedVerticalPassagePairs`'s own doc comment),
   * so deleting one needs to suppress its pair(s) the same way an edit does, or it would keep
   * reappearing on every confirm. An elevator's suppression covers its *entire* generation-time
   * connected component (BFS over `_generatedEdges`' own `elevator` edges), same reasoning
   * `resetPostEditPoint`'s own un-suppress branch gives — a component can span floors that never
   * name this point's own node directly. */
  deletePostEditPoint: (point) => {
    set((state) => {
      const level = activeFloorLevel(state);
      const bareKey = `${point[0]},${point[1]}`;
      const key = level === undefined ? bareKey : `${bareKey}@${level}`;

      const pointNodeIds = new Set(
        state.nodes
          .filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0))
          .map((n) => n.id),
      );
      const draftTargets: PostEditEndpoint[] = [
        ...[...pointNodeIds].map((id) => nodeEndpoint(id)),
        ...(state.postEditDraftSplitPoints[key] ?? []).map((slotId) => splitEndpoint(point, slotId, level)),
      ];
      const endpointRefsTarget = (ep: PostEditEndpoint) => draftTargets.some((t) => endpointsEqual(ep, t));
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointRefsTarget(e.from) || endpointRefsTarget(e.to);

      const meta = state.postEditDraftMeta ?? {
        start: state.start !== null ? nodeEndpoint(state.start) : null,
        finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
      };
      const nextMeta = { ...meta };
      if (nextMeta.start !== null && draftTargets.some((t) => endpointsEqual(t, nextMeta.start!))) nextMeta.start = null;
      if (nextMeta.finish !== null && draftTargets.some((t) => endpointsEqual(t, nextMeta.finish!))) nextMeta.finish = null;

      const postEditDraftTeleports = state.postEditDraftTeleports.filter((t) => !refsTarget(t));
      const postEditDraftVerticalPassages = state.postEditDraftVerticalPassages.filter((p) => !refsTarget(p));
      const postEditDraftElevators = state.postEditDraftElevators.filter((e) => !e.floors.some(endpointRefsTarget));

      const postEditSuppressedVerticalPassagePairs = new Set(state.postEditSuppressedVerticalPassagePairs);
      for (const e of state._generatedEdges) {
        if (e.kind !== "vertical_passage") continue;
        if (!pointNodeIds.has(e.from) && !pointNodeIds.has(e.to)) continue;
        const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
        postEditSuppressedVerticalPassagePairs.add(`${a},${b}`);
      }

      const elevatorComponentIds = elevatorComponent(state._generatedEdges, pointNodeIds);
      const postEditSuppressedElevatorPairs = new Set(state.postEditSuppressedElevatorPairs);
      for (const e of state._generatedEdges) {
        if (e.kind !== "elevator") continue;
        if (!elevatorComponentIds.has(e.from) && !elevatorComponentIds.has(e.to)) continue;
        const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
        postEditSuppressedElevatorPairs.add(`${a},${b}`);
      }

      return {
        postEditDraftMeta: nextMeta,
        postEditDraftTeleports,
        postEditDraftVerticalPassages,
        postEditDraftElevators,
        postEditSuppressedVerticalPassagePairs,
        postEditSuppressedElevatorPairs,
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
      const level = activeFloorLevel(state);
      const { splitPoints, slotId } = addSlot(state.postEditDraftSplitPoints, point, level);
      const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
      return {
        postEditDraftSplitPoints: splitPoints,
        postEditActiveSplitNode: { ...state.postEditActiveSplitNode, [key]: splitEndpoint(point, slotId, level) },
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removeSplitNode: (point, slotId) => {
    const state = get();
    const level = activeFloorLevel(state);
    const target = splitEndpoint(point, slotId, level);

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
        (entry, point, slotId) => entry.kind === "split" && endpointsEqual(entry, splitEndpoint(point, slotId, level)),
        level,
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
    set((state) => {
      const level = activeFloorLevel(state);
      return {
        postEditActiveSplitNode: cycleActive(
          state.postEditDraftSplitPoints, state.postEditActiveSplitNode, point,
          (p, slotId) => splitEndpoint(p, slotId, level), (entry) => (entry && entry.kind === "split" ? entry.slotId : undefined),
          level,
        ),
      };
    });
  },

  setActiveSplitNode: (point, endpoint) => {
    set((state) => ({
      postEditActiveSplitNode: setActive(state.postEditActiveSplitNode, point, endpoint, (e) => e.kind === "node", activeFloorLevel(state)),
    }));
  },

  setPostEditFocusedPoint: (point) => set({ postEditFocusedPoint: point }),
  setPostEditHoveredLink: (link) => set({ postEditHoveredLink: link }),

  rotateSplitPoint: (point, direction) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      const level = activeFloorLevel(state);
      const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
      const slotIds = state.postEditDraftSplitPoints[key] ?? [];
      const field = activeFloorField(state);
      const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeTessellationConfig);
      const cellSet = buildCellSet(cells);
      const floorNodes = state.nodes.filter((n) => (n.level ?? 0) === (level ?? 0));
      const rotated = rotatePostEditSplitPoint(
        state.postEditDraftEdges, point, slotIds, direction, state.activeTessellationConfig,
        cellSet, floorNodes, state.postEditActiveSplitNode, level,
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
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const meta = state.postEditDraftMeta;
    const originalId = state.nodes.find((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0))?.id;
    const originalEndpoint: PostEditEndpoint | null = originalId !== undefined ? nodeEndpoint(originalId) : null;
    // Every node currently at this point — original plus every declared slot — is about to have
    // its faces fully rebuilt by the blueprint; bail out if start/finish still addresses any of
    // them, same guard as a manual `removeSplitNode` (reassign first).
    const existingSlots = state.postEditDraftSplitPoints[key] ?? [];
    const existingNodeEndpoints: PostEditEndpoint[] = [
      ...(originalEndpoint ? [originalEndpoint] : []),
      ...existingSlots.map((slotId) => splitEndpoint(point, slotId, level)),
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
      const slotEndpoints: PostEditEndpoint[] = blueprint.nodeFaces.slice(1).map((_, i) => splitEndpoint(point, i, level));
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
          for (const n of state.nodes) if (n.x === neighbor[0] && n.y === neighbor[1] && (n.level ?? 0) === (level ?? 0)) neighborIds.push(n.id);
          const neighborKey = level === undefined ? `${neighbor[0]},${neighbor[1]}` : `${neighbor[0]},${neighbor[1]}@${level}`;
          // The neighbor's real connecting node — not just its active UI slot (GitHub issue #243).
          // Resolved against the pre-cleanup snapshot (`state.postEditDraftEdges`) and `point`'s
          // *old* (pre-blueprint) endpoints: any pre-existing neighbor edge was recorded against
          // one of those, never against `endpoint` (a fresh node this call is about to mint).
          const neighborPartner = resolvePostEditPartnerAt(
            existingNodeEndpoints, neighbor, neighborIds, state.postEditDraftEdges ?? {}, state.postEditDraftSplitPoints[neighborKey] ?? [], nextActiveSplitNode, level,
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

  startPostEditVerticalPassagePlacement: (origin, tool) => {
    const state = get();
    if (origin.kind !== "node") return;
    const originNode = state.nodes.find((n) => n.id === origin.id);
    if (!originNode) return;
    // `PostEditController`'s hit-test (`pickPostEditVerticalPassageEndpointAt`) only drags/cycles a
    // draft passage when the click lands within an endpoint marker's own hit radius, and it only
    // searches `postEditDraftVerticalPassages` — so every other click on a vertical-passage tool
    // reaches here: a plain new placement, a click on a node with only a *generation-time* passage
    // edge, and (GitHub issue #491) a click elsewhere in the same cell as an existing draft passage,
    // which resolves to the same `origin` node the marker would.
    //
    // Two guards keep this from stacking a duplicate directed edge that would resolve as two-way on
    // the next confirm regardless of either entry's own direction:
    //  1. the seed branch just below — a generation-time edge with no draft entry yet seeds one from
    //     its own direction instead of a fresh passage on top of it (same "edit, don't duplicate"
    //     fix `startPostEditElevatorPlacement` has for generation-time elevators);
    //  2. the direction-aware create path further down (`draftEntryFor`) — a direction already
    //     covered by *any* draft entry (still pre-confirm, or its edge already echoed into
    //     `state.edges` by an auto-confirm) is cycled/skipped rather than re-placed.
    const generatedPartnerIds = new Set<number>();
    for (const e of state.edges) {
      if (e.kind !== "vertical_passage") continue;
      if (e.from === origin.id) generatedPartnerIds.add(e.to);
      else if (e.to === origin.id) generatedPartnerIds.add(e.from);
    }
    // Seed branch (guard 1). Scoped to the specific *partner*, not "any draft touching origin": a
    // point can hold two independent vertical passages (one up, one down), so a partner that already
    // has a draft entry is skipped here and handled by guard 2 instead.
    const partnerId = [...generatedPartnerIds].find((id) =>
      findPostEditVerticalPassageForPair(state.postEditDraftVerticalPassages, origin.id, id) === undefined);
    if (partnerId !== undefined) {
      const forwardExists = state.edges.some((e) =>
        e.kind === "vertical_passage" && e.from === origin.id && e.to === partnerId);
      const reverseExists = state.edges.some((e) =>
        e.kind === "vertical_passage" && e.from === partnerId && e.to === origin.id);
      const direction: "forward" | "backward" | "two_way" =
        forwardExists && reverseExists ? "two_way" : forwardExists ? "forward" : "backward";
      const entry: PostEditVerticalPassageEntry = {
        id: state._nextPostEditVerticalPassageId,
        from: origin,
        to: nodeEndpoint(partnerId),
        direction,
      };
      const [a, b] = [origin.id, partnerId].sort((x, y) => x - y);
      set((state) => ({
        postEditDraftVerticalPassages: [...state.postEditDraftVerticalPassages, entry],
        _nextPostEditVerticalPassageId: state._nextPostEditVerticalPassageId + 1,
        postEditSuppressedVerticalPassagePairs: new Set(state.postEditSuppressedVerticalPassagePairs).add(`${a},${b}`),
        postEditDirty: true,
      }));
      if (get().postEditAutoConfirm) {
        void get().confirmPostEdit();
      }
      return;
    }
    const originLevel = originNode.level ?? 0;
    const resolveFieldAt = resolveFieldAtOf(state);
    const point: [number, number] = [originNode.x, originNode.y];
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) return;
    // Direction-aware create path (guard 2, GitHub issue #491). This click could place a passage in
    // each of `availableDirections`; for any direction already covered by a draft entry (still
    // pre-confirm in `postEditDraftVerticalPassages`, or its edge already echoed into `state.edges`
    // by an auto-confirm), adding a fresh one would mint a *second* entry for the same pair, which
    // then reads as two-way on the next confirm regardless of either entry's own direction. Resolve
    // the partner node per direction and reuse the seed branch's own node-id pair lookup.
    const draftEntryFor = (direction: "up" | "down") => {
      const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
      const toNode = state.nodes.find((n) => n.x === originNode.x && n.y === originNode.y && (n.level ?? 0) === toLevel);
      if (!toNode) return undefined;
      return findPostEditVerticalPassageForPair(state.postEditDraftVerticalPassages, origin.id, toNode.id);
    };
    const directionEntries = availableDirections.map((d) => [d, draftEntryFor(d)] as const);
    const freeDirections = directionEntries.filter(([, entry]) => entry === undefined).map(([d]) => d);
    if (freeDirections.length === 0) {
      // Every direction this click could place is already drafted. One direction → cycle that
      // entry, mirroring the marker-click path (a one-way passage flips, a two-way stays). Two →
      // the cell click can't disambiguate which passage to cycle, so it's a no-op rather than a
      // guess or a duplicate; the user can still use the markers themselves.
      if (directionEntries.length === 1 && directionEntries[0][1]) {
        get().cyclePostEditVerticalPassageDirection(directionEntries[0][1].id);
      }
      return;
    }
    if (freeDirections.length === 1) {
      commitPostEditVerticalPassage(get, set, origin, tool, freeDirections[0]);
      return;
    }
    set({ postEditVerticalPassagePending: { origin, tool, availableDirections: freeDirections } });
  },

  choosePostEditVerticalPassageDirection: (direction) => {
    const pending = get().postEditVerticalPassagePending;
    if (!pending) return;
    commitPostEditVerticalPassage(get, set, pending.origin, pending.tool, direction);
  },

  cancelPostEditVerticalPassagePlacement: () => set({ postEditVerticalPassagePending: null }),

  cyclePostEditVerticalPassageDirection: (id) => {
    set((state) => {
      const target = state.postEditDraftVerticalPassages.find((p) => p.id === id);
      // Suppress this pair's own generation-time edge unconditionally, not just on first edit — a
      // draft entry already confirmed once has its own edges resting in `state.edges` by now too
      // (every confirm folds the WASM snapshot's edges back), so a *second* direction cycle on an
      // already-confirmed draft entry needs the same suppression the first one already added,
      // mirrors `startPostEditElevatorPlacement`'s own re-edit doc comment for why this can't be
      // "only on first edit".
      const suppressed = new Set(state.postEditSuppressedVerticalPassagePairs);
      if (target && target.from.kind === "node" && target.to.kind === "node") {
        const [a, b] = [target.from.id, target.to.id].sort((x, y) => x - y);
        suppressed.add(`${a},${b}`);
      }
      return {
        postEditDraftVerticalPassages: cyclePostEditVerticalPassageDirection(state.postEditDraftVerticalPassages, id),
        postEditSuppressedVerticalPassagePairs: suppressed,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditVerticalPassage: (id) => {
    set((state) => ({
      postEditDraftVerticalPassages: removePostEditVerticalPassage(state.postEditDraftVerticalPassages, id),
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditVerticalPassageEndpoint: (id, end, endpoint) => {
    set((state) => {
      const target = state.postEditDraftVerticalPassages.find((p) => p.id === id);
      const suppressed = new Set(state.postEditSuppressedVerticalPassagePairs);
      // Suppress both the pair's old node ids (its previous confirm's own edge, now stale) and its
      // new ones (this move's own edge, about to be confirmed) — same rationale as
      // `cyclePostEditVerticalPassageDirection`'s own doc comment.
      if (target && target.from.kind === "node" && target.to.kind === "node") {
        const [a, b] = [target.from.id, target.to.id].sort((x, y) => x - y);
        suppressed.add(`${a},${b}`);
      }
      if (endpoint.kind === "node") {
        const otherEnd = end === "from" ? target?.to : target?.from;
        if (otherEnd && otherEnd.kind === "node") {
          const [a, b] = [endpoint.id, otherEnd.id].sort((x, y) => x - y);
          suppressed.add(`${a},${b}`);
        }
      }
      return {
        postEditDraftVerticalPassages: movePostEditVerticalPassageEndpoint(state.postEditDraftVerticalPassages, { id, end }, endpoint),
        postEditSuppressedVerticalPassagePairs: suppressed,
        postEditDirty: true,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  startPostEditElevatorPlacement: (origin) => {
    if (origin.kind !== "node") return;
    const state = get();
    const originNode = state.nodes.find((n) => n.id === origin.id);
    if (!originNode) return;
    // Clicking an existing elevator's own marker edits that entry instead of creating a second one
    // — `floors` seeds from its actual current floors so the dialog reflects real state (GitHub
    // issue #341 follow-up). An elevator can come from two sources: a user-placed draft entry
    // (`postEditDraftElevators`, addressed by its own PostEditEndpoints) or a generation-time one,
    // confirmed into the graph as a full mesh of bidirectional `elevator` edges in `state.edges`
    // (no separate entry object to look up — its "floors" are just every node reachable from
    // `origin.id` via `elevator` edges, i.e. `origin.id`'s own connected component).
    const originLevel = originNode.level ?? 0;
    const existingDraft = state.postEditDraftElevators.find((e) => e.floors.some((f) =>
      f.kind === "node" && f.id === origin.id));
    if (existingDraft) {
      const floors = new Set<number>();
      const sourceNodeIds: number[] = [];
      for (const f of existingDraft.floors) {
        if (f.kind !== "node") continue;
        const n = state.nodes.find((nd) => nd.id === f.id);
        if (n) floors.add(n.level ?? 0);
        sourceNodeIds.push(f.id);
      }
      // A draft entry already confirmed once has its own edges resting in `state.edges` too (every
      // confirm's WASM snapshot folds every edge kind, including a just-confirmed draft elevator's,
      // back into `state.edges`) — from that point on, `generatedVerticalEdges` in `confirmPostEdit`
      // treats them exactly like any other generation-time mesh and keeps resending them regardless
      // of `editingId`. `sourceNodeIds` must be captured here too (not only in the generation-time
      // branch below) so a re-edit of an already-confirmed draft elevator suppresses its own stale
      // mesh the same way — otherwise a floor removed from `floors` would still show its old marker,
      // resurrected from `state.edges` on the very next confirm.
      set({ postEditElevatorPending: { origin, floors, editingId: existingDraft.id, sourceNodeIds } });
      return;
    }
    const generatedFloorIds = elevatorComponent(state.edges, [origin.id]);
    if (generatedFloorIds.size >= 2) {
      const floors = new Set<number>();
      for (const id of generatedFloorIds) {
        const n = state.nodes.find((nd) => nd.id === id);
        if (n) floors.add(n.level ?? 0);
      }
      // No `editingId` — a generation-time elevator has no `PostEditElevatorEntry` of its own to
      // update; `sourceNodeIds` records which nodes the original mesh connected so
      // `confirmPostEditElevatorPlacement` can suppress those generation-time edges once the edit
      // is confirmed (otherwise the old mesh would keep coexisting with the new draft entry, and a
      // floor the user un-checked would still show a marker via the still-resent generation edge).
      set({ postEditElevatorPending: { origin, floors, sourceNodeIds: Array.from(generatedFloorIds) } });
      return;
    }
    set({ postEditElevatorPending: { origin, floors: new Set([originLevel]) } });
  },

  togglePostEditElevatorFloor: (floorIndex) => {
    set((state) => {
      const pending = state.postEditElevatorPending;
      if (!pending || pending.origin.kind !== "node") return {};
      const originId = pending.origin.id;
      const originNode = state.nodes.find((n) => n.id === originId);
      const originLevel = originNode?.level ?? 0;
      if (floorIndex === originLevel) return {};
      const floors = new Set(pending.floors);
      if (floors.has(floorIndex)) floors.delete(floorIndex);
      else floors.add(floorIndex);
      return { postEditElevatorPending: { ...pending, floors } };
    });
  },

  confirmPostEditElevatorPlacement: () => {
    const state = get();
    const pending = state.postEditElevatorPending;
    if (!pending || pending.floors.size < 2 || pending.origin.kind !== "node") return;
    const originId = pending.origin.id;
    const originNode = state.nodes.find((n) => n.id === originId);
    if (!originNode) return;
    const point: [number, number] = [originNode.x, originNode.y];
    // Every selected floor resolves to that floor's own original node at `point` — mirrors
    // `confirmPresetElevatorPlacement`, addressed by `PostEditEndpoint` (node id) instead of a
    // `PresetEndpoint` (cell + level).
    const floors: PostEditEndpoint[] = [];
    for (const level of Array.from(pending.floors).sort((a, b) => a - b)) {
      const node = state.nodes.find((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === level);
      if (node) floors.push(nodeEndpoint(node.id));
    }
    if (floors.length < 2) return;
    const editingId = pending.editingId;
    const sourceNodeIds = pending.sourceNodeIds;
    set((state) => {
      const suppressed = new Set(state.postEditSuppressedElevatorPairs);
      if (sourceNodeIds) {
        // Every pair the elevator's *previous* confirmed state connected (whether that came from
        // generation or an earlier post-edit confirm — either way its own edges already rest in
        // `state.edges` by now) must stop being resent from `state.edges` on every future confirm,
        // or the old mesh would keep coexisting with (and outliving) this edit's new floors set,
        // silently re-adding a floor the user just un-checked.
        for (let i = 0; i < sourceNodeIds.length; i++) {
          for (let j = i + 1; j < sourceNodeIds.length; j++) {
            const [a, b] = [sourceNodeIds[i], sourceNodeIds[j]].sort((x, y) => x - y);
            suppressed.add(`${a},${b}`);
          }
        }
      }
      return {
        postEditDraftElevators: editingId !== undefined
          ? state.postEditDraftElevators.map((e) => e.id === editingId ? { ...e, floors } : e)
          : [...state.postEditDraftElevators, { id: state._nextPostEditElevatorId, floors } as PostEditElevatorEntry],
        _nextPostEditElevatorId: editingId !== undefined ? state._nextPostEditElevatorId : state._nextPostEditElevatorId + 1,
        postEditElevatorPending: null,
        postEditDirty: true,
        postEditSuppressedElevatorPairs: suppressed,
      };
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cancelPostEditElevatorPlacement: () => set({ postEditElevatorPending: null }),

  removePostEditElevator: (id) => {
    set((state) => ({
      postEditDraftElevators: removePostEditElevator(state.postEditDraftElevators, id),
      postEditDirty: true,
    }));
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  requestPostEditSplitTarget: (prompt) => set({ postEditSplitTargetPrompt: prompt }),

  cancelPostEditSplitTarget: () => set({ postEditSplitTargetPrompt: null }),

  applyPostEditSplitTargetPick: (nodeId) => {
    const prompt = get().postEditSplitTargetPrompt;
    if (!prompt) return;
    set({ postEditSplitTargetPrompt: null });
    const endpoint = nodeEndpoint(nodeId);
    const { action } = prompt;
    switch (action.tool) {
      case "set_start":
        get().setPostEditEndpoint("start", endpoint);
        break;
      case "set_finish":
        get().setPostEditEndpoint("finish", endpoint);
        break;
      case "vertical_passage_one_way":
      case "vertical_passage_two_way":
        get().startPostEditVerticalPassagePlacement(endpoint, action.tool);
        break;
      case "elevator":
        get().startPostEditElevatorPlacement(endpoint);
        break;
      case "teleport_one_way":
      case "teleport_two_way": {
        // Same two-click machine as `PostEditController.tryTeleportClick`, driven by node id: first
        // pick sets the pending origin, second pick (a different node) completes the link.
        const pendingFrom = get().postEditTeleportPendingFrom;
        if (pendingFrom === null) {
          get().setPostEditTeleportPendingFrom(nodeId);
        } else if (pendingFrom !== nodeId) {
          get().addPostEditTeleport(
            nodeEndpoint(pendingFrom),
            endpoint,
            action.tool === "teleport_two_way" ? "two_way" : "forward",
          );
        }
        break;
      }
    }
  },
});
