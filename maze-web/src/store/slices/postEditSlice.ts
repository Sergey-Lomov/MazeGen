import type { StateCreator } from "zustand";
import { computeAnalytics } from "../../wasm/mazeService";
import type { PostEditEdgeWasmDto } from "../../wasm/types";
import {
  postEditTeleportsToDto,
  rotateSplitPointMoves,
  findPostEditVerticalPassageForPair,
  postEditVerticalToDto, pruneRemovedSplitNodes,
} from "../../pixi/postEditUtils";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { presetEndpointToDto } from "../../pixi/presetEndpoint";
import {
  type PostEditEndpoint, type PostEditHoveredEntity, nodeEndpoint, splitEndpoint, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
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
import type { PostEditEdge, PostEditEdgeState } from "../postEditTypes";
import { filterCommandsForPoint } from "../../pixi/postEditReplay";
import { fieldConfigToWasm, buildValidPresetConnections } from "./generationSlice";
import { ruleStrategyToConfig } from "./generateConfigBuilder";
import { relevantRuleParams, activeFloorField, activeFloorLevel, floorTessellationOf, resolveFieldAtOf } from "../storeHelpers";
import { configAllCells } from "../../pixi/tessellationCells";
import {
  toWasmEndpoint, buildMultiFloorPointNodeMap, commitPostEditVerticalPassage,
  buildPostEditBaseline, appendPostEditCommand, replacePostEditCommands,
  derivedStateToLegacyFields as legacyFieldsFor, resolveActiveNodeIdAt, nextPostEditIdCounters,
} from "./postEditSliceHelpers";
import { formatPostEditId } from "../../pixi/postEditIdFormat";

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
    const face = byNeighbor.get(nKey) ?? {
      neighbor,
      toNeighbor: { kind: "wall" as const, from: target, to: neighbor },
      fromNeighbor: { kind: "wall" as const, from: neighbor, to: target },
    };
    if (isFrom) face.toNeighbor = e; else face.fromNeighbor = e;
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
  _nextPostEditOneWayId: 1,
  postEditDraftMeta: null,
  postEditDraftSplitPoints: {},
  postEditDraftSplitPointIds: {},
  _nextSplitSlotId: {},
  _nextPostEditSplitPointId: 1,
  postEditActiveSplitNode: {},
  postEditFocusedPoint: null,
  postEditHoveredEntity: null,
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
  postEditSplitTargetPrompt: null,
  postEditChangesOpen: true,
  postEditChangesEntityFilter: null,
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
    const bwdKey = edgeKey(to_, from_);
    const fromId = from_.kind === "node" ? from_.id : undefined;
    const toId = to_.kind === "node" ? to_.id : undefined;
    // Effective current entry of each direction — a face's reducer (`setEdgePair`'s own
    // `applyPostEditCommand` case) deletes the record entirely for `wall`, so "no record" and
    // "explicit wall" are the same state on the wire; the `?? wallEdge` fallback below collapses
    // them back for comparison, matching what's actually rendered.
    const wallEdge = (from: PostEditEndpoint, to: PostEditEndpoint): PostEditEdge => ({ kind: "wall", from, to });
    const curAToBEntry = currentEdges[fwdKey] ?? wallEdge(from_, to_);
    const curBToAEntry = currentEdges[bwdKey] ?? wallEdge(to_, from_);
    const curAToB = curAToBEntry.kind;
    const curBToA = curBToAEntry.kind;
    const wasOneWay = curAToB === "one_way_forward" || curAToB === "one_way_backward"
      || curBToA === "one_way_forward" || curBToA === "one_way_backward";
    // One-way id resolution (GitHub issue #564): a fresh one-way (from wall/passage) mints a new id;
    // flipping an already-one-way face reuses whichever side currently carries the id (same entity,
    // new direction). `replacedOneWayIds` records the id(s), if any, this command destroys on each
    // side — resolved here (pre-state still available), never inferred later from the log.
    let nextOneWayId = state._nextPostEditOneWayId;
    const mintOneWayId = (): string => formatPostEditId("oneWay", nextOneWayId++);
    const oldAToBId = curAToB === "one_way_forward" || curAToB === "one_way_backward" ? curAToBEntry.id : undefined;
    const oldBToAId = curBToA === "one_way_forward" || curBToA === "one_way_backward" ? curBToAEntry.id : undefined;

    let aToB: PostEditEdgeState;
    let bToA: PostEditEdgeState;
    let replacedOneWayIds: { aToB?: string; bToA?: string } | undefined;
    if (tool === "reset") {
      const origAB = state._generatedEdges.some((e) => e.from === fromId && e.to === toId);
      const origBA = state._generatedEdges.some((e) => e.from === toId && e.to === fromId);
      // A face restored to a baseline one-way gets its ORIGINAL baseline id back, read from
      // `postEditBaseline.derived.edges` — never mints a new one, since nothing new is being
      // created (issue #564: reset restores identity, not just kind).
      const baselineEdges = state.postEditBaseline.derived.edges;
      if (origAB && origBA) { aToB = { kind: "basic", from: from_, to: to_ }; bToA = { kind: "basic", from: to_, to: from_ }; }
      else if (origAB) {
        const baseline = baselineEdges[fwdKey];
        const id = baseline && (baseline.kind === "one_way_forward" || baseline.kind === "one_way_backward") ? baseline.id : mintOneWayId();
        aToB = { kind: "one_way_forward", from: from_, to: to_, id };
        bToA = { kind: "wall", from: to_, to: from_ };
      } else if (origBA) {
        const baseline = baselineEdges[bwdKey];
        const id = baseline && (baseline.kind === "one_way_forward" || baseline.kind === "one_way_backward") ? baseline.id : mintOneWayId();
        aToB = { kind: "wall", from: from_, to: to_ };
        bToA = { kind: "one_way_forward", from: to_, to: from_, id };
      } else { aToB = { kind: "wall", from: from_, to: to_ }; bToA = { kind: "wall", from: to_, to: from_ }; }
      replacedOneWayIds = { aToB: oldAToBId, bToA: oldBToAId };
    } else if (tool === "wall") {
      if (curAToB === "wall" && curBToA === "wall") return;
      aToB = { kind: "wall", from: from_, to: to_ };
      bToA = { kind: "wall", from: to_, to: from_ };
      replacedOneWayIds = { aToB: oldAToBId, bToA: oldBToAId };
    } else if (tool === "passage") {
      if (curAToB === "basic" && curBToA === "basic") return;
      aToB = { kind: "basic", from: from_, to: to_ };
      bToA = { kind: "basic", from: to_, to: from_ };
      replacedOneWayIds = { aToB: oldAToBId, bToA: oldBToAId };
    } else if (tool === "one_way") {
      // Flip only when THIS face is already the one-way side - not just "some record exists" (a
      // `basic` two-way passage also has a record on both sides, and clicking `one_way` on it must
      // create a fresh forward one-way, not silently flip to backward-only and drop the passage).
      // `wasOneWay` (either side, either direction) is the right check here — the old
      // `curAToB === "one_way_forward" || curBToA === "one_way_backward"` only recognized ONE of
      // the two possible one-way layouts: after an odd number of flips the one-way side is `bToA:
      // one_way_forward` (this branch's own result below always normalizes the flipped side back to
      // `forward`, never `backward`), which that check's `curBToA === "one_way_backward"` half never
      // matches — every second flip fell through to the "fresh" branch below and minted a brand-new
      // id instead of reusing the existing one, duplicating the entity on every other click.
      if (wasOneWay) {
        // Flip: reuses the existing side's id — same entity, new direction. Swap which side is
        // `one_way_forward`/`wall` relative to whichever side CURRENTLY carries it, not always
        // toward `bToA` — otherwise every flip after the first re-set the same `bToA` side and
        // never actually toggled the direction (GitHub issue #575).
        const aToBIsOneWay = curAToB === "one_way_forward" || curAToB === "one_way_backward";
        const id = oldAToBId ?? oldBToAId ?? mintOneWayId();
        if (aToBIsOneWay) {
          aToB = { kind: "wall", from: from_, to: to_ };
          bToA = { kind: "one_way_forward", from: to_, to: from_, id };
        } else {
          aToB = { kind: "one_way_forward", from: from_, to: to_, id };
          bToA = { kind: "wall", from: to_, to: from_ };
        }
      } else {
        // Fresh one-way from wall/passage: mints a new id, destroys whatever one-way (if any) used
        // to occupy either side (a `basic` two-way passage has no one-way id to destroy on either
        // side, so both stay `undefined` there).
        const id = mintOneWayId();
        aToB = { kind: "one_way_forward", from: from_, to: to_, id };
        bToA = { kind: "wall", from: to_, to: from_ };
        replacedOneWayIds = { aToB: oldAToBId, bToA: oldBToAId };
      }
    } else {
      return;
    }

    // A face touching a split point's own node is recorded as a fresh `updateSplitNodeFaces`
    // command carrying that node's FULL current face list, not a `setEdgePair` targeting just the
    // clicked face — one click reconfiguring one face of a split node is still "reconfigure this
    // node's wiring", the same one-entity-one-lifeline treatment `updateElevatorFloors` gives a
    // lift's floor edit (GitHub issue #545). This now covers the point's ORIGINAL node too, not
    // just its numbered slots (GitHub issue #564 follow-up) — every node of a split point is an
    // equally addressable member of it, the original included; a `node`-kind endpoint whose own
    // point is already a declared split point is resolved to `{ point, level, slotId: undefined }`
    // (`resolveSplitSide`) below, the same "undefined = original node" convention
    // `postEditActiveSplitNode`/`PresetEndpoint.slotId` already use elsewhere. A `node`-kind
    // endpoint whose point ISN'T split falls through to the plain `setEdgePair` two-node case below
    // unchanged — a plain, unsplit point's own edges are ordinary edges, not a split node's faces.
    const resolveSplitSide = (ep: PostEditEndpoint): { point: [number, number]; level?: number; slotId?: number } | null => {
      if (ep.kind === "split") return ep;
      const node = state.nodes.find((n) => n.id === ep.id);
      if (node === undefined) return null;
      const level = node.level === 0 ? undefined : node.level;
      const key = level === undefined ? `${node.x},${node.y}` : `${node.x},${node.y}@${level}`;
      if (!(key in state.postEditDraftSplitPoints)) return null;
      return { point: [node.x, node.y], level, slotId: undefined };
    };
    const fromSplitSide = resolveSplitSide(from_);
    const toSplitSide = resolveSplitSide(to_);
    const splitSide = fromSplitSide ?? toSplitSide;
    const splitSideIsFrom = fromSplitSide !== null;
    // `reset` on a split face is a no-op, not routed into the `splitSide` branch below — that
    // branch would append a fresh `updateSplitNodeFaces` "restoring" this one face, but the
    // command's lifeline covers the WHOLE node (`slot:point:slotId`/`originalNode:point`,
    // `lifelineKeysOf`), so removing it later (point-reset) would wipe every other face of the node
    // too, not just this one. No caller currently reaches this combination (edge-branch reset
    // routes split points to `resetPostEditPoint` instead, and `ManageSplitNodesDialog` never
    // passes `reset`) — this guard is purely defensive, so a future caller can't silently hit the
    // mismatched semantics.
    if (splitSide && tool === "reset") return;
    if (splitSide) {
      const neighbor = splitSideIsFrom ? to_ : from_;
      // `toNeighbor`/`fromNeighbor` (GitHub issue #564) are `PostEditEdgeState` — `aToB`/`bToA`
      // already have `from`/`to` set to `from_`/`to_`, so they carry the right endpoints/id as-is;
      // just pick the pair matching `target -> neighbor` (`toNeighbor`) vs `neighbor -> target`
      // (`fromNeighbor`) depending on which side `from_` is.
      const toNeighbor = splitSideIsFrom ? aToB : bToA;
      const fromNeighbor = splitSideIsFrom ? bToA : aToB;
      const key = splitSide.level === undefined ? `${splitSide.point[0]},${splitSide.point[1]}` : `${splitSide.point[0]},${splitSide.point[1]}@${splitSide.level}`;
      if (splitSide.slotId !== undefined && !(state.postEditDraftSplitPoints[key] ?? []).includes(splitSide.slotId)) return;
      const pointId = state.postEditDraftSplitPointIds[key];
      if (pointId === undefined) return;
      const target = splitSide.slotId === undefined ? (splitSideIsFrom ? from_ : to_) : splitEndpoint(splitSide.point, splitSide.slotId, splitSide.level);
      const faces = currentSplitNodeFaces(currentEdges, target).filter((f) => !endpointsEqual(f.neighbor, neighbor));
      if (toNeighbor.kind !== "wall" || fromNeighbor.kind !== "wall") faces.push({ neighbor, toNeighbor, fromNeighbor });
      const applied = appendPostEditCommand(get, set, {
        kind: "updateSplitNodeFaces", point: splitSide.point, level: splitSide.level, slotId: splitSide.slotId, faces, pointId,
      });
      if (applied && nextOneWayId !== state._nextPostEditOneWayId) {
        set({ _nextPostEditOneWayId: nextOneWayId });
      }
    } else if (tool === "reset") {
      // Unlike wall/passage/one_way, "reset" doesn't record a new "restored to generation state"
      // command — it REMOVES whatever earlier command(s) touched this exact edge, mirroring
      // `resetPostEditPoint`'s own "undo via lifeline removal, not counter-command" approach
      // (GitHub issue #545). Without this, every reset click appended a fresh `setEdgePair`
      // restoring the generation kind, which could pile up duplicate entries in the log and never
      // actually cleared the original edit.
      // Filtered by the command's own endpoints, not by lifeline key (GitHub issue #564: a
      // `setEdgePair`'s lifeline is now the one-way id(s) it touches, not a spatial key — a
      // placeholder-wall command no longer produces a comparable key) — every `setEdgePair`/`setEdge`
      // addressing this exact face pair (either direction) is dropped, matching the old behavior.
      const touchesThisFace = (a: PostEditEndpoint, b: PostEditEndpoint) =>
        (endpointsEqual(a, from_) && endpointsEqual(b, to_)) || (endpointsEqual(a, to_) && endpointsEqual(b, from_));
      const filtered = state.postEditCommands.filter((cmd) => {
        if (cmd.kind === "setEdgePair") return !touchesThisFace(cmd.a, cmd.b);
        if (cmd.kind === "setEdge") return !touchesThisFace(cmd.edge.from, cmd.edge.to);
        return true;
      });
      if (filtered.length === state.postEditCommands.length) return;
      replacePostEditCommands(get, set, filtered, true);
    } else {
      const directionFlip = tool === "one_way" && wasOneWay ? true : undefined;
      const applied = appendPostEditCommand(get, set, { kind: "setEdgePair", a: from_, b: to_, aToB, bToA, directionFlip, replacedOneWayIds });
      if (applied && nextOneWayId !== state._nextPostEditOneWayId) {
        set({ _nextPostEditOneWayId: nextOneWayId });
      }
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

    // `VerticalPassage`/`Elevator` edges: generation-baked ones are now full baseline draft entries
    // in `postEditDraftVerticalPassages`/`postEditDraftElevators` with their own stable id (GitHub
    // issue #564), same as any user-created one — there is no separate generation-mesh suppression
    // concept any more, `state.postEditDraftVerticalPassages`/`Elevators` is the single source of
    // truth for every vertical connection. Converted the same way `postEditDraftTeleports` is,
    // through the previous confirmed snapshot's resolver.
    const verticalEdges = postEditVerticalToDto(state.postEditDraftVerticalPassages, state.postEditDraftElevators, resolveSplit);

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
      // Every baseline-seeded entity (teleport/one-way/split-point/vertical-passage/elevator, GitHub
      // issue #564) occupies ids 1..N of its own category — the next user-created one must start
      // past them, not collide (#363's fix, now generalized to every category since generation-baked
      // vertical passages/elevators are full baseline entries too).
      return {
        nodes: state._generatedNodes,
        edges: state._generatedEdges,
        postEditBaseline: baseline,
        postEditDerived: baseline.derived,
        postEditCommands: [] as PostEditCommand[],
        ...legacyFieldsFor(baseline.derived),
        ...nextPostEditIdCounters(baseline.derived),
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
        postEditElevatorPending: null,
        postEditSplitTargetPrompt: null,
        postEditChangesEntityFilter: null,
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
   * `removeElevator`) rather than a single bundled `deletePoint` command (GitHub issue #545) — each
   * removal gets its own lifeline (`lifelineKeysOf` in `postEditReplay.ts`), so the "Changes" panel
   * lists them as separate entries and a later `resetPostEditPoint` still undoes every one of them
   * via the ordinary per-lifeline cascade, no dedicated `deletePoint` lifeline needed.
   *
   * A generation-baked vertical passage/elevator is a full baseline draft entry with its own stable
   * id (GitHub issue #564) — the `derived.verticalPassages`/`derived.elevators` loops above already
   * cover it, same as a user-created one; deleting it emits exactly one `removeVerticalPassage`/
   * `removeElevator`, not N raw edge-pair suppressions (the issue's own follow-up fix). */
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
      appendPostEditCommand(get, set, { kind: "setMeta", slot: "start", endpoint: null, previousEndpoint: derived.meta.start });
    }
    if (derived.meta.finish !== null && endpointRefsTarget(derived.meta.finish)) {
      appendPostEditCommand(get, set, { kind: "setMeta", slot: "finish", endpoint: null, previousEndpoint: derived.meta.finish });
    }
    for (const t of derived.teleports) {
      if (refsTarget(t)) appendPostEditCommand(get, set, { kind: "removeTeleport", id: t.id, from: t.from, to: t.to, direction: t.direction });
    }
    for (const p of derived.verticalPassages) {
      if (refsTarget(p)) appendPostEditCommand(get, set, { kind: "removeVerticalPassage", id: p.id, from: p.from, to: p.to, direction: p.direction });
    }
    for (const e of derived.elevators) {
      if (e.floors.some(endpointRefsTarget)) appendPostEditCommand(get, set, { kind: "removeElevator", id: e.id, floors: e.floors });
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
    const previousEndpoint = get().postEditDerived?.meta[kind] ?? undefined;
    appendPostEditCommand(get, set, { kind: "setMeta", slot: kind, endpoint: null, previousEndpoint });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  setPostEditTeleportPendingFrom: (nodeId) => set({ postEditTeleportPendingFrom: nodeId }),

  addPostEditTeleport: (from, to, direction) => {
    const nextId = get()._nextPostEditTeleportId;
    const id = formatPostEditId("teleport", nextId);
    const applied = appendPostEditCommand(get, set, { kind: "addTeleport", id, from, to, direction });
    if (applied) set({ _nextPostEditTeleportId: nextId + 1, postEditTeleportPendingFrom: null });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  cyclePostEditTeleportDirection: (id) => {
    const target = get().postEditDraftTeleports.find((t) => t.id === id);
    if (!target || target.direction === "two_way") return;
    const direction = target.direction === "forward" ? "backward" : "forward";
    appendPostEditCommand(get, set, { kind: "setTeleportDirection", id, direction, from: target.from, to: target.to });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditTeleport: (id) => {
    const target = get().postEditDraftTeleports.find((t) => t.id === id);
    if (!target) return;
    appendPostEditCommand(get, set, { kind: "removeTeleport", id, from: target.from, to: target.to, direction: target.direction });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditTeleportEndpoint: (id, end, endpoint) => {
    const target = get().postEditDraftTeleports.find((t) => t.id === id);
    const from = end === "from" ? endpoint : target?.from;
    const to = end === "to" ? endpoint : target?.to;
    if (!from || !to || !target) return;
    appendPostEditCommand(get, set, { kind: "moveTeleportEndpoint", id, end, endpoint, from, to, direction: target.direction });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  addSplitNode: (point) => {
    const state = get();
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotId = state._nextSplitSlotId[key] ?? 0;
    // `pointId` (GitHub issue #564) — the point's current id if it already exists (current derived
    // state, in or out of the log — covers baseline and any earlier-in-this-log create), else a
    // freshly-minted one. Resolved here, at construction time, not left for the reducer to invent.
    const existingPointId = state.postEditDraftSplitPointIds[key];
    const nextSplitPointId = state._nextPostEditSplitPointId;
    const pointId = existingPointId ?? formatPostEditId("splitPoint", nextSplitPointId);
    const applied = appendPostEditCommand(get, set, { kind: "addSplitNode", point, level, slotId, pointId });
    if (applied) {
      set((state) => ({
        _nextSplitSlotId: { ...state._nextSplitSlotId, [key]: slotId + 1 },
        ...(existingPointId === undefined ? { _nextPostEditSplitPointId: nextSplitPointId + 1 } : {}),
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

    const key0 = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const pointId = state.postEditDraftSplitPointIds[key0];
    if (pointId === undefined) return;
    const applied = appendPostEditCommand(get, set, { kind: "removeSplitNode", point, level, slotId, pointId });
    if (applied) {
      const key = key0;
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
  setPostEditHoveredEntity: (entity: PostEditHoveredEntity | null) => set({ postEditHoveredEntity: entity }),

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
    // A blueprint applied on top of an already-split point must reuse the point's existing slots
    // for as many of its own nodes as it needs (GitHub issue #545) — minting fresh ones instead
    // left the reused-looking survivor as an orphaned, all-wall node while the blueprint's face
    // list landed on a brand-new id, so the maze visibly kept "one connected node plus a floating
    // empty one" instead of properly rewiring both. Any existing slot beyond what the new blueprint
    // needs is dropped entirely (not left empty) — guarded by the same start/finish check below.
    const slotsNeeded = Math.max(blueprint.nodeFaces.length - 1, 0);
    const reusedSlotIds = existingSlots.slice(0, slotsNeeded);
    if (meta && existingNodeEndpoints.some((t) =>
      (meta.start && endpointsEqual(meta.start, t)) || (meta.finish && endpointsEqual(meta.finish, t)))) {
      set({ error: "Cannot apply a blueprint while an existing split node is assigned as start/finish — reassign it first." });
      return;
    }

    // Slot ids beyond the reused ones are minted from the point's high-water mark (GitHub issue
    // #543 plan section 7), not reused positional indices — a point-reset can prune a
    // previously-issued high slotId out of the log while the mark stays put, so a fresh mint must
    // not reissue it.
    const nextMark = state._nextSplitSlotId[key] ?? 0;
    const freshSlotIds = Array.from({ length: Math.max(slotsNeeded - reusedSlotIds.length, 0) }, (_, i) => nextMark + i);
    const mintedSlotIds = [...reusedSlotIds, ...freshSlotIds];
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

    // `pointId` (GitHub issue #564) — same resolution rule as `addSplitNode`'s own field: the
    // point's current id if it already exists, else a freshly-minted one.
    const existingPointId = state.postEditDraftSplitPointIds[key];
    const nextSplitPointId = state._nextPostEditSplitPointId;
    const pointId = existingPointId ?? formatPostEditId("splitPoint", nextSplitPointId);

    const applied = appendPostEditCommand(get, set, {
      kind: "applySplitBlueprint", point, level, resolvedSlots, originalFaces, blueprintTitleKey: blueprint.titleKey, pointId,
    });
    if (applied) {
      set((state) => ({
        // Only the freshly-minted ids actually advance the high-water mark - reused ids were
        // already accounted for by whatever `addSplitNode`/earlier `applySplitBlueprint` call
        // originally minted them.
        _nextSplitSlotId: { ...state._nextSplitSlotId, [key]: nextMark + freshSlotIds.length },
        ...(existingPointId === undefined ? { _nextPostEditSplitPointId: nextSplitPointId + 1 } : {}),
        // Activate the blueprint's first slot (reused or freshly minted), mirroring `addSplitNode`'s
        // own "just-created slot becomes active" behavior — without this, a face click right after
        // applying a blueprint resolves through `PostEditController`'s `resolveActiveEndpointAt`
        // fallback to the plain original-node endpoint (no active split entry to prefer), missing
        // the `splitSide` branch in `applyPostEditToolAt` entirely and logging a bare `setEdgePair`
        // ("Set wall"/"Set passage") instead of one `updateSplitNodeFaces` entry (GitHub issue #545).
        // `nextActiveSplitNode` already dropped this point's stale entry (line 744, above) for the
        // neighbor-resolution pass — a blueprint needing zero slots must commit that drop too,
        // rather than leave a pre-existing active-slot entry pointing at a slot id this apply may
        // have just dropped from the point entirely.
        postEditActiveSplitNode: mintedSlotIds.length > 0
          ? { ...nextActiveSplitNode, [key]: splitEndpoint(point, mintedSlotIds[0], level) }
          : nextActiveSplitNode,
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
    // reaches here: a plain new placement, a click on a node with a generation-baked passage (now a
    // full baseline draft entry with its own id, GitHub issue #564 — no separate seed branch needed
    // any more, `findPostEditVerticalPassageForPair` below already finds it), and (GitHub issue #491)
    // a click elsewhere in the same cell as an existing draft passage, which resolves to the same
    // `origin` node the marker would.
    //
    // The direction-aware create path below (guard, GitHub issue #491) keeps this from stacking a
    // duplicate directed edge that would resolve as two-way on the next confirm regardless of either
    // entry's own direction: a direction already covered by *any* draft entry (baseline-seeded,
    // still pre-confirm, or its edge already echoed into `state.edges` by an auto-confirm) is
    // cycled/skipped rather than re-placed.
    const originLevel = originNode.level ?? 0;
    const resolveFieldAt = resolveFieldAtOf(state);
    const point: [number, number] = [originNode.x, originNode.y];
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) return;
    // Direction-aware create path (GitHub issue #491). This click could place a passage in each of
    // `availableDirections`; for any direction already covered by a draft entry (baseline-seeded,
    // still pre-confirm in `postEditDraftVerticalPassages`, or its edge already echoed into
    // `state.edges` by an auto-confirm), adding a fresh one would mint a *second* entry for the same
    // pair, which then reads as two-way on the next confirm regardless of either entry's own
    // direction. Resolve the partner node per direction and look up its own draft entry.
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
    // A two-way passage has no direction to flip (`cyclePostEditVerticalPassageDirection` in
    // `postEditVerticalUtils.ts` is a documented no-op for it) — bail out before logging anything,
    // rather than appending a command for a click that changes nothing (GitHub issue #545: a no-op
    // click must not touch the log at all).
    if (target.direction === "two_way") return;
    // `direction` here is informational only — the reducer's `setVerticalPassageDirection` case
    // always cycles from whatever direction the log has produced up to that point (replay
    // determinism), it never reads this field. Pass the entry's own current direction as the most
    // meaningful placeholder value.
    appendPostEditCommand(get, set, {
      kind: "setVerticalPassageDirection", id, direction: target.direction,
      from: target.from, to: target.to,
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditVerticalPassage: (id) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target) return;
    appendPostEditCommand(get, set, { kind: "removeVerticalPassage", id, from: target.from, to: target.to, direction: target.direction });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditVerticalPassageEndpoint: (id, end, endpoint) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    // `from`/`to` (GitHub issue #564 follow-up) are the RESULTING pair after this move, not the
    // pre-move `target.from`/`target.to` — the "Changes" panel must show where the passage ended up.
    const from = end === "from" ? endpoint : target?.from;
    const to = end === "to" ? endpoint : target?.to;
    if (!from || !to || !target) return;
    appendPostEditCommand(get, set, { kind: "moveVerticalPassageEndpoint", id, end, endpoint, from, to, direction: target.direction });
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
    // issue #341 follow-up). A generation-baked elevator is now a full baseline draft entry with its
    // own stable id (GitHub issue #564), same as a user-placed one — both are found here, no separate
    // generation-time connected-component branch needed any more.
    const originLevel = originNode.level ?? 0;
    const existingDraft = state.postEditDraftElevators.find((e) => e.floors.some((f) =>
      f.kind === "node" && f.id === origin.id));
    if (existingDraft) {
      const floors = new Set<number>();
      for (const f of existingDraft.floors) {
        if (f.kind !== "node") continue;
        const n = state.nodes.find((nd) => nd.id === f.id);
        if (n) floors.add(n.level ?? 0);
      }
      set({ postEditElevatorPending: { origin, floors, editingId: existingDraft.id } });
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
    // Every selected floor resolves to whichever node the user last picked at `point` on that
    // floor (GitHub issue #546 fifth follow-up — `postEditActiveSplitNode`, same map the edge
    // tools already read via `PostEditController.resolveActiveEndpointAt`), falling back to that
    // floor's own original node only when nothing's been picked there yet. Previously always took
    // the original node outright, silently ignoring a split floor's actually-clicked slot.
    const floors: PostEditEndpoint[] = [];
    for (const level of Array.from(pending.floors).sort((a, b) => a - b)) {
      const nodeIds = state.nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === level).map((n) => n.id);
      const nodeId = resolveActiveNodeIdAt(point, nodeIds, state.postEditActiveSplitNode, level === 0 ? undefined : level);
      if (nodeId !== undefined) floors.push(nodeEndpoint(nodeId));
    }
    if (floors.length < 2) return;
    const editingId = pending.editingId;
    // `editingId` is always set when editing an existing entry now (GitHub issue #564 — a
    // generation-baked elevator is a full baseline draft entry with its own id, found by
    // `startPostEditElevatorPlacement`'s `existingDraft` lookup) — no separate generation-mesh
    // suppression concept, `updateElevatorFloors` is an ordinary edit of an existing draft entry.
    const applied = editingId !== undefined
      ? appendPostEditCommand(get, set, { kind: "updateElevatorFloors", id: editingId, floors })
      : appendPostEditCommand(get, set, { kind: "addElevator", id: formatPostEditId("elevator", state._nextPostEditElevatorId), floors });
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
    const target = get().postEditDraftElevators.find((e) => e.id === id);
    if (!target) return;
    appendPostEditCommand(get, set, { kind: "removeElevator", id, floors: target.floors });
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

  setPostEditChangesEntityFilter: (id) => set({ postEditChangesEntityFilter: id }),

  setPostEditDragOverride: (override) => set({ postEditDragOverride: override }),
});
