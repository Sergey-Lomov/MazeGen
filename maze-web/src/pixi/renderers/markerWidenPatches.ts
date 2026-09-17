import type { Graphics } from "pixi.js";
import type { MarkerData } from "./types";
import { drawMarkerUnderlay } from "./markerShapes";

/** Draws a filled patch matching each marker's own shape, in the line's own color, wherever a
 *  marker sits on top of a stroked line — GitHub issue #311's reusable "widen the line so a
 *  marker doesn't get visually swallowed by it" mechanism. Not waypoint-specific: any renderer
 *  drawing markers over a stroked line (a corridor, a wall, ...) can call this with its own
 *  `MarkerData[]` and stroke color/width. A marker's own visible footprint radius is
 *  `radius + (borderWidth ?? 0) + (gapWidth ?? 0)` (same convention `exportWarnings.ts`'s
 *  `markerWorldRadius` uses for its overlap checks). The patch itself is a single true outward
 *  offset of the marker's own *fill* path (`radius`) by `borderWidth` plus whatever's left of the
 *  footprint beyond that — not a `drawMarkerShape` redrawn at `radius + borderWidth`, which rescales
 *  a rounded shape's corner radius right along with it and drifts from the marker's real outer
 *  silhouette at the corners (GitHub issue #552 sixth follow-up; see `drawMarkerWidenPatches`'s own
 *  comment). `padding` is added on top of the footprint so
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
  if (padding <= 0) return; // padding is this patch's own on/off switch — 0 means no widen patch at all, regardless of borderWidth/gapWidth
  const halfWidth = lineWidth / 2;
  for (const marker of markers) {
    const borderWidth = marker.borderWidth ?? 0;
    const markerOuterRadius = marker.radius + borderWidth;
    const footprint = markerOuterRadius + (marker.gapWidth ?? 0) + padding;
    const patchRadius = Math.max(footprint, halfWidth);
    const useOverride = shapeOverride !== undefined && shapeOverride !== "match_marker";
    const shape = useOverride ? shapeOverride : (marker.shape ?? "circle");
    const rounded = useOverride ? squareCornerStyle === "round" : marker.cornerStyle === "round";
    // The patch must offset outward from the marker's *own fill path* (`marker.radius`), not from a
    // `drawMarkerShape` redrawn at `markerOuterRadius` — see `drawMarkerUnderlay`'s own doc comment
    // for why redrawing a rounded shape at a bigger radius drifts from the marker's true outer edge
    // at the corners (GitHub issue #552 sixth follow-up). `extra` (floored at 0) is what's left of
    // the footprint beyond the marker's own outer edge — `patchRadius` can be `halfWidth`-floored
    // below `markerOuterRadius` for a marker smaller than the stroke.
    const extra = Math.max(patchRadius - markerOuterRadius, 0);
    // `padding > 0` (checked above) guarantees `footprint > markerOuterRadius`, so `extra > 0` and
    // therefore `outset > 0` here always — there's always something to draw once this loop runs.
    const outset = borderWidth + extra;
    drawMarkerUnderlay(g, shape, marker.pos[0], marker.pos[1], marker.radius, rounded, outset, lineColor);
  }
}
