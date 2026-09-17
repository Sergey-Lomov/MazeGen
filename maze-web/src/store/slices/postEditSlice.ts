import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto } from "../../wasm/types";
import {
  postEditTeleportsToDto,
  rotateSplitPointMoves,
  findPostEditVerticalPassageForPair,
  postEditVerticalToDto, elevatorComponent, pruneRemovedSplitNodes,
} from "../../pixi/postEditUtils";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { presetEndpointToDto } from "../../pixi/presetEndpoint";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
  edgeKey, resolvePostEditPartnerAt,
} from "../../pixi/postEditEndpoint";
import { cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type {
  MazeStore, PostEditState, PostEditActions, PostEditTool, PostEditTeleportEntry,
  PostEditVerticalPassageEntry, PostEditElevatorEntry,
} from "../storeTypes";
import type { PostEditCommand, ResolvedSplitEdgeFace, ResolvedSplitFace, ResolvedSplitSlot } from "../postEditCommandTypes";
import type { PostEditEdge } from "../postEditTypes";
import { filterCommandsForPoint, suppressionPairKey } from "../../pixi/postEditReplay";
import { fieldConfigToWasm, buildValidPresetConnections } from "./generationSlice";
import { ruleStrategyToConfig } from "./generateConfigBuilder";
import { relevantRuleParams, activeFloorField, activeFloorLevel, floorTessellationOf, resolveFieldAtOf } from "../storeHelpers";
import { configAllCells } from "../../pixi/tessellationCells";
import {
  toWasmEndpoint, buildMultiFloorPointNodeMap, commitPostEditVerticalPassage,
  buildPostEditBaseline, appendPostEditCommand, replacePostEditCommands,
  derivedStateToLegacyFields as legacyFieldsFor,
} from "./postEditSliceHelpers";

/** Every face currently wired on `target` (a split node's own endpoint), read from live
 * `postEditDraftEdges` and grouped one entry per distinct neighbor — the starting point
 * `applyPostEditToolAt` upserts a single clicked face into before re-emitting the slot's full
 * `updateSplitNodeFaces` list (GitHub issue #545). A neighbor with no edge at all in either
 * direction never appears here (both directions read back as `"wall"`, so there is nothing to
 * record) — same "absence is wall" convention every other post-edit edge lookup uses. */
function currentSplitNodeFaces(edges: Record<string, PostEditEdge>, target: PostEditEndpoint): ResolvedSplitEdgeFace[] {
  const byNeighbor = new Map<string, ResolvedSplitEdgeFace>();
  for (const e of Object.values(edges)) {
    const isFrom = endpointsEqual(e.from, target);
    const isTo = endpointsEqual(e.to, target);
    if (!isFrom && !isTo) continue;
    const neighbor = isFrom ? e.to : e.from;
    const nKey = edgeKey(neighbor, target);
    const face = byNeighbor.get(nKey) ?? { neighbor, toNeighbor: "wall" as const, fromNeighbor: "wall" as const };
    if (isFrom) face.toNeighbor = e.kind; else face.fromNeighbor = e.kind;
    byNeighbor.set(nKey, face);
  }
  return [...byNeighbor.values()];
}

export const createPostEditSlice: StateCreator<MazeStore, [], [], PostEditState & PostEditActions> = (set, get) => ({
  postEditAutoConfirm: true,
  postEditTool: "wall" as PostEditTool,
  postEditCommands: [] as PostEditCommand[],
  postEditBaseline: null,
  postEditDerived: null,
  postEditDraftEdges: null,
  postEditDraftTeleports: [] as PostEditTeleportEntry[],
  postEditTeleportPendingFrom: null,
  _nextPostEditTeleportId: 1,
  postEditDraftMeta: null,
  postEditDraftSplitPoints: {},
  _nextSplitSlotId: {},
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
  postEditChangesOpen: false,
  postEditDragOverride: null,

  setPostEditAutoConfirm: (v) => set({ postEditAutoConfirm: v }),
  setPostEditTool: (tool) => set({ postEditTool: tool }),

  applyPostEditTool: (edgeKey, from_, to_) => {
    get().applyPostEditToolAt(get().postEditTool, edgeKey, from_, to_);
  },

  applyPostEditToolAt: (tool, _edgeKeyStr, from_, to_) => {
    const state = get();
    if (state.postEditBaseline === null) return;
    // `tool` (wall/passage/one_way/reset) is resolved to the resulting edge kind once here, reading
    // live `postEditDraftEdges`/`_generatedEdges` exactly as `applyPostEditEdgeTool` used to inline
    // — the command itself only ever carries the *result* (`setEdge`'s `edgeKind`), replay recomputes
    // nothing conditionally (GitHub issue #543 plan section 2).
    const currentEdges = state.postEditDraftEdges ?? {};
    const fwdKey = edgeKey(from_, to_);
    const fromId = from_.kind === "node" ? from_.id : undefined;
    const toId = to_.kind === "node" ? to_.id : undefined;
    let aToB: "wall" | "basic" | "one_way_forward";
    let bToA: "wall" | "basic" | "one_way_forward";
    if (tool === "reset") {
      const origAB = state._generatedEdges.some((e) => e.from === fromId && e.to === toId);
      const origBA = state._generatedEdges.some((e) => e.from === toId && e.to === fromId);
      if (origAB && origBA) { aToB = "basic"; bToA = "basic"; }
      else if (origAB) { aToB = "one_way_forward"; bToA = "wall"; }
      else if (origBA) { aToB = "wall"; bToA = "one_way_forward"; }
      else { aToB = "wall"; bToA = "wall"; }
    } else if (tool === "wall") {
      aToB = "wall"; bToA = "wall";
    } else if (tool === "passage") {
      aToB = "basic"; bToA = "basic";
    } else if (tool === "one_way") {
      if (currentEdges[fwdKey] !== undefined) { aToB = "wall"; bToA = "one_way_forward"; }
      else { aToB = "one_way_forward"; bToA = "wall"; }
    } else {
      return;
    }

    // A face touching a split node's own slot (GitHub issue #545) is recorded as a fresh
    // `updateSplitNodeFaces` command carrying that slot's FULL current face list, not a
    // `setEdgePair` targeting just the clicked face — one click reconfiguring one face of a split
    // node is still "reconfigure this slot's wiring", the same one-entity-one-lifeline treatment
    // `updateElevatorFloors` gives a lift's floor edit. Neither side being a split endpoint falls
    // through to the plain `setEdgePair` two-node case below.
    const splitSide = from_.kind === "split" ? from_ : to_.kind === "split" ? to_ : null;
    if (splitSide) {
      const neighbor = from_.kind === "split" ? to_ : from_;
      const toNeighbor = from_.kind === "split" ? aToB : bToA;
      const fromNeighbor = from_.kind === "split" ? bToA : aToB;
      const key = splitSide.level === undefined ? `${splitSide.point[0]},${splitSide.point[1]}` : `${splitSide.point[0]},${splitSide.point[1]}@${splitSide.level}`;
      if (!(state.postEditDraftSplitPoints[key] ?? []).includes(splitSide.slotId)) return;
      const target = splitEndpoint(splitSide.point, splitSide.slotId, splitSide.level);
      const faces = currentSplitNodeFaces(currentEdges, target).filter((f) => !endpointsEqual(f.neighbor, neighbor));
      if (toNeighbor !== "wall" || fromNeighbor !== "wall") faces.push({ neighbor, toNeighbor, fromNeighbor });
      appendPostEditCommand(get, set, {
        kind: "updateSplitNodeFaces", point: splitSide.point, level: splitSide.level, slotId: splitSide.slotId, faces,
      });
    } else {
      appendPostEditCommand(get, set, { kind: "setEdgePair", a: from_, b: to_, aToB, bToA });
    }
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
        // Suppression pairs are keyed by `PostEditEndpoint` (see `suppressGenerationPair`), not
        // raw node ids — reuse the same key builder so a generation-time node-to-node pair looks
        // itself up correctly.
        const key = suppressionPairKey(nodeEndpoint(e.from), nodeEndpoint(e.to));
        if (e.kind === "elevator") return !state.postEditSuppressedElevatorPairs.has(key);
        return !state.postEditSuppressedVerticalPassagePairs.has(key);
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
        // Real user-configured strategy weights (e.g. `scored_endpoints`), GitHub issue #532 —
        // this path never dispatches repair, but the wasm side still reads `strategy` directly to
        // compute the route score from the project's actual weights instead of defaults.
        const strategy = ruleStrategyToConfig(state, g);
        return {
          checks: activeChecks.map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params })),
          params,
          ...(strategy ? { strategy } : {}),
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
      // GitHub issue #376 follow-up: a start/finish pinned by a preset marker can't be moved by
      // repair, so a `start`/`finish` element of a flagged cross-element group must be flagged
      // `preset_locked`. Sent unfiltered (same contract as `preset_connections` above — the Rust
      // side silently skips a marker it can't resolve against the rebuilt field).
      ...(state.presetStart ? { preset_start: presetEndpointToDto(state.presetStart) } : {}),
      ...(state.presetFinish ? { preset_finish: presetEndpointToDto(state.presetFinish) } : {}),
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
      // Rebuilds the baseline from `_generatedNodes`/`_generatedEdges` (not `state.nodes`/
      // `state.edges`, which `confirmPostEdit` overwrites — GitHub issue #323) at the *same*
      // revision — a plain reset is not a new generation. Command log becomes empty
      // (`replacePostEditCommands([], dirty=false)`, GitHub issue #543 plan section 9's trivial
      // "reset all" case) — every user-created entity disappears, every user-edited generation
      // entity reverts, every user-deleted one is restored, matching the plan's reset-semantics
      // table (section 10).
      const revision = state.postEditBaseline?.revision ?? 0;
      const baseline = buildPostEditBaseline(
        state._generatedNodes, state._generatedEdges, revision, state._generatedStart, state._generatedFinish,
      );
      return {
        nodes: state._generatedNodes,
        edges: state._generatedEdges,
        postEditBaseline: baseline,
        postEditDerived: baseline.derived,
        postEditCommands: [] as PostEditCommand[],
        ...legacyFieldsFor(baseline.derived),
        // Restored generation-time teleports occupy ids 1..N (see `buildMultiFloorPostEditDraft`'s
        // renumbering) — the next user-created one must start past them, not collide (#363).
        _nextPostEditTeleportId: baseline.derived.teleports.length + 1,
        postEditTeleportPendingFrom: null,
        _nextSplitSlotId: {},
        postEditActiveSplitNode: {},
        postEditFocusedPoint: null,
        postEditEdges: null,
        postEditTeleportEdges: [],
        postEditMeta: null,
        postEditAnalytics: null,
        postEditTool: "wall" as PostEditTool,
        postEditDirty: false,
        postEditVerticalPassagePending: null,
        _nextPostEditVerticalPassageId: 1,
        postEditElevatorPending: null,
        _nextPostEditElevatorId: 1,
        postEditSplitTargetPrompt: null,
      };
    });
    void get().confirmPostEdit();
  },

  resetPostEditPoint: (point) => {
    const state = get();
    if (state.postEditBaseline === null) return;
    const level = activeFloorLevel(state);
    // Fixed-point cascade pruning (GitHub issue #543 plan section 9) — removes every command whose
    // lifeline currently touches `point`/`level`, including a prior `deletePoint` at this point
    // (restoring anything it removed) and any command transitively depending on a removed split
    // slot. `postEditActiveSplitNode` (ephemeral UI state, not in the log) is cleared for this
    // point directly, mirroring the old code's own `activeSplitNode` reset.
    const filtered = filterCommandsForPoint(state.postEditBaseline, state.postEditCommands, point, level);
    replacePostEditCommands(get, set, filtered, true);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    set((state) => {
      const nextActive = { ...state.postEditActiveSplitNode };
      delete nextActive[key];
      return { postEditActiveSplitNode: nextActive };
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
   * Appends one command per removed entity (`setMeta`/`removeTeleport`/`removeVerticalPassage`/
   * `removeElevator`/`suppressGenerationPair`) rather than a single bundled `deletePoint` command
   * (GitHub issue #545) — each removal gets its own lifeline (`lifelineKeyOf` in
   * `postEditReplay.ts`), so the "Changes" panel lists them as separate entries and a later
   * `resetPostEditPoint` still undoes every one of them via the ordinary per-lifeline cascade, no
   * dedicated `deletePoint` lifeline needed.
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
    const state = get();
    if (state.postEditBaseline === null || state.postEditDerived === null) return;
    const level = activeFloorLevel(state);
    const { context } = state.postEditBaseline;
    const derived = state.postEditDerived;

    const pointNodeIds = new Set(
      context.nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0)).map((n) => n.id),
    );
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const draftTargets: PostEditEndpoint[] = [
      ...[...pointNodeIds].map((id) => nodeEndpoint(id)),
      ...(derived.splitPoints[key] ?? []).map((slotId) => splitEndpoint(point, slotId, level)),
    ];
    const endpointRefsTarget = (ep: PostEditEndpoint) => draftTargets.some((t) => endpointsEqual(ep, t));
    const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
      endpointRefsTarget(e.from) || endpointRefsTarget(e.to);

    if (derived.meta.start !== null && endpointRefsTarget(derived.meta.start)) {
      appendPostEditCommand(get, set, { kind: "setMeta", slot: "start", endpoint: null });
    }
    if (derived.meta.finish !== null && endpointRefsTarget(derived.meta.finish)) {
      appendPostEditCommand(get, set, { kind: "setMeta", slot: "finish", endpoint: null });
    }
    for (const t of derived.teleports) {
      if (refsTarget(t)) appendPostEditCommand(get, set, { kind: "removeTeleport", id: t.id });
    }
    for (const p of derived.verticalPassages) {
      if (refsTarget(p)) appendPostEditCommand(get, set, { kind: "removeVerticalPassage", id: p.id });
    }
    for (const e of derived.elevators) {
      if (e.floors.some(endpointRefsTarget)) appendPostEditCommand(get, set, { kind: "removeElevator", id: e.id });
    }

    for (const e of context.edges) {
      if (e.kind !== "vertical_passage") continue;
      if (!pointNodeIds.has(e.from) && !pointNodeIds.has(e.to)) continue;
      const a = nodeEndpoint(e.from);
      const b = nodeEndpoint(e.to);
      if (get().postEditDerived!.suppressedVerticalPassagePairs.has(suppressionPairKey(a, b))) continue;
      appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "verticalPassage", a, b });
    }
    const elevatorComponentIds = elevatorComponent(context.edges, pointNodeIds);
    for (const e of context.edges) {
      if (e.kind !== "elevator") continue;
      if (!elevatorComponentIds.has(e.from) && !elevatorComponentIds.has(e.to)) continue;
      const a = nodeEndpoint(e.from);
      const b = nodeEndpoint(e.to);
      if (get().postEditDerived!.suppressedElevatorPairs.has(suppressionPairKey(a, b))) continue;
      appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "elevator", a, b });
    }

    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  setPostEditEndpoint: (kind, endpoint) => {
    appendPostEditCommand(get, set, { kind: "setMeta", slot: kind, endpoint });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
  clearPostEditEndpoint: (kind) => {
    appendPostEditCommand(get, set, { kind: "setMeta", slot: kind, endpoint: null });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  setPostEditTeleportPendingFrom: (nodeId) => set({ postEditTeleportPendingFrom: nodeId }),

  addPostEditTeleport: (from, to, direction) => {
    const id = get()._nextPostEditTeleportId;
    const applied = appendPostEditCommand(get, set, { kind: "addTeleport", id, from, to, direction });
    if (applied) set({ _nextPostEditTeleportId: id + 1, postEditTeleportPendingFrom: null });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cyclePostEditTeleportDirection: (id) => {
    const target = get().postEditDraftTeleports.find((t) => t.id === id);
    if (!target || target.direction === "two_way") return;
    const direction = target.direction === "forward" ? "backward" : "forward";
    appendPostEditCommand(get, set, { kind: "setTeleportDirection", id, direction });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditTeleport: (id) => {
    appendPostEditCommand(get, set, { kind: "removeTeleport", id });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditTeleportEndpoint: (id, end, endpoint) => {
    appendPostEditCommand(get, set, { kind: "moveTeleportEndpoint", id, end, endpoint });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  addSplitNode: (point) => {
    const state = get();
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotId = state._nextSplitSlotId[key] ?? 0;
    const applied = appendPostEditCommand(get, set, { kind: "addSplitNode", point, level, slotId });
    if (applied) {
      set((state) => ({
        _nextSplitSlotId: { ...state._nextSplitSlotId, [key]: slotId + 1 },
        postEditActiveSplitNode: { ...state.postEditActiveSplitNode, [key]: splitEndpoint(point, slotId, level) },
      }));
    }
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

    const applied = appendPostEditCommand(get, set, { kind: "removeSplitNode", point, level, slotId });
    if (applied) {
      const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
      set((state) => {
        const nextActive = { ...state.postEditActiveSplitNode };
        const current = nextActive[key];
        if (current !== undefined && current.kind === "split" && endpointsEqual(current, target)) delete nextActive[key];
        return { postEditActiveSplitNode: nextActive };
      });
    }
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

  setPostEditFocusedPoint: (point) => set({ postEditFocusedPoint: point, postEditChangesOpen: point !== null ? false : get().postEditChangesOpen }),
  setPostEditHoveredLink: (link) => set({ postEditHoveredLink: link }),

  rotateSplitPoint: (point, direction) => {
    const state = get();
    if (state.postEditDraftEdges === null || state.postEditBaseline === null) return;
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotIds = state.postEditDraftSplitPoints[key] ?? [];
    const field = activeFloorField(state);
    const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeTessellationConfig);
    const cellSet = buildCellSet(cells);
    const floorNodes = state.nodes.filter((n) => (n.level ?? 0) === (level ?? 0));
    const before = state.postEditDraftEdges;
    const moves = rotateSplitPointMoves(
      before, point, slotIds, direction, state.activeTessellationConfig,
      cellSet, floorNodes, state.postEditActiveSplitNode, level,
    );
    if (moves.length === 0) return;
    appendPostEditCommand(get, set, { kind: "rotateSplitPoint", point, level, moves });
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

    // Slot ids are minted from the point's high-water mark (GitHub issue #543 plan section 7), not
    // reused positional indices — a point-reset can prune a previously-issued high slotId out of
    // the log while the mark stays put, so a fresh blueprint apply must not reissue it.
    const nextMark = state._nextSplitSlotId[key] ?? 0;
    const mintedSlotIds = blueprint.nodeFaces.slice(1).map((_, i) => nextMark + i);
    const slotEndpoints: PostEditEndpoint[] = mintedSlotIds.map((slotId) => splitEndpoint(point, slotId, level));
    const nodeEndpoints: PostEditEndpoint[] = [originalEndpoint, ...slotEndpoints].filter((e): e is PostEditEndpoint => e !== null);
    const nextActiveSplitNode = { ...state.postEditActiveSplitNode };
    delete nextActiveSplitNode[key];

    const { offsets } = getNeighborData(state.activeTessellationConfig, point[0], point[1]);
    const field = activeFloorField(state);
    const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeTessellationConfig);
    const inFieldCells = buildCellSet(cells);
    const currentEdges = state.postEditDraftEdges ?? {};

    // Per-blueprint-node face lists, indexed exactly like `nodeEndpoints` (node 0 = original when
    // present) — split into slots-only `resolvedSlots` further down, since the reducer derives
    // `nodeEndpoints` itself from `resolvedSlots` alone (original endpoint is never carried on the
    // command — `postEditReplay.ts`'s `applySplitBlueprint` case re-adds it from `context.nodes`).
    const facesByNode: ResolvedSplitFace[][] = nodeEndpoints.map(() => []);
    // Every one of the blueprint's declared faces gets a `passage` to its in-field neighbor;
    // every other face of the tile is left with no entry at all, which post-edit already reads
    // as `wall` by default — no separate "wall" pass needed. Neighbor resolution happens once
    // here, at construction time, reading live `state.nodes`/`postEditDraftEdges` exactly as the
    // old inline implementation did — replay only ever re-applies the already-picked neighbor.
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
          existingNodeEndpoints, neighbor, neighborIds, currentEdges, state.postEditDraftSplitPoints[neighborKey] ?? [], nextActiveSplitNode, level,
        );
        if (!neighborPartner) continue;
        facesByNode[nodeIndex].push({ faceIndex, neighbor: neighborPartner });
      }
    }
    // `resolvedSlots` carries only the minted slots' faces — the original node's own faces (when
    // present) travel on the same command via `originalFaces` instead (GitHub issue #545):
    // applying a blueprint is one logical action, not one command per minted node plus a `setEdge`
    // pair per original-node face.
    const resolvedSlots: ResolvedSplitSlot[] = mintedSlotIds.map((slotId, i) => ({
      slotId,
      faces: facesByNode[originalEndpoint ? i + 1 : i] ?? [],
    }));
    const originalFaces: ResolvedSplitFace[] | undefined = originalEndpoint ? facesByNode[0] : undefined;

    const applied = appendPostEditCommand(get, set, {
      kind: "applySplitBlueprint", point, level, resolvedSlots, originalFaces, blueprintTitleKey: blueprint.titleKey,
    });
    if (applied) {
      set((state) => ({
        _nextSplitSlotId: { ...state._nextSplitSlotId, [key]: nextMark + mintedSlotIds.length },
        postEditActiveSplitNode: (() => {
          const next = { ...state.postEditActiveSplitNode };
          delete next[key];
          return next;
        })(),
      }));
    }
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
      const id = state._nextPostEditVerticalPassageId;
      const partnerEndpoint = nodeEndpoint(partnerId);
      const applied = appendPostEditCommand(get, set, {
        kind: "addVerticalPassage", id, from: origin, to: partnerEndpoint, direction,
      });
      if (applied) {
        appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "verticalPassage", a: origin, b: partnerEndpoint });
        set((state) => ({ _nextPostEditVerticalPassageId: state._nextPostEditVerticalPassageId + 1 }));
      }
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
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target) return;
    // `direction` here is informational only — the reducer's `setVerticalPassageDirection` case
    // always cycles from whatever direction the log has produced up to that point (replay
    // determinism), it never reads this field. Pass the entry's own current direction as the most
    // meaningful placeholder value.
    appendPostEditCommand(get, set, { kind: "setVerticalPassageDirection", id, direction: target.direction });
    // Suppress this pair's own generation-time edge unconditionally, not just on first edit — a
    // draft entry already confirmed once has its own edges resting in `state.edges` by now too
    // (every confirm folds the WASM snapshot's edges back), so a *second* direction cycle on an
    // already-confirmed draft entry needs the same suppression the first one already added,
    // mirrors `startPostEditElevatorPlacement`'s own re-edit doc comment for why this can't be
    // "only on first edit".
    appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "verticalPassage", a: target.from, b: target.to });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditVerticalPassage: (id) => {
    appendPostEditCommand(get, set, { kind: "removeVerticalPassage", id });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditVerticalPassageEndpoint: (id, end, endpoint) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    appendPostEditCommand(get, set, { kind: "moveVerticalPassageEndpoint", id, end, endpoint });
    // Suppress both the pair's old endpoints (its previous confirm's own edge, now stale) and its
    // new ones (this move's own edge, about to be confirmed) — same rationale as
    // `cyclePostEditVerticalPassageDirection`'s own doc comment.
    if (target) {
      appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "verticalPassage", a: target.from, b: target.to });
      const otherEnd = end === "from" ? target.to : target.from;
      appendPostEditCommand(get, set, { kind: "suppressGenerationPair", entity: "verticalPassage", a: endpoint, b: otherEnd });
    }
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
    // Every pair the elevator's *previous* confirmed state connected (whether that came from
    // generation or an earlier post-edit confirm — either way its own edges already rest in
    // `state.edges` by now) must stop being resent from `state.edges` on every future confirm, or
    // the old mesh would keep coexisting with (and outliving) this edit's new floors set, silently
    // re-adding a floor the user just un-checked. Folded into the elevator command's own
    // `suppressPairs` (GitHub issue #545) rather than appended as separate `suppressGenerationPair`
    // commands — one floor edit is one log entry, not one entry per suppressed mesh pair.
    const suppressPairs: [PostEditEndpoint, PostEditEndpoint][] | undefined = sourceNodeIds && sourceNodeIds.length >= 2
      ? sourceNodeIds.flatMap((a, i) => sourceNodeIds.slice(i + 1).map((b): [PostEditEndpoint, PostEditEndpoint] => [nodeEndpoint(a), nodeEndpoint(b)]))
      : undefined;
    const applied = editingId !== undefined
      ? appendPostEditCommand(get, set, { kind: "updateElevatorFloors", id: editingId, floors, suppressPairs })
      : appendPostEditCommand(get, set, { kind: "addElevator", id: state._nextPostEditElevatorId, floors, suppressPairs });
    if (applied) {
      if (editingId === undefined) {
        set((state) => ({ _nextPostEditElevatorId: state._nextPostEditElevatorId + 1 }));
      }
      set({ postEditElevatorPending: null });
    }
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cancelPostEditElevatorPlacement: () => set({ postEditElevatorPending: null }),

  removePostEditElevator: (id) => {
    appendPostEditCommand(get, set, { kind: "removeElevator", id });
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

  setPostEditChangesOpen: (open) => set({ postEditChangesOpen: open, postEditFocusedPoint: open ? null : get().postEditFocusedPoint }),

  setPostEditDragOverride: (override) => set({ postEditDragOverride: override }),
});
