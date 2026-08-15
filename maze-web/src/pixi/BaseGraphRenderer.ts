import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { drawDirectionArrow } from "./renderers/wallUtils";
import { TILE_SIZE } from "./constants";
import { computeCrossFloorBadgePos, drawCrossFloorBadge, drawCrossFloorStub } from "./renderers/floorBadge";
import type { Pos } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

export type { Pos };

export function nodeColor(id: number, selectedNode: number | null, start: number | null, finish: number | null): number {
  if (id === selectedNode) return canvas.node.selected;
  if (id === start) return canvas.node.start;
  if (id === finish) return canvas.node.finish;
  return canvas.node.default;
}

export function nodeRadius(id: number, start: number | null, finish: number | null): number {
  return (id === start || id === finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
}

export interface RenderEdge {
  path: Pos[];
  hasReverse: boolean;
}

export interface RenderNode {
  id: number;
  pos: Pos;
}

export function buildPairedRenderEdges(
  edges: { from: number; to: number }[],
  nodePos: Map<number, Pos>,
): RenderEdge[] {
  type PairFlags = { loToHi: boolean; hiToLo: boolean };
  const pairs = new Map<string, PairFlags>();
  for (const edge of edges) {
    const lo = Math.min(edge.from, edge.to);
    const hi = Math.max(edge.from, edge.to);
    const key = `${lo}:${hi}`;
    let f = pairs.get(key);
    if (!f) { f = { loToHi: false, hiToLo: false }; pairs.set(key, f); }
    if (edge.from === lo) f.loToHi = true; else f.hiToLo = true;
  }

  const renderEdges: RenderEdge[] = [];
  for (const [key, { loToHi, hiToLo }] of pairs) {
    const [loStr, hiStr] = key.split(":");
    const posLo = nodePos.get(Number(loStr));
    const posHi = nodePos.get(Number(hiStr));
    if (!posLo || !posHi) continue;
    const both = loToHi && hiToLo;
    if (loToHi) renderEdges.push({ path: [posLo, posHi], hasReverse: both });
    if (hiToLo) renderEdges.push({ path: [posHi, posLo], hasReverse: both });
  }
  return renderEdges;
}

export function buildPathRenderEdges(
  navEdges: { path: number[] }[],
  nodePos: Map<number, Pos>,
): RenderEdge[] {
  const edgeKeys = new Set<string>();
  for (const e of navEdges) {
    const fromNode = e.path[0];
    const toNode = e.path[e.path.length - 1];
    edgeKeys.add(`${fromNode}->${toNode}`);
  }

  const renderEdges: RenderEdge[] = [];
  for (const e of navEdges) {
    const path = e.path.map(nid => nodePos.get(nid)).filter((p): p is Pos => p !== undefined);
    if (path.length < 2) continue;
    const fromNode = e.path[0];
    const toNode = e.path[e.path.length - 1];
    const hasReverse = edgeKeys.has(`${toNode}->${fromNode}`);
    renderEdges.push({ path, hasReverse });
  }
  return renderEdges;
}

/** Which way the stub line's own direction arrow points, mirroring `RenderEdge.hasReverse`'s
 *  convention — `"toBadge"`/`"fromBadge"` for a one-way pair (arrow follows the real edge's own
 *  `from`→`to` direction), `"none"` when both directions exist between the on-floor node and this
 *  target floor (no arrow, same as an ordinary bidirectional edge). */
export type CrossFloorDirection = "toBadge" | "fromBadge" | "none";

/** One graph-overlay edge/hop whose other endpoint lives on a different floor (GitHub issue #339)
 *  — `nodePos`/`nodeId` are the *on-floor* endpoint's own hub position/id, `badgePos` is where the
 *  badge itself is drawn (see `computeCrossFloorBadgePos`), `targetFloorIndex` is the other floor
 *  (`levels_ordered()` position, same convention as `NodeDto.level`). */
export type CrossFloorMarker = { nodeId: number; nodePos: Pos; badgePos: Pos; targetFloorIndex: number; direction: CrossFloorDirection };

/** A node's own cell coordinate, keyed by id — the *unscoped* source (every floor, not just the
 *  active one) `buildCrossFloorMarkers` needs to resolve an off-floor endpoint's real `(x, y)` for
 *  `computeCrossFloorBadgePos`'s own same-cell/different-cell branch. */
export type NodeCellResolver = (id: number) => [number, number] | undefined;

/** Scans `pairs` (a base-graph edge, or a nav-edge/cycle-edge/route-hop collapsed to its two
 *  endpoint node ids) for a pair whose `nodePos` (floor-scoped, per `buildNodePositions`) has
 *  exactly one endpoint resolved — the other endpoint was silently dropped by floor-scoping, same
 *  as `buildPathRenderEdges`/`buildPairedRenderEdges` do for the edge itself (GitHub issue #339,
 *  mirroring `VerticalConnectionRenderer`/`TeleportRenderer`'s own cross-floor marker pattern, see
 *  `Specs/floors.md`'s "Cross-floor rendering" section). `resolveNodeLevel`/`resolveNodeCell` (both
 *  built from the *unscoped* node list, e.g. `selectNodeLevelResolver`) resolve the missing
 *  endpoint's own floor/cell; a pair whose "missing" endpoint doesn't resolve at all (stale/removed
 *  node) is silently skipped, same as the edge itself would be. One marker per distinct
 *  `(onFloorId, targetLevel)` — an elevator/vertical passage reaching several different floors from
 *  the same on-floor node draws one badge per target floor. Badges sharing an on-floor node get
 *  distinct `slot`s (spread evenly around that node's own circle, `computeCrossFloorBadgePos`'s
 *  `slot`/`slotCount`) so multiple targets from one node don't overlap. */
export function buildCrossFloorMarkers(
  pairs: { from: number; to: number }[],
  nodePos: Map<number, Pos>,
  resolveNodeLevel: (id: number) => number | undefined,
  resolveNodeCell: NodeCellResolver,
  activeFloorIndex: number,
  cfg: TessellationConfig,
  badgeRadius: number,
): CrossFloorMarker[] {
  const seen = new Set<string>();
  const byNode = new Map<number, { offFloorId: number; onPos: Pos; level: number; toBadge: boolean; fromBadge: boolean }[]>();
  const tileRadius = TILE_SIZE;

  const collect = (onFloorId: number, offFloorId: number, onPos: Pos, level: number, toBadge: boolean, fromBadge: boolean) => {
    const key = `${onFloorId}:${level}`;
    let list = byNode.get(onFloorId);
    if (!list) { list = []; byNode.set(onFloorId, list); }
    if (seen.has(key)) {
      const entry = list.find(t => t.level === level)!;
      if (toBadge) entry.toBadge = true;
      if (fromBadge) entry.fromBadge = true;
      return;
    }
    seen.add(key);
    list.push({ offFloorId, onPos, level, toBadge, fromBadge });
  };

  for (const { from, to } of pairs) {
    const fromPos = nodePos.get(from);
    const toPos = nodePos.get(to);
    if (fromPos && !toPos) {
      const level = resolveNodeLevel(to);
      if (level !== undefined && level !== activeFloorIndex) collect(from, to, fromPos, level, true, false);
    } else if (!fromPos && toPos) {
      const level = resolveNodeLevel(from);
      if (level !== undefined && level !== activeFloorIndex) collect(to, from, toPos, level, false, true);
    }
  }

  const result: CrossFloorMarker[] = [];
  for (const [onFloorId, targets] of byNode) {
    const onCell = resolveNodeCell(onFloorId);
    if (!onCell) continue;
    targets.forEach((t, slot) => {
      const offCell = resolveNodeCell(t.offFloorId);
      if (!offCell) return;
      const badgePos = computeCrossFloorBadgePos(onCell, offCell, cfg, badgeRadius, tileRadius, slot, targets.length);
      const direction: CrossFloorDirection = t.toBadge && t.fromBadge ? "none" : t.toBadge ? "toBadge" : "fromBadge";
      result.push({ nodeId: onFloorId, nodePos: t.onPos, badgePos, targetFloorIndex: t.level, direction });
    });
  }
  return result;
}

const CROSS_FLOOR_BADGE_COLOR = canvas.node.start;
const CROSS_FLOOR_BADGE_BORDER = canvas.node.start;

/** Draws every cross-floor badge (GitHub issue #339) — a plain circle, floor-colored knockout digit
 *  for the target floor's 1-based display number (`drawFloorBadge`, shared with `TeleportRenderer`)
 *  — no connection-type icon (a nav-edge/cycle-edge/route-hop is a collapsed abstraction with no
 *  single underlying `EdgeDto.kind` to draw an icon for, unlike a literal vertical-passage/teleport
 *  edge). Adds an invisible hit-circle wired to `navigateToFloor` on top of each badge so clicking
 *  it switches `FloorSwitcher` to the target floor. Draws each stub line (with a direction arrow
 *  matching the real edge's own `from`→`to` direction) into `edgesContainer` — the same layer
 *  ordinary edges use, so it tucks behind node circles like a real edge — and each badge itself into
 *  `nodesContainer`. `lineColor` mirrors whatever edge color the caller's own overlay uses (e.g.
 *  `PureCyclesOverlay`'s green), so a badge's stub reads as the same kind of connection as the rest
 *  of that overlay's edges. */
export function drawCrossFloorMarkers(
  edgesContainer: Container,
  nodesContainer: Container,
  markers: CrossFloorMarker[],
  r: number,
  lineColor: number = canvas.edge.default,
): void {
  const stubs = new Graphics();
  for (const marker of markers) {
    drawCrossFloorStub(stubs, marker.nodePos, marker.badgePos, marker.direction, lineColor, NODE_RADIUS, r);
    drawCrossFloorBadge(
      nodesContainer, marker.badgePos, marker.targetFloorIndex, r,
      CROSS_FLOOR_BADGE_COLOR, CROSS_FLOOR_BADGE_BORDER, canvas.floor.default,
    );
  }
  edgesContainer.addChild(stubs);
}

/** Draws one edge segment (a multi-point path, margin-trimmed at both ends to clear node
 *  circles, with a direction arrow at the midpoint unless `hasReverse`) — the same low-level
 *  primitive `BaseGraphRenderer.drawEdges` uses internally, exported so a non-graph consumer
 *  (e.g. `SequenceHighlightRenderer` for `DebugValueKind.Sequence` debug values, GitHub issue
 *  #131's follow-up) can reuse the exact same visual without subclassing `BaseGraphRenderer` —
 *  per `maze-web/CLAUDE.md`'s feature-renderer ownership rule, a debug-value overlay owned by
 *  `GenerationRenderer` must not share a renderer instance with another feature. */
export function drawEdge(g: Graphics, edge: RenderEdge, color: number): void {
  const pts = edge.path;
  if (pts.length < 2) return;

  const first = pts[0];
  const second = pts[1];
  const secondLast = pts[pts.length - 2];
  const last = pts[pts.length - 1];

  const dxStart = second.x - first.x;
  const dyStart = second.y - first.y;
  const lenStart = Math.sqrt(dxStart * dxStart + dyStart * dyStart);

  const dxEnd = last.x - secondLast.x;
  const dyEnd = last.y - secondLast.y;
  const lenEnd = Math.sqrt(dxEnd * dxEnd + dyEnd * dyEnd);

  if (lenStart < 1 || lenEnd < 1) return;

  const margin = NODE_RADIUS + 1;
  const startPt: Pos = {
    x: first.x + (dxStart / lenStart) * margin,
    y: first.y + (dyStart / lenStart) * margin,
  };
  const endPt: Pos = {
    x: last.x - (dxEnd / lenEnd) * margin,
    y: last.y - (dyEnd / lenEnd) * margin,
  };

  g.moveTo(startPt.x, startPt.y);
  for (let i = 1; i < pts.length - 1; i++) {
    g.lineTo(pts[i].x, pts[i].y);
  }
  g.lineTo(endPt.x, endPt.y);
  g.stroke({ width: 2, color });

  if (!edge.hasReverse) {
    const midX = (startPt.x + endPt.x) / 2;
    const midY = (startPt.y + endPt.y) / 2;
    const edgeLen = Math.sqrt((endPt.x - startPt.x) ** 2 + (endPt.y - startPt.y) ** 2);
    if (edgeLen < 1) return;
    const ux = (endPt.x - startPt.x) / edgeLen;
    const uy = (endPt.y - startPt.y) / edgeLen;
    drawDirectionArrow(g, midX, midY, ux, uy, TILE_SIZE * 0.18, color);
  }
}

export abstract class BaseGraphRenderer {
  protected overlayContainer: Container;
  protected edgesContainer: Container;
  protected nodesContainer: Container;

  constructor(overlayContainer: Container) {
    this.overlayContainer = overlayContainer;
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);
  }

  protected resetContainers(): void {
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);
  }

  protected drawEdges(edges: RenderEdge[], color: number): void {
    const g = new Graphics();
    for (const edge of edges) drawEdge(g, edge, color);
    this.edgesContainer.addChild(g);
  }

  /** Draws every cross-floor badge (GitHub issue #339, see `buildCrossFloorMarkers`) — the stub
   *  line into `edgesContainer` (so it tucks behind node circles like a real edge) and the badge
   *  itself into `nodesContainer` (since it stands in for an off-floor node at the on-floor
   *  endpoint). `lineColor` defaults to the ordinary edge color; pass the caller's own edge color
   *  (e.g. `PureCyclesOverlay`'s green) to match that overlay's own edge style. */
  protected renderCrossFloorMarkers(markers: CrossFloorMarker[], radius: number, lineColor?: number): void {
    drawCrossFloorMarkers(this.edgesContainer, this.nodesContainer, markers, radius, lineColor);
  }

  protected redrawNode(g: Graphics, r: number, color: number): void {
    g.clear();
    g.circle(0, 0, r);
    g.fill(color);
  }

  protected drawNodes(
    renderNodes: RenderNode[],
    selectedNode: number | null,
    start: number | null,
    finish: number | null,
    interactive: boolean,
  ): Map<number, Graphics> {
    const views = new Map<number, Graphics>();
    for (const { id, pos } of renderNodes) {
      const g = new Graphics();
      const color = nodeColor(id, selectedNode, start, finish);
      this.redrawNode(g, nodeRadius(id, start, finish), color);
      g.x = pos.x;
      g.y = pos.y;

      if (interactive) {
        g.interactive = true;
        g.cursor = "pointer";
        g.on("pointerover", () => {
          const s = useMazeStore.getState();
          if (s.selectedNode !== id) {
            const base = nodeColor(id, null, s.start, s.finish);
            this.redrawNode(g, nodeRadius(id, s.start, s.finish), base !== canvas.node.default ? base : canvas.node.hover);
          }
        });
        g.on("pointerout", () => {
          const s = useMazeStore.getState();
          this.redrawNode(g, nodeRadius(id, s.start, s.finish), nodeColor(id, s.selectedNode, s.start, s.finish));
        });
        g.on("pointerdown", (e) => {
          e.stopPropagation();
          useMazeStore.getState().selectNode(id);
        });
      }

      this.nodesContainer.addChild(g);
      views.set(id, g);
    }
    return views;
  }

  destroy(): void {
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
  }
}
