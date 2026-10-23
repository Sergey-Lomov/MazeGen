import { Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { FLOOR_LABEL_ANCHORS, type FloorLabelAnchor, type FloorLabelPosition, type FloorLabelSettings } from "../../store/imageExportTypes";
import { getCellCenter, nearestCellCoord } from "../tessellationGeometry";
import { formatIndexLabel } from "./indexLabel";
import { makeCenteredLabel, msdfFontFamily } from "./msdfFont";
import { drawRoundedPolygon, drawRoundedRect, offsetPolygonPath } from "./markerShapes";
import { measureText, rectangularTextFrameHalfExtents, type TextExtent } from "../textFit";

export interface FloorBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function floorLabelText(settings: FloorLabelSettings, floorIndex: number, floorTitle?: string): string {
  if (settings.labelMode === "title" && floorTitle?.trim()) return floorTitle;
  return `${settings.prefix}${formatIndexLabel(floorIndex, settings.labelType)}`;
}

/** Horizontal text centre inside the label frame. The frame centre remains the placement anchor. */
export function floorLabelTextX(
  settings: FloorLabelSettings,
  centerX: number,
  textBounds: Pick<TextExtent, "left" | "right">,
): number {
  if (settings.textAlignment === "center") return centerX;
  const shape = settings.backgroundShape === "parallelogram" ? "parallelogram" : "rectangle";
  const { hw } = rectangularTextFrameHalfExtents(settings.width, settings.height, shape, settings.textMargin);
  return settings.textAlignment === "left"
    ? centerX - hw - textBounds.left
    : centerX + hw - textBounds.right;
}

/** Geometric center of the active floor's cell bounds, independent of viewport pan and zoom. */
export function floorLabelCenter(bounds: FloorBounds): { x: number; y: number } | null {
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null;
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/** Resolves one floor's persisted placement. Cell coordinates address the infinite tessellation grid. */
export function floorLabelPosition(
  settings: FloorLabelSettings,
  floorId: string,
  bounds: FloorBounds,
  cfg: TessellationConfig,
): { x: number; y: number } | null {
  const fallback = floorLabelCenter(bounds);
  const position = settings.positionsByFloorId[floorId];
  if (!position || position.mode === "anchored") {
    return floorLabelAnchorPoint(bounds, position?.anchor ?? "center", settings.width, settings.height);
  }
  if (position.mode === "free") {
    return Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : fallback;
  }
  const [x, y] = position.cell;
  return getCellCenter(x, y, cfg);
}

/** Converts placement modes while keeping the rendered label center as close as the target mode permits. */
export function convertFloorLabelPosition(
  settings: FloorLabelSettings,
  floorId: string,
  targetMode: FloorLabelPosition["mode"],
  bounds: FloorBounds,
  cfg: TessellationConfig,
): FloorLabelPosition {
  const current = settings.positionsByFloorId[floorId] ?? { mode: "anchored" as const, anchor: "center" as const };
  if (current.mode === targetMode) return current.mode === "cell" ? { ...current, cell: [...current.cell] } : { ...current };
  const point = floorLabelPosition(settings, floorId, bounds, cfg) ?? { x: 0, y: 0 };
  if (targetMode === "free") return { mode: "free", x: point.x, y: point.y };
  if (targetMode === "cell") return { mode: "cell", cell: nearestCellCoord(point.x, point.y, cfg) };

  let closest: FloorLabelAnchor = "center";
  let closestDistance = Infinity;
  for (const anchor of FLOOR_LABEL_ANCHORS) {
    const candidate = floorLabelAnchorPoint(bounds, anchor, settings.width, settings.height);
    if (!candidate) continue;
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (distance < closestDistance) {
      closest = anchor;
      closestDistance = distance;
    }
  }
  return { mode: "anchored", anchor: closest };
}

function floorLabelAnchorPoint(bounds: FloorBounds, anchor: FloorLabelAnchor, width: number, height: number): { x: number; y: number } | null {
  const center = floorLabelCenter(bounds);
  if (!center) return null;
  const halfWidth = Math.max(1, width) / 2;
  const halfHeight = Math.max(1, height) / 2;
  const x = anchor.endsWith("_left") ? bounds.minX + halfWidth : anchor.endsWith("_right") ? bounds.maxX - halfWidth : center.x;
  const y = anchor.startsWith("top_") ? bounds.minY + halfHeight : anchor.startsWith("bottom_") ? bounds.maxY - halfHeight : center.y;
  return { x, y };
}

/** Draws the active floor label at its resolved world-space position. */
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
    floorTitle?: string,
  ): void {
    this.clear();
    if (!settings.enabled || floorCount <= 1 || !center) return;

    const text = floorLabelText(settings, floorIndex, floorTitle);
    const label = makeCenteredLabel(
      text,
      msdfFontFamily(settings.textFontWeight),
      settings.textSize,
      settings.textColor,
    );
    label.x = floorLabelTextX(settings, center.x, measureText(text, settings.textFontWeight, settings.textSize));
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
