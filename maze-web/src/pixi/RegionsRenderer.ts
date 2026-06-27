import { Container } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import type { CellFillGroup } from "./renderers/CellFillRenderer";
import { RegionBorderRenderer } from "./renderers/RegionBorderRenderer";
import type { RegionBorderGroup } from "./renderers/RegionBorderRenderer";
import { buildPalette, COMPONENT_MASK_ALPHA, WALL_THICKNESS } from "./colorUtils";

export interface RegionsContainers {
  fill: Container;
  border: Container;
}

export interface RegionsData {
  nodes: NodeDto[];
  components: number[][];
  cfg: TessellationConfig;
}

export class RegionsRenderer {
  private readonly cells: CellFillRenderer;
  private readonly border: RegionBorderRenderer;

  constructor(containers: RegionsContainers) {
    this.cells = new CellFillRenderer(containers.fill);
    this.border = new RegionBorderRenderer(containers.border);
  }

  render(data: RegionsData): void {
    const { nodes, components, cfg } = data;
    if (nodes.length === 0 || components.length === 0) {
      this.cells.render([], cfg);
      this.border.render([], cfg);
      return;
    }

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    const palette = buildPalette(components.length);
    const cellsByComponent: [number, number][][] = components.map((comp) => {
      const cells: [number, number][] = [];
      for (const nodeId of comp) {
        const node = nodeById.get(nodeId);
        if (node) cells.push([node.x, node.y]);
      }
      return cells;
    });

    const fillGroups: CellFillGroup[] = cellsByComponent.map((cells, i) => ({
      cells,
      color: palette[i],
      alpha: COMPONENT_MASK_ALPHA,
    }));
    const borderGroups: RegionBorderGroup[] = cellsByComponent.map((cells, i) => ({
      cells,
      color: palette[i],
      width: WALL_THICKNESS,
      inset: WALL_THICKNESS,
    }));

    this.cells.render(fillGroups, cfg);
    this.border.render(borderGroups, cfg);
  }

  destroy(): void {
    this.cells.destroy();
    this.border.destroy();
  }
}
