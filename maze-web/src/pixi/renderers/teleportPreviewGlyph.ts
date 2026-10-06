import type { Graphics } from "pixi.js";
import { DEFAULT_MAZE_RENDER_STYLE } from "../defaultMazeRenderStyle";
import { drawMarkerUnderlay, drawMarkerWithBorder } from "./markerShapes";
import { clipDistance } from "./teleportGeometry";

/** Dimmed while-placing look for a teleport whose first endpoint is fixed: the endpoint marker at
 *  `(originX, originY)` plus a connector line reaching to the cursor. Shared by
 *  `PresetConnectionsRenderer` and `PostEditRenderer` — both drew a hand-rolled fixed 16px square
 *  before (GitHub issue #456 follow-up), which never matched the real teleport marker shape/size.
 *
 *  The marker is drawn with the exact `DEFAULT_MAZE_RENDER_STYLE.teleport` shape / size / corner
 *  style / border the renderers use for real teleport endpoints, only dimmed via `alpha` so the
 *  gesture reads as "one end fixed, aim the other". All coordinates are screen-space (post
 *  projection) — callers project grid coords themselves.
 *
 *  Does not `clear()` — the caller owns the `Graphics` lifecycle and clears it first. */
export function drawTeleportPreview(
  g: Graphics,
  originX: number,
  originY: number,
  cursorX: number,
  cursorY: number,
): void {
  const style = DEFAULT_MAZE_RENDER_STYLE.teleport;
  const r = style.size / 2;
  const rounded = style.cornerStyle === "round";
  const strokeWidth = style.connectorWidth;
  // The real marker's outer edge is `r + borderWidth + edgeGapWidth` (`TeleportRenderer`'s gap
  // ring / connector-clip formula) — the connector must clip to that, not the bare fill radius.
  const outerR = r + style.borderWidth + style.edgeGapWidth;

  const dx = cursorX - originX;
  const dy = cursorY - originY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) {
    const ux = dx / len;
    const uy = dy / len;
    const clip = clipDistance(ux, uy, outerR, strokeWidth);
    if (len > clip) {
      g.moveTo(originX + ux * clip, originY + uy * clip)
        .lineTo(cursorX, cursorY)
        .stroke({ width: strokeWidth, color: style.connectorColor, alpha: 0.5, cap: "round" });
    }
  }

  // Single true outward offset of the fill path (`r`) by `borderWidth + edgeGapWidth` (GitHub issue
  // #552 ninth follow-up) — see `WaypointsRenderer`'s own gap ring for the full rationale.
  if (style.edgeGapWidth > 0) {
    drawMarkerUnderlay(g, style.shape, originX, originY, r, rounded, style.borderWidth + style.edgeGapWidth, { color: style.floorColor, alpha: 0.5 });
  }
  drawMarkerWithBorder(
    g,
    style.shape,
    originX,
    originY,
    r,
    rounded,
    { color: style.edgeColor, alpha: 0.5 },
    { color: style.edgeBorderColor, alpha: 0.5 },
    style.borderWidth,
  );
}
