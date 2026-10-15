import { Container } from "pixi.js";
import type { NodeDto, RegionClass, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { RegionOverlayRenderer } from "./renderers/RegionOverlayRenderer";
import { REGION_CLASS_MASK_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";
import type { TeleportEdge } from "./renderers/types";

export interface RegionClassesData {
  nodes: NodeDto[];
  /** Each entry is one SCC region's member maze node ids — same shape as `RegionsData.components`. */
  components: number[][];
  /** component index (as string) -> region class. */
  regionClasses: Record<string, RegionClass>;
  cfg: FieldConfig;
  allEdges?: EdgeDto[];
  resolveNodeLevel?: (id: number) => number | undefined;
  activeFloorIndex?: number;
  teleportEdges?: TeleportEdge[];
}

export class RegionClassesRenderer {
  private readonly overlay: RegionOverlayRenderer;

  constructor(cellsContainer: Container, badgesContainer: Container) {
    this.overlay = new RegionOverlayRenderer(cellsContainer, badgesContainer);
  }

  render(data: RegionClassesData): void {
    const { components, regionClasses } = data;
    const componentColors = components.map((_, i) => {
      const cls = regionClasses[String(i)];
      return cls != null ? canvas.region[cls] : canvas.region.unreachable;
    });
    this.overlay.render({ ...data, componentColors, alpha: REGION_CLASS_MASK_ALPHA });
  }

  destroy(): void {
    this.overlay.destroy();
  }
}
