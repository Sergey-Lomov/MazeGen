import { Container } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import type { CellFillGroup } from "./renderers/CellFillRenderer";
import { buildPalette, COMPONENT_MASK_ALPHA } from "./colorUtils";


export interface ComponentData {
  nodes: NodeDto[];
  components: number[][];
  cfg: TessellationConfig;
}

export class ComponentRenderer {
  private readonly cells: CellFillRenderer;

  constructor(container: Container) {
    this.cells = new CellFillRenderer(container);
  }

  render(data: ComponentData): void {
    const { nodes, components, cfg } = data;
    if (nodes.length === 0 || components.length === 0) {
      this.cells.render([], cfg);
      return;
    }

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    const palette = buildPalette(components.length);
    const groups: CellFillGroup[] = components.map((comp, i) => {
      const cells: [number, number][] = [];
      for (const nodeId of comp) {
        const node = nodeById.get(nodeId);
        if (node) cells.push([node.x, node.y]);
      }
      return { cells, color: palette[i], alpha: COMPONENT_MASK_ALPHA };
    });

    this.cells.render(groups, cfg);
  }

  destroy(): void {
    this.cells.destroy();
  }
}
