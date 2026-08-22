import type { NavNodeDto, NavEdgeDto, RouteInfoDto, MazeStatisticsDto, IssueDto } from "../wasm/types";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "delete" | "one_way" | "set_start" | "set_finish" | "teleport_one_way" | "teleport_two_way" | "vertical_passage_one_way" | "vertical_passage_two_way" | "elevator" | "manage_split_nodes";

export interface PostEditEdge {
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  kind: PostEditEdgeKind;
}

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
  id: number;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditTeleportDirection;
}

/** Endpoint of a post-edit teleport, identified for hit-testing/drag by the owning entry's id and which end it is. */
export interface PostEditTeleportEndpointHit {
  id: number;
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
  id: number;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditVerticalPassageDirection;
}

/** A user-placed `Elevator` link, editable in Post-Edit (GitHub issue #341) — mirrors
 * `PresetElevatorEntry`. Two-way by construction, no direction concept. */
export interface PostEditElevatorEntry {
  id: number;
  floors: PostEditEndpoint[];
}

/** Endpoint of a post-edit vertical passage — mirrors `PostEditTeleportEndpointHit`. */
export interface PostEditVerticalPassageEndpointHit {
  id: number;
  end: "from" | "to";
}

export interface PostEditAnalytics {
  statistics: MazeStatisticsDto;
  routeInfo: RouteInfoDto | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  issues: IssueDto[];
}
