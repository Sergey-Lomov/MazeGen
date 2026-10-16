import type { StateCreator } from "zustand";
import { computeAnalyticsAsync } from "../../wasm/mazeService";
import type { NodeDto, PostEditEdgeWasmDto } from "../../wasm/types";
import {
  postEditTeleportsToDto,
  rotateSplitPointNodes,
  currentSplitNodeFaces,
  postEditVerticalToDto, pruneRemovedSplitNodes,
  resolveVerticalPassageMove,
  resolveElevatorMove,
} from "../../pixi/postEditUtils";
import { selectNodeLevelResolver } from "../../pixi/selectors/mazeSelectors";
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
import { resolveBlueprintFaceIndex } from "../../pixi/splitBlueprints";
import type {
  MazeStore, PostEditState, PostEditActions, PostEditTool, PostEditTeleportEntry,
  PostEditVerticalPassageEntry, PostEditElevatorEntry,
} from "../storeTypes";
import type { PostEditCommand, ResolvedSplitFace, ResolvedSplitSlot } from "../postEditCommandTypes";
import type { PostEditEdge, PostEditEdgeState } from "../postEditTypes";
import { filterCommandsForPoint, resetCommandsAt, deleteCommandAt, isCreateCommand, replayPostEditCommands, lifelineKeysOf } from "../../pixi/postEditReplay";
import { compactPostEditCommands } from "../../pixi/postEditCompaction";
import { postEditEntitiesForPurpose, type EntityToolPurpose } from "../../pixi/entityToolKinds";
import type { PostEditPointEntityDescriptor } from "../../pixi/postEditPointEntities";
import { fieldConfigToWasm, buildValidPresetConnections } from "./generationSlice";
import { ruleStrategyToConfig } from "./generateConfigBuilder";
import { relevantRuleParams, activeFloorField, activeFloorLevel, floorTessellationOf, resolveFieldAtOf } from "../storeHelpers";
import { configAllCells } from "../../pixi/tessellationCells";
import {
  toWasmEndpoint, buildMultiFloorPointNodeMap, commitPostEditVerticalPassage, tryCommitPostEditVerticalPassage,
  resolveDragTargets, dispatchPostEditElevatorPlacement,
  buildPostEditBaseline, appendPostEditCommand, replacePostEditCommands,
  derivedStateToLegacyFields as legacyFieldsFor, nextPostEditIdCounters,
  nextSplitSlotIdCounters,
  buildPostEditPointEntitiesAt, removePostEditSplitSlots, resolveNodeIdToEndpoint,
  buildPostEditResetLifelinesAt, postEditDragOverridesEqual,
} from "./postEditSliceHelpers";
import { formatPostEditId } from "../../pixi/postEditIdFormat";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import { notify } from "../../notifications/notificationStore";
import * as m from "~/paraglide/messages";

const REFRESH_FAILED = "post_edit.refresh_failed";
const REMOVE_ENDPOINT_NODE_REJECTED = "post_edit.remove_endpoint_node_rejected";
registerNotificationCode(REFRESH_FAILED, { category: "error", message: () => m[REFRESH_FAILED]() });
registerNotificationCode(REMOVE_ENDPOINT_NODE_REJECTED, { category: "notice", message: () => m[REMOVE_ENDPOINT_NODE_REJECTED]() });

function endpointTouchesPoint(
  endpoint: PostEditEndpoint,
  nodes: NodeDto[],
  point: [number, number] | undefined,
  level: number | undefined,
): boolean {
  if (point === undefined) return true;
  const endpointLevel = endpoint.kind === "split"
    ? endpoint.level ?? 0
    : nodes.find((node) => node.id === endpoint.id)?.level ?? 0;
  if (endpointLevel !== (level ?? 0)) return false;
  return endpoint.kind === "split"
    ? endpoint.point[0] === point[0] && endpoint.point[1] === point[1]
    : (() => {
      const node = nodes.find((candidate) => candidate.id === endpoint.id);
      return node?.x === point[0] && node?.y === point[1];
    })();
}

function samePostEditCommand(a: PostEditCommand, b: PostEditCommand): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keep the creation event for a post-edit-only entity when Reset removes it, then append the
 * matching remove event. Without this, reset silently pruned the creation command and the Changes
 * log had no deletion entry (GitHub issue #593). Generation-backed entities are deliberately not
 * included: resetting them restores their baseline state and therefore has no deletion to record. */
function resetCommandsWithDeletionEvents(
  state: PostEditState,
  remainingCommands: PostEditCommand[],
  point?: [number, number],
  level?: number,
): PostEditCommand[] {
  const { postEditBaseline: baseline, postEditDerived: derived, postEditCommands: commands } = state;
  if (!baseline || !derived) return commands;
  const baselineTeleportIds = new Set(baseline.derived.teleports.map((entry) => entry.id));
  const baselinePassageIds = new Set(baseline.derived.verticalPassages.map((entry) => entry.id));
  const baselineElevatorIds = new Set(baseline.derived.elevators.map((entry) => entry.id));
  const targetKey = point === undefined ? undefined : level === undefined
    ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const touches = (from: PostEditEndpoint, to: PostEditEndpoint) =>
    endpointTouchesPoint(from, baseline.context.nodes, point, level)
    || endpointTouchesPoint(to, baseline.context.nodes, point, level);

  const createdTeleports = derived.teleports.filter((entry) =>
    !baselineTeleportIds.has(entry.id) && touches(entry.from, entry.to));
  const createdPassages = derived.verticalPassages.filter((entry) =>
    !baselinePassageIds.has(entry.id) && touches(entry.from, entry.to));
  const createdElevators = derived.elevators.filter((entry) =>
    !baselineElevatorIds.has(entry.id)
    && (point === undefined || entry.floors.some((floor) => endpointTouchesPoint(floor, baseline.context.nodes, point, level))));
  const createdMeta = (slot: "start" | "finish") =>
    baseline.derived.meta[slot] === null && derived.meta[slot] !== null
    && endpointTouchesPoint(derived.meta[slot]!, baseline.context.nodes, point, level);

  const createdSplitSlots = targetKey === undefined
    ? Object.entries(derived.splitPoints).flatMap(([key, slots]) => slots.filter((slot) => !(baseline.derived.splitPoints[key] ?? []).includes(slot)).map((slot) => ({ key, slot })))
    : (derived.splitPoints[targetKey] ?? []).filter((slot) => !(baseline.derived.splitPoints[targetKey] ?? []).includes(slot)).map((slot) => ({ key: targetKey, slot }));
  const createdSplitKeys = new Set(createdSplitSlots.map(({ key }) => key));
  const createdCommands = commands.filter((command) => {
    if (!isCreateCommand(command)) return false;
    switch (command.kind) {
      case "addMeta": return createdMeta(command.slot);
      case "addTeleport": return createdTeleports.some((entry) => entry.id === command.id);
      case "addVerticalPassage": return createdPassages.some((entry) => entry.id === command.id);
      case "addElevator": return createdElevators.some((entry) => entry.id === command.id);
      case "addSplitNode":
      case "applySplitBlueprint": {
        const key = command.level === undefined
          ? `${command.point[0]},${command.point[1]}` : `${command.point[0]},${command.point[1]}@${command.level}`;
        return createdSplitKeys.has(key);
      }
      default: return false;
    }
  });

  const deletions: PostEditCommand[] = [];
  if (createdMeta("start")) deletions.push({ kind: "removeMeta", slot: "start", id: "s", endpoint: derived.meta.start! });
  if (createdMeta("finish")) deletions.push({ kind: "removeMeta", slot: "finish", id: "f", endpoint: derived.meta.finish! });
  for (const entry of createdTeleports) deletions.push({ kind: "removeTeleport", id: entry.id, from: entry.from, to: entry.to, direction: entry.direction });
  for (const entry of createdPassages) deletions.push({ kind: "removeVerticalPassage", id: entry.id, from: entry.from, to: entry.to, direction: entry.direction });
  for (const entry of createdElevators) deletions.push({ kind: "removeElevator", id: entry.id, floors: entry.floors });
  for (const key of createdSplitKeys) {
    const [x, yAndLevel] = key.split(",");
    const [y, rawLevel] = yAndLevel.split("@");
    const splitPoint: [number, number] = [Number(x), Number(y)];
    const splitLevel = rawLevel === undefined ? undefined : Number(rawLevel);
    const pointId = derived.splitPointIds[key];
    const slots = createdSplitSlots.filter((entry) => entry.key === key).map((entry) => entry.slot);
    if (pointId && slots.length > 0) deletions.push({ kind: "removeSplitPoint", point: splitPoint, level: splitLevel, pointId, removedSlotIds: slots });
  }

  return [...remainingCommands, ...createdCommands, ...deletions];
}

export const createPostEditSlice: StateCreator<MazeStore, [], [], PostEditState & PostEditActions> = (set, get) => ({
  postEditAutoConfirm: true,
  postEditAutoCompact: false,
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
  postEditDraftSplitPointIds: {},
  _nextSplitSlotId: {},
  _nextPostEditSplitPointId: 1,
  postEditActiveSplitNode: {},
  postEditFocusedPoint: null,
  postEditFocusedPointCovered: false,
  postEditHoveredEntity: null,
  postEditEdges: null,
  postEditTeleportEdges: [],
  postEditMeta: null,
  postEditAnalytics: null,
  postEditRefreshError: null,
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
  postEditEntityDeletePrompt: null,
  postEditResetPrompt: null,
  postEditChangesOpen: true,
  postEditChangesEntityFilter: null,
  postEditDragOverride: null,
  postEditDragFailureMessage: null,
  postEditEntityPickPrompt: null,
  postEditMoveRequest: null,
  postEditConnectionSettingsPrompt: null,

  setPostEditAutoConfirm: (v) => set({ postEditAutoConfirm: v }),
  // Turning auto-compact ON compacts the log immediately (GitHub issue #548 follow-up) — otherwise
  // any staleness already sitting in the log (from before the toggle was on) would only disappear
  // after the NEXT command, which reads as the toggle doing nothing right away.
  setPostEditAutoCompact: (v) => {
    set({ postEditAutoCompact: v });
    if (v) get().compactPostEditLog();
  },
  setPostEditTool: (tool) => set({
    postEditTool: tool,
    postEditEntityPickPrompt: null,
    postEditMoveRequest: null,
    postEditConnectionSettingsPrompt: null,
    ...(tool !== "manage_split_nodes" ? { postEditFocusedPoint: null, postEditFocusedPointCovered: false } : {}),
  }),

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
    // Effective current entry of each direction — a face's reducer (`setEdgePair`'s own
    // `applyPostEditCommand` case) deletes the record entirely for `wall`, so "no record" and
    // "explicit wall" are the same state on the wire; the `?? wallEdge` fallback below collapses
    // them back for comparison, matching what's actually rendered.
    const wallEdge = (from: PostEditEndpoint, to: PostEditEndpoint): PostEditEdge => ({ kind: "wall", from, to });
    const curAToB = (currentEdges[fwdKey] ?? wallEdge(from_, to_)).kind;
    const curBToA = (currentEdges[bwdKey] ?? wallEdge(to_, from_)).kind;
    const wasOneWay = curAToB === "one_way_forward" || curAToB === "one_way_backward"
      || curBToA === "one_way_forward" || curBToA === "one_way_backward";
    let aToB: PostEditEdgeState;
    let bToA: PostEditEdgeState;
    if (tool === "reset") {
      const fromId = from_.kind === "node" ? from_.id : undefined;
      const toId = to_.kind === "node" ? to_.id : undefined;
      const origAB = state._generatedEdges.some((e) => e.from === fromId && e.to === toId);
      const origBA = state._generatedEdges.some((e) => e.from === toId && e.to === fromId);
      // A face restored to a baseline one-way gets its ORIGINAL baseline id back, read from
      // `postEditBaseline.derived.edges` — never mints a new one, since nothing new is being
      // created (issue #564: reset restores identity, not just kind).
      if (origAB && origBA) { aToB = { kind: "basic", from: from_, to: to_ }; bToA = { kind: "basic", from: to_, to: from_ }; }
      else if (origAB) {
        aToB = { kind: "one_way_forward", from: from_, to: to_ };
        bToA = { kind: "wall", from: to_, to: from_ };
      } else if (origBA) {
        aToB = { kind: "wall", from: from_, to: to_ };
        bToA = { kind: "one_way_forward", from: to_, to: from_ };
      } else { aToB = { kind: "wall", from: from_, to: to_ }; bToA = { kind: "wall", from: to_, to: from_ }; }
    } else if (tool === "wall") {
      if (curAToB === "wall" && curBToA === "wall") return;
      aToB = { kind: "wall", from: from_, to: to_ };
      bToA = { kind: "wall", from: to_, to: from_ };
    } else if (tool === "passage") {
      if (curAToB === "basic" && curBToA === "basic") return;
      aToB = { kind: "basic", from: from_, to: to_ };
      bToA = { kind: "basic", from: to_, to: from_ };
    } else if (tool === "one_way" || tool === "one_way_flip") {
      // The one-way tool creates a forward one-way edge or reverses an existing one; `one_way_flip`
      // (settings tool, GitHub issue #748) only reverses and leaves any other face unchanged.
      if (tool === "one_way_flip" && !wasOneWay) return;
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
        if (aToBIsOneWay) {
          aToB = { kind: "wall", from: from_, to: to_ };
          bToA = { kind: "one_way_forward", from: to_, to: from_ };
        } else {
          aToB = { kind: "one_way_forward", from: from_, to: to_ };
          bToA = { kind: "wall", from: to_, to: from_ };
        }
      } else {
        // Fresh one-way from wall/passage: mints a new id, destroys whatever one-way (if any) used
        // to occupy either side (a `basic` two-way passage has no one-way id to destroy on either
        // side, so both stay `undefined` there).
        aToB = { kind: "one_way_forward", from: from_, to: to_ };
        bToA = { kind: "wall", from: to_, to: from_ };
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
      appendPostEditCommand(get, set, {
        kind: "updateSplitNodeFaces", point: splitSide.point, level: splitSide.level, slotId: splitSide.slotId, faces, pointId,
      });
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
      const snapshot = await computeAnalyticsAsync(config);
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
        postEditRefreshError: null,
        showRouteOverlay: snapshot.route_info != null ? state.showRouteOverlay : false,
      }));
    } catch (err) {
      if (get()._postEditRequestId !== requestId) return;
      const msg = err instanceof Error ? err.message : String(err);
      set({ postEditRefreshError: msg });
      notify({ source: "post_edit", code: REFRESH_FAILED, details: msg });
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
      const resetCommands = resetCommandsWithDeletionEvents(state, []);
      const resetDerived = replayPostEditCommands(baseline, resetCommands);
      const nextIds = nextPostEditIdCounters(resetDerived);
      const baselineSplitCounters = nextSplitSlotIdCounters(baseline.derived.splitPoints);
      const nextSplitSlots = Object.fromEntries([...new Set([
        ...Object.keys(state._nextSplitSlotId),
        ...Object.keys(baseline.derived.splitPoints),
      ])].map((key) => [key, Math.max(
        state._nextSplitSlotId[key] ?? 0,
        baselineSplitCounters[key] ?? 0,
      )]));
      return {
        nodes: state._generatedNodes,
        edges: state._generatedEdges,
        postEditBaseline: baseline,
        postEditDerived: resetDerived,
        postEditCommands: resetCommands,
        ...legacyFieldsFor(resetDerived),
        // Reset now keeps add/remove pairs in the log for post-edit-only entities. Preserve the
        // high-water marks so a later add cannot reuse an id still present in that history.
        _nextPostEditTeleportId: Math.max(state._nextPostEditTeleportId, nextIds._nextPostEditTeleportId),
        _nextPostEditSplitPointId: Math.max(state._nextPostEditSplitPointId, nextIds._nextPostEditSplitPointId),
        _nextPostEditVerticalPassageId: Math.max(state._nextPostEditVerticalPassageId, nextIds._nextPostEditVerticalPassageId),
        _nextPostEditElevatorId: Math.max(state._nextPostEditElevatorId, nextIds._nextPostEditElevatorId),
        postEditTeleportPendingFrom: null,
        _nextSplitSlotId: nextSplitSlots,
        postEditActiveSplitNode: {},
        postEditFocusedPoint: null,
        postEditFocusedPointCovered: false,
        postEditEdges: null,
        postEditTeleportEdges: [],
        postEditMeta: null,
        postEditAnalytics: null,
        postEditTool: "wall" as PostEditTool,
        postEditDirty: false,
        postEditVerticalPassagePending: null,
        postEditElevatorPending: null,
        postEditSplitTargetPrompt: null,
        postEditEntityDeletePrompt: null,
        postEditResetPrompt: null,
        postEditChangesEntityFilter: null,
        postEditEntityPickPrompt: null,
        postEditMoveRequest: null,
        postEditConnectionSettingsPrompt: null,
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
    const resetCommands = resetCommandsWithDeletionEvents(state, filtered, point, level);
    replacePostEditCommands(get, set, resetCommands, true);
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

  /** Delete tool (GitHub issue #386, extended to split slots by #550) — removes every generation-
   * placed non-edge piece of content touching `point`'s nodes (start/finish marker, teleport links,
   * vertical passages, elevators, split slots), regardless of split state (every one of the point's
   * nodes loses its content in one click, per the issue's own scope decision — not just the
   * currently active split node). Unlike `resetPostEditPoint`, this never restores anything from
   * `_generatedEdges` — it's a pure removal, and it never touches `postEditDraftEdges` at all (the
   * `wall`/`reset` tools already own basic-edge removal).
   *
   * Appends one command per removed entity (`removeMeta`/`removeTeleport`/`removeVerticalPassage`/
   * `removeElevator`) rather than a single bundled `deletePoint` command (GitHub issue #545) — each
   * removal gets its own lifeline (`lifelineKeysOf` in `postEditReplay.ts`), so the "Changes" panel
   * lists them as separate entries and a later `resetPostEditPoint` still undoes every one of them
   * via the ordinary per-lifeline cascade, no dedicated `deletePoint` lifeline needed.
   *
   * A generation-baked vertical passage/elevator is a full baseline draft entry with its own stable
   * id (GitHub issue #564) — the `derived.verticalPassages`/`derived.elevators` loops above already
   * cover it, same as a user-created one; deleting it emits exactly one `removeVerticalPassage`/
   * `removeElevator`, not N raw edge-pair suppressions (the issue's own follow-up fix).
   *
   * Split slots (if any) are removed last, as a whole point via `removePostEditSplitSlots` (GitHub
   * issue #550 follow-up) — by then start/finish has already been cleared above, so a slot that was
   * assigned as start/finish is no longer blocked from removal. Unlike the other loops here,
   * `removePostEditSplitSlots` doesn't append one command per slot: a post-edit-created slot is
   * cascade-deleted out of the log entirely (as if never created), and any remaining
   * generation-baked slot is dropped by one `removeSplitPoint` command that also restores the
   * original node's own generation-time wiring — see its own doc comment for why. */
  deletePostEditPoint: (point) => {
    const state = get();
    if (state.postEditBaseline === null || state.postEditDerived === null) return;
    const level = activeFloorLevel(state);
    const { context } = state.postEditBaseline;
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotIds = state.postEditDerived.splitPoints[key] ?? [];

    // Split slots are removed FIRST (GitHub issue #550 follow-up) — `removePostEditSplitSlots`
    // cascade-deletes a post-edit-created slot's own creation lifeline (and everything that came to
    // depend on it, per `expandSlotReferenceCascade`), which must run against the log as it stood
    // BEFORE this action appended anything of its own. Running it after the meta/teleport/vertical/
    // elevator clearing loops below would have the cascade sweep up THEIR just-appended clearing
    // commands too (they reference the same doomed slot endpoint), silently undoing this action's own
    // "clear start/finish" step and leaving a baseline start/finish assignment behind instead of null.
    if (slotIds.length > 0) removePostEditSplitSlots(get, set, point, level, slotIds);

    const derived = get().postEditDerived;
    if (derived === null) return;
    const pointNodeIds = new Set(
      context.nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0)).map((n) => n.id),
    );
    const remainingSlotIds = derived.splitPoints[key] ?? [];
    const draftTargets: PostEditEndpoint[] = [
      ...[...pointNodeIds].map((id) => nodeEndpoint(id)),
      ...remainingSlotIds.map((slotId) => splitEndpoint(point, slotId, level)),
    ];
    const endpointRefsTarget = (ep: PostEditEndpoint) => draftTargets.some((t) => endpointsEqual(ep, t));
    const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
      endpointRefsTarget(e.from) || endpointRefsTarget(e.to);

    if (derived.meta.start !== null && endpointRefsTarget(derived.meta.start)) {
      appendPostEditCommand(get, set, { kind: "removeMeta", slot: "start", id: "s", endpoint: derived.meta.start });
    }
    if (derived.meta.finish !== null && endpointRefsTarget(derived.meta.finish)) {
      appendPostEditCommand(get, set, { kind: "removeMeta", slot: "finish", id: "f", endpoint: derived.meta.finish });
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

  requestPostEditEntityDelete: (point, level, bulk) => {
    const state = get();
    const entities = buildPostEditPointEntitiesAt(state, point, level);
    if (entities.length === 0) return;
    // Held shift bypasses the picker dialog entirely and removes every entity at once — mirrors
    // `requestPresetEntityDelete`'s own bulk shortcut (GitHub issue #540).
    if (bulk) {
      get().deletePostEditPoint(point);
      return;
    }
    if (entities.length === 1) {
      get().removePostEditPointEntity(entities[0]);
      return;
    }
    set({ postEditEntityDeletePrompt: { point, level }, postEditSplitTargetPrompt: null });
  },

  cancelPostEditEntityDelete: () => set({ postEditEntityDeletePrompt: null }),

  requestPostEditEntityPick: (point, level, purpose) => {
    const entities = postEditEntitiesForPurpose(purpose, buildPostEditPointEntitiesAt(get(), point, level));
    if (entities.length === 0) return;
    if (entities.length === 1) {
      actOnPostEditEntity(get, set, purpose, entities[0]);
      return;
    }
    set({ postEditEntityPickPrompt: { point, level, purpose }, postEditSplitTargetPrompt: null, postEditEntityDeletePrompt: null });
  },

  choosePostEditEntityPick: (descriptor) => {
    const prompt = get().postEditEntityPickPrompt;
    if (!prompt) return;
    set({ postEditEntityPickPrompt: null });
    actOnPostEditEntity(get, set, prompt.purpose, descriptor);
  },

  cancelPostEditEntityPick: () => set({ postEditEntityPickPrompt: null }),

  takePostEditMoveRequest: () => {
    const request = get().postEditMoveRequest;
    if (request) set({ postEditMoveRequest: null });
    return request;
  },

  openPostEditEntitySettings: (descriptor) => {
    switch (descriptor.kind) {
      case "teleport":
      case "vertical_passage":
        set({ postEditConnectionSettingsPrompt: { kind: descriptor.kind, id: descriptor.id } });
        break;
      case "elevator":
        get().editPostEditElevator(descriptor.id, descriptor.endpoint);
        break;
      case "split_point": {
        // The row's endpoint is the point's original node. The split-node panel is only shown
        // while its own tool is active (GitHub issue #699).
        const endpoint = descriptor.endpoint;
        const node = endpoint.kind === "node" ? get().nodes.find((n) => n.id === endpoint.id) : undefined;
        const point: [number, number] | undefined = node ? [node.x, node.y] : endpoint.kind === "split" ? endpoint.point : undefined;
        if (!point) break;
        get().setPostEditTool("manage_split_nodes");
        get().setPostEditFocusedPoint(point);
        break;
      }
      default:
        break;
    }
  },

  cancelPostEditConnectionSettings: () => set({ postEditConnectionSettingsPrompt: null }),

  removePostEditPointEntity: (descriptor) => {
    switch (descriptor.kind) {
      case "start":
        get().clearPostEditEndpoint("start");
        break;
      case "finish":
        get().clearPostEditEndpoint("finish");
        break;
      case "teleport":
        get().removePostEditTeleport(descriptor.id);
        break;
      case "vertical_passage":
        get().removePostEditVerticalPassage(descriptor.id);
        break;
      case "elevator":
        get().removePostEditElevator(descriptor.id);
        break;
      case "split_point": {
        // GitHub issue #550 follow-up: one row for the whole tile, not one per slot — per-slot
        // removal has its own dedicated surface ("Manage split nodes"). `descriptor.endpoint` is the
        // point's original node (`buildPostEditPointEntities`'s own convention for this row).
        const state = get();
        const endpoint = descriptor.endpoint;
        const node = endpoint.kind === "node" ? state.nodes.find((n) => n.id === endpoint.id) : undefined;
        if (node) {
          const nodePoint: [number, number] = [node.x, node.y];
          const nodeLevel = node.level === 0 ? undefined : node.level;
          const key = nodeLevel === undefined ? `${nodePoint[0]},${nodePoint[1]}` : `${nodePoint[0]},${nodePoint[1]}@${nodeLevel}`;
          const slotIds = state.postEditDraftSplitPoints[key] ?? [];
          if (slotIds.length > 0) removePostEditSplitSlots(get, set, nodePoint, nodeLevel, slotIds);
        }
        break;
      }
    }

    const prompt = get().postEditEntityDeletePrompt;
    if (!prompt) return;
    const remaining = buildPostEditPointEntitiesAt(get(), prompt.point, prompt.level);
    if (remaining.length === 0) set({ postEditEntityDeletePrompt: null });
  },

  removeAllPostEditPointEntities: () => {
    const prompt = get().postEditEntityDeletePrompt;
    if (!prompt) return;
    set({ postEditEntityDeletePrompt: null });
    get().deletePostEditPoint(prompt.point);
  },

  requestPostEditReset: (point, level, bulk) => {
    const state = get();
    const lifelines = buildPostEditResetLifelinesAt(state, point, level);
    if (lifelines.length === 0) return;
    // Held shift bypasses the picker dialog entirely and resets every lifeline at once — mirrors
    // `requestPostEditEntityDelete`'s own bulk shortcut (GitHub issue #550/#540).
    if (bulk) {
      get().resetPostEditPoint(point);
      return;
    }
    if (lifelines.length === 1) {
      get().resetPostEditPointLifeline(lifelines[0].commandIndex);
      return;
    }
    set({ postEditResetPrompt: { point, level, lifelines }, postEditSplitTargetPrompt: null });
  },

  cancelPostEditReset: () => set({ postEditResetPrompt: null }),

  resetPostEditPointLifeline: (commandIndex, snapshotCommand, snapshotKeys) => {
    // A row resets only its own lifeline's LATEST command (GitHub issue #549 follow-up), same
    // single-entry-collapse-or-cascade semantics `deletePostEditCommand` already gives the Changes
    // panel's own per-row Delete action — not the whole lifeline via a lifeline-key cascade.
    const state = get();
    let actualIndex = snapshotCommand === undefined
      ? commandIndex
      : state.postEditCommands.findIndex((command) => samePostEditCommand(command, snapshotCommand));
    if (actualIndex < 0 && snapshotKeys !== undefined) {
      for (let i = state.postEditCommands.length - 1; i >= 0; i -= 1) {
        const keys = lifelineKeysOf(state.postEditCommands[i]);
        if (snapshotKeys.every((key) => keys.includes(key))) {
          actualIndex = i;
          break;
        }
      }
    }
    const targetCommand = actualIndex >= 0 ? state.postEditCommands[actualIndex] : undefined;
    if (targetCommand !== undefined) get().deletePostEditCommand(actualIndex);

    const prompt = get().postEditResetPrompt;
    if (!prompt) return;
    const removedCommand = snapshotCommand ?? targetCommand;
    const remaining = removedCommand === undefined
      ? prompt.lifelines
      : prompt.lifelines.filter((row) => !samePostEditCommand(row.command, removedCommand));
    if (remaining.length === 0) set({ postEditResetPrompt: null });
    else set({ postEditResetPrompt: { ...prompt, lifelines: remaining } });
  },

  resetAllPostEditPointLifelines: () => {
    const prompt = get().postEditResetPrompt;
    if (!prompt) return;
    set({ postEditResetPrompt: null });
    get().resetPostEditPoint(prompt.point);
  },

  resetPostEditCommand: (commandIndex) => {
    const state = get();
    if (state.postEditBaseline === null) return;
    const truncated = resetCommandsAt(state.postEditCommands, commandIndex);
    if (truncated === state.postEditCommands) return;
    replacePostEditCommands(get, set, truncated, true);
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  deletePostEditCommand: (commandIndex) => {
    const state = get();
    if (state.postEditBaseline === null) return;
    const next = deleteCommandAt(state.postEditBaseline, state.postEditCommands, commandIndex);
    if (next === state.postEditCommands) return;
    replacePostEditCommands(get, set, next, true);
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  compactPostEditLog: () => {
    const state = get();
    if (state.postEditBaseline === null) return;
    const next = compactPostEditCommands(state.postEditBaseline, state.postEditCommands);
    if (next === state.postEditCommands) return;
    replacePostEditCommands(get, set, next, true);
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  setPostEditEndpoint: (kind, endpoint) => {
    const current = get().postEditDerived?.meta[kind] ?? null;
    const id = kind === "start" ? "s" : "f";
    appendPostEditCommand(get, set, current === null
      ? { kind: "addMeta", slot: kind, id, endpoint }
      : { kind: "setMeta", slot: kind, id, endpoint, previousEndpoint: current });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
  clearPostEditEndpoint: (kind) => {
    const previousEndpoint = get().postEditDerived?.meta[kind] ?? undefined;
    if (!previousEndpoint) return;
    const id = kind === "start" ? "s" : "f";
    appendPostEditCommand(get, set, { kind: "removeMeta", slot: kind, id, endpoint: previousEndpoint });
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

  setPostEditTeleportDirection: (id, direction) => {
    const target = get().postEditDraftTeleports.find((t) => t.id === id);
    if (!target || target.direction === direction) return;
    appendPostEditCommand(get, set, { kind: "setTeleportDirection", id, direction, from: target.from, to: target.to, absolute: true });
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
    const meta = state.postEditDraftMeta;

    // Structural comparison (not a resolved id) — rejects the removal the same way whether or
    // not this split node has been confirmed yet.
    if (meta && ((meta.start && endpointsEqual(meta.start, target)) || (meta.finish && endpointsEqual(meta.finish, target)))) {
      notify({ source: "post_edit", code: REMOVE_ENDPOINT_NODE_REJECTED });
      return;
    }

    // GitHub issue #550 follow-up: routes through the same whole-point-aware removal
    // `deletePostEditPoint`/"Delete all" use, not a bare `removeSplitNode` command — if `slotId` is
    // this point's last remaining slot, the point un-splits and the original node's generation-time
    // wiring is restored (feedback point 3); a post-edit-created slot cascades away entirely
    // (feedback points 2/4/5) instead of leaving a dangling `removeSplitNode` row. Removing one slot
    // among several behaves exactly as before (the slot's own edges vanish, nothing else changes).
    removePostEditSplitSlots(get, set, point, level, [slotId]);
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

  // A newly (re)opened dialog is never covered on open — `postEditFocusedPointCovered` reset here
  // rather than left stale from whatever the previously focused point's covered state happened to
  // be (e.g. reopening the dialog for a different point right after it was covered).
  setPostEditFocusedPoint: (point) => set({ postEditFocusedPoint: point, postEditFocusedPointCovered: false }),
  setPostEditFocusedPointCovered: (covered) => set({ postEditFocusedPointCovered: covered }),
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
    const rotatedNodes = rotateSplitPointNodes(
      before, point, slotIds, direction, state.activeTessellationConfig,
      cellSet, floorNodes, state.postEditActiveSplitNode, state.postEditDraftSplitPoints, level,
    );
    if (rotatedNodes.length === 0) return;
    appendPostEditCommand(get, set, { kind: "rotateSplitPoint", point, level, nodes: rotatedNodes });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  applySplitBlueprint: (point, blueprint) => {
    const state = get();
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
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
    // needs is dropped entirely (not left empty); elements that referenced a dropped slot are
    // migrated to the original node after the blueprint command is applied.
    const slotsNeeded = Math.max(blueprint.nodeFaces.length - 1, 0);
    const reusedSlotIds = existingSlots.slice(0, slotsNeeded);
    // Slot ids beyond the reused ones are minted from the point's high-water mark (GitHub issue
    // #543 plan section 7), not reused positional indices — a point-reset can prune a
    // previously-issued high slotId out of the log while the mark stays put, so a fresh mint must
    // not reissue it.
    const nextMark = state._nextSplitSlotId[key] ?? 0;
    const freshSlotIds = Array.from({ length: Math.max(slotsNeeded - reusedSlotIds.length, 0) }, (_, i) => nextMark + i);
    const mintedSlotIds = [...reusedSlotIds, ...freshSlotIds];
    const slotEndpoints: PostEditEndpoint[] = mintedSlotIds.map((slotId) => splitEndpoint(point, slotId, level));
    const nodeEndpoints: PostEditEndpoint[] = [originalEndpoint, ...slotEndpoints].filter((e): e is PostEditEndpoint => e !== null);
    const targetForExistingEndpoint = (endpoint: PostEditEndpoint): PostEditEndpoint => {
      if (endpoint.kind === "split") {
        if (endpoint.point[0] !== point[0] || endpoint.point[1] !== point[1] || (endpoint.level ?? 0) !== (level ?? 0)) return endpoint;
        const oldIndex = existingSlots.indexOf(endpoint.slotId);
        return oldIndex >= 0 ? (nodeEndpoints[oldIndex + 1] ?? originalEndpoint ?? endpoint) : (originalEndpoint ?? endpoint);
      }
      const sourceNode = state.nodes.find((n) => n.id === endpoint.id)
        ?? state.postEditBaseline?.context.nodes.find((n) => n.id === endpoint.id);
      if (!sourceNode || sourceNode.x !== point[0] || sourceNode.y !== point[1] || (sourceNode.level ?? 0) !== (level ?? 0)) return endpoint;
      if (sourceNode.i === 0) return originalEndpoint ?? endpoint;
      const oldIndex = existingSlots.indexOf(sourceNode.i - 1);
      return oldIndex >= 0 ? (nodeEndpoints[oldIndex + 1] ?? originalEndpoint ?? endpoint) : (originalEndpoint ?? endpoint);
    };
    const remapEndpoint = (endpoint: PostEditEndpoint): PostEditEndpoint => targetForExistingEndpoint(endpoint);
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
      for (const authoredFaceIndex of blueprint.nodeFaces[nodeIndex]) {
        const faceIndex = resolveBlueprintFaceIndex(blueprint, state.activeTessellationConfig, point, authoredFaceIndex);
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

      // A blueprint changes node identity at a point, so every vertex element already attached to
      // one of the old nodes must be moved onto its corresponding new node.  Keep this as ordinary
      // per-element commands after the single blueprint command: the Changes log then shows one
      // split creation and one movement event per affected element, and replay/undo retain their
      // existing lifeline semantics.
      const current = get().postEditDerived;
      if (current) {
        const moveMeta = (slot: "start" | "finish", id: "s" | "f", endpoint: PostEditEndpoint | null) => {
          if (!endpoint) return;
          const target = remapEndpoint(endpoint);
          if (endpointsEqual(endpoint, target)) return;
          appendPostEditCommand(get, set, { kind: "setMeta", slot, id, endpoint: target, previousEndpoint: endpoint });
        };
        moveMeta("start", "s", current.meta.start);
        moveMeta("finish", "f", current.meta.finish);

        for (const teleport of current.teleports) {
          const from = remapEndpoint(teleport.from);
          const to = remapEndpoint(teleport.to);
          if (endpointsEqual(from, teleport.from) && endpointsEqual(to, teleport.to)) continue;
          appendPostEditCommand(get, set, {
            kind: "moveTeleportEndpoint", id: teleport.id,
            end: !endpointsEqual(from, teleport.from) ? "from" : "to",
            endpoint: !endpointsEqual(from, teleport.from) ? from : to,
            from, to, direction: teleport.direction,
          });
        }

        for (const passage of current.verticalPassages) {
          const from = remapEndpoint(passage.from);
          const to = remapEndpoint(passage.to);
          if (endpointsEqual(from, passage.from) && endpointsEqual(to, passage.to)) continue;
          appendPostEditCommand(get, set, {
            kind: "moveVerticalPassageEndpoint", id: passage.id, end: "from",
            endpoint: from, from, to, direction: passage.direction,
          });
        }

        for (const elevator of current.elevators) {
          const floors = elevator.floors.map(remapEndpoint);
          if (floors.every((target, i) => endpointsEqual(target, elevator.floors[i]))) continue;
          appendPostEditCommand(get, set, { kind: "updateElevatorFloors", id: elevator.id, floors });
        }
      }
    }
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  startPostEditVerticalPassagePlacement: (origin, tool) => {
    const state = get();
    // `origin` can be a `split`-kind endpoint (GitHub issue #550 ninth follow-up) — a plain
    // `origin.kind !== "node"` guard here used to silently drop every placement started from a split
    // point's numbered slot (the disambiguation dialog picks a slot fine, but this rejected it
    // outright), so `point`/`originLevel` are resolved from either kind: a `node` endpoint via its
    // confirmed coordinates, a `split` endpoint directly from its own `point`/`level` fields.
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const point: [number, number] = origin.kind === "node" ? [originNode!.x, originNode!.y] : origin.point;
    const originLevel = origin.kind === "node" ? (originNode!.level ?? 0) : (origin.level ?? 0);
    // Every click adds a new passage, even where one already exists (GitHub issue #748): a cell may
    // hold any number of elements. Editing an existing passage is the settings tool's job.
    const resolveFieldAt = resolveFieldAtOf(state);
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) return;
    if (availableDirections.length === 1) {
      tryCommitPostEditVerticalPassage(get, set, origin, tool, availableDirections[0]);
      return;
    }
    set({ postEditVerticalPassagePending: { origin, tool, availableDirections } });
  },

  choosePostEditVerticalPassageDirection: (direction) => {
    const pending = get().postEditVerticalPassagePending;
    if (!pending) return;
    tryCommitPostEditVerticalPassage(get, set, pending.origin, pending.tool, direction);
  },

  cancelPostEditVerticalPassagePlacement: () => set({ postEditVerticalPassagePending: null }),

  setPostEditVerticalPassageDirection: (id, direction) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target || target.direction === direction) return;
    appendPostEditCommand(get, set, {
      kind: "setVerticalPassageDirection", id, direction, from: target.from, to: target.to, absolute: true,
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

  movePostEditVerticalPassageEndpoint: (id, end, endpoint, otherEndpoint) => {
    const state = get();
    const target = state.postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target) return;
    // `endpoint` is normally `node`-kind (the plain landing node) but can now be a `split`-kind
    // pick (GitHub issue #567, when the user picked a numbered slot via `PostEditSplitTargetDialog`
    // for the dragged end's own landing point) — either way the real node id is resolved fresh via
    // `resolveEndpoint`/`buildSplitNodeResolver` to drive `resolveVerticalPassageMove`'s (x, y)
    // lookup; `endpoint` itself is passed through unchanged as the dragged end's own resulting form.
    const nodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
    const newNodeId = resolveEndpoint(endpoint, resolveSplit);
    const newNode = newNodeId !== undefined ? state.nodes.find((n) => n.id === newNodeId) : undefined;
    if (!newNode) return;
    // GitHub issue #566: dragging one end of a vertical passage must move BOTH ends to the same
    // (x, y) — `resolveVerticalPassageMove` resolves the OTHER end's own node on its own floor and
    // fails (reverting the whole gesture, no command appended) if that floor has no node there.
    // `otherEndpoint` (GitHub issue #567) is the user's own pick for that other floor when it also
    // turned out to be split — passed straight through instead of `findNodeAt`'s bare first-node
    // pick.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const resolved = resolveVerticalPassageMove(target, end, newNode, state.nodes, resolveNodeLevel, endpoint, otherEndpoint);
    if ("failure" in resolved) {
      set({ postEditDragFailureMessage: { ...resolved.failure, entityKind: "vertical_passage" } });
      return;
    }
    appendPostEditCommand(get, set, {
      kind: "moveVerticalPassageEndpoint", id, end, endpoint, from: resolved.from, to: resolved.to, direction: target.direction,
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  startPostEditElevatorPlacement: (origin) => {
    // `origin` can be a `split`-kind endpoint (GitHub issue #550 ninth follow-up) — a plain
    // `origin.kind !== "node"` guard here used to silently drop every placement started from a
    // split point's numbered slot. `point`/`originLevel` resolve from either kind: a `node`
    // endpoint via its confirmed coordinates, a `split` endpoint directly from its own fields.
    const state = get();
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const originLevel = origin.kind === "node" ? (originNode!.level ?? 0) : (origin.level ?? 0);
    // Always starts a new elevator, even on a node that already has one (GitHub issue #748).
    set({ postEditElevatorPending: { origin, floors: new Set([originLevel]) } });
  },

  // `floors` seeds from the entry's current floors so the dialog reflects real state, and confirming
  // updates the entry in place (GitHub issue #341 follow-up). Generation-baked elevators are full
  // baseline draft entries with their own ids (GitHub issue #564), so they are edited the same way.
  editPostEditElevator: (id, origin) => {
    const state = get();
    const existing = state.postEditDraftElevators.find((e) => e.id === id);
    if (!existing) return;
    const floors = new Set<number>();
    for (const f of existing.floors) {
      floors.add(f.kind === "node" ? (state.nodes.find((nd) => nd.id === f.id)?.level ?? 0) : (f.level ?? 0));
    }
    set({ postEditElevatorPending: { origin, floors, editingId: existing.id } });
  },

  togglePostEditElevatorFloor: (floorIndex) => {
    set((state) => {
      const pending = state.postEditElevatorPending;
      if (!pending) return {};
      const origin = pending.origin;
      const originLevel = origin.kind === "node" ? (state.nodes.find((n) => n.id === origin.id)?.level ?? 0) : (origin.level ?? 0);
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
    if (!pending || pending.floors.size < 2) return;
    const origin = pending.origin;
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const point: [number, number] = origin.kind === "node" ? [originNode!.x, originNode!.y] : origin.point;
    const levels = Array.from(pending.floors).sort((a, b) => a - b);
    // GitHub issue #567 second follow-up: any of the pending floors can independently be a split
    // point — checked here via the same maze-wide `pointNodeMap` the drag-commit path uses, BEFORE
    // falling back to `resolveActiveNodeIdAt`'s active/first-node default. Before this fix, a fresh
    // elevator placement whose target floor happened to already be split silently attached to
    // whichever node was "active" there (or the first one), the same ambiguity the drag-onto-
    // existing-endpoint case already got a dialog for.
    const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const { picks, queue } = resolveDragTargets(levels.map((level) => ({ point, level: level === 0 ? undefined : level })), pointNodeMap);
    if (queue.length > 0) {
      const first = queue[0];
      set({
        postEditSplitTargetPrompt: {
          point: first.point, level: first.level, nodeIds: first.nodeIds,
          action: { tool: "place_elevator", origin, levels, editingId: pending.editingId },
          queue, picks,
        },
      });
      return;
    }
    // Every floor resolved for free (none split) — same fallback `resolveActiveNodeIdAt` gave before
    // this fix for the single-confirmed-node/no-node cases (`resolveDragTargets` only fills `picks`
    // from a point's CONFIRMED nodes, same as `resolveActiveNodeIdAt`'s own `nodeIds` source).
    const floors = picks.filter((p): p is PostEditEndpoint => p !== undefined);
    if (floors.length < 2) return;
    dispatchPostEditElevatorPlacement(get, set, pending.editingId, floors);
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

  movePostEditElevatorEndpoint: (id, level, endpoint, otherEndpoints) => {
    const state = get();
    const target = state.postEditDraftElevators.find((e) => e.id === id);
    if (!target) return;
    // `endpoint` is normally `node`-kind (the plain landing node) but can now be a `split`-kind
    // pick (GitHub issue #567, when the user picked a numbered slot for the dragged floor's own
    // landing point) — resolve the real node id fresh via `resolveEndpoint`/`buildSplitNodeResolver`
    // to drive `resolveElevatorMove`'s (x, y) lookup; `endpoint` itself passes through unchanged.
    const nodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
    const newNodeId = resolveEndpoint(endpoint, resolveSplit);
    const newNode = newNodeId !== undefined ? state.nodes.find((n) => n.id === newNodeId) : undefined;
    if (!newNode) return;
    // GitHub issue #566: dragging one floor's marker moves every OTHER floor's own endpoint to the
    // same (x, y) too — reuses `updateElevatorFloors`, no dedicated command kind needed since it
    // already carries the full resulting `floors` array. `otherEndpoints` (GitHub issue #567) are
    // the user's own picks for whichever OTHER floors also turned out split, keyed by level —
    // passed straight through `resolveElevatorMove`'s override map instead of `findNodeAt`'s bare
    // first-node pick.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const overridesByLevel = new Map<number, PostEditEndpoint>([[level, endpoint], ...(otherEndpoints ?? []).map((o): [number, PostEditEndpoint] => [o.level, o.endpoint])]);
    const resolved = resolveElevatorMove(target, { id, level }, newNode, state.nodes, resolveNodeLevel, overridesByLevel);
    if ("failure" in resolved) {
      set({ postEditDragFailureMessage: { ...resolved.failure, entityKind: "elevator" } });
      return;
    }
    // `resolved.own`/`.others` are already the correct final `PostEditEndpoint` for each floor —
    // either the user's own explicit pick (already the right node/split kind) or a plain
    // `nodeEndpoint` from `findNodeAt`. No re-wrap needed: unlike before GitHub issue #567, a
    // floor's resulting kind is decided by what it actually resolved to this move, not by whether
    // it happened to be split-addressed BEFORE the move.
    const floors = target.floors.map((f) => {
      const floorLevel = f.kind === "node" ? (resolveNodeLevel(f.id) ?? 0) : (f.level ?? 0);
      return floorLevel === level ? resolved.own : (resolved.others.get(floorLevel) ?? f);
    });
    appendPostEditCommand(get, set, { kind: "updateElevatorFloors", id, floors });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  dismissPostEditDragFailureMessage: () => set({ postEditDragFailureMessage: null }),

  requestPostEditSplitTarget: (prompt) => set({ postEditSplitTargetPrompt: prompt }),

  cancelPostEditSplitTarget: () => set({ postEditSplitTargetPrompt: null, postEditDragOverride: null }),

  applyPostEditSplitTargetPick: (nodeId) => {
    const prompt = get().postEditSplitTargetPrompt;
    if (!prompt) return;
    // `nodeId` is a resolved `NodeId` — when the picked cell is a split point, that id may belong to
    // one of its numbered slots, not the original node. Resolving it through `resolveNodeIdToEndpoint`
    // (built fresh from live `state.nodes`/`postEditDraftSplitPoints`, same as `confirmPostEdit`'s
    // own resolver) turns it back into a proper `splitEndpoint(...)` in that case, so the resulting
    // teleport/vertical-passage/elevator/start/finish is recorded against the actual slot the user
    // picked. A bare `nodeEndpoint(nodeId)` here silently dropped every such entity from the delete
    // dialog's slot rows — `buildPostEditPointEntities` never matches a `node`-kind endpoint whose id
    // is a slot's resolved id against `nodesHere`'s own `splitEndpoint(...)` entry for that slot.
    const state = get();
    const endpoint = resolveNodeIdToEndpoint(state.nodes, state.postEditDraftSplitPoints, nodeId);
    const { action } = prompt;

    // GitHub issue #567: a `move_*`/`place_*` action defers a drag commit or a fresh placement
    // through a QUEUE of split points (see `postEditSplitTargetPrompt`'s own doc comment) — this
    // pick fills one slot of `picks` rather than dispatching immediately. `queue`/`picks` are
    // always present together for these five tools (the caller never opens one without the other).
    if (
      action.tool === "move_teleport_endpoint" || action.tool === "move_vertical_passage_endpoint" || action.tool === "move_elevator_endpoint"
      || action.tool === "place_vertical_passage" || action.tool === "place_elevator"
    ) {
      const queue = prompt.queue ?? [];
      const picks = [...(prompt.picks ?? [])];
      // `queue[0]` is always the point currently on screen (`PostEditController`/the slice action
      // that opened the prompt keeps `queue` un-shifted, mirroring `point`/`level`/`nodeIds` in its
      // own `[0]` — see `postEditSplitTargetPrompt`'s doc comment) — always defined here, since the
      // prompt is only ever opened with at least that one entry.
      const current = queue[0];
      const targetIndex = current ? current.targetIndex : 0;
      picks[targetIndex] = endpoint;
      const rest = queue.slice(1);
      if (rest.length > 0) {
        const next = rest[0];
        set({ postEditSplitTargetPrompt: { ...prompt, point: next.point, level: next.level, nodeIds: next.nodeIds, queue: rest, picks } });
        return;
      }
      // The queue is fully resolved now — clear the drag override too (see `PostEditController`'s
      // pointerup handlers for why it was left alone while the prompt was open): the `move_*`
      // dispatch below writes the final position straight into the draft, so the renderer no longer
      // needs the override to show it.
      set({ postEditSplitTargetPrompt: null, postEditDragOverride: null });
      if (action.tool === "move_teleport_endpoint") {
        const target = picks[0];
        if (target) get().movePostEditTeleportEndpoint(action.id, action.end, target);
      } else if (action.tool === "move_vertical_passage_endpoint") {
        const own = picks[0];
        const other = picks[1];
        if (own) get().movePostEditVerticalPassageEndpoint(action.id, action.end, own, other);
      } else if (action.tool === "move_elevator_endpoint") {
        const resolved = action.levels.map((level, i) => ({ level, endpoint: picks[i] })).filter((r): r is { level: number; endpoint: PostEditEndpoint } => r.endpoint !== undefined);
        if (resolved.length === action.levels.length) get().movePostEditElevatorEndpoint(action.id, resolved[0].level, resolved[0].endpoint, resolved.slice(1));
      } else if (action.tool === "place_vertical_passage") {
        const to = picks[0];
        if (to) commitPostEditVerticalPassage(get, set, action.origin, action.passageTool, action.direction, to);
      } else {
        const floors = picks.filter((p): p is PostEditEndpoint => p !== undefined);
        if (floors.length === action.levels.length) dispatchPostEditElevatorPlacement(get, set, action.editingId, floors);
      }
      return;
    }

    // Clears `postEditDragOverride` too, not just the prompt — a `set_start`/`set_finish` pick can
    // originate from a marker drag onto a split tile (GitHub issue #567 follow-up), whose in-flight
    // drag preview left an override pointing at the ORIGINAL (pre-dialog) resolved node; leaving it
    // set after this dispatch made the renderer keep showing the marker there until something else
    // happened to clear it later, even though `setPostEditEndpoint` below already wrote the
    // genuinely-picked node into the draft. Harmless no-op for every other `action.tool` here, none
    // of which touch a drag override.
    set({ postEditSplitTargetPrompt: null, postEditDragOverride: null });
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
            resolveNodeIdToEndpoint(state.nodes, state.postEditDraftSplitPoints, pendingFrom),
            endpoint,
            action.tool === "teleport_two_way" ? "two_way" : "forward",
          );
        }
        break;
      }
    }
  },

  setPostEditChangesOpen: (open) => set({ postEditChangesOpen: open }),

  setPostEditChangesEntityFilter: (id) => set({ postEditChangesEntityFilter: id }),

  setPostEditDragOverride: (override) => {
    if (postEditDragOverridesEqual(get().postEditDragOverride, override)) return;
    set({ postEditDragOverride: override });
  },
});

/** Starts carrying `descriptor` (move) or opens its settings surface (settings) — GitHub issue #748. */
function actOnPostEditEntity(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore>) => void,
  purpose: EntityToolPurpose,
  descriptor: PostEditPointEntityDescriptor,
): void {
  if (purpose === "move") set({ postEditMoveRequest: descriptor });
  else get().openPostEditEntitySettings(descriptor);
}
