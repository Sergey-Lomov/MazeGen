import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { buildRegionGeometry } from "../selectors/issueHighlightSelectors";
import { drawCellHighlightAt, drawCellHighlightPath, getCellHighlightInset, type CellHighlightCornerStyle } from "../cellHighlightGeometry";
import { cellBoundaryKey, drawCellBoundaryHighlight } from "./wallUtils";

const REGION_FILL_ALPHA = 0.25;

function pointKey(p: { x: number; y: number }): string {
  const roundedKey = (value: number) => {
    const rounded = Number(value.toFixed(4));
    return rounded === 0 ? "0.0000" : rounded.toFixed(4);
  };
  return `${roundedKey(p.x)},${roundedKey(p.y)}`;
}

function canonicalizeContour(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const rotateToLowest = (input: { x: number; y: number }[]) => {
    let lowest = 0;
    for (let i = 1; i < input.length; i++) {
      if (input[i].y < input[lowest].y || (input[i].y === input[lowest].y && input[i].x < input[lowest].x)) lowest = i;
    }
    return input.slice(lowest).concat(input.slice(0, lowest));
  };
  const forward = rotateToLowest(points);
  const backward = rotateToLowest([...points].reverse());
  return forward.map(pointKey).join("|") <= backward.map(pointKey).join("|") ? forward : backward;
}

function simplifyContour(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const result = points.filter((point, i) => i === 0 || pointKey(point) !== pointKey(points[i - 1]));
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const a = result[(i + result.length - 1) % result.length];
      const b = result[i];
      const c = result[(i + 1) % result.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) <= 1e-6) {
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** Turns the exposed cell sides into one or more closed loops. Shared sides never appear here, so
 * adjacent region cells become one silhouette (including L-shaped and stepped regions).
 *
 * Segments are traced per `component` (GitHub issue #618): two cells that touch only at a corner
 * point are not edge-adjacent, so `buildRegionGeometry` puts them in different components even
 * though a vertex can coincide. Tracing them together would let the turn-angle rule cross from
 * one cell's boundary into the other's at that shared point, producing a self-intersecting
 * "bowtie" contour instead of two separate ones. */
type ContourPoint = { x: number; y: number };
type ContourSide = { v0: ContourPoint; v1: ContourPoint; polyline?: ContourPoint[] };

export function buildRegionContours(segments: (ContourSide & { component: number })[]): { x: number; y: number }[][] {
  const contours: { x: number; y: number }[][] = [];
  const byComponent = new Map<number, typeof segments>();
  for (const seg of segments) {
    const group = byComponent.get(seg.component) ?? [];
    group.push(seg);
    byComponent.set(seg.component, group);
  }
  for (const group of byComponent.values()) contours.push(...traceContours(group));
  return contours;
}

function traceContours(segments: ContourSide[]): { x: number; y: number }[][] {
  // Keep the boundary as an undirected geometric graph. The old tracer indexed only `v0`, which
  // happened to work for square cells because every exposed side was oriented consistently. Hex
  // and triangle cells can expose the same vertex with the opposite segment orientation, so that
  // tracer stopped at a valid vertex and rendered separate cells. Half-edges make the merge
  // independent of the tessellation's local vertex winding.
  // A side's interior points (an arc's flattening) travel with it, so a curved side keeps its
  // shape in the contour while the turn rule still sees only its end points.
  const edges = segments
    .filter((seg) => pointKey(seg.v0) !== pointKey(seg.v1))
    .map((seg) => ({ ...seg, via: seg.polyline?.slice(1, -1) ?? [], used: false }));
  const byPoint = new Map<string, { edge: number; to: { x: number; y: number } }[]>();
  const addHalfEdge = (point: { x: number; y: number }, to: { x: number; y: number }, edge: number) => {
    const entries = byPoint.get(pointKey(point)) ?? [];
    entries.push({ edge, to });
    byPoint.set(pointKey(point), entries);
  };
  edges.forEach((edge, i) => {
    addHalfEdge(edge.v0, edge.v1, i);
    addHalfEdge(edge.v1, edge.v0, i);
  });
  // The interior points of `edge` in the direction of travel that ends at `end`.
  const viaTowards = (edge: (typeof edges)[number], end: ContourPoint) => pointKey(end) === pointKey(edge.v1) ? edge.via : [...edge.via].reverse();

  const contours: { x: number; y: number }[][] = [];
  for (const first of edges) {
    if (first.used) continue;
    first.used = true;
    const contour = [first.v0, ...first.via, first.v1];
    const startKey = pointKey(first.v0);
    let previous = first.v0;
    let current = first.v1;
    while (pointKey(current) !== startKey) {
      const candidates = (byPoint.get(pointKey(current)) ?? [])
        .filter(({ edge }) => !edges[edge].used)
        .map(({ edge, to: nextPoint }) => {
          const incoming = { x: current.x - previous.x, y: current.y - previous.y };
          const outgoing = { x: nextPoint.x - current.x, y: nextPoint.y - current.y };
          const clockwiseTurn = (Math.atan2(incoming.x * outgoing.y - incoming.y * outgoing.x, incoming.x * outgoing.x + incoming.y * outgoing.y) + Math.PI * 2) % (Math.PI * 2);
          return { edge, nextPoint, clockwiseTurn };
        });
      const chosen = candidates.sort((a, b) => a.clockwiseTurn - b.clockwiseTurn)[0];
      if (chosen === undefined) break;
      edges[chosen.edge].used = true;
      contour.push(...viaTowards(edges[chosen.edge], chosen.nextPoint), chosen.nextPoint);
      previous = current;
      current = chosen.nextPoint;
    }
    if (contour.length >= 3 && pointKey(current) === startKey) {
      contours.push(canonicalizeContour(simplifyContour(contour.slice(0, -1))));
    }
  }
  return contours;
}

function pointInsideContour(point: { x: number; y: number }, contour: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const a = contour[i], b = contour[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function renderRegionContours(
  g: Graphics,
  contours: { x: number; y: number }[][],
  color: number,
  alpha: number,
  inset: number,
  cornerStyle: CellHighlightCornerStyle,
  borderWidth: number,
): void {
  const depth = contours.map((contour) => contours.reduce(
    (count, other) => count + (other !== contour && pointInsideContour(contour[0], other) ? 1 : 0), 0,
  ));
  const parent = contours.map((contour, i) => contours
    .map((other, j) => ({ other, j }))
    .filter(({ other, j }) => j !== i && pointInsideContour(contour[0], other))
    .sort((a, b) => depth[a.j] - depth[b.j])[0]?.j ?? -1);
  const children = contours.map((_, i) => parent
    .map((p, j) => p === i ? j : -1)
    .filter((j) => j >= 0));
  const renderNode = (i: number) => {
    // A hole needs the opposite offset from its containing contour. With a positive inset the
    // outer region moves inward, while the hole must expand outward to keep the same wall gap;
    // with an outward split inset the signs reverse together.
    const contourInset = depth[i] % 2 === 0 ? inset : -inset;
    drawCellHighlightPath(g, contours[i], contourInset, cornerStyle);
    if (depth[i] % 2 === 0) g.fill({ color, alpha });
    else g.cut();
    for (const child of children[i]) renderNode(child);
  };
  for (let i = 0; i < contours.length; i++) {
    if (parent[i] === -1) renderNode(i);
  }
  if (borderWidth > 0) {
    for (let i = 0; i < contours.length; i++) {
      const contourInset = depth[i] % 2 === 0 ? inset : -inset;
      drawCellHighlightPath(g, contours[i], contourInset, cornerStyle);
      g.stroke({ color, alpha: 1, width: borderWidth });
    }
  }
}

export interface RegionHighlightData {
  nodes: NodeDto[];
  /** SCC regions to highlight, each as its own list of maze node ids — kept as separate groups
   *  (not one flat list) so two adjacent-in-id-space-but-disjoint regions don't merge into one
   *  shared boundary. */
  regionGroups: number[][];
  color: number;
  width: number;
  alpha: number;
  cfg: FieldConfig;
  /** Additional cells that are visual targets but do not have a node id (for example a
   *  cross-floor teleport badge drawn at a snapped midpoint). */
  cells?: [number, number][];
  /** Skips `perimeterSegments` stroking, drawing only the cell fill. Default `false` (draws both,
   *  the original behavior every other caller relies on). Set by `DebugValueHighlightOverlay` for
   *  `DebugValueKind.Region` debug values (GitHub issue #131's follow-up) — a one-element-per-id
   *  "region" draws a perimeter around every single cell, and with cell walls already rendered
   *  underneath, that outline reads as extra wall lines and makes real walls harder to see. */
  skipPerimeter?: boolean;
  /** Inset and corner treatment for the cell fills. Defaults to the shared highlight style. */
  inset?: number;
  cornerStyle?: CellHighlightCornerStyle;
  /** Opaque outline around each inset cell fill. Defaults to the 3px edge-highlight stroke. */
  borderWidth?: number;
  insetMode?: "inset" | "outset";
  /** Multiple independently colored regions rendered in one pass. Used by Analytics' region
   *  overlays so each SCC keeps its own color while sharing the merged-contour implementation. */
  groups?: { regionGroups: number[][]; color: number; fillAlpha?: number; insetMode?: "inset" | "outset" }[];
  boundaryEdges?: [number, number][];
  boundaryWidth?: number;
  boundaryFillAlpha?: number;
  boundaryBorderWidth?: number;
}

/** Draws region fill + perimeter for one or more SCC regions — same API contract as
 *  `EdgeHighlightRenderer` (owns a persistent `Graphics`, `render()` clears+redraws) so both
 *  feature-owners (`IssueHighlightOverlay` for Analytics, `DebugRefHighlightOverlay` for
 *  GitHub issue #130's debug-tree refs) hold their own instance with a consistent lifecycle.
 *  Geometry itself comes from `buildRegionGeometry` (pure, unit-tested); this class only draws
 *  it. */
export class RegionHighlightRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: RegionHighlightData): void {
    this.g.clear();
    const { nodes, regionGroups, color, width, alpha, cfg, cells = [], skipPerimeter = false,
      inset = getCellHighlightInset(), insetMode = "inset", cornerStyle = "round", borderWidth = 3, groups,
      boundaryEdges = [], boundaryWidth, boundaryFillAlpha = REGION_FILL_ALPHA, boundaryBorderWidth = 3 } = data;
    const renderGroups = groups ?? [{ regionGroups, color, fillAlpha: REGION_FILL_ALPHA }];
    if (regionGroups.length === 0 && cells.length === 0 && boundaryEdges.length === 0 && (!groups || groups.every((group) => group.regionGroups.length === 0))) return;

    for (const style of renderGroups) for (const group of style.regionGroups) {
      const { cells, perimeterSegments } = buildRegionGeometry(group, nodes, cfg);
      const splitInset = (style.insetMode ?? insetMode) === "outset" ? -Math.abs(inset) : inset;

      const contours = buildRegionContours(perimeterSegments);
      if (contours.length > 0) {
        renderRegionContours(this.g, contours, style.color, style.fillAlpha ?? REGION_FILL_ALPHA, splitInset, cornerStyle, borderWidth);
      } else for (const [x, y] of cells) {
        drawCellHighlightAt(this.g, x, y, cfg, style.color, style.fillAlpha ?? REGION_FILL_ALPHA, splitInset, cornerStyle, borderWidth);
      }

      if (skipPerimeter) continue;
      for (const seg of perimeterSegments) {
        this.g.moveTo(seg.polyline[0].x, seg.polyline[0].y);
        for (let i = 1; i < seg.polyline.length; i++) this.g.lineTo(seg.polyline[i].x, seg.polyline[i].y);
        this.g.stroke({ width, color, alpha });
      }
    }
    const cellsInset = insetMode === "outset" ? -Math.abs(inset) : inset;
    for (const [x, y] of cells) {
      drawCellHighlightAt(this.g, x, y, cfg, color, REGION_FILL_ALPHA, cellsInset, cornerStyle, borderWidth);
    }
    if (boundaryEdges.length > 0) {
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const drawnEdges = new Set<string>();
      for (const [fromId, toId] of boundaryEdges) {
        const from = nodeById.get(fromId);
        const to = nodeById.get(toId);
        if (!from || !to) continue;
        const key = cellBoundaryKey([from.x, from.y], [to.x, to.y]);
        if (drawnEdges.has(key)) continue;
        const drew = drawCellBoundaryHighlight(this.g, [from.x, from.y], [to.x, to.y], cfg, color, boundaryFillAlpha, boundaryBorderWidth, boundaryWidth);
        if (drew) drawnEdges.add(key);
      }
    }
  }

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
