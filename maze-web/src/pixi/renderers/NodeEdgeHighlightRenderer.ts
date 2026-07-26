import { Container, Graphics } from "pixi.js";
import type { EdgeHL } from "./types";
import { EdgeHighlightRenderer } from "./EdgeHighlightRenderer";

export interface NodeEdgeHighlight {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: number;
  width: number;
  alpha: number;
  nodeRadius: number;
  /** Same meaning as `EdgeHL.bidirectional`. */
  bidirectional?: boolean;
}

/** Shared "node-to-node" highlight primitive (GitHub issue #237) — a straight line between two
 *  node positions plus a small filled circle marker on each end, extracted from
 *  `DebugRefHighlightOverlay`'s own `edgeHighlightsFor`/`drawNodeCircles` so both the debug
 *  event-tree hover highlight and the post-edit/preset "Manage split nodes" panel's link-bubble
 *  hover highlight (which has no `NodeDto`/`NodeId` to resolve against for a preset endpoint) draw
 *  identically without duplicating the drawing code. Takes already-resolved `(x,y)` positions, not
 *  node ids — callers are responsible for resolving their own endpoint kind (real `NodeId` for
 *  post-edit, `PresetEndpoint` for presets) to a screen position first. */
export class NodeEdgeHighlightRenderer {
  private readonly edgeContainer: Container;
  private readonly nodeContainer: Container;

  private readonly edgeRenderer: EdgeHighlightRenderer;
  private readonly nodeGraphics: Graphics;

  constructor(container: Container) {
    this.edgeContainer = new Container();
    this.nodeContainer = new Container();
    container.addChild(this.edgeContainer);
    container.addChild(this.nodeContainer);

    this.edgeRenderer = new EdgeHighlightRenderer(this.edgeContainer);
    this.nodeGraphics = new Graphics();
    this.nodeContainer.addChild(this.nodeGraphics);
  }

  render(highlights: NodeEdgeHighlight[]): void {
    this.nodeGraphics.clear();

    const edgeHighlights: EdgeHL[] = highlights.map((h) => ({
      from: [h.from.x, h.from.y],
      to: [h.to.x, h.to.y],
      color: h.color,
      width: h.width,
      alpha: h.alpha,
      bidirectional: h.bidirectional,
    }));
    this.edgeRenderer.render({ highlights: edgeHighlights });

    for (const h of highlights) {
      for (const pos of [h.from, h.to]) {
        this.nodeGraphics.circle(pos.x, pos.y, h.nodeRadius);
        this.nodeGraphics.fill({ color: h.color, alpha: h.alpha });
      }
    }
  }

  clear(): void {
    this.edgeRenderer.render({ highlights: [] });
    this.nodeGraphics.clear();
  }

  destroy(): void {
    this.edgeRenderer.destroy();
    this.nodeGraphics.destroy();
    this.edgeContainer.destroy();
    this.nodeContainer.destroy();
  }
}
