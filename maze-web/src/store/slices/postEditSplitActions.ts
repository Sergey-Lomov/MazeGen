import type { StateCreator } from "zustand";
import type { MazeStore, PostEditState, PostEditActions } from "../storeTypes";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import * as m from "~/paraglide/messages";
import { rotateSplitPointNodes } from "../../pixi/postEditRotation";
import { type PostEditEndpoint, type PostEditHoveredEntity, nodeEndpoint, splitEndpoint, endpointsEqual, resolvePostEditPartnerAt } from "../../pixi/postEditEndpoint";
import { cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildActiveCells } from "../../pixi/selectors/fieldSelectors";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import { resolveFaceNeighbor } from "../../pixi/faceNeighbors";
import type { ResolvedSplitFace, ResolvedSplitSlot } from "../postEditCommandTypes";
import { activeFloorField, activeFloorLevel } from "../storeHelpers";
import { appendPostEditCommand, removePostEditSplitSlots } from "./postEditSliceHelpers";
import { formatPostEditId } from "../../pixi/postEditIdFormat";
import { notify } from "../../notifications/notificationStore";
import { notifyEditRefusal, SPLIT_FACE_OWNER_AMBIGUOUS, SPLIT_ROTATION_OUTSIDE_FIELD } from "../../notifications/editRefusalNotifications";

const REMOVE_ENDPOINT_NODE_REJECTED = "post_edit.remove_endpoint_node_rejected";
registerNotificationCode(REMOVE_ENDPOINT_NODE_REJECTED, { category: "notice", message: () => m[REMOVE_ENDPOINT_NODE_REJECTED]() });

type Creator = StateCreator<MazeStore, [], [], PostEditState & PostEditActions>;
type CreatorSet = Parameters<Creator>[0];
type CreatorGet = Parameters<Creator>[1];

export const createPostEditSplitActions = (set: CreatorSet, get: CreatorGet): Pick<PostEditActions, "addSplitNode" | "removeSplitNode" | "cycleActiveSplitNode" | "setActiveSplitNode" | "setPostEditFocusedPoint" | "setPostEditFocusedPointCovered" | "setPostEditHoveredEntity" | "rotateSplitPoint" | "applySplitBlueprint"> => ({
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
    const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeFieldConfig);
    const cellSet = buildCellSet(cells);
    const floorNodes = state.nodes.filter((n) => (n.level ?? 0) === (level ?? 0));
    const before = state.postEditDraftEdges;
    const rotatedNodes = rotateSplitPointNodes(
      before, point, slotIds, direction, state.activeFieldConfig,
      cellSet, floorNodes, state.postEditActiveSplitNode, state.postEditDraftSplitPoints, level,
    );
    if (rotatedNodes.refusalReason) {
      notifyEditRefusal(
        "post_edit",
        rotatedNodes.refusalReason === "outside_field" ? SPLIT_ROTATION_OUTSIDE_FIELD : SPLIT_FACE_OWNER_AMBIGUOUS,
      );
      return;
    }
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

    const { offsets } = getNeighborData(state.activeFieldConfig, point[0], point[1]);
    const field = activeFloorField(state);
    const cells = buildActiveCells(field.fieldPoints, field.fieldEditMode, state.activeFieldConfig);
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
        // (normal UI flow always picks one via `blueprintsFor`, so this only matters for
        // a direct/programmatic `applySplitBlueprint` call) — `offsets[faceIndex]` would
        // otherwise be `undefined` and the destructure below would throw.
        if (faceIndex >= offsets.length) continue;
        const neighbor = resolveFaceNeighbor(state.activeFieldConfig, point, faceIndex, inFieldCells);
        if (neighbor === null) continue;
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
});
