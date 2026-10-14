import { Container, Graphics } from "pixi.js";
import type { FloorLabelSettings } from "../../store/imageExportTypes";
import { formatIndexLabel } from "./indexLabel";
import { makeCenteredLabel, msdfFontFamily } from "./msdfFont";
import { drawRoundedPolygon, drawRoundedRect, offsetPolygonPath } from "./markerShapes";

export interface FloorBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function floorLabelText(settings: FloorLabelSettings, floorIndex: number): string {
  return `${settings.prefix}${formatIndexLabel(floorIndex, settings.labelType)}`;
}

/** Geometric center of the active floor's cell bounds, independent of viewport pan and zoom. */
export function floorLabelCenter(bounds: FloorBounds): { x: number; y: number } | null {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null;
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/** Draws the active floor label over the geometric center of the maze. */
export class FloorLabelRenderer {
  private readonly layer: Container;

  constructor(container: Container) {
    this.layer = new Container();
    container.addChild(this.layer);
  }

  clear(): void {
    this.layer.removeChildren().forEach((child) => child.destroy({ children: true }));
  }

  render(
    settings: FloorLabelSettings,
    center: { x: number; y: number } | null,
    floorIndex: number,
    floorCount: number,
    surfaceColor: number,
  ): void {
    this.clear();
    if (!settings.enabled || floorCount <= 1 || !center) return;

    const label = makeCenteredLabel(
      floorLabelText(settings, floorIndex),
      msdfFontFamily(settings.textFontWeight),
      settings.textSize,
      settings.textColor,
    );
    label.x = center.x;
    label.y = center.y;

    if (settings.backgroundShape === "none") {
      this.layer.addChild(label);
      return;
    }

    const width = Math.max(1, settings.width);
    const height = Math.max(1, settings.height);
    const x = center.x - width / 2;
    const y = center.y - height / 2;
    const gap = Math.max(0, settings.gap);
    const borderWidth = Math.max(0, settings.borderWidth);
    const body = new Graphics();

    if (settings.backgroundShape === "rectangle") {
      const radius = Math.min(Math.max(0, settings.cornerRadius), width / 2, height / 2);
      if (gap > 0) {
        const outset = borderWidth + gap;
        drawRoundedRect(body, x - outset, y - outset, width + outset * 2, height + outset * 2, radius + outset);
        body.fill(surfaceColor);
      }
      if (borderWidth > 0) {
        drawRoundedRect(body, x - borderWidth, y - borderWidth, width + borderWidth * 2, height + borderWidth * 2, radius + borderWidth);
        body.fill(settings.borderColor);
      }
      drawRoundedRect(body, x, y, width, height, radius);
      body.fill(settings.fillColor);
    } else {
      const skew = Math.min(height * 0.45, width * 0.2);
      const points = [x + skew, y, x + width, y, x + width - skew, y + height, x, y + height];
      const radius = Math.min(Math.max(0, settings.cornerRadius), height / 2, width / 4);
      if (gap > 0) {
        const outset = borderWidth + gap;
        // Offset the four sharp vertices first, then round those four vertices. Using a rounded
        // offset join here creates extra arc points that `drawRoundedPolygon` treats as corners,
        // which leaves the parallelogram's border visibly less rounded than its fill.
        drawRoundedPolygon(body, offsetPolygonPath(points, outset, 4, "miter"), radius + outset);
        body.fill(surfaceColor);
      }
      if (borderWidth > 0) {
        drawRoundedPolygon(body, offsetPolygonPath(points, borderWidth, 4, "miter"), radius + borderWidth);
        body.fill(settings.borderColor);
      }
      drawRoundedPolygon(body, points, radius);
      body.fill(settings.fillColor);
    }

    this.layer.addChild(body);
    this.layer.addChild(label);
  }

  destroy(): void {
    this.clear();
    this.layer.destroy({ children: true });
  }
}
