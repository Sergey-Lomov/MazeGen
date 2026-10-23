import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { HoveredDebugRef } from "../store/storeTypes";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { NodeEdgeHighlightRenderer, type NodeEdgeHighlight } from "./renderers/NodeEdgeHighlightRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { splitWallAndLineEdges } from "./renderers/wallUtils";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { buildNodePositions } from "./tessellationGeometry";
import type { Pos } from "./tessellationGeometry";
import { buildCrossFloorMarkers, drawCrossFloorMarkers, type NodeCellResolver } from "./BaseGraphRenderer";

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
  cfg: FieldConfig;
  /** Cross-floor lookup data used to render an edge/cycle ref with the same stub + floor badge
   *  representation as graph overlays. Omitted callers retain the single-floor behaviour. */
  resolveNodeLevel?: (id: number) => number | undefined;
  resolveNodeCell?: NodeCellResolver;
  activeFloorIndex?: number;
  /** Width of the studio renderer's wall one-way marker (GitHub issue #377/#619) — same value
   *  Analytics' `IssueHighlightOverlay` uses, so an `issue`-kind ref's wall highlight matches its
   *  span exactly. When omitted, a boundary highlight uses the full cell-to-cell distance. */
  oneWayBoundaryWidth?: number;
}

/** Directed endpoint pairs represented by an edge/cycle debug ref. A bidirectional edge bubble
 *  contributes its implicit reverse direction so the shared graph marker draws no one-way arrow. */
export function debugRefEdgePairs(ref: HoveredDebugRef): { from: number; to: number }[] {
  if (ref.kind === "edge") {
    const pair = { from: Number(ref.from), to: Number(ref.to) };
    return ref.bidirectional ? [pair, { from: pair.to, to: pair.from }] : [pair];
  }
  if (ref.kind === "cycle") return ref.edges.map(([from, to]) => ({ from: Number(from), to: Number(to) }));
  if (ref.kind === "issue" && ref.target?.cycle) {
    return ref.target.cycle.edges.map(([from, to]) => ({ from: Number(from), to: Number(to) }));
  }
  return [];
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
  private readonly wallContainer: Container;
  private readonly regionContainer: Container;
  private readonly crossFloorEdgesContainer: Container;
  private readonly crossFloorNodesContainer: Container;

  private readonly edgeRenderer: NodeEdgeHighlightRenderer;
  private readonly regionRenderer: RegionHighlightRenderer;

  constructor(container: Container) {
    this.edgeContainer = new Container();
    this.wallContainer = new Container();
    this.regionContainer = new Container();
    this.crossFloorEdgesContainer = new Container();
    this.crossFloorNodesContainer = new Container();
    container.addChild(this.edgeContainer);
    container.addChild(this.wallContainer);
    container.addChild(this.regionContainer);
    container.addChild(this.crossFloorEdgesContainer);
    container.addChild(this.crossFloorNodesContainer);

    this.edgeRenderer = new NodeEdgeHighlightRenderer(this.edgeContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
  }

  render(data: DebugRefHighlightData): void {
    const { nodes, allNodes, edges, ref, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex, oneWayBoundaryWidth } = data;
    this.crossFloorEdgesContainer.removeChildren().forEach((child) => child.destroy());
    this.crossFloorNodesContainer.removeChildren().forEach((child) => child.destroy());
    this.wallContainer.removeChildren().forEach((child) => child.destroy());

    if (!ref || nodes.length === 0) {
      this.edgeRenderer.render([]);
      this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
      return;
    }

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);
    const posOf = (id: bigint): Pos | undefined => nodePos.get(Number(id));

    const renderCrossFloorRef = (target: HoveredDebugRef, color: number) => {
      if (!resolveNodeLevel || !resolveNodeCell || activeFloorIndex === undefined) return;
      const markers = buildCrossFloorMarkers(
        debugRefEdgePairs(target), nodePos, resolveNodeLevel, resolveNodeCell,
        activeFloorIndex, cfg, NODE_RADIUS,
      );
      const nodeMarkers = new Graphics();
      for (const marker of markers) {
        nodeMarkers.circle(marker.nodePos.x, marker.nodePos.y, NODE_RADIUS);
        nodeMarkers.fill({ color, alpha: HIGHLIGHT_ALPHA });
      }
      this.crossFloorNodesContainer.addChild(nodeMarkers);
      drawCrossFloorMarkers(
        this.crossFloorEdgesContainer, this.crossFloorNodesContainer, markers, NODE_RADIUS,
        color, color, color, HIGHLIGHT_WIDTH, HIGHLIGHT_ALPHA,
      );
    };

    switch (ref.kind) {
      case "edge": {
        const highlights = this.edgeHighlightsFor([[ref.from, ref.to]], posOf, [ref.bidirectional]);
        this.edgeRenderer.render(highlights);
        renderCrossFloorRef(ref, canvas.debug.refHighlight);
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
        break;
      }
      case "cycle": {
        const highlights = this.edgeHighlightsFor(ref.edges, posOf);
        this.edgeRenderer.render(highlights);
        renderCrossFloorRef(ref, canvas.debug.refHighlight);
        this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
        break;
      }
      case "region": {
        this.edgeRenderer.render([]);
        const regionNodeIds = ref.nodes.map((id) => Number(id));
        this.regionRenderer.render({ nodes, regionGroups: [regionNodeIds], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
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
        this.regionRenderer.render({ nodes: lookupNodes, regionGroups: [[nodeId]], color: canvas.debug.refHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
        break;
      }
      case "issue": {
        // `cycle`/`region` are independent, not mutually exclusive (GitHub issue #619) -- an
        // `invalid_cross_element_group` pair mixing a one-way member (wall) with a split/region
        // member needs both drawn at once, mirroring Analytics' own
        // `highlightEdges`/`highlightRegionGroups` split in `IssuesBlock.tsx`.
        if (!ref.target?.cycle) {
          this.edgeRenderer.render([]);
        } else {
          // A single flagged one-way (GitHub issue #377, `asWall`) draws as the shared wall
          // between its two cells (small inset rect + fill), same as Analytics'
          // `IssueHighlightOverlay` — not as a plain line between node centers.
          const { asWall, edges: cycleEdges } = ref.target.cycle;
          const nodeById = new Map(nodes.map((node) => [node.id, node]));
          const cellOf = (id: bigint): [number, number] | undefined => {
            const node = nodeById.get(Number(id));
            return node ? [node.x, node.y] : undefined;
          };
          const wallG = new Graphics();
          const wallEdges = cycleEdges.map(([from, to]) => ({ from, to, asWall }));
          const lineEdges = splitWallAndLineEdges(wallG, wallEdges, cellOf, cfg, canvas.debug.issueHighlight, 0.25, HIGHLIGHT_WIDTH, oneWayBoundaryWidth, getCellHighlightInset())
            .map(({ from, to }) => [from, to] as [bigint, bigint]);
          this.wallContainer.addChild(wallG);
          const highlights = this.edgeHighlightsFor(lineEdges, posOf, undefined, canvas.debug.issueHighlight);
          this.edgeRenderer.render(highlights);
          renderCrossFloorRef(ref, canvas.debug.issueHighlight);
        }
        if (!ref.target?.region) {
          this.regionRenderer.render({ nodes: [], regionGroups: [], color: canvas.debug.issueHighlight, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg, skipPerimeter: true });
        } else {
          // Each group picks its own inset direction from its own `isSplit` flag (GitHub issue
          // #619), same as Analytics' `IssueHighlightOverlay` -- a split-tile group draws with the
          // outward "split" inset, every other group with the normal inward one.
          const insetGroups = ref.target.region.groups.filter((group) => !group.isSplit).map((group) => group.nodes.map((id) => Number(id)));
          const outsetGroups = ref.target.region.groups.filter((group) => group.isSplit).map((group) => group.nodes.map((id) => Number(id)));
          this.regionRenderer.render({
            nodes,
            regionGroups: [],
            color: canvas.debug.issueHighlight,
            width: HIGHLIGHT_WIDTH,
            alpha: HIGHLIGHT_ALPHA,
            cfg,
            skipPerimeter: true,
            groups: [
              { regionGroups: insetGroups, color: canvas.debug.issueHighlight, insetMode: "inset" },
              { regionGroups: outsetGroups, color: canvas.debug.issueHighlight, insetMode: "outset" },
            ],
          });
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
    this.crossFloorEdgesContainer.removeChildren().forEach((child) => child.destroy());
    this.crossFloorNodesContainer.removeChildren().forEach((child) => child.destroy());
  }

  destroy(): void {
    this.edgeRenderer.destroy();
    this.regionRenderer.destroy();
    this.edgeContainer.destroy();
    this.regionContainer.destroy();
    this.crossFloorEdgesContainer.destroy({ children: true });
    this.crossFloorNodesContainer.destroy({ children: true });
  }
}
