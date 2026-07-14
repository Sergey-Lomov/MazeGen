import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { HoveredDebugRef } from "../store/storeTypes";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS, canvas } from "./colorUtils";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import type { EdgeHL } from "./renderers/types";
import type { Pos } from "./tessellationGeometry";

const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface DebugRefHighlightData {
  nodes: NodeDto[];
  ref: HoveredDebugRef | null;
  cfg: TessellationConfig;
}

/** Canvas highlighting for node/edge/cycle/region references hovered in the debug event tree
 *  narration (GitHub issue #130) — owned by `GenerationRenderer`, per the feature-renderer
 *  ownership rule (`maze-web/CLAUDE.md`): must not share `IssueHighlightOverlay`'s instance even
 *  though the drawing logic overlaps, so it holds its own instances of the shared
 *  `EdgeHighlightRenderer`/`RegionHighlightRenderer` classes instead. Uses a distinct accent
 *  color (`canvas.debug.refHighlight`) from Analytics' issue-highlight red (`0xff4444`).
 *
 *  `edge` and `cycle` both render via `edgeHighlightRenderer` (one segment vs. several — same
 *  primitive), `region` via `regionHighlightRenderer`, `node` via this class's own small
 *  persistent `Graphics` (the only kind with no existing reusable renderer, and the only
 *  consumer of one). Exactly one of the three sub-renderers has content at a time; the other two
 *  are cleared. */
export class DebugRefHighlightOverlay {
  private readonly edgeContainer: Container;
  private readonly regionContainer: Container;
  private readonly nodeContainer: Container;

  private readonly edgeRenderer: EdgeHighlightRenderer;
  private readonly regionRenderer: RegionHighlightRenderer;
  private readonly nodeGraphics: Graphics;

  constructor(container: Container) {
    this.edgeContainer = new Container();
    this.regionContainer = new Container();
    this.nodeContainer = new Container();
    container.addChild(this.edgeContainer);
    container.addChild(this.regionContainer);
    container.addChild(this.nodeContainer);

    this.edgeRenderer = new EdgeHighlightRenderer(this.edgeContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
    this.nodeGraphics = new Graphics();
    this.nodeContainer.addChild(this.nodeGraphics);
  }

  render(data: DebugRefHighlightData): void {
    const { nodes, ref, cfg } = data;
    this.nodeGraphics.clear();

    if (!ref || nodes.length === 0) {
      this.edgeRenderer.render({ highlights: [] });
      this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
      return;
    }

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));
    const posOf = (id: bigint): Pos | undefined => nodePos.get(Number(id));

    switch (ref.kind) {
      case "edge": {
        const highlights = this.edgeHighlightsFor([[ref.from, ref.to]], posOf);
        this.edgeRenderer.render({ highlights });
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        this.drawNodeCircles([ref.from, ref.to], posOf);
        break;
      }
      case "cycle": {
        const highlights = this.edgeHighlightsFor(ref.edges, posOf);
        this.edgeRenderer.render({ highlights });
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "region": {
        this.edgeRenderer.render({ highlights: [] });
        const regionNodeIds = ref.nodes.map((id) => Number(id));
        this.regionRenderer.render({ nodes, regionGroups: [regionNodeIds], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "node": {
        // Highlights the referenced vertex's own tile (fill+perimeter, via `RegionHighlightRenderer`
        // treating the single node as a one-element region), not a circle marker at its center —
        // reads more directly as "this maze cell" than a dot floating on top of the maze.
        this.edgeRenderer.render({ highlights: [] });
        this.regionRenderer.render({ nodes, regionGroups: [[Number(ref.id)]], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
    }
  }

  private edgeHighlightsFor(edges: [bigint, bigint][], posOf: (id: bigint) => Pos | undefined): EdgeHL[] {
    const highlights: EdgeHL[] = [];
    for (const [from, to] of edges) {
      const a = posOf(from);
      const b = posOf(to);
      if (!a || !b) continue;
      highlights.push({ from: [a.x, a.y], to: [b.x, b.y], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA });
    }
    return highlights;
  }

  private drawNodeCircles(ids: bigint[], posOf: (id: bigint) => Pos | undefined): void {
    for (const id of ids) {
      const pos = posOf(id);
      if (!pos) continue;
      this.nodeGraphics.circle(pos.x, pos.y, NODE_RADIUS);
      this.nodeGraphics.fill({ color: canvas.debug.refHighlight, alpha: HIGHLIGHT_ALPHA });
    }
  }

  clear(): void {
    this.edgeRenderer.render({ highlights: [] });
    this.regionRenderer.clear();
    this.nodeGraphics.clear();
  }

  destroy(): void {
    this.edgeRenderer.destroy();
    this.regionRenderer.destroy();
    this.nodeGraphics.destroy();
    this.edgeContainer.destroy();
    this.regionContainer.destroy();
    this.nodeContainer.destroy();
  }
}
