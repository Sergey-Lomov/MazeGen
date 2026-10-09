import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { BackgroundImage } from "../store/tessellationTypes";
import { colorToRgb } from "../store/colorMath";
import { backgroundImageCrop } from "./BackgroundImageLayer";
import { getCellVertices, pointInPolygon } from "./tessellationGeometry";
import { makeProjection, encodePoint } from "./tessellationProjection";

export type BackgroundAutoFillMode = "transparent" | "color";

export interface BackgroundPixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const EXACT_PIXEL_SPAN_LIMIT = 256;
const BASE_TARGET_SAMPLES_PER_CELL = 128;
const MAX_TARGET_SAMPLES_PER_CELL = 1024;
const THRESHOLD_ADAPTATION_RANGE = 0.25;
const REFINEMENT_BAND = 0.1;

let decodedPixelsCache: { dataUrl: string; promise: Promise<BackgroundPixelData> } | null = null;

/** Returns the opaque RGB color represented by the first pixel in an image buffer. */
export function topLeftPixelColor(pixels: BackgroundPixelData): number {
  if (pixels.width <= 0 || pixels.height <= 0 || pixels.data.length < 4) return 0xffffff;
  return (pixels.data[0] << 16) | (pixels.data[1] << 8) | pixels.data[2];
}

/** Reads the source image's top-left pixel for the selected-color auto-fill mode. */
export async function getBackgroundImageTopLeftColor(dataUrl: string): Promise<number> {
  return topLeftPixelColor(await getBackgroundImagePixels(dataUrl));
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
  const targetSamples = targetSamplesForThreshold(normalizedThreshold);

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
      const sourceWidth = Math.max(0, sourceMaxX - sourceMinX + 1);
      const sourceHeight = Math.max(0, sourceMaxY - sourceMinY + 1);
      const pixelSpan = sourceWidth * sourceHeight;
      const initialStep = samplingStep(pixelSpan, targetSamples);
      let sample = sampleCell(
        vertices,
        getCellCenterWorld(vertices),
        imageMinX,
        imageMinY,
        scale,
        crop,
        pixels,
        mode,
        rgb,
        sourceMinX,
        sourceMaxX,
        sourceMinY,
        sourceMaxY,
        initialStep,
      );

      if (initialStep > 1 && needsRefinement(sample, normalizedThreshold)) {
        const refinedStep = Math.max(1, Math.floor(initialStep / 2));
        sample = sampleCell(
          vertices,
          getCellCenterWorld(vertices),
          imageMinX,
          imageMinY,
          scale,
          crop,
          pixels,
          mode,
          rgb,
          sourceMinX,
          sourceMaxX,
          sourceMinY,
          sourceMaxY,
          refinedStep,
        );

        if (refinedStep > 1 && needsRefinement(sample, normalizedThreshold)) {
          sample = sampleCell(
            vertices,
            getCellCenterWorld(vertices),
            imageMinX,
            imageMinY,
            scale,
            crop,
            pixels,
            mode,
            rgb,
            sourceMinX,
            sourceMaxX,
            sourceMinY,
            sourceMaxY,
            1,
          );
        }
      }

      if (sample.coveredPixels > 0 && sample.nonBackgroundPixels > sample.coveredPixels * normalizedThreshold) {
        result.add(encodePoint(x, y));
      }
    }
  }
  return result;
}

interface CellSample {
  coveredPixels: number;
  nonBackgroundPixels: number;
}

function targetSamplesForThreshold(threshold: number): number {
  const distanceToEdge = Math.min(threshold, 1 - threshold);
  const edgeFactor = Math.max(0, Math.min(1,
    (THRESHOLD_ADAPTATION_RANGE - distanceToEdge) / THRESHOLD_ADAPTATION_RANGE,
  ));
  return Math.round(BASE_TARGET_SAMPLES_PER_CELL
    + (MAX_TARGET_SAMPLES_PER_CELL - BASE_TARGET_SAMPLES_PER_CELL) * edgeFactor);
}

function samplingStep(pixelSpan: number, targetSamples: number): number {
  if (pixelSpan <= EXACT_PIXEL_SPAN_LIMIT) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(pixelSpan / targetSamples)));
}

function needsRefinement(sample: CellSample, threshold: number): boolean {
  if (sample.coveredPixels === 0) return false;
  if (Math.min(threshold, 1 - threshold) <= REFINEMENT_BAND) return false;
  const ratio = sample.nonBackgroundPixels / sample.coveredPixels;
  return Math.abs(ratio - threshold) <= REFINEMENT_BAND;
}

function getCellCenterWorld(vertices: { x: number; y: number }[]): { x: number; y: number } {
  return {
    x: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / vertices.length,
    y: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / vertices.length,
  };
}

function sampleCell(
  vertices: { x: number; y: number }[],
  center: { x: number; y: number },
  imageMinX: number,
  imageMinY: number,
  scale: number,
  crop: ReturnType<typeof backgroundImageCrop>,
  pixels: BackgroundPixelData,
  mode: BackgroundAutoFillMode,
  rgb: { r: number; g: number; b: number },
  sourceMinX: number,
  sourceMaxX: number,
  sourceMinY: number,
  sourceMaxY: number,
  step: number,
): CellSample {
  let coveredPixels = 0;
  let nonBackgroundPixels = 0;
  const centerSourceX = Math.floor(crop.x + (center.x - imageMinX) / scale);
  const centerSourceY = Math.floor(crop.y + (center.y - imageMinY) / scale);

  const samplePixel = (sourceX: number, sourceY: number, worldX: number, worldY: number): void => {
    if (!pointInPolygon({ x: worldX, y: worldY }, vertices)) return;
    coveredPixels++;
    const hasImagePixel = sourceX >= crop.x
      && sourceX < crop.x + crop.width
      && sourceY >= crop.y
      && sourceY < crop.y + crop.height
      && sourceX >= 0
      && sourceX < pixels.width
      && sourceY >= 0
      && sourceY < pixels.height;
    // A sample outside the visible underlay is an absent pixel, and absent pixels are background.
    // This keeps a cell that only partly overlaps the image eligible while preventing its
    // uncovered portion from falsely increasing the foreground share.
    if (!hasImagePixel) return;

    const offset = (sourceY * pixels.width + sourceX) * 4;
    const alpha = pixels.data[offset + 3];
    const isBackground = alpha === 0 || (mode === "color"
      && Math.abs(pixels.data[offset] - rgb.r) <= 16
      && Math.abs(pixels.data[offset + 1] - rgb.g) <= 16
      && Math.abs(pixels.data[offset + 2] - rgb.b) <= 16);
    if (!isBackground) nonBackgroundPixels++;
  };

  // A coarse pass always starts with the cell center. The regular lattice below keeps thin
  // features from depending on one arbitrary sample location.
  if (step > 1) {
    samplePixel(centerSourceX, centerSourceY, center.x, center.y);
  }
  for (let sourceY = sourceMinY; sourceY <= sourceMaxY; sourceY += step) {
    for (let sourceX = sourceMinX; sourceX <= sourceMaxX; sourceX += step) {
      if (step > 1 && sourceX === centerSourceX && sourceY === centerSourceY) continue;
      const worldX = imageMinX + ((sourceX + 0.5 - crop.x) * scale);
      const worldY = imageMinY + ((sourceY + 0.5 - crop.y) * scale);
      samplePixel(sourceX, sourceY, worldX, worldY);
    }
  }
  return { coveredPixels, nonBackgroundPixels };
}

/** Loads the data URL through a canvas and calculates a preview from its decoded pixels. */
export async function buildBackgroundFieldPreviewFromImage(
  image: BackgroundImage,
  config: TessellationConfig,
  mode: BackgroundAutoFillMode,
  backgroundColor: number,
  threshold: number,
): Promise<Set<number>> {
  const pixels = await getBackgroundImagePixels(image.dataUrl, image.naturalWidth, image.naturalHeight);
  return buildBackgroundFieldPreview(image, config, pixels, mode, backgroundColor, threshold);
}

function getBackgroundImagePixels(
  dataUrl: string,
  fallbackWidth = 0,
  fallbackHeight = 0,
): Promise<BackgroundPixelData> {
  if (decodedPixelsCache?.dataUrl === dataUrl) return decodedPixelsCache.promise;

  const promise = decodeBackgroundImagePixels(dataUrl, fallbackWidth, fallbackHeight);
  const entry = { dataUrl, promise };
  decodedPixelsCache = entry;
  void promise.catch(() => {
    if (decodedPixelsCache === entry) decodedPixelsCache = null;
  });
  return promise;
}

async function decodeBackgroundImagePixels(
  dataUrl: string,
  fallbackWidth: number,
  fallbackHeight: number,
): Promise<BackgroundPixelData> {
  const source = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || fallbackWidth;
  canvas.height = source.naturalHeight || fallbackHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.drawImage(source, 0, 0);
  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    width: canvas.width,
    height: canvas.height,
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load underlay"));
    image.src = dataUrl;
  });
}
