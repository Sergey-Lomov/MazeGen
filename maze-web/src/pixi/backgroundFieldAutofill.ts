import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { BackgroundImage } from "../store/tessellationTypes";
import { colorToRgb } from "../store/colorMath";
import { backgroundImageCrop } from "./BackgroundImageLayer";
import { getCellVertices } from "./tessellationGeometry";
import { makeProjection, encodePoint } from "./tessellationProjection";

export type BackgroundAutoFillMode = "transparent" | "color";

export interface BackgroundPixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Returns the opaque RGB color represented by the first pixel in an image buffer. */
export function topLeftPixelColor(pixels: BackgroundPixelData): number {
  if (pixels.width <= 0 || pixels.height <= 0 || pixels.data.length < 4) return 0xffffff;
  return (pixels.data[0] << 16) | (pixels.data[1] << 8) | pixels.data[2];
}

/** Reads the source image's top-left pixel for the selected-color auto-fill mode. */
export async function getBackgroundImageTopLeftColor(dataUrl: string): Promise<number> {
  const source = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.drawImage(source, 0, 0);
  return topLeftPixelColor({
    data: context.getImageData(0, 0, 1, 1).data,
    width: 1,
    height: 1,
  });
}

/**
 * Builds a custom-field point set from the pixels covered by the current underlay transform.
 * The calculation deliberately works in world coordinates, so a manually moved or cropped
 * underlay is classified in exactly the same alignment the field editor displays.
 */
export function buildBackgroundFieldPreview(
  image: BackgroundImage,
  config: TessellationConfig,
  pixels: BackgroundPixelData,
  mode: BackgroundAutoFillMode,
  backgroundColor: number,
  threshold: number,
): Set<number> {
  if (pixels.width <= 0 || pixels.height <= 0 || pixels.data.length < pixels.width * pixels.height * 4) {
    return new Set();
  }

  const crop = backgroundImageCrop(image);
  const scale = image.displayWidth / crop.width;
  if (!Number.isFinite(scale) || scale <= 0) return new Set();

  const imageMinX = image.centerX - image.displayWidth / 2;
  const imageMaxX = image.centerX + image.displayWidth / 2;
  const imageMinY = image.centerY - image.displayHeight / 2;
  const imageMaxY = image.centerY + image.displayHeight / 2;
  const projection = makeProjection(config);
  const corners = [
    projection.screenToGrid(imageMinX, imageMinY),
    projection.screenToGrid(imageMaxX, imageMinY),
    projection.screenToGrid(imageMinX, imageMaxY),
    projection.screenToGrid(imageMaxX, imageMaxY),
  ];
  const minGridX = Math.min(...corners.map((point) => point.x)) - 2;
  const maxGridX = Math.max(...corners.map((point) => point.x)) + 2;
  const minGridY = Math.min(...corners.map((point) => point.y)) - 2;
  const maxGridY = Math.max(...corners.map((point) => point.y)) + 2;
  const rgb = colorToRgb(backgroundColor);
  const result = new Set<number>();
  const normalizedThreshold = Math.max(0, Math.min(1, threshold));

  for (let y = minGridY; y <= maxGridY; y++) {
    for (let x = minGridX; x <= maxGridX; x++) {
      const vertices = getCellVertices(x, y, config);
      if (!vertices) continue;
      const cellMinWorldX = Math.min(...vertices.map((vertex) => vertex.x));
      const cellMaxWorldX = Math.max(...vertices.map((vertex) => vertex.x));
      const cellMinWorldY = Math.min(...vertices.map((vertex) => vertex.y));
      const cellMaxWorldY = Math.max(...vertices.map((vertex) => vertex.y));
      const sourceMinX = Math.floor(crop.x + (cellMinWorldX - imageMinX) / scale);
      const sourceMaxX = Math.ceil(crop.x + (cellMaxWorldX - imageMinX) / scale);
      const sourceMinY = Math.floor(crop.y + (cellMinWorldY - imageMinY) / scale);
      const sourceMaxY = Math.ceil(crop.y + (cellMaxWorldY - imageMinY) / scale);
      let coveredPixels = 0;
      let nonBackgroundPixels = 0;

      for (let sourceY = sourceMinY; sourceY <= sourceMaxY; sourceY++) {
        for (let sourceX = sourceMinX; sourceX <= sourceMaxX; sourceX++) {
          const worldX = imageMinX + ((sourceX + 0.5 - crop.x) * scale);
          const worldY = imageMinY + ((sourceY + 0.5 - crop.y) * scale);
          if (!pointInPolygon(worldX, worldY, vertices)) continue;
          coveredPixels++;
          const hasImagePixel = sourceX >= crop.x
            && sourceX < crop.x + crop.width
            && sourceY >= crop.y
            && sourceY < crop.y + crop.height
            && sourceX >= 0
            && sourceX < pixels.width
            && sourceY >= 0
            && sourceY < pixels.height;
          // A sample outside the visible underlay is an absent pixel, and absent pixels are
          // background. This keeps a cell that only partly overlaps the image eligible while
          // preventing its uncovered portion from falsely increasing the foreground share.
          const isBackground = !hasImagePixel || (() => {
            const offset = (sourceY * pixels.width + sourceX) * 4;
            const alpha = pixels.data[offset + 3];
            return alpha === 0 || (mode === "color"
              && Math.abs(pixels.data[offset] - rgb.r) <= 16
              && Math.abs(pixels.data[offset + 1] - rgb.g) <= 16
              && Math.abs(pixels.data[offset + 2] - rgb.b) <= 16);
          })();
          if (!isBackground) nonBackgroundPixels++;
        }
      }

      if (coveredPixels > 0 && nonBackgroundPixels > coveredPixels * normalizedThreshold) {
        result.add(encodePoint(x, y));
      }
    }
  }
  return result;
}

/** Loads the data URL through a canvas and calculates a preview from its decoded pixels. */
export async function buildBackgroundFieldPreviewFromImage(
  image: BackgroundImage,
  config: TessellationConfig,
  mode: BackgroundAutoFillMode,
  backgroundColor: number,
  threshold: number,
): Promise<Set<number>> {
  const source = await loadImage(image.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || image.naturalWidth;
  canvas.height = source.naturalHeight || image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return buildBackgroundFieldPreview(image, config, pixels, mode, backgroundColor, threshold);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load underlay"));
    image.src = dataUrl;
  });
}

function pointInPolygon(x: number, y: number, vertices: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const current = vertices[i];
    const previous = vertices[j];
    const intersects = (current.y > y) !== (previous.y > y)
      && x < (previous.x - current.x) * (y - current.y) / (previous.y - current.y) + current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
