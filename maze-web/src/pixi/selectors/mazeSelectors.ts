import type { NodeDto, EdgeDto, IssueDto } from "../../wasm/types";
import type { MazeState, PostEditEdge } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, PassageKind, TeleportEdge, SplitPassage } from "../renderers/types";
import { getCellCenter, getNeighborData, getSplitCircleRotationDeg, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { NODE_RADIUS } from "../renderConstants";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { splitSlotColor } from "../colorUtils";
import { resolveEndpoint } from "../postEditEndpoint";

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

/** Points with more than one `NodeDto` (split points, GitHub issue #221/#223) — geometric edges
 *  touching one of these are excluded from `buildMazeWalls`'s ordinary reading entirely; they
 *  render exclusively via `buildSplitPassages`'s colored per-node lines instead. */
function buildSplitPointKeys(nodes: NodeDto[]): Set<string> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = new Set<string>();
  for (const [key, count] of counts) if (count > 1) keys.add(key);
  return keys;
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
  const splitPointKeys = buildSplitPointKeys(nodes);
  const result: WallEdge[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    if (splitPointKeys.has(selfKey)) continue; // rendered by buildSplitPassages instead
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      if (splitPointKeys.has(`${nx},${ny}`)) continue; // rendered by buildSplitPassages instead
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
    if (splitPointKeys.has(`${n.x},${n.y}`)) continue; // rendered by buildSplitPassages instead
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

/** A split point's hub-point circle radius (GitHub issue #223) — 1/2 of the cell's own radius. */
const SPLIT_HUB_RADIUS = TILE_SIZE / 4;

/** A split point's per-slot point on its hub circle — shared by `getSplitAwareNodePosition` and
 *  `buildSplitPassages` so the two never drift apart (same radius/rotation/slot formula). */
function splitHubPoint(
  center: { x: number; y: number },
  slotIndex: number,
  slotCount: number,
  cfg: TessellationConfig,
): { x: number; y: number } {
  const rotationRad = (getSplitCircleRotationDeg(cfg) * Math.PI) / 180;
  const angle = rotationRad + (2 * Math.PI * slotIndex) / slotCount;
  return { x: center.x + SPLIT_HUB_RADIUS * Math.cos(angle), y: center.y + SPLIT_HUB_RADIUS * Math.sin(angle) };
}

/** Position to draw a node-anchored entity (start/finish marker, teleport endpoint) at — the
 *  cell's own center for an ordinary (unsplit) node, or that node's hub point on the small circle
 *  `buildSplitPassages` places split-point nodes on (`splitHubPoint`, same formula), so a
 *  marker landing on a split point reads as belonging to one specific node of it, not the tile as
 *  a whole (GitHub issue #223). `nodes` must include every node of the point (not just `nodeId`)
 *  for the slot index to be computed correctly. */
export function getSplitAwareNodePosition(
  nodes: NodeDto[],
  nodeId: number,
  cfg: TessellationConfig,
): { x: number; y: number } | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const pointNodes = nodes.filter((n) => n.x === node.x && n.y === node.y);
  const center = getCellCenter(node.x, node.y, cfg);
  if (pointNodes.length <= 1) return center;

  const slotIndex = pointNodes.findIndex((n) => n.id === nodeId);
  return splitHubPoint(center, slotIndex, pointNodes.length, cfg);
}

/** Colored passages for every split point (GitHub issue #223). Each node of a split point gets
 *  its own share of the wall on every geometric face it connects across (`wallSegments`) — when
 *  several of the point's nodes connect across the same face, that face's edge is divided evenly
 *  among them in slot order, each getting one contiguous sub-segment, so independent passages
 *  sharing a face read as visually distinct rather than overlapping.
 *
 *  Those shares are then linked into `connectors`: a node with exactly 2 connected faces draws one
 *  straight line directly between its two shares' centers — no hub point, since a pure through-
 *  passage reads more naturally as one continuous corridor. Any other count (1 or 3+) draws one
 *  line per share from the node's own point on a small circle (radius = 1/2 of the cell, i.e.
 *  `TILE_SIZE / 4`, evenly distributed among the point's node count, rotated by the tessellation's
 *  own starting angle — `getSplitCircleRotationDeg`) out to that share's center; the circle itself
 *  is never drawn. A node with zero connections produces no `SplitPassage` entry at all.
 *
 *  **Straightening exception:** a node whose only two connections are both ordinary geometric
 *  faces still gets the straight 2-face connector described above — but a node carrying a
 *  start/finish marker or a teleport endpoint (`specialNodeIds`) always keeps its hub point even
 *  at exactly 2 connections, since a marker/teleport line drawn on that node's hub point would
 *  otherwise sit on a straight line with nothing marking which point along it is actually special. */
export function buildSplitPassages(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  specialNodeIds: ReadonlySet<number> = new Set(),
): SplitPassage[] {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  // Directed node-id pairs, so a node's own connectivity to a specific face can be read directly
  // without re-scanning `edges` per node (this function runs once per redraw over every split
  // point's every node).
  const directed = new Set<string>();
  for (const e of edges) {
    if (e.kind === "teleport") continue;
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
    directed.add(`${e.from}->${e.to}`);
  }

  const byPoint = new Map<string, NodeDto[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = byPoint.get(key);
    if (list) list.push(n); else byPoint.set(key, [n]);
  }

  const result: SplitPassage[] = [];

  for (const pointNodes of byPoint.values()) {
    if (pointNodes.length <= 1) continue; // unsplit point — rendered by buildMazeWalls instead

    const [px, py] = [pointNodes[0].x, pointNodes[0].y];
    const center = getCellCenter(px, py, cfg);
    const count = pointNodes.length;
    const circlePoint = (slotIndex: number) => splitHubPoint(center, slotIndex, count, cfg);

    // Every distinct neighboring face this point's nodes connect across, geometric-neighbor-point
    // keyed (not per specific neighbor node) — collected once per point so each face's edge can be
    // divided among exactly the nodes that actually use it, in slot order.
    const facesToOthers = new Map<string, { x: number; y: number }>();
    for (const node of pointNodes) {
      for (const other of nodes) {
        if (other.x === node.x && other.y === node.y) continue;
        if (!directed.has(`${node.id}->${other.id}`) && !directed.has(`${other.id}->${node.id}`)) continue;
        facesToOthers.set(`${other.x},${other.y}`, { x: other.x, y: other.y });
      }
    }

    // Per-node accumulator, in slot order — filled face by face below, then turned into
    // `SplitPassage` entries once every face has been processed.
    const segmentsBySlot: SplitPassage["wallSegments"][] = pointNodes.map(() => []);

    for (const other of facesToOthers.values()) {
      const seg = getSharedEdgeSegment([px, py], [other.x, other.y], cfg);
      if (!seg) continue;

      // This face's connected nodes, in slot order — determines both the sub-segment order along
      // the edge and which node gets which piece.
      const connectedSlots: number[] = [];
      pointNodes.forEach((node, slotIndex) => {
        const connected = nodes.some((cand) =>
          cand.x === other.x && cand.y === other.y &&
          (directed.has(`${node.id}->${cand.id}`) || directed.has(`${cand.id}->${node.id}`)));
        if (connected) connectedSlots.push(slotIndex);
      });
      if (connectedSlots.length === 0) continue;

      // `seg.v0`→`seg.v1` order is canonicalized by `getSharedEdgeSegment` based on the *lower*
      // of the two points' coordinates, independent of which side `px,py` is on — flip the
      // sub-segment order when this point is the "to" side, so slot order still maps to a
      // consistent physical direction along the edge regardless of which side owns v0/v1.
      const pxy: [number, number] = [px, py];
      const oxy: [number, number] = [other.x, other.y];
      const pIsLower = pxy[0] < oxy[0] || (pxy[0] === oxy[0] && pxy[1] < oxy[1]);
      const orderedSlots = pIsLower ? connectedSlots : [...connectedSlots].reverse();

      const n = orderedSlots.length;
      orderedSlots.forEach((slotIndex, i) => {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const v0 = { x: seg.v0.x + (seg.v1.x - seg.v0.x) * t0, y: seg.v0.y + (seg.v1.y - seg.v0.y) * t0 };
        const v1 = { x: seg.v0.x + (seg.v1.x - seg.v0.x) * t1, y: seg.v0.y + (seg.v1.y - seg.v0.y) * t1 };
        const segCenter = { x: (v0.x + v1.x) / 2, y: (v0.y + v1.y) / 2 };

        const node = pointNodes[slotIndex];
        const fwd = nodes.some((cand) => cand.x === other.x && cand.y === other.y && directed.has(`${node.id}->${cand.id}`));
        const bwd = nodes.some((cand) => cand.x === other.x && cand.y === other.y && directed.has(`${cand.id}->${node.id}`));
        let oneWayDir: { dx: number; dy: number } | undefined;
        if (fwd !== bwd) {
          const toCenter = getCellCenter(other.x, other.y, cfg);
          const dx = fwd ? toCenter.x - center.x : center.x - toCenter.x;
          const dy = fwd ? toCenter.y - center.y : center.y - toCenter.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 0) oneWayDir = { dx: dx / len, dy: dy / len };
        }

        segmentsBySlot[slotIndex].push({ v0, v1, center: segCenter, oneWayDir });
      });
    }

    pointNodes.forEach((node, slotIndex) => {
      const wallSegments = segmentsBySlot[slotIndex];
      if (wallSegments.length === 0) return; // no connections — draws nothing

      const color = splitSlotColor(slotIndex, canvas.node.splitSlots);
      const straighten = wallSegments.length === 2 && !specialNodeIds.has(node.id);
      const connectors = straighten
        ? [{ from: wallSegments[0].center, to: wallSegments[1].center }]
        : wallSegments.map((seg) => ({ from: circlePoint(slotIndex), to: seg.center }));

      result.push({ color, wallSegments, connectors });
    });
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
//
// A teleport endpoint on a split point (GitHub issue #223) anchors to that node's own hub point
// (`getSplitAwareNodePosition`), not the tile's plain center — `nodeById`'s full value set stands
// in for `nodes` here (unsplit callers, e.g. GenerationRenderer, never have more than one node per
// point, so this is a no-op for them; only PostEditRenderer's split points actually differ).
export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
): TeleportEdge[] {
  const teleports = edges.filter((e) => e.kind === "teleport");
  const byPair = new Set(teleports.map((e) => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: TeleportEdge[] = [];
  const allNodes = Array.from(nodeById.values());

  for (const e of teleports) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const reverseExists = byPair.has(`${e.to}->${e.from}`);
    const fromPos = getSplitAwareNodePosition(allNodes, e.from, cfg);
    const toPos = getSplitAwareNodePosition(allNodes, e.to, cfg);
    if (!fromPos || !toPos) continue;

    result.push({
      from: [fromPos.x, fromPos.y],
      to: [toPos.x, toPos.y],
      oneWay: !reverseExists,
    });
  }

  return result;
}

/** A start/finish marker on a split point (GitHub issue #223) anchors to that node's own hub
 *  point (`getSplitAwareNodePosition`), not the tile's plain center — `nodeById`'s full value set
 *  stands in for `nodes` (see `buildTeleportEdges`'s doc comment for why this is safe for
 *  unsplit callers). */
export function buildMazeMarkers(
  nodeById: Map<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig,
): MarkerData[] {
  const markers: MarkerData[] = [];
  const allNodes = Array.from(nodeById.values());
  if (start !== null) {
    const c = getSplitAwareNodePosition(allNodes, start, cfg);
    if (c) markers.push({ pos: [c.x, c.y], color: canvas.node.start, radius: NODE_RADIUS * 1.5 });
  }
  if (finish !== null) {
    const c = getSplitAwareNodePosition(allNodes, finish, cfg);
    if (c) markers.push({ pos: [c.x, c.y], color: canvas.node.finish, radius: NODE_RADIUS * 1.5 });
  }
  return markers;
}

