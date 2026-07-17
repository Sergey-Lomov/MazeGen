import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellCenter } from "../tessellationGeometry";
import { NODE_RADIUS } from "../sizing";

const VERTEX_MARKER_RADIUS = NODE_RADIUS * 1.35;

export interface VertexHighlightData {
  nodes: NodeDto[];
  /** The single node currently occupying the slot, or `null` if never set / cleared. */
  id: number | null;
  color: number;
  cfg: TessellationConfig;
}

/** Draws a `DebugValueKind.Vertex` debug value (GitHub issue #145's follow-up, e.g. Wilson's
 *  `"walk_start"`/`"walk_head"`) as one enlarged filled circle at the slot's current occupant —
 *  a single reassignable node id, not a set (`RegionHighlightRenderer`) or a chain
 *  (`SequenceHighlightRenderer`). Same API contract as the other highlight renderers (owns a
 *  persistent `Graphics`, `render()` clears+redraws) so `DebugValueHighlightOverlay` can hold any
 *  of the supported kinds interchangeably per debug-value name. */
export class VertexHighlightRenderer {
  private readonly g: Graphics;

  // Cached position map, rebuilt only when `nodes`/`cfg` identity changes — mirrors
  // `MapHighlightRenderer`'s own cache for the same reason (avoids O(total node count) work on
  // every debug-step tick during scrubbing/autoplay).
  private cachedNodes: NodeDto[] | null = null;
  private cachedCfg: TessellationConfig | null = null;
  private nodePos: Map<number, { x: number; y: number }> = new Map();

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: VertexHighlightData): void {
    this.g.clear();
    const { nodes, id, color, cfg } = data;
    if (id === null || nodes.length === 0) return;

    if (this.cachedNodes !== nodes || this.cachedCfg !== cfg) {
      this.nodePos = new Map(nodes.map(n => [n.id, getCellCenter(n.x, n.y, cfg)]));
      this.cachedNodes = nodes;
      this.cachedCfg = cfg;
    }

    const pos = this.nodePos.get(id);
    if (!pos) return;
    this.g.circle(pos.x, pos.y, VERTEX_MARKER_RADIUS).fill(color);
  }

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
