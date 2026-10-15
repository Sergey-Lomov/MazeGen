import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { getCellCenter } from "../tessellationGeometry";
import { drawEdge, type RenderEdge } from "../BaseGraphRenderer";
import { NODE_RADIUS } from "../renderConstants";

export interface MapHighlightData {
  nodes: NodeDto[];
  /** Key -> value pairs, each rendered as its own directed arrow from key to value — unlike
   *  `SequenceHighlightRenderer`'s chain, pairs are independent of each other (no connection
   *  between one pair's value and the next pair's key). */
  entries: Map<number, number>;
  color: number;
  cfg: FieldConfig;
}

/** Draws a `DebugValueKind.Map` debug value (GitHub issue #145's follow-up, e.g. Wilson's
 *  `"current_walk"`) as one directed arrow per key -> value pair, plus a filled circle at every id
 *  that appears as a key or a value (same visual-anchor rationale as `SequenceHighlightRenderer`'s
 *  node markers). Same API contract as `RegionHighlightRenderer`/`SequenceHighlightRenderer` (owns
 *  a persistent `Graphics`, `render()` clears+redraws) so `DebugValueHighlightOverlay` can hold any
 *  of the supported kinds interchangeably per debug-value name. */
export class MapHighlightRenderer {
  private readonly g: Graphics;

  // Cached position map, rebuilt only when `nodes`/`cfg` identity changes — mirrors
  // `SequenceHighlightRenderer`'s own cache for the same reason (avoids O(total node count) work
  // on every debug-step tick during scrubbing/autoplay).
  private cachedNodes: NodeDto[] | null = null;
  private cachedCfg: FieldConfig | null = null;
  private nodePos: Map<number, { x: number; y: number }> = new Map();

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: MapHighlightData): void {
    this.g.clear();
    const { nodes, entries, color, cfg } = data;
    if (entries.size === 0 || nodes.length === 0) return;

    if (this.cachedNodes !== nodes || this.cachedCfg !== cfg) {
      this.nodePos = new Map(nodes.map(n => [n.id, getCellCenter(n.x, n.y, cfg)]));
      this.cachedNodes = nodes;
      this.cachedCfg = cfg;
    }
    const nodePos = this.nodePos;

    const markedIds = new Set<number>();
    for (const [key, value] of entries) {
      const from = nodePos.get(key);
      const to = nodePos.get(value);
      if (!from || !to) continue;
      const edge: RenderEdge = { path: [from, to], hasReverse: false };
      drawEdge(this.g, edge, color);
      markedIds.add(key);
      markedIds.add(value);
    }

    for (const id of markedIds) {
      const pos = nodePos.get(id);
      if (!pos) continue;
      this.g.circle(pos.x, pos.y, NODE_RADIUS).fill(color);
    }
  }

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
