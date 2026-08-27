import { Container, Graphics, Text } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellCenter, getCellVertices, nearestCellCoord, type Pos } from "../tessellationGeometry";
import { navigateToFloor } from "./floorNavigation";
import { drawDirectionArrow } from "./wallUtils";
import { TILE_SIZE } from "../constants";

export const FLOOR_BADGE_STROKE_WIDTH = 3;

/// Angle (radians, world space) from `center` toward one of `cell`'s own vertices, cycling through
/// them by `slot`/`slotCount` — falls back to a fixed 45° when the tessellation has no vertex
/// geometry (`getCellVertices` returns `null`, e.g. an unrecognized `cfg.type`).
function vertexAngle(cell: [number, number], center: Pos, cfg: TessellationConfig, slot: number, slotCount: number): number {
  const vertices = getCellVertices(cell[0], cell[1], cfg);
  if (!vertices || vertices.length === 0) return Math.PI / 4;
  const index = slotCount <= 1 ? 0 : Math.round((slot / slotCount) * vertices.length) % vertices.length;
  const v = vertices[index];
  return Math.atan2(v.y - center.y, v.x - center.x);
}

/** Draws one cross-floor badge (GitHub issue #337/#339) at `(cx, cy)` — a plain circle (always
 *  round, never the caller's own point shape, so it never reads as an ordinary marker), filled in
 *  `color` with a `borderColor` ring, and the target floor's 1-based display number cut out of the
 *  fill in `floorColor` (a "knockout" look, readable against the filled circle the same way a
 *  stencil digit reads against a solid background) — not `borderColor` text on a `floorColor`
 *  fill, which would make the badge blend into the surrounding floor instead of reading as a solid
 *  marker. Sized well past the ordinary marker-label convention since a single digit needs to be
 *  legible at a glance among other overlapping canvas markers. Plain `Text` for now (blurs past its
 *  own rasterized size on zoom-in) — true distance-field text is tracked separately (GitHub issue
 *  #352); `resolution` is set well above 1 so this stays acceptably sharp for typical zoom levels in
 *  the meantime. Shared by `TeleportRenderer` (teleport cross-floor badges) and the graph overlays'
 *  own cross-floor markers (`NavGraphRenderer`/`MazeGraphRenderer`/`PureCyclesOverlay`/
 *  `RouteOverlay`, GitHub issue #339) — per `maze-web/CLAUDE.md`'s feature-renderer ownership rule,
 *  shared drawing logic between feature-renderers lives in a shared utility, never a shared
 *  renderer instance.
 *
 *  `labelsContainer` hosts the digit `Text` alone — PixiJS v8 deprecates `addChild` on a `Graphics`
 *  instance (`g`) and disallows it in a future major version (GitHub issue #432), so the label can
 *  no longer be a child of `g` itself; callers pass any actual `Container` sitting above `g` in
 *  z-order (a sibling layer, or the same container `g` was itself added to). */
export function drawFloorBadge(g: Graphics, labelsContainer: Container, r: number, cx: number, cy: number, color: number, borderColor: number, floorColor: number, floorNumber: number): void {
  g.circle(cx, cy, r).fill(color).stroke({ width: FLOOR_BADGE_STROKE_WIDTH, color: borderColor, alignment: 0 });
  const label = new Text({
    text: `${floorNumber}`,
    // `trim: true` makes pixi measure the digit's own tight ink bounding box (`Text.updateBounds`
    // switches from `CanvasTextMetrics.measureText`'s nominal line-height box to
    // `getCanvasBoundingBox`'s actual rendered-pixel scan — see pixi's own `CanvasTextGenerator`)
    // instead of the font's nominal line-height box — without it, `anchor.set(0.5)` centers on the
    // line-height box, which sits a typical font's digits (no descenders to balance the ascent
    // above the baseline) visibly above true center. No headless canvas is available in this repo
    // to pixel-verify the resulting centering directly (and per `maze-web/CLAUDE.md`, a browser
    // isn't used for visual checks either) — this relies on reading pixi's own measurement code,
    // not a rendered comparison.
    style: { fontSize: Math.max(r * 1.6, 12), fill: floorColor, fontWeight: "bold", trim: true },
    resolution: 4,
  });
  label.anchor.set(0.5);
  label.x = cx;
  label.y = cy;
  labelsContainer.addChild(label);
}

/** Resolves a cross-floor badge's own world position (GitHub issue #339) — the badge stands in for
 *  an off-floor endpoint whose real position isn't drawable on this floor's image. Graph-overlay
 *  use only (`BaseGraphRenderer.buildCrossFloorMarkers`) — `buildTeleportEdges` in
 *  `mazeSelectors.ts` computes the real teleport midpoint independently and does not call this.
 *
 *  Both cases place the badge on the same per-`slot` angle — the direction toward one of the
 *  on-floor cell's own vertices (`getCellVertices`, cycling through them by `slot` so several
 *  badges sharing an on-floor node — e.g. an elevator reaching several floors — head toward
 *  distinct corners instead of overlapping), rather than a fixed 45°, since a tessellation's own
 *  corners don't sit at 45° in general (a flat-top hex's corners, for one):
 *  - **Same cell** (e.g. a vertical passage/elevator, whose off-floor node sits at the identical
 *    (x, y)) — there's no second cell to head toward, so the badge sits offset from the on-floor
 *    node's own center along `angle`, distance `tileRadius - badgeRadius` (the badge's own far
 *    edge just clears the cell's own boundary).
 *  - **Different cell** (`onFloorCell` and `offFloorCell` differ) — starts from the midpoint
 *    between the two cells' own centers, snapped onto the nearest actual grid coordinate
 *    (`nearestCellCoord`) so it never lands mid-wall, then offset along `angle + 180°` (the
 *    opposite side from the same-cell case) at half that distance — deliberately *not* along the
 *    node→midpoint line, so the badge doesn't sit on top of the edge/stub line itself and read as
 *    part of it, and doesn't collide with badges from unrelated edges passing through the same
 *    snapped cell. */
export function computeCrossFloorBadgePos(
  onFloorCell: [number, number],
  offFloorCell: [number, number],
  cfg: TessellationConfig,
  badgeRadius: number,
  tileRadius: number,
  slot = 0,
  slotCount = 1,
): Pos {
  const onCenter = getCellCenter(onFloorCell[0], onFloorCell[1], cfg);
  const dist = Math.max(tileRadius - badgeRadius, 0);
  const angle = vertexAngle(onFloorCell, onCenter, cfg, slot, slotCount);

  if (onFloorCell[0] !== offFloorCell[0] || onFloorCell[1] !== offFloorCell[1]) {
    const offCenter = getCellCenter(offFloorCell[0], offFloorCell[1], cfg);
    const midX = (onCenter.x + offCenter.x) / 2;
    const midY = (onCenter.y + offCenter.y) / 2;
    const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
    const snapped = getCellCenter(snapX, snapY, cfg);

    const oppositeAngle = angle + Math.PI;
    const halfDist = dist / 2;
    return { x: snapped.x + Math.cos(oppositeAngle) * halfDist, y: snapped.y + Math.sin(oppositeAngle) * halfDist };
  }

  return { x: onCenter.x + Math.cos(angle) * dist, y: onCenter.y + Math.sin(angle) * dist };
}

/** Resolves the world position for one badge in a cell-centered ring of region cross-floor badges
 *  (GitHub issue #345) — unlike `computeCrossFloorBadgePos` (which anchors to a tessellation
 *  vertex and connects back to a node via a stub line), a region badge has no single "on-floor
 *  node" to stand in for: any cell in the region can carry one, and there's no connector line to
 *  another drawn point (the whole point is that the region's own fill color already carries the
 *  continuity across floors — see `Specs/regions.md`). A single badge sits at the cell's own
 *  center; two or more are spread evenly around a ring of radius `badgeRadius * 1.25` centered on
 *  the cell, starting straight up (`-90°`) and going clockwise, so badges never overlap each other
 *  or (mostly) the cell's own perimeter stroke. See `Specs/floors.md`'s "Cross-floor region badges"
 *  section for the full feature description. */
export function computeRegionBadgeRingPos(cell: [number, number], cfg: TessellationConfig, badgeRadius: number, slot: number, slotCount: number): Pos {
  const center = getCellCenter(cell[0], cell[1], cfg);
  if (slotCount <= 1) return center;
  // Ring radius accounts for the badge's own stroke (drawn outward, `alignment: 0`) — otherwise
  // two adjacent badges' outer rings (radius `badgeRadius + strokeWidth`) overlap despite sitting
  // 1.25x the bare fill radius apart.
  const ringRadius = (badgeRadius + FLOOR_BADGE_STROKE_WIDTH) * 1.25;
  const angle = -Math.PI / 2 + (slot / slotCount) * 2 * Math.PI;
  return { x: center.x + Math.cos(angle) * ringRadius, y: center.y + Math.sin(angle) * ringRadius };
}

/** Draws a cross-floor badge's own connecting stub — a line from the on-floor node's own position
 *  to the badge's, mirroring a teleport connector's own center-to-center line (GitHub issue #339)
 *  — into `edgesContainer`, i.e. the *same layer ordinary edges draw into*, so the stub tucks
 *  behind node circles the same way a real edge does instead of drawing on top of them. Style
 *  (width/color) mirrors whatever edge style the caller's own overlay uses (e.g.
 *  `PureCyclesOverlay`'s green), matching `drawEdge`'s own `{ width, color }` stroke convention.
 *  `direction` adds a `drawDirectionArrow` matching the real edge's own `from`→`to` direction —
 *  `"none"` when both directions exist between the pair (no arrow, same as an ordinary
 *  bidirectional edge). Trimmed by `nodeRadius`/`badgeRadius` at each end (mirroring `drawEdge`'s
 *  own margin trim) so the line doesn't run into either circle's fill. */
export function drawCrossFloorStub(
  g: Graphics,
  nodePos: Pos,
  badgePos: Pos,
  direction: "toBadge" | "fromBadge" | "none",
  lineColor: number,
  nodeRadius: number,
  badgeRadius: number,
  lineWidth = 2,
  lineAlpha = 1,
): void {
  const dx = badgePos.x - nodePos.x;
  const dy = badgePos.y - nodePos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;
  const nodeMargin = nodeRadius + 1;
  const badgeMargin = badgeRadius + 1;
  const startPt: Pos = { x: nodePos.x + ux * nodeMargin, y: nodePos.y + uy * nodeMargin };
  const endPt: Pos = { x: badgePos.x - ux * badgeMargin, y: badgePos.y - uy * badgeMargin };

  g.moveTo(startPt.x, startPt.y).lineTo(endPt.x, endPt.y).stroke({
    width: lineWidth, color: lineColor, alpha: lineAlpha, cap: "round",
  });

  if (direction !== "none") {
    const segLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    if (segLen >= 1) {
      const sign = direction === "toBadge" ? 1 : -1;
      const midX = (startPt.x + endPt.x) / 2;
      const midY = (startPt.y + endPt.y) / 2;
      drawDirectionArrow(g, midX, midY, ux * sign, uy * sign, TILE_SIZE * 0.18, lineColor, lineAlpha);
    }
  }
}

/** Adds an invisible hit-circle covering a whole badge drawn by `drawFloorBadge` at `(cx, cy)`,
 *  wired to `navigateToFloor` so clicking anywhere on the badge (not just its digit text) switches
 *  `FloorSwitcher` to `targetFloorIndex` (GitHub issue #368). `radius` is `drawFloorBadge`'s own
 *  fill radius; the hit area extends `FLOOR_BADGE_STROKE_WIDTH` further out to also cover the
 *  border ring, which `drawFloorBadge` strokes outward (`alignment: 0`) past that fill radius.
 *  Shared by every floor-badge call site (`TeleportRenderer`, `RegionOverlayRenderer`,
 *  `drawCrossFloorBadge` below) so the hit-area radius can never drift from the badge's own drawn
 *  extent. */
export function attachFloorBadgeNavigation(container: Container, cx: number, cy: number, radius: number, targetFloorIndex: number): void {
  const hit = new Graphics().circle(cx, cy, radius + FLOOR_BADGE_STROKE_WIDTH).fill({ color: 0, alpha: 0 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  hit.on("pointertap", () => navigateToFloor(targetFloorIndex));
  container.addChild(hit);
}

/** Draws one cross-floor badge (GitHub issue #339) into `nodesContainer`, plus an invisible
 *  hit-circle wired to `navigateToFloor` (`attachFloorBadgeNavigation`) so clicking the badge
 *  switches `FloorSwitcher` to the target floor. Pair with `drawCrossFloorStub` for the connecting
 *  line. */
export function drawCrossFloorBadge(
  nodesContainer: Container,
  badgePos: Pos,
  targetFloorIndex: number,
  radius: number,
  color: number,
  borderColor: number,
  floorColor: number,
): void {
  const g = new Graphics();
  // The body must sit below the label `Text` that `drawFloorBadge` adds to the same container.
  // Adding `g` afterwards covered the digit with the badge's opaque fill (GitHub issue #449).
  nodesContainer.addChild(g);
  drawFloorBadge(g, nodesContainer, radius, badgePos.x, badgePos.y, color, borderColor, floorColor, targetFloorIndex + 1);
  attachFloorBadgeNavigation(nodesContainer, badgePos.x, badgePos.y, radius, targetFloorIndex);
}
