import { Container, Graphics } from "pixi.js";
import { getCellHighlightInset } from "../cellHighlightGeometry";
import { drawRoundedPolygon } from "./markerShapes";
import { offsetPolyline, polylineLength, trimPolyline } from "../geometry/polylineOps";
import { WALL_THICKNESS } from "../renderConstants";
import { WALL_HIGHLIGHT_SPAN } from "./wallUtils";

/// One highlighted stretch of the field boundary: a polyline (consecutive faces already merged) and its colour.
export interface TopologyBand {
  polyline: [number, number][];
  color: number;
}

/** The boundary highlight band the other edge highlights use (`drawCellBoundaryHighlight`: a
 * rounded quad of `WALL_HIGHLIGHT_SPAN`, pulled back from the ends by the cell highlight inset,
 * filled at 0.25 with a `WALL_THICKNESS` border), built on an arbitrary polyline so consecutive
 * faces form one band. A boundary face has no second cell, so the shared-edge helper cannot be
 * used directly. */
function drawPolylineBand(g: Graphics, polyline: [number, number][], color: number): void {
  const length = polylineLength(polyline);
  if (length === 0) return;
  const inset = Math.max(0, Math.min(getCellHighlightInset(), length / 2 - 1));
  const trimmed = trimPolyline(polyline, inset, length - inset);
  if (trimmed.length < 2) return;
  const half = WALL_HIGHLIGHT_SPAN / 2;
  const points = [...offsetPolyline(trimmed, half), ...offsetPolyline(trimmed, -half).reverse()].flat();
  const radius = Math.min(polylineLength(trimmed), WALL_HIGHLIGHT_SPAN) * 0.18;
  drawRoundedPolygon(g, points, radius);
  g.fill({ color, alpha: 0.25 });
  drawRoundedPolygon(g, points, radius);
  g.stroke({ color, alpha: 1, width: WALL_THICKNESS, join: "round" });
}

/// Highlight bands of the topology editor (GitHub issue #839): the runs being picked for a new glue and the
/// sides hovered in the glue editor, each drawn with the ordinary edge highlight band in its own colour.
export class TopologyBandRenderer {
  private readonly g = new Graphics();

  constructor(container: Container) {
    container.addChild(this.g);
  }

  render(bands: readonly TopologyBand[]): void {
    this.g.clear();
    for (const { polyline, color } of bands) drawPolylineBand(this.g, polyline, color);
  }

  destroy(): void {
    this.g.destroy();
  }
}
