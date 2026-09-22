import type { NavNodeDto, NavEdgeDto, RouteInfoDto, MazeStatisticsDto, IssueDto } from "../wasm/types";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "delete" | "one_way" | "set_start" | "set_finish" | "teleport_one_way" | "teleport_two_way" | "vertical_passage_one_way" | "vertical_passage_two_way" | "elevator" | "manage_split_nodes";

/** A directed post-edit edge — discriminated by `kind` (GitHub issue #564) so a one-way edge's
 * stable `id` is required exactly when `kind` is one of the `one_way_*` variants, and impossible
 * to attach to a `wall`/`basic` edge. `id` is assigned by `_nextPostEditOneWayId`, minted at
 * baseline-construction time for a generation-baked one-way (keyed by canonical `edgeKey(from,to)`,
 * see `assignSequentialIds`) or on fresh creation/flip via the `one_way` tool — see
 * `applyPostEditToolAt`. Reused as `PostEditEdgeState` for `setEdgePair`'s `aToB`/`bToA` payload.
 * `id` is a stable string (GitHub issue #564 second follow-up, `"ow{n}"`) — see
 * `postEditIdFormat.ts`'s doc comment for the per-category prefix convention shared by every
 * post-edit entity id (one-way, split point, teleport, vertical passage, elevator). */
export type PostEditEdge =
  | { kind: "wall" | "basic"; from: PostEditEndpoint; to: PostEditEndpoint }
  | { kind: "one_way_forward" | "one_way_backward"; from: PostEditEndpoint; to: PostEditEndpoint; id: string };

/** Same shape as `PostEditEdge` — used for `setEdgePair`'s `aToB`/`bToA` command fields, which
 * describe a directed edge's RESULTING state after the command, not a `Record`-stored entry. Kept
 * as a separate type alias for readability at command-construction/consumption call sites. */
export type PostEditEdgeState = PostEditEdge;

/** `start`/`finish` are `PostEditEndpoint`, not a bare `number` — see `postEditEndpoint.ts`'s doc
 * comment for why a split node's raw `NodeId` isn't safe to keep across confirms. */
export interface PostEditMeta {
  start: PostEditEndpoint | null;
  finish: PostEditEndpoint | null;
}

export type PostEditTeleportDirection = "forward" | "backward" | "two_way";

/** A post-edit teleport link, edited by node/split endpoint (unlike PresetTeleportEntry, which
 * edits by cell coordinates on the pre-generation field). Converted to EdgeDto[] at the
 * WASM-call/render boundary via `postEditTeleportsToDto`. */
export interface PostEditTeleportEntry {
  id: string;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditTeleportDirection;
}

/** Endpoint of a post-edit teleport, identified for hit-testing/drag by the owning entry's id and which end it is. */
export interface PostEditTeleportEndpointHit {
  id: string;
  end: "from" | "to";
}

export type PostEditVerticalPassageDirection = "forward" | "backward" | "two_way";

/** A user-placed `VerticalPassage` link, editable in Post-Edit (GitHub issue #341) — mirrors
 * `PresetVerticalPassageEntry` (`fieldEditUtils.ts`), addressed by `PostEditEndpoint` (node id)
 * instead of `PresetEndpoint` (cell + level), since post-edit addresses already-resolved nodes on
 * the confirmed graph rather than pre-generation cells. Never `split`-addressed — a vertical
 * passage always connects two points' *original* nodes, same as the preset-stage entry it mirrors.
 * `from`/`to` are the two click points in placement order; `"backward"` runs `to -> from`. */
export interface PostEditVerticalPassageEntry {
  id: string;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditVerticalPassageDirection;
}

/** A user-placed `Elevator` link, editable in Post-Edit (GitHub issue #341) — mirrors
 * `PresetElevatorEntry`. Two-way by construction, no direction concept. */
export interface PostEditElevatorEntry {
  id: string;
  floors: PostEditEndpoint[];
}

/** Endpoint of a post-edit vertical passage — mirrors `PostEditTeleportEndpointHit`. */
export interface PostEditVerticalPassageEndpointHit {
  id: string;
  end: "from" | "to";
}

/** Endpoint of a post-edit elevator (GitHub issue #566) — identified by the owning entry's id and
 * the floor level of the dragged marker, mirroring `PresetElevatorEndpointHit` (an elevator has no
 * "from"/"to", only a set of floor endpoints). */
export interface PostEditElevatorEndpointHit {
  id: string;
  level: number;
}

/** A dragged post-edit vertical-passage/elevator endpoint failed to resolve a node on one of its
 * OTHER floors (GitHub issue #566) — mirrors `VerticalDragFailure` (fieldValidity.ts). Reported so
 * the caller can show the user which floor/coordinate rejected the move, then discard the whole
 * gesture (both editors revert on failure, never a partial move). */
export interface PostEditVerticalDragFailure {
  level: number;
  point: [number, number];
}

export interface PostEditAnalytics {
  statistics: MazeStatisticsDto;
  routeInfo: RouteInfoDto | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  issues: IssueDto[];
}
