import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices } from "../tessellationGeometry";
import { buildRegionGeometry } from "../selectors/issueHighlightSelectors";

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
  cfg: TessellationConfig;
  /** Skips `perimeterSegments` stroking, drawing only the cell fill. Default `false` (draws both,
   *  the original behavior every other caller relies on). Set by `DebugValueHighlightOverlay` for
   *  `DebugValueKind.Region` debug values (GitHub issue #131's follow-up) — a one-element-per-id
   *  "region" draws a perimeter around every single cell, and with cell walls already rendered
   *  underneath, that outline reads as extra wall lines and makes real walls harder to see. */
  skipPerimeter?: boolean;
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
    const { nodes, regionGroups, color, width, alpha, cfg, skipPerimeter = false } = data;
    if (regionGroups.length === 0 || nodes.length === 0) return;

    for (const group of regionGroups) {
      const { cells, perimeterSegments } = buildRegionGeometry(group, nodes, cfg);

      for (const [x, y] of cells) {
        const verts = getCellVertices(x, y, cfg);
        if (verts) {
          this.g.poly(verts.flatMap(v => [v.x, v.y])).fill({ color, alpha: REGION_FILL_ALPHA });
        }
      }

      if (skipPerimeter) continue;
      for (const seg of perimeterSegments) {
        this.g.moveTo(seg.v0.x, seg.v0.y);
        this.g.lineTo(seg.v1.x, seg.v1.y);
        this.g.stroke({ width, color, alpha });
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
