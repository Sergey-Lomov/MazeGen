import type { Graphics } from "pixi.js";
import type { MarkerData } from "./types";
import { drawMarkerShape } from "./markerShapes";

/** Draws a filled patch matching each marker's own shape, in the line's own color, wherever a
 *  marker sits on top of a stroked line — GitHub issue #311's reusable "widen the line so a
 *  marker doesn't get visually swallowed by it" mechanism. Not waypoint-specific: any renderer
 *  drawing markers over a stroked line (a corridor, a wall, ...) can call this with its own
 *  `MarkerData[]` and stroke color/width. A marker's own visible footprint radius is
 *  `radius + (borderWidth ?? 0) + (gapWidth ?? 0)` (same convention `exportWarnings.ts`'s
 *  `markerWorldRadius` uses for its overlap checks); `padding` is added on top of that footprint so
 *  the patch actually extends past what the marker itself draws — without it, a marker with no
 *  border/gap has a footprint exactly equal to its own fill radius, so the marker completely covers
 *  the patch and no widened line is visible around it at all. The result is floored at the line's
 *  own half-width so a small marker (plus padding) never narrows the line under it. Must be drawn
 *  after the line's own stroke and before the markers themselves.
 *
 *  `shapeOverride` (GitHub issue #313 follow-up, `VectorByCorridorsSettings.markerWidenShape`) fixes
 *  every patch to one shape (`"circle"`/`"square"`) regardless of that particular marker's own —
 *  omitted (or `"match_marker"`) keeps the original per-marker `marker.shape ?? "circle"` behavior.
 *  This applies uniformly to every marker, cross-floor teleport badges included (GitHub issue #485
 *  follow-up: the badge patch copies the badge shape only when `markerWidenShape` is
 *  `"match_marker"`, and follows the fixed `"circle"`/`"square"` otherwise, exactly like an
 *  ordinary marker). `squareCornerStyle` only matters when `shapeOverride` is `"square"` — the
 *  corridor's own `join` drives it (`"round"`->rounded corners, `"miter"`->sharp), not a fixed
 *  value, so a square patch reads consistently with the corridor stroke's own corners. */
export function drawMarkerWidenPatches(
  g: Graphics,
  markers: MarkerData[],
  lineColor: number,
  lineWidth: number,
  padding: number,
  shapeOverride?: "circle" | "square" | "match_marker",
  squareCornerStyle?: "sharp" | "round",
): void {
  const halfWidth = lineWidth / 2;
  for (const marker of markers) {
    const footprint = marker.radius + (marker.borderWidth ?? 0) + (marker.gapWidth ?? 0) + padding;
    const patchRadius = Math.max(footprint, halfWidth);
    const useOverride = shapeOverride !== undefined && shapeOverride !== "match_marker";
    const shape = useOverride ? shapeOverride : (marker.shape ?? "circle");
    const rounded = useOverride ? squareCornerStyle === "round" : marker.cornerStyle === "round";
    drawMarkerShape(g, shape, marker.pos[0], marker.pos[1], patchRadius, rounded);
    g.fill(lineColor);
  }
}
