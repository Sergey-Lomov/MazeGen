import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { HoveredDebugRef } from "../store/storeTypes";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { NodeEdgeHighlightRenderer, type NodeEdgeHighlight } from "./renderers/NodeEdgeHighlightRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { buildNodePositions } from "./tessellationGeometry";
import type { Pos } from "./tessellationGeometry";
import { drawOneWayWallHighlight } from "./renderers/wallUtils";

const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 1;

export interface DebugRefHighlightData {
  nodes: NodeDto[];
  /** Every node that ever existed during the run (`debugArena.allNodes`, GitHub issue #271),
   *  including ones removed before the current debug step — lets a `node`-kind ref keep
   *  highlighting by coordinate after its node is gone from `nodes` (GitHub issue #279), instead
   *  of silently drawing nothing. */
  allNodes: NodeDto[];
  /** Drives shape-aware split node-point positioning (GitHub issue #318) — see
   *  `buildNodePositions`'s own doc comment. `[]` (default at call sites with no edges in hand)
   *  falls back to the generic hub position. */
  edges: EdgeDto[];
  ref: HoveredDebugRef | null;
  cfg: TessellationConfig;
}

/** Canvas highlighting for node/edge/cycle/region references hovered in the debug event tree
 *  narration (GitHub issue #130) — owned by `GenerationRenderer`, per the feature-renderer
 *  ownership rule (`maze-web/CLAUDE.md`): must not share `IssueHighlightOverlay`'s instance even
 *  though the drawing logic overlaps, so it holds its own instances of the shared
 *  `NodeEdgeHighlightRenderer`/`RegionHighlightRenderer` classes instead. Uses a distinct accent
 *  color (`canvas.debug.refHighlight`) for plain node/edge/cycle/region refs; an `issue`-kind ref
 *  (GitHub issue #203) instead uses `canvas.debug.issueHighlight`, matching Analytics'
 *  `IssueHighlightOverlay`'s issue-highlight red so an issue reads the same way in both views.
 *
 *  `edge` and `cycle` both render via `edgeRenderer` (one segment vs. several — same primitive,
 *  `NodeEdgeHighlightRenderer` also draws the endpoint circle markers), `region` via
 *  `regionRenderer`, `node` via `RegionHighlightRenderer` treating a single node as a
 *  one-element region. Exactly one of the two sub-renderers has content at a time; the other is
 *  cleared. */
export class DebugRefHighlightOverlay {
  private readonly edgeContainer: Container;
  private readonly regionContainer: Container;
  private readonly wallContainer: Container;

  private readonly edgeRenderer: NodeEdgeHighlightRenderer;
  private readonly regionRenderer: RegionHighlightRenderer;
  private readonly wallGraphics: Graphics;

  constructor(container: Container) {
    this.edgeContainer = new Container();
    this.regionContainer = new Container();
    this.wallContainer = new Container();
    container.addChild(this.edgeContainer);
    container.addChild(this.regionContainer);
    container.addChild(this.wallContainer);

    this.edgeRenderer = new NodeEdgeHighlightRenderer(this.edgeContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
    this.wallGraphics = new Graphics();
    this.wallContainer.addChild(this.wallGraphics);
  }

  render(data: DebugRefHighlightData): void {
    const { nodes, allNodes, edges, ref, cfg } = data;
    this.wallGraphics.clear();

    if (!ref || nodes.length === 0) {
      this.edgeRenderer.render([]);
      this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
      return;
    }

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);
    const posOf = (id: bigint): Pos | undefined => nodePos.get(Number(id));

    switch (ref.kind) {
      case "edge": {
        const highlights = this.edgeHighlightsFor([[ref.from, ref.to]], posOf, [ref.bidirectional]);
        this.edgeRenderer.render(highlights);
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "cycle": {
        const highlights = this.edgeHighlightsFor(ref.edges, posOf);
        this.edgeRenderer.render(highlights);
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "region": {
        this.edgeRenderer.render([]);
        const regionNodeIds = ref.nodes.map((id) => Number(id));
        this.regionRenderer.render({ nodes, regionGroups: [regionNodeIds], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "node": {
        // Highlights the referenced vertex's own tile (fill+perimeter, via `RegionHighlightRenderer`
        // treating the single node as a one-element region), not a circle marker at its center —
        // reads more directly as "this maze cell" than a dot floating on top of the maze.
        this.edgeRenderer.render([]);
        const nodeId = Number(ref.id);
        // `allNodes` (GitHub issue #271) deliberately excludes the field's original base nodes —
        // those are never removed, so they're always already in `nodes` (see
        // `DebugGenerationState`'s doc comment). It's the *concatenation* of the two that's a full
        // union of every node that ever existed, mirroring `DebugEventTree.tsx`'s own
        // `coordIndex` — using `allNodes` alone here previously still lost a removed base-field
        // node's tile, since it's absent from both `nodes` (removed) and `allNodes` (never minted
        // mid-run) individually (GitHub issue #279).
        const lookupNodes = nodes.some((n) => n.id === nodeId) ? nodes : [...nodes, ...allNodes];
        this.regionRenderer.render({ nodes: lookupNodes, regionGroups: [[nodeId]], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        break;
      }
      case "issue": {
        // No structural target (most issue kinds — see `IssuePayload::None`): nothing to
        // highlight, same as the no-`ref` branch above.
        if (!ref.target) {
          this.edgeRenderer.render([]);
          this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.issueHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
          break;
        }
        if (ref.target.kind === "cycle") {
          // A single flagged one-way (GitHub issue #377, `asWall`) draws as the shared wall
          // between its two cells instead of a line — same treatment as Analytics'
          // `IssueHighlightOverlay`. Falls back to a line for any edge whose endpoints aren't
          // tessellation-adjacent (no shared wall to draw).
          const lookupNodes = [...nodes, ...allNodes];
          const nodeById = new Map<number, NodeDto>();
          for (const n of lookupNodes) nodeById.set(n.id, n);
          const lineEdges: [bigint, bigint][] = [];
          if (ref.target.asWall) {
            for (const [from, to] of ref.target.edges) {
              const a = nodeById.get(Number(from));
              const b = nodeById.get(Number(to));
              if (!a || !b) {
                lineEdges.push([from, to]);
                continue;
              }
              const drew = drawOneWayWallHighlight(this.wallGraphics, [a.x, a.y], [b.x, b.y], cfg, canvas.debug.issueHighlight, HIGHLIGHT_WIDTH, HIGHLIGHT_ALPHA);
              if (!drew) lineEdges.push([from, to]);
            }
          } else {
            lineEdges.push(...ref.target.edges);
          }
          const highlights = this.edgeHighlightsFor(lineEdges, posOf, undefined, canvas.debug.issueHighlight);
          this.edgeRenderer.render(highlights);
          this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.issueHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        } else {
          this.edgeRenderer.render([]);
          const regionNodeIds = ref.target.nodes.map((id) => Number(id));
          this.regionRenderer.render({ nodes, regionGroups: [regionNodeIds], color: canvas.debug.issueHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
        }
        break;
      }
    }
  }

  private edgeHighlightsFor(
    edges: [bigint, bigint][],
    posOf: (id: bigint) => Pos | undefined,
    bidirectional?: (boolean | undefined)[],
    color: number = canvas.debug.refHighlight,
  ): NodeEdgeHighlight[] {
    const highlights: NodeEdgeHighlight[] = [];
    edges.forEach(([from, to], i) => {
      const a = posOf(from);
      const b = posOf(to);
      if (!a || !b) return;
      highlights.push({
        from: a, to: b,
        color, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, nodeRadius: NODE_RADIUS,
        bidirectional: bidirectional?.[i],
      });
    });
    return highlights;
  }

  clear(): void {
    this.edgeRenderer.clear();
    this.regionRenderer.clear();
    this.wallGraphics.clear();
  }

  destroy(): void {
    this.edgeRenderer.destroy();
    this.regionRenderer.destroy();
    this.wallGraphics.destroy();
    this.edgeContainer.destroy();
    this.regionContainer.destroy();
    this.wallContainer.destroy();
  }
}
