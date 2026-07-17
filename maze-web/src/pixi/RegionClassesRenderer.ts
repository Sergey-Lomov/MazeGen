import { Container } from "pixi.js";
import type { NodeDto, RegionClass } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import type { CellFillGroup } from "./renderers/CellFillRenderer";
import { REGION_CLASS_MASK_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";

export interface RegionClassesData {
  nodes: NodeDto[];
  /** Each entry is one SCC region's member maze node ids — same shape as `RegionsData.components`. */
  components: number[][];
  /** component index (as string) -> region class. */
  regionClasses: Record<string, RegionClass>;
  cfg: TessellationConfig;
}

export class RegionClassesRenderer {
  private readonly cells: CellFillRenderer;

  constructor(container: Container) {
    this.cells = new CellFillRenderer(container);
  }

  render(data: RegionClassesData): void {
    const { nodes, components, regionClasses, cfg } = data;
    if (nodes.length === 0 || components.length === 0) {
      this.cells.render([], cfg);
      return;
    }

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    const groups: CellFillGroup[] = components.map((comp, i) => {
      const cells: [number, number][] = [];
      for (const nodeId of comp) {
        const node = nodeById.get(nodeId);
        if (node) cells.push([node.x, node.y]);
      }
      const cls = regionClasses[String(i)];
      const color = cls != null ? canvas.region[cls] : canvas.region.unreachable;
      return { cells, color, alpha: REGION_CLASS_MASK_ALPHA };
    });

    this.cells.render(groups, cfg);
  }

  destroy(): void {
    this.cells.destroy();
  }
}
