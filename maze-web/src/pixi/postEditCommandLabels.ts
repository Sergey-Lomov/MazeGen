import type { NodeDto } from "../wasm/types";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry } from "../store/postEditTypes";
import { type PostEditEndpoint, type PostEditHoveredEntity, type PostEditHoverPoint, resolveEndpointToHoverPoint } from "./postEditEndpoint";
import { messageForTitleKey } from "./splitPatternTitles";
import * as m from "~/paraglide/messages";

/** One entity bubble in a "Changes" panel row (GitHub issue #546) — `text` is the same `Lf:x:y`/
 *  `x:y` coordinate convention the debug event tree's own bubbles use (`bubbleLabel`,
 *  `debugRowText.ts`), never a raw `NodeId`/entity id. `highlight` (when non-`null`) drives the
 *  bubble's hover-to-canvas-highlight, mirroring `DebugRefBubble`'s own hoverable-bubble pattern —
 *  a plain `point` for a single-point bubble, or `points` for a bubble naming several floors of the
 *  same coordinate at once (an elevator's or vertical passage's combined bubble, GitHub issue #546
 *  follow-up). `null` for a bubble naming an entity the log no longer has enough information to
 *  highlight — a removed/dangling id with no live draft entry left to resolve a point from. */
export interface PostEditEntityBubble {
  text: string;
  highlight: PostEditHoveredEntity | null;
}

/** One row of the "Changes" panel (GitHub issue #545, bubbles added by #546) — a human-readable
 *  action plus one or two entity bubbles (two for an edge/link-shaped entity, connected by an
 *  arrow — same "from -> to" bubble pair `SplitNodesDialogView`'s link bubbles use; one or more,
 *  unconnected, otherwise), derived from a single `PostEditCommand`. */
export interface PostEditCommandLabel {
  action: string;
  bubbles: PostEditEntityBubble[];
  /** `true` when `bubbles` should render as "bubbles[0] <arrow> bubbles[1]" (always exactly two
   *  bubbles in that case) rather than a plain list — set for every edge/teleport/vertical-passage
   *  kind. */
  isLink: boolean;
  /** `"<->"` for a wall/passage face (undirected — the same kind applies in both directions) or a
   *  two-way teleport/vertical passage; `"->"`/`"<-"` for a one-way one, telling which of the two
   *  fixed bubble positions traffic flows FROM and TO — same convention `SplitNodesDialogView`'s
   *  own link arrows use. `bubbles`' own order never changes with direction (GitHub issue #546
   *  follow-up: flipping a one-way face/passage's direction used to swap which bubble showed first,
   *  which reads as "the points swapped places" rather than "the arrow flipped") — only the glyph
   *  does. Only meaningful when `isLink`. */
  arrow: "->" | "<-" | "<->";
}

/** Coordinate text for one point, matching the debug event tree's own bubble convention exactly
 *  (`bubbleLabel` in `debugRowText.ts`): `x:y` on a single-floor maze, `Lf:x:y` (1-based floor) on
 *  a multi-floor one — no words, no parens. `multiFloor` mirrors that function's own parameter. */
function formatPoint(p: PostEditHoverPoint | undefined, multiFloor: boolean): string {
  if (p === undefined) return "?";
  const [x, y] = p.point;
  return multiFloor ? `L${(p.level ?? 0) + 1}:${x}:${y}` : `${x}:${y}`;
}

/** One bubble naming a plain point/node endpoint, hover-highlighting it as a `point` entity. */
function endpointBubble(ep: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean): PostEditEntityBubble {
  const p = resolveEndpointToHoverPoint(ep, nodeById);
  return { text: formatPoint(p, multiFloor), highlight: p ? { kind: "point", ...p } : null };
}

/** One bubble naming a split point directly by its own `(point, level)` — used by split-structure
 *  commands (`addSplitNode`, `rotateSplitPoint`, ...), which address the whole point rather than a
 *  single resolved node. Same plain coordinate bubble as any other point — a split point names no
 *  slot of its own (GitHub issue #546: the panel isn't the place to disambiguate slots). */
function splitPointBubble(point: [number, number], level: number | undefined, multiFloor: boolean): PostEditEntityBubble {
  return { text: formatPoint({ point, level }, multiFloor), highlight: { kind: "point", point, level } };
}

/** Two bubbles for an edge/teleport/vertical-passage-shaped entity — rendered "from -> to" by the
 *  panel (GitHub issue #546), same pairing `SplitNodesDialogView`'s link bubbles use. Each bubble
 *  highlights its own endpoint on hover; the pair together also drives the `link`-kind highlight
 *  when the row itself (not a single bubble) is hovered — see `postEditRowHighlight`. */
function edgeBubbles(from: PostEditEndpoint, to: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean): PostEditEntityBubble[] {
  return [endpointBubble(from, nodeById, multiFloor), endpointBubble(to, nodeById, multiFloor)];
}

/** 1-based floor number text for one resolved endpoint, `"?"` if unresolved — same tolerance every
 *  other bubble has, used only inside the combined coordinate+floors bubbles below. */
function floorText(p: PostEditHoverPoint | undefined): string {
  return p === undefined ? "?" : `L${(p.level ?? 0) + 1}`;
}

/** Single bubble for an elevator (GitHub issue #546 follow-up) — every one of an elevator's floor
 *  endpoints shares one `(x, y)` (it's a vertical stack at one point, see
 *  `startPostEditElevatorPlacement`), so a bubble per floor repeated the same coordinate once per
 *  floor for no reason. Shows the shared coordinate once,
 *  followed by every floor it spans: `x:y [L1,L2,L3]`. Hover-highlights every floor's point
 *  (`points`-kind), same as before. */
function elevatorBubble(floors: readonly PostEditEndpoint[], nodeById: ReadonlyMap<number, NodeDto>): PostEditEntityBubble {
  const points = floors.map((ep) => resolveEndpointToHoverPoint(ep, nodeById));
  const resolved = points.find((p): p is PostEditHoverPoint => p !== undefined);
  const coord = resolved ? `${resolved.point[0]}:${resolved.point[1]}` : "?";
  const floorList = points.map(floorText).join(",");
  const validPoints = points.filter((p): p is PostEditHoverPoint => p !== undefined);
  return {
    text: `${coord} [${floorList}]`,
    highlight: validPoints.length > 0 ? { kind: "points", points: validPoints } : null,
  };
}

/** Single bubble for a vertical passage (GitHub issue #546 follow-up) — `from`/`to` share one
 *  `(x, y)` (see `PostEditVerticalPassageEntry`'s doc comment), only their floor differs, so this
 *  shows the shared coordinate once followed by the two floors it connects, arrow-joined the same
 *  way an edge bubble pair is: `x:y [L1->L2]` one-way `forward` (traffic flows FROM's floor to TO's
 *  floor), `x:y [L1<-L2]` one-way `backward` (traffic flows TO's floor to FROM's), `x:y [L1<->L2]`
 *  two-way. `from`/`to`'s own display order is always fixed (GitHub issue #546 follow-up: flipping
 *  direction changes the arrow glyph, never which floor's text comes first — same fixed-order rule
 *  `setEdgePair`'s bubble pair now follows). Hover-highlights both floors' points. */
function verticalPassageBubble(
  from: PostEditEndpoint,
  to: PostEditEndpoint,
  direction: "forward" | "backward" | "two_way",
  nodeById: ReadonlyMap<number, NodeDto>,
): PostEditEntityBubble {
  const fromP = resolveEndpointToHoverPoint(from, nodeById);
  const toP = resolveEndpointToHoverPoint(to, nodeById);
  const resolved = fromP ?? toP;
  const coord = resolved ? `${resolved.point[0]}:${resolved.point[1]}` : "?";
  const arrow = direction === "two_way" ? "<->" : direction === "forward" ? "->" : "<-";
  const points = [fromP, toP].filter((p): p is PostEditHoverPoint => p !== undefined);
  return {
    text: `${coord} [${floorText(fromP)}${arrow}${floorText(toP)}]`,
    highlight: points.length > 0 ? { kind: "points", points } : null,
  };
}

/** A bubble naming an entity nothing's left in the log to resolve any point from at all (no live
 *  draft entry found by id, e.g. after the entity was itself later removed by a subsequent
 *  command) — falls back to `"?"`, same tolerance every other unresolved bubble has. */
function unresolvedBubble(): PostEditEntityBubble {
  return { text: "?", highlight: null };
}

/** Builds the `nodeById` map `postEditCommandLabel` needs, from the confirmed node snapshot
 *  (`state.nodes`) — the same lookup basis `ManageSplitNodesDialog`/`PostEditController` use for
 *  resolving a `node` endpoint back to its point. */
export function buildNodeByIdMap(nodes: readonly NodeDto[]): Map<number, NodeDto> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Live draft entries a "Changes" row needs to resolve an id-only command (`setTeleportDirection`,
 *  `removeTeleport`, ...) back to a coordinate pair — GitHub issue #546 removed the old "Teleport
 *  #3"/"Vertical passage #1 (one-way)" id-labeled bubbles in favor of the same from/to coordinate
 *  bubbles every other edge-shaped row uses, keyed by the id every such command already carries. A
 *  missing lookup (the entity was itself removed by a later command) falls back to
 *  `unresolvedBubble()`. */
export interface PostEditLiveEntries {
  teleports: ReadonlyMap<number, PostEditTeleportEntry>;
  verticalPassages: ReadonlyMap<number, PostEditVerticalPassageEntry>;
  elevators: ReadonlyMap<number, PostEditElevatorEntry>;
}

export function buildLiveEntries(
  teleports: readonly PostEditTeleportEntry[],
  verticalPassages: readonly PostEditVerticalPassageEntry[],
  elevators: readonly PostEditElevatorEntry[],
): PostEditLiveEntries {
  return {
    teleports: new Map(teleports.map((t) => [t.id, t])),
    verticalPassages: new Map(verticalPassages.map((v) => [v.id, v])),
    elevators: new Map(elevators.map((e) => [e.id, e])),
  };
}

/** Formats one `PostEditCommand` for the "Changes" panel. `nodeById` must be built from the
 *  confirmed node snapshot (`buildNodeByIdMap`) — an endpoint that doesn't resolve yet (a
 *  not-yet-confirmed split node) falls back to `"?"` rather than throwing, same "nothing to
 *  resolve yet" tolerance every other endpoint consumer has. `live` resolves an id-only command's
 *  current from/to (see `PostEditLiveEntries`). `multiFloor` selects the debug tree's own `Lf:x:y`
 *  vs. plain `x:y` bubble format (`floors.length > 1`, GitHub issue #546). */
export function postEditCommandLabel(
  command: PostEditCommand,
  nodeById: ReadonlyMap<number, NodeDto>,
  live: PostEditLiveEntries,
  multiFloor: boolean,
): PostEditCommandLabel {
  const edge = (from: PostEditEndpoint, to: PostEditEndpoint) => edgeBubbles(from, to, nodeById, multiFloor);
  const teleportBubbles = (id: number): PostEditEntityBubble[] => {
    const entry = live.teleports.get(id);
    return entry ? edge(entry.from, entry.to) : [unresolvedBubble()];
  };
  const verticalPassageBubbles = (id: number): PostEditEntityBubble[] => {
    const entry = live.verticalPassages.get(id);
    return entry ? [verticalPassageBubble(entry.from, entry.to, entry.direction, nodeById)] : [unresolvedBubble()];
  };
  const elevatorBubbles = (id: number): PostEditEntityBubble[] => {
    const entry = live.elevators.get(id);
    return entry ? [elevatorBubble(entry.floors, nodeById)] : [unresolvedBubble()];
  };

  switch (command.kind) {
    case "setEdge": {
      const actionKey = command.edgeKind === "wall"
        ? "post_edit.changes_action_set_edge_wall"
        : command.edgeKind === "basic"
        ? "post_edit.changes_action_set_edge_passage"
        : "post_edit.changes_action_set_edge_one_way";
      const arrow = command.edgeKind === "wall" || command.edgeKind === "basic" ? "<->" : "->";
      return { action: m[actionKey](), bubbles: edge(command.from, command.to), isLink: true, arrow };
    }
    case "setEdgePair": {
      if (command.aToB === "wall" && command.bToA === "wall") {
        return { action: m["post_edit.changes_action_set_edge_wall"](), bubbles: edge(command.a, command.b), isLink: true, arrow: "<->" };
      }
      if (command.aToB === "basic" && command.bToA === "basic") {
        return { action: m["post_edit.changes_action_set_edge_passage"](), bubbles: edge(command.a, command.b), isLink: true, arrow: "<->" };
      }
      // `directionFlip` (GitHub issue #545): this click changed an already-one-way face's
      // direction rather than creating a fresh one-way passage — labeled distinctly, mirrors
      // `setVerticalPassageDirection` vs. `addVerticalPassage`.
      const action = command.directionFlip
        ? m["post_edit.changes_action_flip_edge_one_way"]()
        : m["post_edit.changes_action_set_edge_one_way"]();
      // Bubble order is always `a, b` (GitHub issue #546 follow-up: fixed point order, direction
      // shown by the arrow glyph alone, not by swapping which bubble comes first) — `aToB` says
      // whether traffic actually flows a->b or b->a.
      return { action, bubbles: edge(command.a, command.b), isLink: true, arrow: command.aToB === "one_way_forward" ? "->" : "<-" };
    }
    case "addTeleport":
      return { action: m["post_edit.changes_action_add_teleport"](), bubbles: edge(command.from, command.to), isLink: true, arrow: command.direction === "two_way" ? "<->" : "->" };
    case "setTeleportDirection":
      return { action: m["post_edit.changes_action_set_teleport_direction"](), bubbles: teleportBubbles(command.id), isLink: true, arrow: command.direction === "two_way" ? "<->" : "->" };
    case "moveTeleportEndpoint": {
      const entry = live.teleports.get(command.id);
      return { action: m["post_edit.changes_action_move_teleport_endpoint"](), bubbles: teleportBubbles(command.id), isLink: true, arrow: entry?.direction === "two_way" ? "<->" : "->" };
    }
    case "removeTeleport": {
      const entry = live.teleports.get(command.id);
      return { action: m["post_edit.changes_action_remove_teleport"](), bubbles: teleportBubbles(command.id), isLink: true, arrow: entry?.direction === "two_way" ? "<->" : "->" };
    }
    case "setMeta": {
      const set = command.endpoint !== null;
      const action = command.slot === "start"
        ? (set ? m["post_edit.changes_action_set_start"]() : m["post_edit.changes_action_clear_start"]())
        : (set ? m["post_edit.changes_action_set_finish"]() : m["post_edit.changes_action_clear_finish"]());
      return { action, bubbles: command.endpoint !== null ? [endpointBubble(command.endpoint, nodeById, multiFloor)] : [], isLink: false, arrow: "->" };
    }
    case "addSplitNode":
      return { action: m["post_edit.changes_action_add_split_node"](), bubbles: [splitPointBubble(command.point, command.level, multiFloor)], isLink: false, arrow: "->" };
    case "removeSplitNode":
      return { action: m["post_edit.changes_action_remove_split_node"](), bubbles: [splitPointBubble(command.point, command.level, multiFloor)], isLink: false, arrow: "->" };
    case "rotateSplitPoint":
      return { action: m["post_edit.changes_action_rotate_split_point"](), bubbles: [splitPointBubble(command.point, command.level, multiFloor)], isLink: false, arrow: "->" };
    case "applySplitBlueprint": {
      const action = command.blueprintTitleKey
        ? m["post_edit.changes_action_apply_split_blueprint_named"]({ name: messageForTitleKey(command.blueprintTitleKey) })
        : m["post_edit.changes_action_apply_split_blueprint"]();
      return { action, bubbles: [splitPointBubble(command.point, command.level, multiFloor)], isLink: false, arrow: "->" };
    }
    case "updateSplitNodeFaces":
      return { action: m["post_edit.changes_action_update_split_node_faces"](), bubbles: [splitPointBubble(command.point, command.level, multiFloor)], isLink: false, arrow: "->" };
    case "addVerticalPassage":
      return { action: m["post_edit.changes_action_add_vertical_passage"](), bubbles: [verticalPassageBubble(command.from, command.to, command.direction, nodeById)], isLink: false, arrow: "->" };
    case "setVerticalPassageDirection":
      return { action: m["post_edit.changes_action_set_vertical_passage_direction"](), bubbles: verticalPassageBubbles(command.id), isLink: false, arrow: "->" };
    case "moveVerticalPassageEndpoint":
      return { action: m["post_edit.changes_action_move_vertical_passage_endpoint"](), bubbles: verticalPassageBubbles(command.id), isLink: false, arrow: "->" };
    case "removeVerticalPassage":
      return { action: m["post_edit.changes_action_remove_vertical_passage"](), bubbles: verticalPassageBubbles(command.id), isLink: false, arrow: "->" };
    case "addElevator":
      return { action: m["post_edit.changes_action_add_elevator"](), bubbles: [elevatorBubble(command.floors, nodeById)], isLink: false, arrow: "->" };
    case "updateElevatorFloors":
      return { action: m["post_edit.changes_action_update_elevator_floors"](), bubbles: [elevatorBubble(command.floors, nodeById)], isLink: false, arrow: "->" };
    case "removeElevator":
      return { action: m["post_edit.changes_action_remove_elevator"](), bubbles: elevatorBubbles(command.id), isLink: false, arrow: "->" };
    case "suppressGenerationPair":
      return { action: m["post_edit.changes_action_suppress_generation_pair"](), bubbles: edge(command.a, command.b), isLink: true, arrow: "<->" };
  }
}

/** The `link`-kind `PostEditHoveredEntity` a "Changes" panel row itself (not one of its own
 *  bubbles) hover-highlights (GitHub issue #546) — only meaningful when `label.isLink` (exactly two
 *  bubbles); every other row has no single row-level highlight of its own, since a `point`/`points`
 *  row's bubbles already highlight themselves individually. `null` when either bubble's own
 *  highlight didn't resolve (mirrors every bubble's own "nothing to highlight yet" tolerance). */
export function postEditRowHighlight(label: PostEditCommandLabel): PostEditHoveredEntity | null {
  if (!label.isLink || label.bubbles.length !== 2) return null;
  const [from, to] = label.bubbles;
  if (from.highlight?.kind !== "point" || to.highlight?.kind !== "point") return null;
  return { kind: "link", from: from.highlight, to: to.highlight };
}

/** Distinct 0-based floor indices a "Changes" panel row's bubbles touch, ascending — feeds the
 *  shared `FloorBadgeRow` (GitHub issue #546), same "which floor(s) is this on" convention
 *  `IssueFloorBadges`/`DebugRefBubble` already use. Reads each bubble's own already-resolved
 *  `highlight` rather than re-deriving floors from the raw command, so a bubble's hover-highlight
 *  and the row's floor badges never disagree about which entity/floors they're describing. A
 *  bubble with no highlight (nothing left to resolve — see `unresolvedBubble`) contributes no
 *  floor. */
export function postEditCommandFloors(label: PostEditCommandLabel): number[] {
  const levels: number[] = [];
  for (const b of label.bubbles) {
    if (!b.highlight) continue;
    if (b.highlight.kind === "point") levels.push(b.highlight.level ?? 0);
    else if (b.highlight.kind === "points") levels.push(...b.highlight.points.map((p) => p.level ?? 0));
  }
  return [...new Set(levels)].sort((a, b) => a - b);
}
