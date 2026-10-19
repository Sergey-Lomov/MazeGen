import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { buildRegionGeometry } from "../selectors/issueHighlightSelectors";
import { drawCellHighlightAt, getCellHighlightInset, type CellHighlightCornerStyle } from "../cellHighlightGeometry";
import { buildRegionContours, renderRegionContours } from "./regionContours";
import { cellBoundaryKey, drawCellBoundaryHighlight } from "./wallUtils";

export { buildRegionContours };

const REGION_FILL_ALPHA = 0.25;

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
