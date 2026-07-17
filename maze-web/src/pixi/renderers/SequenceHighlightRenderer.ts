import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellCenter } from "../tessellationGeometry";
import { drawEdge, type RenderEdge } from "../BaseGraphRenderer";
import { NODE_RADIUS } from "../sizing";

export interface SequenceHighlightData {
  nodes: NodeDto[];
  /** Ordered id sequence — adjacent ids are connected by an arrow, in this order, mirroring the
   *  graph/nav-graph edge visual (`BaseGraphRenderer.drawEdges`). Not closed into a loop: no
   *  edge is drawn from the last id back to the first. */
  sequence: number[];
  color: number;
  cfg: TessellationConfig;
}

/** Draws a `DebugValueKind.Sequence` debug value (GitHub issue #131's follow-up, e.g.
 *  `"recursion_stack"`) as an open chain of arrows between consecutive ids, plus a filled circle
 *  at each id in the sequence (an arrow-only chain reads as disconnected line segments floating
 *  over the maze — the node markers anchor it visually the same way graph/nav-graph overlays
 *  mark their own nodes). Reuses `BaseGraphRenderer`'s `drawEdge` primitive directly rather than
 *  subclassing `BaseGraphRenderer` itself (that class also manages interactive/hoverable nodes,
 *  which this overlay has no use for) or sharing a renderer instance with another feature
 *  (forbidden by `maze-web/CLAUDE.md`'s feature-renderer ownership rule). Same API contract as
 *  `RegionHighlightRenderer` (owns a persistent `Graphics`, `render()` clears+redraws) so
 *  `DebugValueHighlightOverlay` can hold either kind interchangeably per debug-value name. */
export class SequenceHighlightRenderer {
  private readonly g: Graphics;

  // Cached position map, rebuilt only when `nodes`/`cfg` identity changes — `nodes` is the
  // whole-maze node list and stays referentially stable across debug steps within one debug
  // session (see `GenerationRenderer`'s own `geometryCache` for the same pattern), so rebuilding
  // it on every `render()` call (once per debug-step tick during scrubbing/autoplay) would be
  // O(total node count) wasted work regardless of how small `sequence` itself is.
  private cachedNodes: NodeDto[] | null = null;
  private cachedCfg: TessellationConfig | null = null;
  private nodePos: Map<number, { x: number; y: number }> = new Map();

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: SequenceHighlightData): void {
    this.g.clear();
    const { nodes, sequence, color, cfg } = data;
    if (sequence.length === 0 || nodes.length === 0) return;

    if (this.cachedNodes !== nodes || this.cachedCfg !== cfg) {
      this.nodePos = new Map(nodes.map(n => [n.id, getCellCenter(n.x, n.y, cfg)]));
      this.cachedNodes = nodes;
      this.cachedCfg = cfg;
    }
    const nodePos = this.nodePos;
    for (let i = 0; i < sequence.length - 1; i++) {
      const from = nodePos.get(sequence[i]);
      const to = nodePos.get(sequence[i + 1]);
      if (!from || !to) continue;
      const edge: RenderEdge = { path: [from, to], hasReverse: false };
      drawEdge(this.g, edge, color);
    }

    for (const id of sequence) {
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
