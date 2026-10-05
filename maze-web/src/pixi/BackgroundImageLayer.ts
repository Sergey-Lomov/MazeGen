import { Container, Sprite, Texture } from "pixi.js";
import type { BackgroundImage } from "../store/tessellationTypes";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { getCellVertices } from "./tessellationGeometry";

export const BACKGROUND_IMAGE_ALPHA = 0.5;

export interface FieldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Tight world-space bounds of the field cells used by the three visual editors. */
export function fieldBounds(cells: readonly [number, number][], cfg: TessellationConfig): FieldBounds | null {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of cells) {
    const vertices = getCellVertices(x, y, cfg);
    if (!vertices) continue;
    for (const vertex of vertices) {
      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.minY = Math.min(bounds.minY, vertex.y);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.maxY = Math.max(bounds.maxY, vertex.y);
    }
  }
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

/** Computes a centered cover transform once when the image is enabled. */
export function calculateBackgroundImageLayout(
  dataUrl: string,
  naturalWidth: number,
  naturalHeight: number,
  bounds: FieldBounds,
): BackgroundImage {
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0 || !Number.isFinite(naturalHeight) || naturalHeight <= 0) {
    throw new Error("Underlay dimensions must be positive finite numbers");
  }
  const fieldWidth = Math.max(1, bounds.maxX - bounds.minX);
  const fieldHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.max(fieldWidth / naturalWidth, fieldHeight / naturalHeight);
  return {
    dataUrl,
    naturalWidth,
    naturalHeight,
    displayWidth: naturalWidth * scale,
    displayHeight: naturalHeight * scale,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
  };
}

/** A deliberately feature-local display primitive. It is mounted only by the field, preset,
 * and post-edit renderers, so the image cannot leak into generation, export, or analytics. */
export class BackgroundImageLayer {
  private readonly container: Container;
  private sprite: Sprite | null = null;
  private dataUrl: string | null = null;
  private loadingDataUrl: string | null = null;
  private loadingImage: BackgroundImage | null = null;
  private loadToken = 0;

  constructor(container: Container) {
    this.container = container;
  }

  render(image: BackgroundImage | null, visible: boolean): void {
    if (!image || !visible) {
      this.loadToken++;
      this.loadingDataUrl = null;
      this.loadingImage = null;
      if (this.sprite) this.sprite.visible = false;
      return;
    }

    if (this.dataUrl !== image.dataUrl) {
      this.sprite?.destroy();
      this.sprite = null;
      this.dataUrl = null;
      this.loadingImage = image;
      if (this.loadingDataUrl !== image.dataUrl) {
        this.loadingDataUrl = image.dataUrl;
        void this.loadSprite(image, ++this.loadToken);
      }
      return;
    }

    if (!this.sprite) return;
    this.sprite.visible = true;
    this.applyLayout(this.sprite, image);
  }

  private async loadSprite(image: BackgroundImage, token: number): Promise<void> {
    try {
      const resource = await loadImageElement(image.dataUrl);
      if (token !== this.loadToken || this.loadingDataUrl !== image.dataUrl) return;
      const latestImage = this.loadingImage ?? image;
      const sprite = new Sprite(Texture.from(resource, true));
      sprite.anchor.set(0.5);
      this.container.addChild(sprite);
      this.sprite = sprite;
      this.dataUrl = image.dataUrl;
      this.loadingDataUrl = null;
      this.loadingImage = null;
      sprite.visible = true;
      this.applyLayout(sprite, latestImage);
    } catch {
      if (token === this.loadToken) this.loadingDataUrl = null;
    }
  }

  private applyLayout(sprite: Sprite, image: BackgroundImage): void {
    sprite.position.set(image.centerX, image.centerY);
    sprite.alpha = BACKGROUND_IMAGE_ALPHA;
    sprite.scale.set(
      image.displayWidth / image.naturalWidth,
      image.displayHeight / image.naturalHeight,
    );
  }

  destroy(): void {
    this.sprite?.destroy();
    this.sprite = null;
    this.dataUrl = null;
    this.loadingDataUrl = null;
    this.loadingImage = null;
    this.loadToken++;
  }
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load underlay"));
    image.src = dataUrl;
  });
}
