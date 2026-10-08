import { BitmapText, Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellCenter, getCellVertices, nearestCellCoord, type Pos } from "../tessellationGeometry";
import { navigateToFloor } from "./floorNavigation";
import { drawDirectionArrow } from "./wallUtils";
import { drawMarkerWithBorder } from "./markerShapes";
import type { MarkerShape } from "./types";
import { TILE_SIZE } from "../constants";
import { makeCenteredLabel, msdfFontFamily } from "./msdfFont";
import type { LabelFontWeight } from "./indexLabel";

export const FLOOR_BADGE_STROKE_WIDTH = 3;
export const CROWDED_BADGE_RADIUS_FACTOR = 0.75;

/** One shared font size for every cross-floor teleport badge in the maze (GitHub issue #485
 *  follow-up). `side = 2 * (r + borderWidth) - 2 * textPadding` is the badge's full outer diameter
 *  (border ring included) less `textPadding` off each edge. The returned `fontSize` is the smaller
 *  of two caps against `side`:
 *   - **width cap** — `probeSize * side / widestGlyphRun`, the size at which the widest label's
 *     rendered advance width equals `side`;
 *   - **size cap** — `fontSize <= side` directly. This is *not* an exact glyph-height fit (a
 *     BitmapText's ink height is roughly `0.7 * fontSize`, so the label sits a little inside the
 *     `side` box vertically); it exists so `textPadding` shrinks the font monotonically from its
 *     very first slider step even for a narrow one-glyph label, which the width cap alone would
 *     leave pinned at the baseline until the padded box got tight.
 *  The result is used verbatim for every badge regardless of its own label, so "I" and "VIII" draw
 *  at one size. No lower bound; at `textPadding: 0` the widest label spans the whole badge, border
 *  included. Mirrors `fitElevatorBadgeFontSize`'s own probe-the-widest approach. `0` when there are
 *  no labels. */
export function fitTeleportBadgeFontSize(labels: string[], r: number, textPadding: number, borderWidth = 0): number {
  const side = Math.max(2 * (r + borderWidth) - 2 * textPadding, 0);
  if (side === 0) return 0;
  const probeSize = (r + borderWidth) * 2;
  let widest = 0;
  for (const label of labels) {
    const probe = new BitmapText({ text: label, style: { fontFamily: msdfFontFamily("bold"), fontSize: probeSize } });
    widest = Math.max(widest, probe.width);
    probe.destroy();
  }
  if (widest === 0) return 0;
  // Width bound: scale the probe size down until the widest glyph run fits `side`.
  const byWidth = probeSize * (side / widest);
  // Height bound: the glyph box height tracks the font size, so cap it at `side` directly —
  // this is what makes small `textPadding` values bite even for a one-glyph label.
  return Math.min(byWidth, side);
}

/// Angle (radians, world space) from `center` toward one of `cell`'s own vertices, cycling through
/// them by `slot`/`slotCount`. When there are more badges than vertices, use an even circular
/// distribution instead of reusing corners. Falls back to a fixed 45° when the tessellation has no
/// vertex geometry (`getCellVertices` returns `null`, e.g. an unrecognized `cfg.type`).
function vertexAngle(cell: [number, number], center: Pos, cfg: TessellationConfig, slot: number, slotCount: number): number {
  const vertices = getCellVertices(cell[0], cell[1], cfg);
  if (!vertices || vertices.length === 0) return Math.PI / 4;
  if (slotCount > vertices.length) return -Math.PI / 2 + (slot / slotCount) * 2 * Math.PI;
  const index = slotCount <= 1 ? 0 : Math.round((slot / slotCount) * vertices.length) % vertices.length;
  const v = vertices[index];
  return Math.atan2(v.y - center.y, v.x - center.x);
}

export function isCrossFloorBadgeCrowded(cell: [number, number], cfg: TessellationConfig, slotCount: number): boolean {
  const vertices = getCellVertices(cell[0], cell[1], cfg);
  return vertices !== null && vertices.length > 0 && slotCount > vertices.length;
}

/** Draws one cross-floor badge (GitHub issue #337/#339) at `(cx, cy)` — a plain circle (always
 *  round, never the caller's own point shape, so it never reads as an ordinary marker), filled in
 *  `color` with a `borderColor` ring, and the target floor's 1-based display number cut out of the
 *  fill in `floorColor` (a "knockout" look, readable against the filled circle the same way a
 *  stencil digit reads against a solid background) — not `borderColor` text on a `floorColor`
 *  fill, which would make the badge blend into the surrounding floor instead of reading as a solid
 *  marker. Sized well past the ordinary marker-label convention since a single digit needs to be
 *  legible at a glance among other overlapping canvas markers. The digit is an MSDF `BitmapText`
 *  (GitHub issue #352) — the GPU reconstructs its edges from the distance field, so it stays crisp
 *  at any viewport zoom. Shared by `TeleportRenderer` (teleport cross-floor badges) and the graph overlays'
 *  own cross-floor markers (`NavGraphRenderer`/`MazeGraphRenderer`/`PureCyclesOverlay`/
 *  `RouteOverlay`, GitHub issue #339) — per `maze-web/CLAUDE.md`'s feature-renderer ownership rule,
 *  shared drawing logic between feature-renderers lives in a shared utility, never a shared
 *  renderer instance.
 *
 *  `labelsContainer` hosts the digit `BitmapText` alone — PixiJS v8 deprecates `addChild` on a
 *  `Graphics` instance (`g`) and disallows it in a future major version (GitHub issue #432), so the
 *  label can no longer be a child of `g` itself; callers pass any actual `Container` sitting above
 *  `g` in z-order (a sibling layer, or the same container `g` was itself added to).
 *
 *  `opts` (GitHub issue #485) lets the cross-floor teleport badge draw a configured marker shape,
 *  a Roman/letter label, an independent `textColor`, an explicit `fontWeight`/`fontSize` (px, the
 *  badge's own `textSize` setting), and a
 *  `borderWidth` taken from the teleport edge marker's own border rather than the fixed
 *  `FLOOR_BADGE_STROKE_WIDTH`. The teleport call site also passes the badge's own `color`/
 *  `borderColor` (GitHub issue #503 follow-up — independent of the connector color).
 *  Every other caller (`RegionOverlayRenderer`, the graph overlays'
 *  `drawCrossFloorBadge`) omits `opts` and keeps the original circle + `floorColor` knockout digit
 *  at the per-badge `r * 1.6` size and the fixed `FLOOR_BADGE_STROKE_WIDTH` border. */
export function drawFloorBadge(
  g: Graphics,
  labelsContainer: Container,
  r: number,
  cx: number,
  cy: number,
  color: number,
  borderColor: number,
  floorColor: number,
  floorNumber: number,
  opts?: { shape?: MarkerShape; labelText?: string; textColor?: number; fontWeight?: LabelFontWeight; fontSize?: number; borderWidth?: number; rounded?: boolean },
): void {
  const borderWidth = opts?.borderWidth ?? FLOOR_BADGE_STROKE_WIDTH;
  drawMarkerWithBorder(g, opts?.shape ?? "circle", cx, cy, r, opts?.rounded ?? true, color, borderColor, borderWidth);
  const label = makeCenteredLabel(
    opts?.labelText ?? `${floorNumber}`,
    msdfFontFamily(opts?.fontWeight ?? "bold"),
    opts?.fontSize ?? r * 1.6,
    opts?.textColor ?? floorColor,
  );
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
  positionRadiusFactor = 1,
): Pos {
  const onCenter = getCellCenter(onFloorCell[0], onFloorCell[1], cfg);
  const dist = Math.max(tileRadius - badgeRadius, 0) * positionRadiusFactor;
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
 *  center; two or more are spread evenly around a ring of radius `(badgeRadius + strokeWidth) * 1.5`
 *  centered on the cell, starting straight up (`-90°`) and going clockwise, so badges never overlap
 *  each other or (mostly) the cell's own perimeter stroke. See `Specs/floors.md`'s "Cross-floor
 *  region badges" section for the full feature description. */
export function computeRegionBadgeRingPos(cell: [number, number], cfg: TessellationConfig, badgeRadius: number, slot: number, slotCount: number): Pos {
  const center = getCellCenter(cell[0], cell[1], cfg);
  if (slotCount <= 1) return center;
  // Ring radius accounts for the badge's own stroke (drawn outward, `alignment: 0`) — otherwise
  // two adjacent badges' outer rings (radius `badgeRadius + strokeWidth`) overlap despite sitting
  // apart. The 1.5x factor (was 1.25x) spreads the ring further so crowded region cells read
  // clearly (GitHub issue #461 follow-up).
  const ringRadius = (badgeRadius + FLOOR_BADGE_STROKE_WIDTH) * 1.5;
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
  /** `true` runs the stub all the way to the node's own center (no `nodeRadius` trim), matching an
   *  overlay whose vertex-to-vertex edges are drawn gapless too (`IssueHighlightOverlay`). */
  nodeGapless = false,
): void {
  const dx = badgePos.x - nodePos.x;
  const dy = badgePos.y - nodePos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;
  const nodeMargin = nodeGapless ? 0 : nodeRadius + 1;
  const badgeMargin = badgeRadius + 1;
  const startPt: Pos = { x: nodePos.x + ux * nodeMargin, y: nodePos.y + uy * nodeMargin };
  const endPt: Pos = { x: badgePos.x - ux * badgeMargin, y: badgePos.y - uy * badgeMargin };

  g.moveTo(startPt.x, startPt.y).lineTo(endPt.x, endPt.y).stroke({
    width: lineWidth, color: lineColor, alpha: lineAlpha, cap: "butt",
  });

  if (direction !== "none") {
    const segLen = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y);
    if (segLen >= 1) {
      const sign = direction === "toBadge" ? 1 : -1;
      // Midpoint of the full node-center → badge-center span, not of the trimmed stroke — the trim
      // is asymmetric (node end may be gapless, badge end never is), which would otherwise pull
      // the arrow visibly off the connection's true center.
      const midX = (nodePos.x + badgePos.x) / 2;
      const midY = (nodePos.y + badgePos.y) / 2;
      drawDirectionArrow(g, midX, midY, ux * sign, uy * sign, TILE_SIZE * 0.18, lineColor, lineAlpha);
    }
  }
}

/** Adds an invisible hit-circle covering a whole badge drawn by `drawFloorBadge` at `(cx, cy)`,
 *  wired to `navigateToFloor` so clicking anywhere on the badge (not just its digit text) switches
 *  `FloorSwitcher` to `targetFloorIndex` (GitHub issue #368). `radius` is `drawFloorBadge`'s own
 *  fill radius; the hit area extends `borderWidth` (default `FLOOR_BADGE_STROKE_WIDTH`, GitHub
 *  issue #485 follow-up lets `TeleportRenderer` pass the teleport edge marker's own border width)
 *  further out to also cover the border ring, which `drawFloorBadge` strokes outward
 *  (`alignment: 0`) past that fill radius. Shared by every floor-badge call site
 *  (`TeleportRenderer`, `RegionOverlayRenderer`, `drawCrossFloorBadge` below) so the hit-area
 *  radius can never drift from the badge's own drawn extent. */
export function attachFloorBadgeNavigation(container: Container, cx: number, cy: number, radius: number, targetFloorIndex: number, borderWidth = FLOOR_BADGE_STROKE_WIDTH): void {
  const hit = new Graphics().circle(cx, cy, radius + borderWidth).fill({ color: 0, alpha: 0 });
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
  // The body must sit below the label `BitmapText` that `drawFloorBadge` adds to the same container.
  // Adding `g` afterwards covered the digit with the badge's opaque fill (GitHub issue #449).
  nodesContainer.addChild(g);
  drawFloorBadge(g, nodesContainer, radius, badgePos.x, badgePos.y, color, borderColor, floorColor, targetFloorIndex + 1);
  attachFloorBadgeNavigation(nodesContainer, badgePos.x, badgePos.y, radius, targetFloorIndex);
}
