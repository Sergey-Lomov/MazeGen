import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTeleportEntry } from "../store/postEditTypes";
import { resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint } from "./postEditEndpoint";
import { recordOnLevel } from "./fieldEditUtils";
import { splitPointFaceKindsByNode } from "./splitNodeGeometry";
import type { SplitFaceKind } from "./splitFaceLayout";

/** A split point's floor-scoped node/edge geometry (GitHub issue #567 follow-up), shared by
 * `PostEditSplitTargetDialog`'s preview and `PostEditElevatorFloorDialog`'s per-floor status
 * label — both need the same "resolve this floor's draft edges/teleports against its own nodes,
 * then compute each split node's per-face connectivity" computation, previously duplicated
 * near-verbatim between the two components. `null` if the point isn't actually split on this
 * floor (fewer than 2 nodes there). */
export interface SplitFloorGeometry {
  pointNodes: NodeDto[];
  floorNodes: NodeDto[];
  edges: EdgeDto[];
  faceKindsByNode: SplitFaceKind[][];
}

export function buildSplitFloorGeometry(
  point: [number, number],
  level: number,
  allNodes: NodeDto[],
  draftEdges: Record<string, PostEditEdge> | null | undefined,
  draftTeleports: PostEditTeleportEntry[],
  splitPoints: Record<string, number[]>,
  cfg: Parameters<typeof splitPointFaceKindsByNode>[3],
): SplitFloorGeometry | null {
  const floorNodes = allNodes.filter((n) => (n.level ?? 0) === level);
  const pointNodes = floorNodes.filter((n) => n.x === point[0] && n.y === point[1]);
  if (pointNodes.length < 2) return null;

  // `bareNodeMap`/`resolveSplit` are scoped to THIS floor alone (bare "x,y" keys, built from
  // `floorNodes` only, `level` stripped off every endpoint before resolving) — not maze-wide.
  // `buildSplitNodeResolver` refuses to fall back from an "x,y@level" lookup to the bare key
  // (GitHub issue #425's fix), so on any floor above the first, resolving a `draftEdges`
  // endpoint by its own real (non-undefined) `level` against a bare-only map always failed,
  // silently dropping every edge touching that floor's split slot — the slot rendered with only
  // wall faces and no marker dot (GitHub issue #546 tenth follow-up).
  const floorNodeIds = new Set(floorNodes.map((n) => n.id));
  const bareNodeMap = new Map<string, number[]>();
  for (const n of floorNodes) {
    const k = `${n.x},${n.y}`;
    const list = bareNodeMap.get(k);
    if (list) list.push(n.id); else bareNodeMap.set(k, [n.id]);
  }
  const resolveSplit = buildSplitNodeResolver(bareNodeMap, recordOnLevel(splitPoints, level));
  const edges: EdgeDto[] = [];
  for (const e of Object.values(draftEdges ?? {})) {
    if (e.kind === "wall") continue;
    const from = floorScopedEndpoint(e.from, level, floorNodeIds);
    const to = floorScopedEndpoint(e.to, level, floorNodeIds);
    if (!from || !to) continue;
    const fromId = resolveEndpoint(from, resolveSplit);
    const toId = resolveEndpoint(to, resolveSplit);
    if (fromId === undefined || toId === undefined) continue;
    edges.push({ from: fromId, to: toId, kind: "basic" });
  }
  for (const t of draftTeleports) {
    const from = floorScopedEndpoint(t.from, level, floorNodeIds);
    const to = floorScopedEndpoint(t.to, level, floorNodeIds);
    if (!from || !to) continue;
    const fromId = resolveEndpoint(from, resolveSplit);
    const toId = resolveEndpoint(to, resolveSplit);
    if (fromId === undefined || toId === undefined) continue;
    if (t.direction !== "backward") edges.push({ from: fromId, to: toId, kind: "teleport" });
    if (t.direction !== "forward") edges.push({ from: toId, to: fromId, kind: "teleport" });
  }

  const directed = new Set(edges.filter((e) => e.kind !== "teleport").map((e) => `${e.from}->${e.to}`));
  const byTile = new Map<string, NodeDto[]>();
  for (const n of floorNodes) {
    const k = `${n.x}:${n.y}`;
    const list = byTile.get(k);
    if (list) list.push(n); else byTile.set(k, [n]);
  }
  const faceKindsByNode = splitPointFaceKindsByNode(pointNodes, byTile, directed, cfg);

  return { pointNodes, floorNodes, edges, faceKindsByNode };
}
