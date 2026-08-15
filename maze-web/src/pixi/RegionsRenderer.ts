import { Container } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { RegionOverlayRenderer } from "./renderers/RegionOverlayRenderer";
import { buildPalette } from "./colorUtils";
import { COMPONENT_MASK_ALPHA } from "./renderConstants";
import type { TeleportEdge } from "./renderers/types";

export interface RegionsData {
  nodes: NodeDto[];
  components: number[][];
  cfg: TessellationConfig;
  allEdges?: EdgeDto[];
  resolveNodeLevel?: (id: number) => number | undefined;
  activeFloorIndex?: number;
  teleportEdges?: TeleportEdge[];
}

export class RegionsRenderer {
  private readonly overlay: RegionOverlayRenderer;

  constructor(cellsContainer: Container, badgesContainer: Container) {
    this.overlay = new RegionOverlayRenderer(cellsContainer, badgesContainer);
  }

  render(data: RegionsData): void {
    const componentColors = buildPalette(data.components.length);
    this.overlay.render({ ...data, componentColors, alpha: COMPONENT_MASK_ALPHA });
  }

  destroy(): void {
    this.overlay.destroy();
  }
}
