import type { NodeDto, EdgeDto, IssueDto } from "../../wasm/types";
import type { MazeState, PostEditEdge } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, PassageKind, TeleportEdge } from "../renderers/types";
import { getCellCenter, getNeighborData } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { NODE_RADIUS } from "../renderConstants";
import { canvas } from "../colorTokens";
import { resolveEndpoint, buildSplitNodeResolver, type PostEditEndpoint } from "../postEditEndpoint";

// Teleport edges are never part of `postEditEdges` — they're tracked separately (see
// `postEditDraftTeleportEdges`/`postEditTeleportEdges` in storeTypes.ts) since a Teleport and a
// Basic edge can coexist in the same direction between the same pair, which the `Record<from-to,
// PostEditEdge>` shape used here can't represent. Callers needing both must concatenate
// `postEditEdgesToDto(...)` with the teleport list themselves.
//
// `resolveSplit` resolves a `split` endpoint to a real node id (see `postEditEndpoint.ts`'s doc
// comment) — an entry with an unresolved endpoint (a split node added but not yet confirmed) is
// silently dropped, same "nothing to draw yet" pattern used elsewhere on this boundary.
export function postEditEdgesToDto(
  postEditEdges: Record<string, PostEditEdge> | null,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): EdgeDto[] {
  if (postEditEdges === null) return [];
  const result: EdgeDto[] = [];
  for (const e of Object.values(postEditEdges)) {
    if (e.kind === "wall") continue;
    const from = resolveEndpoint(e.from, resolveSplit);
    const to = resolveEndpoint(e.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    result.push({ from, to, kind: "basic" });
  }
  return result;
}

// A cell is "closed" (filled as a wall) only when it has no connection at all — including a
// teleport-only connection. A teleport in/out is a valid way to enter/exit the cell even though
// it renders no wall opening on any geometric side (see buildMazeWalls, which deliberately
// ignores teleport edges for the opposite reason: a teleport must not fake an open passage
// between geometric neighbors). Both kinds count as "connected" here.
//
// A split point (GitHub issue #221) can have more than one `NodeDto` at the same (x,y) — the
// original node plus each extra split node. Grouping by cell before checking connectivity is
// required: filtering `nodes` directly (one entry per *node*, not per *cell*) would mark the cell
// closed whenever any single one of its nodes happens to have no edges (e.g. the original node's
// direct passage was walled off, but a split node added at the same point has a passage of its
// own) — the point as a whole is still open, so the cell must not render as a wall.
export function buildClosedCells(nodes: NodeDto[], edges: EdgeDto[]): [number, number][] {
  const connected = new Set<number>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  const anyConnectedByCell = new Map<string, boolean>();
  const cellCoords = new Map<string, [number, number]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    cellCoords.set(key, [n.x, n.y]);
    anyConnectedByCell.set(key, (anyConnectedByCell.get(key) ?? false) || connected.has(n.id));
  }
  const closed: [number, number][] = [];
  for (const [key, isConnected] of anyConnectedByCell) {
    if (!isConnected) closed.push(cellCoords.get(key)!);
  }
  return closed;
}

/** Reduces `nodes`/`edges` for wall/passage rendering (GitHub issue #221) so a split point's cell
 * reads by its currently *active* node only, not the union of every node at that point — e.g. a
 * point split into two independent detours (N<->S on one node, E<->W on the other) must show only
 * whichever detour is active right now, not both openings merged into one cell.
 *
 * For every point present in `splitPoints`, keeps just the active node's `NodeDto` (looked up via
 * `activeSplitNode`, defaulting to the point's original node — same "no entry means original"
 * convention as `postEditActiveSplitNode`) and drops every edge touching one of that point's
 * *other* nodes. Points absent from `splitPoints` (no split nodes at all) pass through untouched.
 */
export function filterNodesToActiveSplitNode(
  nodes: NodeDto[],
  edges: EdgeDto[],
  splitPoints: Readonly<Record<string, number[]>>,
  activeSplitNode: Readonly<Record<string, PostEditEndpoint>>,
): { nodes: NodeDto[]; edges: EdgeDto[] } {
  const pointNodeMap = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = pointNodeMap.get(key);
    if (list) list.push(n.id); else pointNodeMap.set(key, [n.id]);
  }
  const resolveSplit = buildSplitNodeResolver(pointNodeMap, splitPoints);

  // (point key) -> id of every node at that point EXCEPT the active one, to drop from edges/nodes.
  const inactiveIdsByPoint = new Map<string, Set<number>>();
  for (const key of Object.keys(splitPoints)) {
    const ids = pointNodeMap.get(key);
    if (!ids) continue;
    const active = activeSplitNode[key];
    // Falls back to the original node (ids[0]) both when there's no active entry AND when the
    // active entry doesn't resolve yet (a just-added, not-yet-confirmed split node) — without the
    // `?? ids[0]` here, an unresolved `activeId` (undefined) would match no id in `ids`, leaving
    // every node "active" and silently reverting to the old union behavior for that one point.
    const activeId = (active !== undefined ? resolveEndpoint(active, resolveSplit) : undefined) ?? ids[0];
    inactiveIdsByPoint.set(key, new Set(ids.filter((id) => id !== activeId)));
  }
  if (inactiveIdsByPoint.size === 0) return { nodes, edges };

  const isInactive = (id: number, key: string) => inactiveIdsByPoint.get(key)?.has(id) ?? false;
  const filteredNodes = nodes.filter((n) => !isInactive(n.id, `${n.x},${n.y}`));

  const idToPointKey = new Map<number, string>();
  for (const n of nodes) idToPointKey.set(n.id, `${n.x},${n.y}`);
  const filteredEdges = edges.filter((e) => {
    const fromKey = idToPointKey.get(e.from);
    const toKey = idToPointKey.get(e.to);
    if (fromKey !== undefined && isInactive(e.from, fromKey)) return false;
    if (toKey !== undefined && isInactive(e.to, toKey)) return false;
    return true;
  });

  return { nodes: filteredNodes, edges: filteredEdges };
}

export function buildMazeWalls(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
): WallEdge[] {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const e of edges) {
    // Teleport edges are rendered by TeleportRenderer, not as a wall opening -- a teleport
    // between geometrically adjacent cells must not read as an open passage here. `edges` may
    // contain both kinds mixed together (see EdgeDto's coexistence note), so this must filter,
    // not just trust the caller passed a basic-only list.
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const result: WallEdge[] = [];

  for (const n of nodes) {
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      const ownsEdge = n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);

      let kind: PassageKind;
      if (fwd && bwd) kind = "both";
      else if (fwd) kind = "forward";
      else if (bwd) kind = "backward";
      else kind = "none";

      if (kind === "both") continue; // bidirectional passage — no wall

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (kind === "forward" || kind === "backward") {
        const fromCenter = getCellCenter(n.x, n.y, cfg);
        const toCenter = getCellCenter(nx, ny, cfg);
        const tdx = kind === "forward" ? toCenter.x - fromCenter.x : fromCenter.x - toCenter.x;
        const tdy = kind === "forward" ? toCenter.y - fromCenter.y : fromCenter.y - toCenter.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({
        a: [n.x, n.y],
        b: [nx, ny],
        kind,
        style: "solid",
        oneWayDir,
      });
    }
  }

  // Boundary walls (no neighbor in cellSet)
  for (const n of nodes) {
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (cellSet.has(`${nx},${ny}`)) continue;
      result.push({ a: [n.x, n.y], b: [nx, ny], kind: "none", style: "solid" });
    }
  }

  return result;
}

// --- Loss-detection predicates ---
// When adding a new feature that produces user data (not analytics/read-only),
// add a predicate here and wire it into the relevant confirmation dialogs.

/** True when the user has made manual post-edit changes since the last generate/reset. */
export function selectPostEditDirty(s: Pick<MazeState, "postEditDirty">): boolean {
  return s.postEditDirty;
}

/** True when confirming tessellation would destroy data the user has entered. */
export function selectTessellationWouldLoseData(s: Pick<MazeState,
  "previewKind" | "tessellationKind" | "fieldDirty" | "presetsDirty" | "mazeDirty" | "postEditDirty"
>): boolean {
  if (s.previewKind === s.tessellationKind) return false;
  return s.fieldDirty || s.presetsDirty || s.mazeDirty || s.postEditDirty;
}

const PIPELINE_ONLY_ISSUE_KINDS = ["repair_limit_reached"];

/** Issues shown by the Analytics card/feature — `postEditAnalytics.issues` when present
 * (recomputed by `confirmPostEdit`'s `computeAnalytics`, which always re-runs right after
 * generation, even with no user edits), else `issues` (the raw post-generation snapshot).
 * `computeAnalytics` runs QC alone, with no `RepairLimits` concept, so `repair_limit_reached`
 * (pushed only by `build_maze`'s repair loop — see `Specs/repair.md`) can never appear in
 * `postEditAnalytics.issues`; carried forward from `issues` regardless of which source otherwise
 * wins, so it survives the post-generation `confirmPostEdit` recompute. Single source of truth
 * for both the bubble list (`AnalyticsFeature`) and the card status (`FeaturesPanel`) — they must
 * agree on what counts as "this maze has issues". */
export function selectAnalyticsIssues(s: Pick<MazeState, "issues" | "postEditAnalytics">): IssueDto[] {
  return [
    ...s.issues.filter((i) => PIPELINE_ONLY_ISSUE_KINDS.includes(i.kind)),
    ...(s.postEditAnalytics?.issues ?? s.issues),
  ];
}

// Collapses opposite-direction teleport-edge pairs into one entity so a two-way teleport never
// renders as two overlapping lines/arrows. `oneWay: false` when both directions exist between
// the pair; `oneWay: true` (with from/to = that edge's actual direction) when only one does.
export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
): TeleportEdge[] {
  const teleports = edges.filter((e) => e.kind === "teleport");
  const byPair = new Set(teleports.map((e) => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: TeleportEdge[] = [];

  for (const e of teleports) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const reverseExists = byPair.has(`${e.to}->${e.from}`);
    const fromNode = nodeById.get(e.from);
    const toNode = nodeById.get(e.to);
    if (!fromNode || !toNode) continue;

    const fromCenter = getCellCenter(fromNode.x, fromNode.y, cfg);
    const toCenter = getCellCenter(toNode.x, toNode.y, cfg);
    result.push({
      from: [fromCenter.x, fromCenter.y],
      to: [toCenter.x, toCenter.y],
      oneWay: !reverseExists,
    });
  }

  return result;
}

export function buildMazeMarkers(
  nodeById: Map<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig,
): MarkerData[] {
  const markers: MarkerData[] = [];
  if (start !== null) {
    const n = nodeById.get(start);
    if (n) {
      const c = getCellCenter(n.x, n.y, cfg);
      markers.push({ pos: [c.x, c.y], color: canvas.node.start, radius: NODE_RADIUS * 1.5 });
    }
  }
  if (finish !== null) {
    const n = nodeById.get(finish);
    if (n) {
      const c = getCellCenter(n.x, n.y, cfg);
      markers.push({ pos: [c.x, c.y], color: canvas.node.finish, radius: NODE_RADIUS * 1.5 });
    }
  }
  return markers;
}

