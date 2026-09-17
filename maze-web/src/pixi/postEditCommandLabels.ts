import type { NodeDto } from "../wasm/types";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditEndpoint } from "./postEditEndpoint";
import { messageForTitleKey } from "./splitPatternTitles";
import * as m from "~/paraglide/messages";

/** One row of the "Changes" panel (GitHub issue #545) — a human-readable action + the entity it
 *  applies to, derived from a single `PostEditCommand`. Formatted in terms of point coordinates
 *  (never a raw `NodeId`, which isn't stable/meaningful to a user) — mirrors the cell-inspector
 *  status line's `"x:3, y:5"` convention (`cellInspection.ts`'s `buildCellInspection`), the
 *  established "how a point is shown to the user" precedent in this codebase. */
export interface PostEditCommandLabel {
  action: string;
  entity: string;
}

/** Resolves a `PostEditEndpoint` to its point coordinates + floor. A `node` endpoint is looked up
 *  in `nodeById`; a `split` endpoint already carries its own point/level. Returns `null` for a
 *  `node` endpoint whose id isn't in `nodeById` (not yet confirmed, or from a stale command after
 *  a point-reset pruned the node it referenced — same "nothing to resolve yet" case documented on
 *  `resolveEndpoint`). */
function endpointPoint(ep: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>): { x: number; y: number; level: number } | null {
  if (ep.kind === "node") {
    const node = nodeById.get(ep.id);
    return node ? { x: node.x, y: node.y, level: node.level ?? 0 } : null;
  }
  return { x: ep.point[0], y: ep.point[1], level: ep.level ?? 0 };
}

function formatPoint(p: { x: number; y: number; level: number } | null): string {
  if (p === null) return "?";
  return p.level === 0
    ? m["post_edit.changes_entity_point"]({ x: p.x, y: p.y })
    : m["post_edit.changes_entity_point_floor"]({ x: p.x, y: p.y, floor: p.level + 1 });
}

function formatSplitNode(point: [number, number], level: number | undefined): string {
  const lvl = level ?? 0;
  return lvl === 0
    ? m["post_edit.changes_entity_split_node"]({ x: point[0], y: point[1] })
    : m["post_edit.changes_entity_split_node_floor"]({ x: point[0], y: point[1], floor: lvl + 1 });
}

function formatEndpoint(ep: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>): string {
  return formatPoint(endpointPoint(ep, nodeById));
}

function formatEdge(from: PostEditEndpoint, to: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>): string {
  return m["post_edit.changes_entity_edge"]({ from: formatEndpoint(from, nodeById), to: formatEndpoint(to, nodeById) });
}

/** "L1, L3, L4"-style floor list — same `L${level + 1}` convention the cell-inspector status line
 *  uses (`cellInspection.ts`'s `formatFloor`), sorted ascending regardless of the command's own
 *  `floors` order. Endpoints that don't resolve yet are dropped rather than shown as "?" — a
 *  floor list reads better short than cluttered with placeholders for a split node not yet
 *  confirmed. */
function formatElevatorFloors(floors: readonly PostEditEndpoint[], nodeById: ReadonlyMap<number, NodeDto>): string {
  const levels = floors
    .map((ep) => endpointPoint(ep, nodeById)?.level)
    .filter((level): level is number => level !== undefined);
  return [...new Set(levels)].sort((a, b) => a - b).map((level) => `L${level + 1}`).join(", ");
}

/** Builds the `nodeById` map `postEditCommandLabel` needs, from the confirmed node snapshot
 *  (`state.nodes`) — the same lookup basis `ManageSplitNodesDialog`/`PostEditController` use for
 *  resolving a `node` endpoint back to its point. */
export function buildNodeByIdMap(nodes: readonly NodeDto[]): Map<number, NodeDto> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Formats one `PostEditCommand` for the "Changes" panel. `nodeById` must be built from the
 *  confirmed node snapshot (`buildNodeByIdMap`) — an endpoint that doesn't resolve yet (a
 *  not-yet-confirmed split node) falls back to `"?"` rather than throwing, same "nothing to
 *  resolve yet" tolerance every other endpoint consumer has. */
export function postEditCommandLabel(command: PostEditCommand, nodeById: ReadonlyMap<number, NodeDto>): PostEditCommandLabel {
  switch (command.kind) {
    case "setEdge": {
      const actionKey = command.edgeKind === "wall"
        ? "post_edit.changes_action_set_edge_wall"
        : command.edgeKind === "basic"
        ? "post_edit.changes_action_set_edge_passage"
        : "post_edit.changes_action_set_edge_one_way";
      return { action: m[actionKey](), entity: formatEdge(command.from, command.to, nodeById) };
    }
    case "setEdgePair": {
      if (command.aToB === "wall" && command.bToA === "wall") {
        return { action: m["post_edit.changes_action_set_edge_wall"](), entity: formatEdge(command.a, command.b, nodeById) };
      }
      if (command.aToB === "basic" && command.bToA === "basic") {
        return { action: m["post_edit.changes_action_set_edge_passage"](), entity: formatEdge(command.a, command.b, nodeById) };
      }
      // One-way: whichever side is `one_way_forward` is the direction traffic actually flows.
      const [from, to] = command.aToB === "one_way_forward" ? [command.a, command.b] : [command.b, command.a];
      return { action: m["post_edit.changes_action_set_edge_one_way"](), entity: formatEdge(from, to, nodeById) };
    }
    case "addTeleport":
      return { action: m["post_edit.changes_action_add_teleport"](), entity: m["post_edit.changes_entity_teleport"]({ id: command.id }) };
    case "setTeleportDirection":
      return { action: m["post_edit.changes_action_set_teleport_direction"](), entity: m["post_edit.changes_entity_teleport"]({ id: command.id }) };
    case "moveTeleportEndpoint":
      return { action: m["post_edit.changes_action_move_teleport_endpoint"](), entity: m["post_edit.changes_entity_teleport"]({ id: command.id }) };
    case "removeTeleport":
      return { action: m["post_edit.changes_action_remove_teleport"](), entity: m["post_edit.changes_entity_teleport"]({ id: command.id }) };
    case "setMeta": {
      const set = command.endpoint !== null;
      const action = command.slot === "start"
        ? (set ? m["post_edit.changes_action_set_start"]() : m["post_edit.changes_action_clear_start"]())
        : (set ? m["post_edit.changes_action_set_finish"]() : m["post_edit.changes_action_clear_finish"]());
      return { action, entity: command.endpoint !== null ? formatEndpoint(command.endpoint, nodeById) : "" };
    }
    case "addSplitNode":
      return { action: m["post_edit.changes_action_add_split_node"](), entity: formatSplitNode(command.point, command.level) };
    case "removeSplitNode":
      return { action: m["post_edit.changes_action_remove_split_node"](), entity: formatSplitNode(command.point, command.level) };
    case "rotateSplitPoint":
      return { action: m["post_edit.changes_action_rotate_split_point"](), entity: formatSplitNode(command.point, command.level) };
    case "applySplitBlueprint": {
      const action = command.blueprintTitleKey
        ? m["post_edit.changes_action_apply_split_blueprint_named"]({ name: messageForTitleKey(command.blueprintTitleKey) })
        : m["post_edit.changes_action_apply_split_blueprint"]();
      return { action, entity: formatSplitNode(command.point, command.level) };
    }
    case "updateSplitNodeFaces":
      return { action: m["post_edit.changes_action_update_split_node_faces"](), entity: formatSplitNode(command.point, command.level) };
    case "addVerticalPassage":
      return { action: m["post_edit.changes_action_add_vertical_passage"](), entity: m["post_edit.changes_entity_vertical_passage"]({ id: command.id }) };
    case "setVerticalPassageDirection":
      return { action: m["post_edit.changes_action_set_vertical_passage_direction"](), entity: m["post_edit.changes_entity_vertical_passage"]({ id: command.id }) };
    case "moveVerticalPassageEndpoint":
      return { action: m["post_edit.changes_action_move_vertical_passage_endpoint"](), entity: m["post_edit.changes_entity_vertical_passage"]({ id: command.id }) };
    case "removeVerticalPassage":
      return { action: m["post_edit.changes_action_remove_vertical_passage"](), entity: m["post_edit.changes_entity_vertical_passage"]({ id: command.id }) };
    case "addElevator":
      return {
        action: m["post_edit.changes_action_add_elevator"](),
        entity: m["post_edit.changes_entity_elevator_floors"]({ id: command.id, floors: formatElevatorFloors(command.floors, nodeById) }),
      };
    case "updateElevatorFloors":
      return {
        action: m["post_edit.changes_action_update_elevator_floors"](),
        entity: m["post_edit.changes_entity_elevator_floors"]({ id: command.id, floors: formatElevatorFloors(command.floors, nodeById) }),
      };
    case "removeElevator":
      return { action: m["post_edit.changes_action_remove_elevator"](), entity: m["post_edit.changes_entity_elevator"]({ id: command.id }) };
    case "suppressGenerationPair":
      return { action: m["post_edit.changes_action_suppress_generation_pair"](), entity: formatEdge(command.a, command.b, nodeById) };
  }
}
