import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { RegionHighlightRenderer } from "./RegionHighlightRenderer";
import { NODE_RADIUS } from "../renderConstants";
import { attachFloorBadgeNavigation, computeRegionBadgeRingPos, drawFloorBadge } from "./floorBadge";
import { getCellCenter } from "../tessellationGeometry";
import { canvas } from "../colorTokens";
import type { TeleportEdge } from "./types";

/** Shared by `RegionsRenderer` (color by `ComponentId`) and `RegionClassesRenderer` (color by
 *  `RegionClass`) — both are "one filled cell group per SCC region, plus that region's own
 *  cross-floor badges" (GitHub issue #345), differing only in which color each component gets.
 *  Subclasses supply `data.componentColors` (one entry per `components` index); everything else
 *  (cell fill, cross-floor badge geometry/click-to-switch-floor) lives here once. */
export interface RegionOverlayData {
  /** Floor-scoped nodes (active floor only) — cell fills are only ever drawn for the active floor. */
  nodes: NodeDto[];
  components: number[][];
  /** One fill color per `components` index. */
  componentColors: number[];
  alpha: number;
  cfg: TessellationConfig;
  /** Unscoped edge list (every floor) — needed to find `vertical_passage`/`elevator` edges that
   *  stay within one SCC region while crossing to another floor (GitHub issue #345). Cross-floor
   *  teleports are handled separately via `teleportEdges` (see its own doc comment) — a teleport's
   *  badge sits at a routed midpoint, not at either cell's own center. Omitted callers draw no
   *  cross-floor region badges. */
  allEdges?: EdgeDto[];
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — required alongside `allEdges` to detect a same-region edge that leaves the active floor. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** The active floor's own `levels_ordered()` index — required alongside `allEdges`. */
  activeFloorIndex?: number;
  /** The *same* `buildTeleportEdges` output the maze overlay's own `TeleportRenderer` draws from
   *  (GitHub issue #345) — reused rather than re-derived so a cross-floor teleport's region badge
   *  lands at the exact same snapped-midpoint world position as the teleport's own floor badge, and
   *  the region's connector stub runs along the identical line the teleport's own connector already
   *  occupies. Only entries with `toFloor`/`fromFloor` set (the cross-floor ones) are used; entries
   *  without a resolvable `fromNode`/`toNode` (needed for the same-region check) are skipped. */
  teleportEdges?: TeleportEdge[];
}

const CROSS_FLOOR_KINDS = new Set<EdgeDto["kind"]>(["vertical_passage", "elevator"]);

/** One region badge drawn at a cell's own center, with a ring of `targets.length` badges when more
 *  than one distinct target floor shares that cell (`computeRegionBadgeRingPos`). */
export type RegionRingMarker = { cell: [number, number]; color: number; targets: number[] };

/** One region badge anchored to a cross-floor teleport's own badge position (not a cell center) —
 *  `stubFrom` is the on-floor cell's own center, so a connector line can run from there to `pos`
 *  the same way the teleport's own connector does. */
export type RegionTeleportMarker = { pos: [number, number]; stubFrom: [number, number]; color: number; targetFloorIndex: number };

/** Scans `allEdges` for cross-floor `vertical_passage`/`elevator` edges whose `from` and `to` both
 *  land in the same SCC region (GitHub issue #345) — the region continues onto another floor at
 *  that cell, so it gets a region-colored floor badge there. Only cells on the active floor are
 *  considered (`resolveNodeLevel(onId) === activeFloorIndex`); either endpoint can be the on-floor
 *  one (an edge's `from` or `to` may be the active-floor end depending on direction). One badge per
 *  distinct target floor per cell — an elevator reaching several floors from the same cell draws
 *  one badge per floor, all sharing that cell's ring. */
export function buildRegionRingMarkers(
  components: number[][],
  allEdges: EdgeDto[],
  resolveNodeLevel: (id: number) => number | undefined,
  activeFloorIndex: number,
  unscopedNodeById: Map<number, NodeDto>,
  componentColors: number[],
): RegionRingMarker[] {
  const componentOf = new Map<number, number>();
  components.forEach((comp, i) => { for (const id of comp) componentOf.set(id, i); });

  const targetsByCell = new Map<string, { cell: [number, number]; color: number; targets: Set<number> }>();
  const collect = (onId: number, offId: number) => {
    if (resolveNodeLevel(onId) !== activeFloorIndex) return;
    const compIndex = componentOf.get(onId);
    if (compIndex === undefined || componentOf.get(offId) !== compIndex) return;
    const offLevel = resolveNodeLevel(offId);
    if (offLevel === undefined || offLevel === activeFloorIndex) return;
    const node = unscopedNodeById.get(onId);
    if (!node) return;
    const key = `${node.x},${node.y}`;
    let entry = targetsByCell.get(key);
    if (!entry) { entry = { cell: [node.x, node.y], color: componentColors[compIndex], targets: new Set() }; targetsByCell.set(key, entry); }
    entry.targets.add(offLevel);
  };

  for (const e of allEdges) {
    if (!CROSS_FLOOR_KINDS.has(e.kind)) continue;
    collect(e.from, e.to);
    collect(e.to, e.from);
  }

  return Array.from(targetsByCell.values()).map(({ cell, color, targets }) => ({ cell, color, targets: Array.from(targets) }));
}

/** Scans `teleportEdges` (the maze overlay's own `buildTeleportEdges` output) for cross-floor
 *  entries (`toFloor`/`fromFloor` set) whose real node endpoint lands in the same SCC region as the
 *  edge's own other, on-floor endpoint (GitHub issue #345) — same "region continues here" rule as
 *  `buildRegionRingMarkers`, but for teleports, whose badge sits at a routed snapped-midpoint
 *  instead of a cell center. `stubFrom` is always the on-floor cell's own center (`getCellCenter`),
 *  matching where `TeleportRenderer`'s own connector starts from. */
export function buildRegionTeleportMarkers(
  components: number[][],
  teleportEdges: TeleportEdge[],
  unscopedNodeById: Map<number, NodeDto>,
  cfg: TessellationConfig,
  componentColors: number[],
): RegionTeleportMarker[] {
  const componentOf = new Map<number, number>();
  components.forEach((comp, i) => { for (const id of comp) componentOf.set(id, i); });

  const markers: RegionTeleportMarker[] = [];
  for (const e of teleportEdges) {
    const onNodeId = e.toFloor !== undefined ? e.fromNode : e.fromFloor !== undefined ? e.toNode : undefined;
    const offNodeId = e.toFloor !== undefined ? e.toNode : e.fromFloor !== undefined ? e.fromNode : undefined;
    const targetFloorIndex = e.toFloor ?? e.fromFloor;
    if (onNodeId === undefined || offNodeId === undefined || targetFloorIndex === undefined) continue;

    const compIndex = componentOf.get(onNodeId);
    if (compIndex === undefined || componentOf.get(offNodeId) !== compIndex) continue;

    const onNode = unscopedNodeById.get(onNodeId);
    if (!onNode) continue;
    const stubFrom = getCellCenter(onNode.x, onNode.y, cfg);
    const pos = e.toFloor !== undefined ? e.to : e.from;
    markers.push({ pos, stubFrom: [stubFrom.x, stubFrom.y], color: componentColors[compIndex], targetFloorIndex });
  }
  return markers;
}

export class RegionOverlayRenderer {
  private readonly cells: RegionHighlightRenderer;
  private readonly badgesParent: Container;
  private badgesContainer: Container;

  /** `badgesContainer` sits in a *different* container than `cellsContainer` — the cell fill is
   *  drawn low in the stack (under vertical-passage/elevator/teleport markers), but the region's
   *  own cross-floor floor badges (GitHub issue #345) must sit above those markers so they aren't
   *  occluded by them; the caller wires `badgesContainer` to a layer higher up its own z-order
   *  (`AnalyticsRenderer`'s container tree) while this class still owns everything drawn into it. */
  constructor(cellsContainer: Container, badgesContainer: Container) {
    this.cells = new RegionHighlightRenderer(cellsContainer);
    this.badgesParent = badgesContainer;
    this.badgesContainer = new Container();
    badgesContainer.addChild(this.badgesContainer);
  }

  render(data: RegionOverlayData): void {
    const { nodes, components, componentColors, alpha, cfg, allEdges, resolveNodeLevel, activeFloorIndex } = data;
    this.badgesContainer.destroy({ children: true });
    this.badgesContainer = new Container();
    this.badgesParent.addChild(this.badgesContainer);
    if (nodes.length === 0 || components.length === 0) {
      this.cells.render({ nodes: [], regionGroups: [], groups: [], color: 0, width: 0, alpha: 0, cfg });
      return;
    }

    const nodeById = new Map<number, NodeDto>();
    for (const n of nodes) nodeById.set(n.id, n);

    this.cells.render({
      nodes,
      cfg,
      groups: components.map((component, i) => ({
        regionGroups: [component], color: componentColors[i], fillAlpha: alpha,
      })),
      regionGroups: [],
      color: 0,
      width: 0,
      alpha: 0,
      skipPerimeter: true,
      borderWidth: 2,
    });

    const drawBadge = (pos: { x: number; y: number }, color: number, targetFloorIndex: number) => {
      const g = new Graphics();
      // `g` (the badge's opaque fill) must be added to the container *before* `drawFloorBadge` adds
      // the digit `BitmapText` to the same container — otherwise the fill is drawn on top and hides the
      // number (GitHub issue #461, same z-order fix #449 applied to `drawCrossFloorBadge`).
      this.badgesContainer.addChild(g);
      drawFloorBadge(g, this.badgesContainer, NODE_RADIUS, pos.x, pos.y, color, color, canvas.floor.default, targetFloorIndex + 1);
      attachFloorBadgeNavigation(this.badgesContainer, pos.x, pos.y, NODE_RADIUS, targetFloorIndex);
    };

    if (allEdges && resolveNodeLevel && activeFloorIndex !== undefined) {
      const markers = buildRegionRingMarkers(components, allEdges, resolveNodeLevel, activeFloorIndex, nodeById, componentColors);
      for (const marker of markers) {
        marker.targets.forEach((targetFloorIndex, slot) => {
          const pos = computeRegionBadgeRingPos(marker.cell, cfg, NODE_RADIUS, slot, marker.targets.length);
          drawBadge(pos, marker.color, targetFloorIndex);
        });
      }
    }

    if (data.teleportEdges) {
      const teleportMarkers = buildRegionTeleportMarkers(components, data.teleportEdges, nodeById, cfg, componentColors);
      for (const marker of teleportMarkers) {
        const stub = new Graphics();
        stub.moveTo(marker.stubFrom[0], marker.stubFrom[1]).lineTo(marker.pos[0], marker.pos[1]).stroke({ width: 3, color: marker.color });
        this.badgesContainer.addChild(stub);
        drawBadge({ x: marker.pos[0], y: marker.pos[1] }, marker.color, marker.targetFloorIndex);
      }
    }
  }

  destroy(): void {
    this.cells.destroy();
    this.badgesContainer.destroy({ children: true });
  }
}
