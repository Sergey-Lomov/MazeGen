import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import type { Pos } from "./tessellationGeometry";
import { buildNodePositions } from "./tessellationGeometry";
import { drawDirectionArrow, splitWallAndLineEdges } from "./renderers/wallUtils";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { TILE_SIZE } from "./constants";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { touchedNodeIds } from "./renderers/edgeUtils";
import { canvas } from "./colorTokens";
import { BaseGraphRenderer, buildCrossFloorMarkers } from "./BaseGraphRenderer";
import type { NodeCellResolver } from "./BaseGraphRenderer";
import type { IssueHighlightEdge } from "../store/postEditFullTypes";

const HIGHLIGHT_COLOR = canvas.debug.issueHighlight;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 1;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph edges to highlight — typically issue loops or boundary-style entities. Each edge's
   * own `asWall` (GitHub issue #377) picks line-vs-wall drawing — see `IssueHighlightEdge`.
   * Teleport issue endpoints are supplied through `regionGroups`, not as rendered edge lines. */
  edges: IssueHighlightEdge[] | null;
  /** The maze's full edge list (`state.edges`, not the highlighted subset above) — drives
   *  shape-aware split node-point positioning (GitHub issue #318), see `buildNodePositions`'s own
   *  doc comment. `[]` falls back to the generic hub position. */
  allEdges: EdgeDto[];
  /** SCC regions to highlight, each as its own list of maze node ids plus its own split-vs-region
   * inset style (GitHub issue #619 — set by the caller from the payload kind, never guessed from
   * the group's own geometry). Kept as separate groups (not one flat list) so each region gets
   * its own perimeter/fill, instead of two adjacent-in-id-space-but-disjoint regions merging into
   * one outline. Independent of `edges`, not mutually exclusive: a mixed `invalid_cross_element_group`
   * pair (a one-way member alongside a split/region member, GitHub issue #619) sets both at once,
   * and both are rendered independently. */
  regionGroups: { nodes: number[]; isSplit: boolean }[] | null;
  cfg: TessellationConfig;
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a highlighted edge whose other endpoint crosses to another floor
   *  (GitHub issue #367, closing the #339 gap for this overlay). Omitted callers draw no
   *  cross-floor badges. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #367). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel`. */
  activeFloorIndex?: number;
  /** Every cross-floor edge's own `"from->to"` key (`vertical_passage` / `elevator` / `teleport` —
   *  every kind that can span floors), built from the *unscoped* `state.edges`. A cross-floor stub
   *  gets its direction arrow only when the underlying connection is genuinely one-way — exactly
   *  one of `"from->to"`/`"to->from"` present. Must be unscoped: a two-way connection's reverse
   *  edge lives on the other floor and is always missing from any floor-scoped list (GitHub issue
   *  #337/#347). */
  crossFloorEdgeKeys?: ReadonlySet<string>;
  /** Width of the studio renderer's wall one-way marker. When omitted, a boundary highlight uses
   *  the full cell-to-cell distance for generic wall entities. */
  oneWayBoundaryWidth?: number;
}

export class IssueHighlightOverlay extends BaseGraphRenderer {
  private readonly regionContainer: Container;
  private readonly regionRenderer: RegionHighlightRenderer;

  constructor(container: Container) {
    super(container);
    this.regionContainer = new Container();
    this.overlayContainer.addChild(this.regionContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
  }

  render(data: IssueHighlightData): void {
    this.resetContainers();
    const { nodes, edges, allEdges, regionGroups, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex, crossFloorEdgeKeys, oneWayBoundaryWidth } = data;
    const hasEdges = edges != null && edges.length > 0;
    const hasRegions = regionGroups != null && regionGroups.length > 0 && nodes.length > 0;

    if (hasRegions) {
      // Each group picks its own inset direction from its own `isSplit` flag (GitHub issue #619) --
      // deciding this globally for the whole `regionGroups` list meant one split group anywhere in
      // the list flipped every *other* group -- e.g. an unrelated region member of the same
      // `invalid_cross_element_group` pair -- to the outward style too. Guessing it from the
      // group's own geometry (duplicate node/cell) doesn't work either: a multi-cell split tile has
      // no duplicate to detect.
      const insetGroups = regionGroups.filter((group) => !group.isSplit).map((group) => group.nodes);
      const outsetGroups = regionGroups.filter((group) => group.isSplit).map((group) => group.nodes);
      this.regionRenderer.render({
        nodes,
        regionGroups: [],
        color: HIGHLIGHT_COLOR,
        width: HIGHLIGHT_WIDTH,
        alpha: HIGHLIGHT_ALPHA,
        cfg,
        skipPerimeter: true,
        groups: [
          { regionGroups: insetGroups, color: HIGHLIGHT_COLOR, insetMode: "inset" },
          { regionGroups: outsetGroups, color: HIGHLIGHT_COLOR, insetMode: "outset" },
        ],
      });
    } else {
      this.regionRenderer.clear();
    }

    if (!hasEdges || nodes.length === 0) return;

    // Wall edges (GitHub issue #377 — e.g. a single flagged invalid_one_way) draw as the shared
    // wall between their two cells instead of a line — no node/cross-floor markers, since the
    // wall segment itself is the marker. Falls back to a line if the two endpoints turn out not
    // to be tessellation-adjacent (no shared wall to draw, e.g. a cross-floor edge whose other
    // endpoint isn't resolvable to a cell here).
    const nodeById = new Map<number, NodeDto>();
    for (const node of nodes) nodeById.set(node.id, node);
    const cellOf = (id: number): [number, number] | undefined => {
      const node = nodeById.get(id);
      return node ? [node.x, node.y] : undefined;
    };

    const wallG = new Graphics();
    const lineEdges = splitWallAndLineEdges(wallG, edges, cellOf, cfg, HIGHLIGHT_COLOR, 0.25, HIGHLIGHT_WIDTH, oneWayBoundaryWidth, getCellHighlightInset());
    this.edgesContainer.addChild(wallG);

    if (lineEdges.length === 0) return;

    const directedPairs = allEdges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);
    const linePairs: [number, number][] = lineEdges.map((e) => [e.from, e.to]);

    // A same-floor edge drawn as a line gets a mid-segment direction arrow when it's genuinely
    // one-way — the reverse `to`→`from` absent from the base graph. Every edge kind counts here
    // (a one-way teleport must show its arrow too), unlike `directedPairs` above which drops
    // teleports only because they don't drive `buildNodePositions`. Matches how the Cycles overlay
    // marks a one-way hop; a cross-floor edge has no on-floor line to mark and is handled by its
    // badge stub instead.
    const baseEdgeKeys = new Set(allEdges.map((e) => `${e.from},${e.to}`));
    const g = new Graphics();
    for (const [from, to] of linePairs) {
      const a = nodePos.get(from);
      const b = nodePos.get(to);
      if (!a || !b) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke({ width: HIGHLIGHT_WIDTH, color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
      if (baseEdgeKeys.has(`${from},${to}`) && !baseEdgeKeys.has(`${to},${from}`)) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len >= 1) {
          drawDirectionArrow(g, (a.x + b.x) / 2, (a.y + b.y) / 2, (b.x - a.x) / len, (b.y - a.y) / len, TILE_SIZE * 0.18, HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA);
        }
      }
    }
    this.edgesContainer.addChild(g);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      // A cross-floor stub gets its direction arrow only when the underlying connection is
      // genuinely one-way — exactly one of `"from->to"`/`"to->from"` present in
      // `crossFloorEdgeKeys`, with the stub then pointing whichever way that lone edge runs (which
      // may be opposite the loop's own traversal). A two-way connection (both keys present) or a
      // hop with no cross-floor edge at all (neither key) feeds both directions so
      // `buildCrossFloorMarkers` resolves the stub to `direction: "none"` (no arrow).
      const oneWayDir = (from: number, to: number): [number, number] | null => {
        if (crossFloorEdgeKeys == null) return null;
        const fwd = crossFloorEdgeKeys.has(`${from}->${to}`);
        const bwd = crossFloorEdgeKeys.has(`${to}->${from}`);
        if (fwd === bwd) return null;
        return fwd ? [from, to] : [to, from];
      };
      const markerPairs = linePairs.flatMap(([from, to]) => {
        const dir = oneWayDir(from, to);
        return dir ? [{ from: dir[0], to: dir[1] }] : [{ from, to }, { from: to, to: from }];
      });
      const markers = buildCrossFloorMarkers(markerPairs, nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS, HIGHLIGHT_COLOR, HIGHLIGHT_COLOR, HIGHLIGHT_COLOR, true, HIGHLIGHT_WIDTH);
    }

    const nodesG = new Graphics();
    for (const nodeId of touchedNodeIds(linePairs)) {
      const pos = nodePos.get(nodeId);
      if (!pos) continue;
      nodesG.circle(pos.x, pos.y, NODE_RADIUS);
      nodesG.fill({ color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }
    this.nodesContainer.addChild(nodesG);
  }

  clear(): void {
    this.resetContainers();
    this.regionRenderer.clear();
  }

  override destroy(): void {
    super.destroy();
    this.regionRenderer.destroy();
    this.regionContainer.destroy();
  }
}
