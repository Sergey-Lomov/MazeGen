import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, PassageKind } from "../renderers/types";
import { getCellCenter, getNeighborData } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";
import { NODE_START_COLOR, NODE_FINISH_COLOR, NODE_RADIUS } from "../colorUtils";

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

