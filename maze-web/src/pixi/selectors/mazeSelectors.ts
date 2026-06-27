import type { NodeDto, EdgeDto, IssueDto } from "../../wasm/types";
import type { MazeState, PostEditEdge } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, PassageKind } from "../renderers/types";
import { getCellCenter, getNeighborData } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { NODE_START_COLOR, NODE_FINISH_COLOR, NODE_RADIUS } from "../colorUtils";

export function postEditEdgesToDto(postEditEdges: Record<string, PostEditEdge> | null): EdgeDto[] {
  if (postEditEdges === null) return [];
  return Object.values(postEditEdges)
    .filter(e => e.kind !== "wall")
    .map(e => ({ from: e.from, to: e.to }));
}

export function buildClosedCells(nodes: NodeDto[], edges: EdgeDto[]): [number, number][] {
  const connected = new Set<number>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  return nodes.filter(n => !connected.has(n.id)).map(n => [n.x, n.y]);
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

const PIPELINE_ONLY_ISSUE_KINDS = ["repair_limit_reached", "qc_no_progress"];

/** Issues shown by the Analytics card/feature — `postEditAnalytics.issues` when present
 * (recomputed by `confirmPostEdit`'s `computeAnalytics`, which always re-runs right after
 * generation, even with no user edits), else `issues` (the raw post-generation snapshot).
 * `computeAnalytics` runs QC alone, with no `RepairLimits` concept, so `repair_limit_reached`/
 * `qc_no_progress` (pushed only by `build_maze`'s repair loop — see `Specs/repair.md`) can never
 * appear in `postEditAnalytics.issues`; carried forward from `issues` regardless of which source
 * otherwise wins, so they survive the post-generation `confirmPostEdit` recompute. Single source
 * of truth for both the bubble list (`AnalyticsFeature`) and the card status (`FeaturesPanel`) —
 * they must agree on what counts as "this maze has issues". */
export function selectAnalyticsIssues(s: Pick<MazeState, "issues" | "postEditAnalytics">): IssueDto[] {
  return [
    ...s.issues.filter((i) => PIPELINE_ONLY_ISSUE_KINDS.includes(i.kind)),
    ...(s.postEditAnalytics?.issues ?? s.issues),
  ];
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
      markers.push({ pos: [c.x, c.y], color: NODE_START_COLOR, radius: NODE_RADIUS * 1.5 });
    }
  }
  if (finish !== null) {
    const n = nodeById.get(finish);
    if (n) {
      const c = getCellCenter(n.x, n.y, cfg);
      markers.push({ pos: [c.x, c.y], color: NODE_FINISH_COLOR, radius: NODE_RADIUS * 1.5 });
    }
  }
  return markers;
}

