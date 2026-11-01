import type { Graphics } from "pixi.js";
import type { CreaseExportStyle, RenderModeId } from "../../store/imageExportTypes";
import type { MazeState } from "../../store/storeTypes";
import { creaseDisplayPoint } from "../creaseGeometry";

/// The crease style of a render mode (GitHub issue #900): both modes carry the same fields.
export function creaseStyleOf(
  state: Pick<MazeState, "vectorByWallsSettings" | "vectorByCorridorsSettings">,
  mode: RenderModeId,
): CreaseExportStyle {
  return (mode === "vector_by_walls" ? state.vectorByWallsSettings : state.vectorByCorridorsSettings).creases;
}

/// A crease in display space.
export interface ExportCrease {
  from: readonly [number, number];
  to: readonly [number, number];
}

/// The active floor's creases in display space (GitHub issue #900), or none while the style hides them.
export function selectExportCreases(state: Pick<MazeState, "activeFloorId" | "floorFields" | "floorCreases">, style: CreaseExportStyle): ExportCrease[] {
  if (!style.showCreases) return [];
  const floor = state.activeFloorId;
  const cfg = state.floorFields[floor]?.fieldConfig;
  if (!cfg) return [];
  return (state.floorCreases[floor] ?? []).map((crease) => ({ from: creaseDisplayPoint(crease.a, cfg), to: creaseDisplayPoint(crease.b, cfg) }));
}

/// The creases moved by `offset`: one cut-plan copy of them.
export function shiftCreases(creases: readonly ExportCrease[], offset: readonly [number, number]): ExportCrease[] {
  return creases.map(({ from, to }) => ({ from: [from[0] + offset[0], from[1] + offset[1]], to: [to[0] + offset[0], to[1] + offset[1]] }));
}

/// Draws the creases the way the export shows them (GitHub issue #900): as lines (dashed or solid), or as a mark at each
/// end of the crease, a circle with a nose pointing along the crease toward the other end, so the eye follows the crease from one nose to the other.
export function drawExportCreases(g: Graphics, creases: readonly ExportCrease[], style: CreaseExportStyle): void {
  for (const { from, to } of creases) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length === 0) continue;
    const ux = (to[0] - from[0]) / length;
    const uy = (to[1] - from[1]) / length;
    if (style.mode === "lines") drawLine(g, from, ux, uy, length, style);
    else {
      const radius = style.markSize / 2;
      // The nose is clamped so the two marks never reach past the middle of a short crease.
      const nose = Math.max(0, Math.min(style.markTipLength, length / 2 - radius));
      drawMark(g, from, ux, uy, radius, nose);
      drawMark(g, to, -ux, -uy, radius, nose);
    }
  }
  if (style.mode === "lines") g.stroke({ width: style.lineWidth, color: style.color, cap: style.lineStyle === "solid" ? "round" : "butt" });
  else g.fill({ color: style.markColor });
}

function drawLine(g: Graphics, from: readonly [number, number], ux: number, uy: number, length: number, style: CreaseExportStyle): void {
  if (style.lineStyle === "solid") {
    g.moveTo(from[0], from[1]).lineTo(from[0] + ux * length, from[1] + uy * length);
    return;
  }
  const dash = style.lineWidth * 5;
  const period = dash + style.lineWidth * 3;
  for (let at = 0; at < length; at += period) {
    const end = Math.min(at + dash, length);
    g.moveTo(from[0] + ux * at, from[1] + uy * at).lineTo(from[0] + ux * end, from[1] + uy * end);
  }
}

/// A circle of `radius` centred on the crease end `at`, with a nose: the tangents from the point `nose` beyond the circle's
/// edge along the direction (`dx`, `dy`) close into a triangle that joins the circle smoothly.
function drawMark(g: Graphics, at: readonly [number, number], dx: number, dy: number, radius: number, nose: number): void {
  g.circle(at[0], at[1], radius);
  if (nose <= 0 || radius <= 0) return;
  const reach = radius + nose;
  const angle = Math.acos(radius / reach);
  const along = Math.cos(angle) * radius;
  const across = Math.sin(angle) * radius;
  g.poly([
    at[0] + dx * reach, at[1] + dy * reach,
    at[0] + dx * along - dy * across, at[1] + dy * along + dx * across,
    at[0] + dx * along + dy * across, at[1] + dy * along - dx * across,
  ]);
}
