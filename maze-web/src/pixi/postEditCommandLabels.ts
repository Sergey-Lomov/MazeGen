import type { NodeDto } from "../wasm/types";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditTeleportDirection, PostEditVerticalPassageDirection } from "../store/postEditTypes";
import { type PostEditEndpoint, type PostEditHoveredEntity, type PostEditHoverPoint, resolveEndpointToHoverPoint, nodeEndpoint } from "./postEditEndpoint";
import { messageForTitleKey } from "./splitPatternTitles";
import { splitNodeLabelShort } from "../components/features/SplitNodesDialogView";
import { resolveSplitNodeShortLabel, type SplitLabelContext } from "./postEditSplitLabels";
import * as m from "~/paraglide/messages";

/** One entity bubble in a "Changes" panel row (GitHub issue #546) — `text` is the same `Lf:x:y`/
 *  `x:y` coordinate convention the debug event tree's own bubbles use (`bubbleLabel`,
 *  `debugRowText.ts`), never a raw `NodeId`/entity id. Always names exactly one point (GitHub issue
 *  #546 second follow-up dropped the earlier "combined" bubble that named several floors of the same
 *  coordinate at once — each floor gets its own bubble now, so `highlight` is always a plain `point`,
 *  never `points`). `null` for a bubble naming an entity the log no longer has enough information to
 *  highlight — a removed/dangling id with no live draft entry left to resolve a point from. */
export interface PostEditEntityBubble {
  text: string;
  highlight: PostEditHoveredEntity | null;
}

/** One row of the "Changes" panel (GitHub issue #545, bubbles added by #546, per-point bubbles and
 *  `rowHighlight` by the #546 second follow-up) — a human-readable action plus one or more entity
 *  bubbles, each naming exactly one point (never a combined multi-floor bubble — an elevator's
 *  three floors are three separate bubbles, `L1:x:y`/`L2:x:y`/`L3:x:y`, not one `x:y [L1,L2,L3]`),
 *  derived from a single `PostEditCommand`. `showArrow` draws a plain text glyph between exactly
 *  two bubbles (same "from -> to" reading `SplitNodesDialogView`'s link bubbles use) without
 *  implying anything about `rowHighlight` — a vertical passage/elevator/cross-floor teleport shows
 *  the arrow (it still has a direction) but highlights per-point, not as one connecting line. */
export interface PostEditCommandLabel {
  action: string;
  bubbles: PostEditEntityBubble[];
  /** `true` draws a plain text arrow glyph between `bubbles[0]` and `bubbles[1]` (always exactly
   *  two bubbles when set) — purely cosmetic, independent of `rowHighlight`. */
  showArrow: boolean;
  /** `"<->"` for a wall/passage face (undirected — the same kind applies in both directions) or a
   *  two-way teleport/vertical passage; `"->"`/`"<-"` for a one-way one, telling which of the two
   *  fixed bubble positions traffic flows FROM and TO — same convention `SplitNodesDialogView`'s
   *  own link arrows use. `bubbles`' own order never changes with direction (GitHub issue #546
   *  follow-up: flipping a one-way face/passage's direction used to swap which bubble showed first,
   *  which reads as "the points swapped places" rather than "the arrow flipped") — only the glyph
   *  does. Only meaningful when `showArrow`. */
  arrow: "->" | "<-" | "<->";
  /** What hovering the row itself (not one of its own bubbles) highlights on the canvas (GitHub
   *  issue #546 second follow-up) — `null` for a row with no natural "whole row" target (a
   *  single-bubble point/split-structure row; its one bubble already covers that). A `link` for a
   *  same-floor edge/teleport (the connecting line itself reads naturally as "this row"); a
   *  `points` group for a vertical passage/elevator/cross-floor teleport — every one of THOSE
   *  entities' points that's actually drawn on some floor, which after `activeLevel` gating
   *  (`buildHoveredEntityHighlight`) collapses to just the point(s) on the floor being viewed. Never
   *  a `link` for a cross-floor entity — a straight line needs both ends on one floor, which a
   *  vertical/cross-floor entity's own two points never share. */
  rowHighlight: PostEditHoveredEntity | null;
}

/** Coordinate text for one point, matching the debug event tree's own bubble convention exactly
 *  (`bubbleLabel` in `debugRowText.ts`): `x:y` on a single-floor maze, `Lf:x:y` (1-based floor) on
 *  a multi-floor one — no words, no parens. `multiFloor` mirrors that function's own parameter.
 *  `slotSuffix`, when given, appends the same `" (N{slotId})"` parenthetical the debug tree's own
 *  `bubbleLabel` appends for a split point's non-original node (GitHub issue #546 fourth follow-up
 *  — every "Changes" panel bubble now mirrors that convention, matching `debugRowText.ts`'s own
 *  `p.split ? "${coord} (${...})" : coord` shape exactly instead of a plain coordinate). */
function formatPoint(p: PostEditHoverPoint | undefined, multiFloor: boolean, slotSuffix?: string): string {
  if (p === undefined) return "?";
  const [x, y] = p.point;
  const coord = multiFloor ? `L${(p.level ?? 0) + 1}:${x}:${y}` : `${x}:${y}`;
  return slotSuffix === undefined ? coord : `${coord} (${slotSuffix})`;
}

/** One bubble naming a plain point/node endpoint, hover-highlighting it as a `point` entity. Any
 *  endpoint whose point is a split tile gets a "(N{n})"/semantic-short parenthetical suffix (GitHub
 *  issue #546 fourth follow-up, eighth follow-up) — resolved via `resolveSplitNodeShortLabel`
 *  (`postEditSplitLabels.ts`), the same "is this point a split tile at all" check and semantic-name
 *  lookup `ManageSplitNodesDialog`'s own link bubbles use, NOT `NodeDto.i > 0` — the point's
 *  ORIGINAL node (`i === 0`) is just as much a split tile's node as any extra slot and must get the
 *  same suffix. `splitCtx` is `null` where the caller has no field/edges context to resolve against
 *  (falls back to no suffix at all, same as an unsplit point). */
function endpointBubble(ep: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble {
  const p = resolveEndpointToHoverPoint(ep, nodeById);
  const suffix = p ? resolveSplitNodeShortLabel(splitCtx, p.point, p.level, ep) : undefined;
  return { text: formatPoint(p, multiFloor, suffix), highlight: p ? { kind: "point", ...p } : null };
}

/** One bubble naming a split point directly by its own `(point, level)` — used by split-structure
 *  commands that address the whole point rather than a single resolved node (`rotateSplitPoint`,
 *  `applySplitBlueprint`). No slot suffix here — deliberately, unlike `endpointBubble`/the
 *  `slotId`-bearing overload below: these commands rotate/reset the WHOLE tile, not one node of
 *  it, so naming a single slot would misrepresent what changed. */
function splitPointBubble(point: [number, number], level: number | undefined, multiFloor: boolean): PostEditEntityBubble {
  return { text: formatPoint({ point, level }, multiFloor), highlight: { kind: "point", point, level } };
}

/** Same as `splitPointBubble`, for a command that DOES address one specific slot (`addSplitNode`,
 *  `removeSplitNode`, `updateSplitNodeFaces`) — appends that slot's own "(N{n})"/semantic-short
 *  parenthetical (GitHub issue #546 fourth follow-up, eighth follow-up: prefers
 *  `resolveSplitNodeShortLabel`'s semantic name, falling back to plain `splitNodeLabelShort` only
 *  when `splitCtx` is `null` or the topology isn't a recognized named one). */
function splitSlotBubble(point: [number, number], level: number | undefined, slotId: number, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble {
  const suffix = resolveSplitNodeShortLabel(splitCtx, point, level, { kind: "split", point, slotId, level }) ?? splitNodeLabelShort(slotId);
  return { text: formatPoint({ point, level }, multiFloor, suffix), highlight: { kind: "point", point, level } };
}

/** Same as `splitSlotBubble`, for `updateSplitNodeFaces` with `slotId: undefined` — the point's
 *  original node (GitHub issue #564 follow-up: editing the original node's faces is editing the
 *  split, same as any numbered slot). The original has no `split`-kind endpoint to build (structurally
 *  addressed only as `{kind:"node", id}`, never `{kind:"split", ...}` — see `postEditCommandTypes.ts`),
 *  so resolve its `NodeId` from `nodeById` by coordinates and delegate to `endpointBubble`, which
 *  already resolves `node`-kind endpoints (and their short-label suffix) correctly. */
function splitOriginalNodeBubble(point: [number, number], level: number | undefined, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble {
  const original = [...nodeById.values()].find((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0) && n.i === 0);
  if (original === undefined) return { text: formatPoint({ point, level }, multiFloor), highlight: { kind: "point", point, level } };
  return endpointBubble(nodeEndpoint(original.id), nodeById, multiFloor, splitCtx);
}

/** Two bubbles for a same-floor edge/teleport-shaped entity — rendered "from -> to" by the panel
 *  (GitHub issue #546), same pairing `SplitNodesDialogView`'s link bubbles use. Each bubble
 *  highlights its own endpoint on hover; the pair together also drives the `link`-kind highlight
 *  when the row itself (not a single bubble) is hovered — see `linkRowHighlight`. */
function edgeBubbles(from: PostEditEndpoint, to: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble[] {
  return [endpointBubble(from, nodeById, multiFloor, splitCtx), endpointBubble(to, nodeById, multiFloor, splitCtx)];
}

/** One bubble per elevator floor (GitHub issue #546 second follow-up) — every one of an elevator's
 *  floor endpoints shares one `(x, y)` (it's a vertical stack at one point, see
 *  `startPostEditElevatorPlacement`), but each still gets its own bubble (`L1:x:y`, `L2:x:y`, ...,
 *  the same `Lf:x:y` format `formatPoint` already uses for any multi-floor point) rather than one
 *  combined `x:y [L1,L2,L3]` bubble — so hovering ONE floor's bubble highlights only that floor's
 *  own point, matching every other point bubble's "hover me, highlight me" contract instead of
 *  lighting up every floor at once. `multiFloor` is always `true` here in practice (an elevator only
 *  exists where there's more than one floor to span), but threaded through for consistency with
 *  every other bubble builder. */
function elevatorBubbles(floors: readonly PostEditEndpoint[], nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble[] {
  return floors.map((ep) => endpointBubble(ep, nodeById, multiFloor, splitCtx));
}

/** Two bubbles for a vertical passage (GitHub issue #546 second follow-up) — `from`/`to` share one
 *  `(x, y)` (see `PostEditVerticalPassageEntry`'s doc comment), only their floor differs; each still
 *  gets its own `Lf:x:y` bubble (not a combined `x:y [L1->L2]` one) so hovering one floor's bubble
 *  highlights only that floor's own point. `direction` only decides the row's `arrow` glyph
 *  (`postEditCommandLabel` sets it), not anything about these two bubbles themselves — `from`/`to`'s
 *  own display order is always fixed (GitHub issue #546 follow-up: flipping direction changes the
 *  arrow glyph, never which floor's bubble comes first). */
function verticalPassageBubbles(from: PostEditEndpoint, to: PostEditEndpoint, nodeById: ReadonlyMap<number, NodeDto>, multiFloor: boolean, splitCtx: SplitLabelContext | null): PostEditEntityBubble[] {
  return [endpointBubble(from, nodeById, multiFloor, splitCtx), endpointBubble(to, nodeById, multiFloor, splitCtx)];
}

/** Arrow glyph for a teleport's `direction` (GitHub issue #546 third follow-up fixed a bug where
 *  `"backward"` was mapped the same as `"forward"`, `"->"` — direction changes on an existing
 *  teleport, e.g. `setTeleportDirection`/`moveTeleportEndpoint`, never flipped the row's own glyph).
 *  `undefined` (an id-only command whose live entry has already been removed) also falls back to
 *  `"->"`, same tolerance every other unresolved-entity case already has. */
function teleportArrow(direction: PostEditTeleportDirection | undefined): "->" | "<-" | "<->" {
  return direction === "two_way" ? "<->" : direction === "backward" ? "<-" : "->";
}

/** Same fix as `teleportArrow`, for a vertical passage's `direction`. */
function verticalPassageArrow(direction: PostEditVerticalPassageDirection | undefined): "->" | "<-" | "<->" {
  return direction === "two_way" ? "<->" : direction === "backward" ? "<-" : "->";
}

/** Arrow glyph for `setVerticalPassageDirection` specifically (GitHub issue #546 fourth follow-up) —
 *  unlike every other direction-bearing command, this one's own `command.direction` is the entry's
 *  direction BEFORE the click, not after: `cyclePostEditVerticalPassageDirection` in
 *  `postEditSlice.ts` reads the *live* entry's current direction to log it, then the replay reducer
 *  (`postEditReplay.ts`) ignores `command.direction` entirely and just flips whatever the entry's
 *  direction already was at replay time — so the command's own field is "informational only" (see
 *  `postEditSlice.ts`'s own doc comment on `cyclePostEditVerticalPassageDirection`), never the
 *  resulting direction. Showing `command.direction` verbatim was one click behind reality (a
 *  forward->backward flip showed the pre-click "forward" arrow, and the NEXT row — whether another
 *  flip or the following `addVerticalPassage`/`moveVerticalPassageEndpoint` reading the live entry —
 *  then showed what THIS row should have shown, reading as permanently one step desynced). Flipping
 *  it here (forward<->backward, two_way untouched — same toggle `cyclePostEditVerticalPassageDirection`
 *  itself does) reconstructs the actual post-click direction from the log entry alone. */
function flippedVerticalPassageArrow(direction: PostEditVerticalPassageDirection): "->" | "<-" | "<->" {
  if (direction === "two_way") return "<->";
  return direction === "forward" ? "<-" : "->";
}

/** Row-hover highlight for a vertical passage/elevator/cross-floor teleport (GitHub issue #546
 *  second follow-up) — every point of the entity that's actually drawn on some floor, as a
 *  `points`-kind entity; `buildHoveredEntityHighlight`'s own `activeLevel` gate then collapses this
 *  to just the point(s) on the floor currently being viewed (never a straight line — a vertical/
 *  cross-floor entity's own two points never share a floor to draw one on). `null` when no bubble
 *  resolved a point at all. */
function pointsRowHighlight(bubbles: readonly PostEditEntityBubble[]): PostEditHoveredEntity | null {
  const points = bubbles
    .map((b) => (b.highlight?.kind === "point" ? b.highlight : undefined))
    .filter((p): p is PostEditHoverPoint & { kind: "point" } => p !== undefined);
  return points.length > 0 ? { kind: "points", points } : null;
}

/** Row-hover highlight for a same-floor edge/teleport row (GitHub issue #546 second follow-up) — the
 *  connecting line itself, mirroring the old `postEditRowHighlight`. `null` when either bubble's own
 *  highlight didn't resolve to a plain point. */
function linkRowHighlight(bubbles: readonly PostEditEntityBubble[]): PostEditHoveredEntity | null {
  if (bubbles.length !== 2) return null;
  const [from, to] = bubbles;
  if (from.highlight?.kind !== "point" || to.highlight?.kind !== "point") return null;
  return { kind: "link", from: from.highlight, to: to.highlight };
}

/** Builds the `nodeById` map `postEditCommandLabel` needs, from the confirmed node snapshot
 *  (`state.nodes`) — the same lookup basis `ManageSplitNodesDialog`/`PostEditController` use for
 *  resolving a `node` endpoint back to its point. */
export function buildNodeByIdMap(nodes: readonly NodeDto[]): Map<number, NodeDto> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Appends the entity's own stable id (GitHub issue #564) to an action string, `"Action (#N)"` —
 *  every category minted at baseline-construction or command-construction time now carries one
 *  (one-way edge, split point, teleport, vertical passage, elevator), so every row that names a
 *  single entity can show it next to the action instead of only via coordinate bubbles, which don't
 *  distinguish a churned entity (removed then recreated at the same point) from the original. `id`
 *  is a type-prefixed string (`"t3"`, `"s1"`, ... — GitHub issue #564 second follow-up,
 *  `postEditIdFormat.ts`), not a bare number — the prefix already says the entity kind. */
function withId(action: string, id: string): string {
  return `${action} (#${id})`;
}

/** Formats one `PostEditCommand` for the "Changes" panel. `nodeById` must be built from the
 *  confirmed node snapshot (`buildNodeByIdMap`) — an endpoint that doesn't resolve yet (a
 *  not-yet-confirmed split node) falls back to `"?"` rather than throwing, same "nothing to
 *  resolve yet" tolerance every other endpoint consumer has. Every command carries its own
 *  bubble-relevant fields (from/to/direction/floors) denormalized at construction time (GitHub
 *  issue #564) rather than resolving through a live draft lookup by id — an id-only lookup is
 *  correct only for the newest row about an entity, and breaks for any older row once a later
 *  command edits or removes it. `multiFloor` selects the debug tree's own `Lf:x:y` vs. plain `x:y`
 *  bubble format (`floors.length > 1`, GitHub issue #546). */
export function postEditCommandLabel(
  command: PostEditCommand,
  nodeById: ReadonlyMap<number, NodeDto>,
  multiFloor: boolean,
  splitCtx: SplitLabelContext | null = null,
): PostEditCommandLabel {
  const edge = (from: PostEditEndpoint, to: PostEditEndpoint) => edgeBubbles(from, to, nodeById, multiFloor, splitCtx);
  const link = (action: string, bubbles: PostEditEntityBubble[], arrow: "->" | "<-" | "<->"): PostEditCommandLabel =>
    ({ action, bubbles, showArrow: bubbles.length === 2, arrow, rowHighlight: linkRowHighlight(bubbles) });
  // A teleport's own connector is drawn by `TeleportRenderer` (routed, possibly non-straight, GitHub
  // issue #546 — see `Specs/post-edit.md`'s own note on why the row-hover link highlight was never
  // extended to follow that routing) — a straight-line `link` row-highlight over it reads as a second,
  // wrong connector, so a same-floor teleport row highlights both endpoint points instead, same as a
  // vertical passage/elevator (GitHub issue #546 third follow-up).
  const teleportRow = (action: string, bubbles: PostEditEntityBubble[], arrow: "->" | "<-" | "<->"): PostEditCommandLabel =>
    ({ action, bubbles, showArrow: bubbles.length === 2, arrow, rowHighlight: pointsRowHighlight(bubbles) });
  const verticalPassageRow = (action: string, bubbles: PostEditEntityBubble[], arrow: "->" | "<-" | "<->"): PostEditCommandLabel =>
    ({ action, bubbles, showArrow: bubbles.length === 2, arrow, rowHighlight: pointsRowHighlight(bubbles) });
  // An elevator never shows an arrow glyph (GitHub issue #546 third follow-up) — unlike a vertical
  // passage/teleport, it has no single "from -> to" direction of its own even when it happens to
  // span exactly two floors (`addElevator`'s `floors` is an unordered set of stops, not a directed
  // pair), so `showArrow` is unconditionally `false` regardless of `bubbles.length`.
  const elevatorRow = (action: string, bubbles: PostEditEntityBubble[]): PostEditCommandLabel =>
    ({ action, bubbles, showArrow: false, arrow: "->", rowHighlight: pointsRowHighlight(bubbles) });
  const plain = (action: string, bubbles: PostEditEntityBubble[]): PostEditCommandLabel =>
    ({ action, bubbles, showArrow: false, arrow: "->", rowHighlight: null });

  switch (command.kind) {
    case "setEdge": {
      const kind = command.edge.kind;
      const actionKey = kind === "wall"
        ? "post_edit.changes_action_set_edge_wall"
        : kind === "basic"
        ? "post_edit.changes_action_set_edge_passage"
        : "post_edit.changes_action_set_edge_one_way";
      const arrow = kind === "wall" || kind === "basic" ? "<->" : "->";
      // One-way's own id (GitHub issue #564) — wall/basic have no id, nothing to append.
      const action = command.edge.kind === "one_way_forward" || command.edge.kind === "one_way_backward"
        ? withId(m[actionKey](), command.edge.id)
        : m[actionKey]();
      return link(action, edge(command.edge.from, command.edge.to), arrow);
    }
    case "setEdgePair": {
      if (command.aToB.kind === "wall" && command.bToA.kind === "wall") {
        return link(m["post_edit.changes_action_set_edge_wall"](), edge(command.a, command.b), "<->");
      }
      if (command.aToB.kind === "basic" && command.bToA.kind === "basic") {
        return link(m["post_edit.changes_action_set_edge_passage"](), edge(command.a, command.b), "<->");
      }
      // `directionFlip` (GitHub issue #545): this click changed an already-one-way face's
      // direction rather than creating a fresh one-way passage — labeled distinctly, mirrors
      // `setVerticalPassageDirection` vs. `addVerticalPassage`.
      const baseAction = command.directionFlip
        ? m["post_edit.changes_action_flip_edge_one_way"]()
        : m["post_edit.changes_action_set_edge_one_way"]();
      // The resulting one-way side's own id (GitHub issue #564) — whichever of `aToB`/`bToA` is the
      // one-way side (`setEdgePair` never makes both sides one-way at once).
      const oneWaySide = command.aToB.kind === "one_way_forward" || command.aToB.kind === "one_way_backward" ? command.aToB : command.bToA;
      const action = oneWaySide.kind === "one_way_forward" || oneWaySide.kind === "one_way_backward"
        ? withId(baseAction, oneWaySide.id)
        : baseAction;
      // Bubble order is always `a, b` (GitHub issue #546 follow-up: fixed point order, direction
      // shown by the arrow glyph alone, not by swapping which bubble comes first) — `aToB` says
      // whether traffic actually flows a->b or b->a.
      return link(action, edge(command.a, command.b), command.aToB.kind === "one_way_forward" ? "->" : "<-");
    }
    case "addTeleport":
      return teleportRow(withId(m["post_edit.changes_action_add_teleport"](), command.id), edge(command.from, command.to), teleportArrow(command.direction));
    case "setTeleportDirection":
      // `from`/`to` are this command's own denormalized fields (GitHub issue #564 follow-up) —
      // same reasoning as every vertical-passage command's fix.
      return teleportRow(withId(m["post_edit.changes_action_set_teleport_direction"](), command.id), edge(command.from, command.to), teleportArrow(command.direction));
    case "moveTeleportEndpoint":
      return teleportRow(withId(m["post_edit.changes_action_move_teleport_endpoint"](), command.id), edge(command.from, command.to), teleportArrow(command.direction));
    case "removeTeleport":
      return teleportRow(withId(m["post_edit.changes_action_remove_teleport"](), command.id), edge(command.from, command.to), teleportArrow(command.direction));
    case "setMeta": {
      const set = command.endpoint !== null;
      const action = command.slot === "start"
        ? (set ? m["post_edit.changes_action_set_start"]() : m["post_edit.changes_action_clear_start"]())
        : (set ? m["post_edit.changes_action_set_finish"]() : m["post_edit.changes_action_clear_finish"]());
      // `previousEndpoint` (GitHub issue #564 follow-up) is this clear's own denormalized prior
      // value — without it a "start/finish cleared" row showed no coordinates at all.
      const bubbleEndpoint = command.endpoint ?? command.previousEndpoint;
      return plain(action, bubbleEndpoint ? [endpointBubble(bubbleEndpoint, nodeById, multiFloor, splitCtx)] : []);
    }
    case "addSplitNode":
      return plain(withId(m["post_edit.changes_action_add_split_node"](), command.pointId), [splitSlotBubble(command.point, command.level, command.slotId, multiFloor, splitCtx)]);
    case "removeSplitNode":
      return plain(withId(m["post_edit.changes_action_remove_split_node"](), command.pointId), [splitSlotBubble(command.point, command.level, command.slotId, multiFloor, splitCtx)]);
    case "rotateSplitPoint":
      return plain(m["post_edit.changes_action_rotate_split_point"](), [splitPointBubble(command.point, command.level, multiFloor)]);
    case "applySplitBlueprint": {
      const action = command.blueprintTitleKey
        ? m["post_edit.changes_action_apply_split_blueprint_named"]({ name: messageForTitleKey(command.blueprintTitleKey) })
        : m["post_edit.changes_action_apply_split_blueprint"]();
      return plain(withId(action, command.pointId), [splitPointBubble(command.point, command.level, multiFloor)]);
    }
    case "updateSplitNodeFaces":
      return plain(
        withId(m["post_edit.changes_action_update_split_node_faces"](), command.pointId),
        [command.slotId === undefined
          ? splitOriginalNodeBubble(command.point, command.level, nodeById, multiFloor, splitCtx)
          : splitSlotBubble(command.point, command.level, command.slotId, multiFloor, splitCtx)],
      );
    case "addVerticalPassage":
      return verticalPassageRow(withId(m["post_edit.changes_action_add_vertical_passage"](), command.id), verticalPassageBubbles(command.from, command.to, nodeById, multiFloor, splitCtx), verticalPassageArrow(command.direction));
    case "setVerticalPassageDirection":
      // `from`/`to` are this command's own denormalized fields (GitHub issue #564 follow-up) —
      // an id-based lookup into the CURRENT draft would show a stale or unresolved bubble for an
      // old row, since this id may have since moved on or been removed by a later command.
      return verticalPassageRow(
        withId(m["post_edit.changes_action_set_vertical_passage_direction"](), command.id),
        verticalPassageBubbles(command.from, command.to, nodeById, multiFloor, splitCtx),
        flippedVerticalPassageArrow(command.direction),
      );
    case "moveVerticalPassageEndpoint":
      // `from`/`to`/`direction` are this command's own denormalized fields (GitHub issue #564
      // follow-up) — reading the CURRENT draft by id for the arrow used to default a
      // since-removed two-way passage's old move row to a plain "->", same class of bug the
      // bubbles had before.
      return verticalPassageRow(
        withId(m["post_edit.changes_action_move_vertical_passage_endpoint"](), command.id),
        verticalPassageBubbles(command.from, command.to, nodeById, multiFloor, splitCtx),
        verticalPassageArrow(command.direction),
      );
    case "removeVerticalPassage":
      // `from`/`to`/`direction` are the removed passage's own denormalized fields (GitHub issue
      // #564 partial) — the entity is gone from the CURRENT draft by the time this row renders,
      // so an id-based lookup would otherwise always miss.
      return verticalPassageRow(
        withId(m["post_edit.changes_action_remove_vertical_passage"](), command.id),
        verticalPassageBubbles(command.from, command.to, nodeById, multiFloor, splitCtx),
        verticalPassageArrow(command.direction),
      );
    case "addElevator":
      return elevatorRow(withId(m["post_edit.changes_action_add_elevator"](), command.id), elevatorBubbles(command.floors, nodeById, multiFloor, splitCtx));
    case "updateElevatorFloors":
      return elevatorRow(withId(m["post_edit.changes_action_update_elevator_floors"](), command.id), elevatorBubbles(command.floors, nodeById, multiFloor, splitCtx));
    case "removeElevator":
      // `floors` is the removed elevator's own denormalized field (GitHub issue #564 partial) —
      // same reasoning as `removeVerticalPassage` above.
      return elevatorRow(withId(m["post_edit.changes_action_remove_elevator"](), command.id), elevatorBubbles(command.floors, nodeById, multiFloor, splitCtx));
  }
}

