import type { NodeDto } from "../wasm/types";
import { endpointsEqual, splitEndpoint, nodeEndpoint, type PostEditEndpoint } from "./postEditEndpoint";
import type { PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry, PostEditMeta, PostEditEdge } from "../store/postEditTypes";
import { endpointBubble, splitPointBubble, type PostEditEntityBubble } from "./postEditCommandLabels";
import type { SplitLabelContext } from "./postEditSplitLabels";
import * as m from "~/paraglide/messages";

export type PostEditPointEntityKind = "start" | "finish" | "teleport" | "vertical_passage" | "elevator" | "one_way" | "split_point";

/** A single removable entity anchored on a post-edit point, built for the delete-tool picker dialog
 *  (GitHub issue #550, mirroring the preset-side dialog from #540). Pure data — no mutation here; the
 *  store action (`removePostEditPointEntity`) maps `kind`+`id` back to the existing per-entity
 *  remover. `id` is stable and `kind`-scoped (teleport/vertical-passage/elevator's own string id,
 *  `"start"`/`"finish"` for the marker kind itself, `"split_point"` for the whole tile) — at most one
 *  row of each kind per point. A split point gets exactly ONE row for its entire tile, never one per
 *  slot (GitHub issue #550 follow-up: per-slot removal already has its own dedicated surface, the
 *  "Manage split nodes" panel — this dialog's job is "what can I delete from this point", and the
 *  split's own on/off state is the one binary choice that belongs here, not a slot-by-slot picker
 *  duplicating the other panel). Removing this row un-splits the point entirely via
 *  `removePostEditSplitSlots`, the same whole-point removal `deletePostEditPoint`/"Delete all" use.
 *
 *  `entityId`/`bubbles` mirror the "Changes" panel's own row shape (`PostEditCommandLabel`, GitHub
 *  issue #550 fourth follow-up: "the same as in the changes log") — built with the exact same
 *  `endpointBubble`/`splitPointBubble` helpers `postEditCommandLabel` itself uses, so a row here
 *  looks identical to that entity's own log rows (same id bubble, same coordinate bubble text). A
 *  `start`/`finish` row has no id of its own (`entityId: undefined`, same as `entityIdOf` returns
 *  for `setMeta`).
 *
 *  `showArrow`/`arrow` (same fields `PostEditCommandLabel` carries, GitHub issue #550 fifth
 *  follow-up) drive a plain text arrow glyph between `bubbles[0]`/`bubbles[1]` for a teleport/
 *  vertical passage — the row's own floor-target text (a parenthetical like "(3, 4)"/"(L2)") is
 *  dropped from `title` entirely now that the arrow+bubbles pair already shows both ends and their
 *  direction, the same "the entity/direction lives in the bubbles, not the title" split the Changes
 *  panel already uses for these two kinds. `false`/`"->".` for every other kind (only two fixed
 *  bubbles ever get an arrow — an elevator's 2+ floor bubbles have no single "from/to" pair to draw
 *  one between).
 *
 *  `bubbles[0]` is always the point currently being edited (`endpoint` — GitHub issue #550 sixth
 *  follow-up), never a fixed from/to order — a teleport/vertical passage row reorders its own pair
 *  (and flips nothing else: `arrow`/`showArrow` are computed relative to this same endpoint-first
 *  order, so the glyph still reads correctly), and an elevator row moves this floor's own bubble to
 *  the front of the list, so every row's first bubble is always "here," matching what the user just
 *  clicked.
 *
 *  `one_way` (GitHub issue #550 eighth follow-up) is a face — not vertex — entity, the one exception
 *  to this dialog's original "vertex-anchored content only" scope (`Specs/post-edit.md`'s `delete`
 *  Tool Detail): a one-way passage on one of the point's own faces is still something the user
 *  reasonably expects to remove from here, so it gets its own row like everything else, keyed by the
 *  one-way's own stable id (`entityId`, same `oneWay:${id}` lifeline `postEditCommandLabel` shows).
 *  `otherEndpoint` (only ever set for this kind) is the face's OTHER side — `removePostEditPointEntity`
 *  needs both ends to reset the exact face, unlike every other kind here which only ever needs
 *  `endpoint`. Removing it resets the face to its generation-time state (`applyPostEditToolAt`'s own
 *  "reset" tool, the same action a right-click on the face's edge already performs), never a bare
 *  "make it a wall" — a one-way carved out of a generation-time passage reverts to that passage, not
 *  to a wall. */
export interface PostEditPointEntityDescriptor {
  kind: PostEditPointEntityKind;
  id: string;
  endpoint: PostEditEndpoint;
  /** The other side of a `one_way` row's own face — `undefined` for every other kind. */
  otherEndpoint?: PostEditEndpoint;
  title: string;
  entityId: string | undefined;
  bubbles: PostEditEntityBubble[];
  showArrow: boolean;
  arrow: "->" | "<-" | "<->";
}

function formatFloor(level: number): string {
  return `L${level + 1}`;
}

export interface PostEditPointEntitiesInput {
  postEditDraftSplitPoints: Record<string, number[]>;
  postEditDraftMeta: PostEditMeta | null;
  postEditDraftTeleports: PostEditTeleportEntry[];
  postEditDraftVerticalPassages: PostEditVerticalPassageEntry[];
  postEditDraftElevators: PostEditElevatorEntry[];
  /** Scanned for one-way faces touching one of `nodesHere` (GitHub issue #550 eighth follow-up) —
   *  keyed by `edgeKey(from, to)`, same `Record` `applyPostEditToolAt` itself reads/writes. */
  postEditDraftEdges: Record<string, PostEditEdge>;
  /** Resolves any `PostEditEndpoint` (node or split) to its own floor level (0-based, matching
   *  `activeFloorLevel`'s "undefined = floor 0" convention) — a `node` endpoint needs a lookup
   *  against the confirmed snapshot; a `split` endpoint carries its own `level` field directly. */
  nodeLevel: (ep: PostEditEndpoint) => number;
  /** Same three inputs `postEditCommandLabel` takes, threaded through so this dialog's own rows can
   *  build `entityId`/coordinate bubbles with the exact same helpers (GitHub issue #550 fourth
   *  follow-up: "the same as in the changes log"). */
  nodeById: ReadonlyMap<number, NodeDto>;
  multiFloor: boolean;
  splitCtx: SplitLabelContext | null;
}

/** Builds the removable-entity list for the post-edit delete-tool picker dialog (GitHub issue
 *  #550) — every node of `point` (the original node plus every declared split slot) contributes
 *  its own start/finish/teleport/vertical-passage/elevator rows, plus one row per declared split
 *  tile as one whole ("delete this row" un-splits the point entirely via `removePostEditSplitSlots`
 *  — per-slot removal stays "Manage split nodes"' own job, GitHub issue #550 follow-up). Never
 *  touches edges — the delete tool only ever applies to vertex-anchored content, matching the
 *  issue's own scope decision ("connections rendered on cell edges are not affected"). `nodesHere`
 *  is every real `PostEditEndpoint` currently at the point (the original node's endpoint first, then
 *  each declared slot in the same order `slotIds` lists them) — callers build it once per
 *  point/level so this function stays geometry-free. */
export function buildPostEditPointEntities(
  nodesHere: PostEditEndpoint[],
  slotIds: number[],
  input: PostEditPointEntitiesInput,
): PostEditPointEntityDescriptor[] {
  const {
    postEditDraftMeta, postEditDraftTeleports, postEditDraftVerticalPassages, postEditDraftElevators, postEditDraftEdges, nodeLevel,
    nodeById, multiFloor, splitCtx,
  } = input;
  const oneWayEdges = Object.values(postEditDraftEdges).filter(
    (e): e is Extract<PostEditEdge, { kind: "one_way_forward" | "one_way_backward" }> => e.kind === "one_way_forward" || e.kind === "one_way_backward",
  );
  const out: PostEditPointEntityDescriptor[] = [];
  const seen = new Set<string>();

  for (const endpoint of nodesHere) {
    if (postEditDraftMeta?.start && endpointsEqual(postEditDraftMeta.start, endpoint) && !seen.has("start")) {
      seen.add("start");
      out.push({ kind: "start", id: "start", endpoint, title: m["status.cell_start"](), entityId: undefined, bubbles: [endpointBubble(endpoint, nodeById, multiFloor, splitCtx)], showArrow: false, arrow: "->" });
    }
    if (postEditDraftMeta?.finish && endpointsEqual(postEditDraftMeta.finish, endpoint) && !seen.has("finish")) {
      seen.add("finish");
      out.push({ kind: "finish", id: "finish", endpoint, title: m["status.cell_finish"](), entityId: undefined, bubbles: [endpointBubble(endpoint, nodeById, multiFloor, splitCtx)], showArrow: false, arrow: "->" });
    }

    for (const t of postEditDraftTeleports) {
      const departingHere = endpointsEqual(t.from, endpoint);
      const arrivingHere = endpointsEqual(t.to, endpoint);
      if (!departingHere && !arrivingHere) continue;
      const dedupKey = `teleport:${t.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const isForward = departingHere === (t.direction !== "backward");
      const arrow = t.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
      const other = departingHere ? t.to : t.from;
      const bubbles = [endpointBubble(endpoint, nodeById, multiFloor, splitCtx), endpointBubble(other, nodeById, multiFloor, splitCtx)];
      out.push({ kind: "teleport", id: t.id, endpoint, title: m["post_edit.entity_delete_label_teleport"](), entityId: t.id, bubbles, showArrow: true, arrow });
    }

    for (const v of postEditDraftVerticalPassages) {
      const departingHere = endpointsEqual(v.from, endpoint);
      const arrivingHere = endpointsEqual(v.to, endpoint);
      if (!departingHere && !arrivingHere) continue;
      const dedupKey = `vertical_passage:${v.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const isForward = departingHere === (v.direction !== "backward");
      const arrow = v.direction === "two_way" ? "<->" : isForward ? "->" : "<-";
      const other = departingHere ? v.to : v.from;
      const bubbles = [endpointBubble(endpoint, nodeById, multiFloor, splitCtx), endpointBubble(other, nodeById, multiFloor, splitCtx)];
      out.push({ kind: "vertical_passage", id: v.id, endpoint, title: m["post_edit.entity_delete_label_vertical_passage"](), entityId: v.id, bubbles, showArrow: true, arrow });
    }

    for (const e of postEditDraftElevators) {
      if (!e.floors.some((f) => endpointsEqual(f, endpoint))) continue;
      const dedupKey = `elevator:${e.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const targetLevels = [...new Set(e.floors.filter((f) => !endpointsEqual(f, endpoint)).map((f) => nodeLevel(f)))].sort((a, b) => a - b);
      if (targetLevels.length === 0) continue;
      const orderedFloors = [endpoint, ...e.floors.filter((f) => !endpointsEqual(f, endpoint))];
      const bubbles = orderedFloors.map((f) => endpointBubble(f, nodeById, multiFloor, splitCtx));
      out.push({ kind: "elevator", id: e.id, endpoint, title: m["status.cell_elevator"]({ targets: targetLevels.map(formatFloor).join(", ") }), entityId: e.id, bubbles, showArrow: false, arrow: "->" });
    }

    // One-way faces touching this node (GitHub issue #550 eighth follow-up) — a face-anchored
    // exception to this dialog's otherwise vertex-only scope, see the interface doc comment above.
    // `entry.from`/`entry.to` are always this recorded side's own direction (`applyPostEditToolAt`
    // only ever writes `one_way_forward`, meaning traffic flows `from -> to` on this exact record —
    // `one_way_backward` is a defensive union member never actually produced, see `PostEditEdge`'s
    // own doc comment), so `departingHere`/`arrivingHere` below read the record's `kind` as fixed
    // ("forward" already means "this from/to pair", never "flip them") rather than re-deriving a
    // direction from it.
    for (const edge of oneWayEdges) {
      const departingHere = endpointsEqual(edge.from, endpoint);
      const arrivingHere = endpointsEqual(edge.to, endpoint);
      if (!departingHere && !arrivingHere) continue;
      const dedupKey = `one_way:${edge.id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const other = departingHere ? edge.to : edge.from;
      const arrow = departingHere ? "->" : "<-";
      const bubbles = [endpointBubble(endpoint, nodeById, multiFloor, splitCtx), endpointBubble(other, nodeById, multiFloor, splitCtx)];
      out.push({
        kind: "one_way", id: edge.id, endpoint, otherEndpoint: other,
        title: m["post_edit.entity_delete_label_one_way"](), entityId: edge.id, bubbles, showArrow: true, arrow,
      });
    }
  }

  // One row for the whole split tile (GitHub issue #550 follow-up), not one per slot — `endpoint` is
  // the point's original node (`nodesHere[0]`, always present whenever `slotIds` is non-empty), used
  // only as a stable anchor for hover-highlight; the actual removal (`removePostEditPointEntity`)
  // acts on every one of the point's slots at once, never just this one endpoint. No `entityId` here
  // (same as `rotateSplitPoint`'s own log row — a whole-tile action, not one entity's own id).
  if (slotIds.length > 0) {
    const original = nodesHere[0];
    const originalNode = original.kind === "node" ? nodeById.get(original.id) : undefined;
    const anchorPoint: [number, number] = originalNode ? [originalNode.x, originalNode.y] : [0, 0];
    const anchorLevel = nodeLevel(original);
    out.push({
      kind: "split_point",
      id: "split_point",
      endpoint: original,
      title: m["status.cell_split_point"](),
      entityId: undefined,
      bubbles: [splitPointBubble(anchorPoint, anchorLevel, multiFloor)],
      showArrow: false,
      arrow: "->",
    });
  }

  return out;
}

/** Convenience for callers that only have real node ids (no split-shape awareness) — wraps
 *  `nodeEndpoint` for the point's original node and `splitEndpoint` for each declared slot, in the
 *  same order `buildPostEditPointEntities` expects. */
export function postEditNodesAt(originalId: number, point: [number, number], slotIds: number[], level?: number): PostEditEndpoint[] {
  return [nodeEndpoint(originalId), ...slotIds.map((slotId) => splitEndpoint(point, slotId, level))];
}
