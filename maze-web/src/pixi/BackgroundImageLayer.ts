import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { BackgroundImage, BackgroundImageLayerMode } from "../store/tessellationTypes";
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
    layer: "below_grid",
    opacity: BACKGROUND_IMAGE_ALPHA,
  };
}

/** A deliberately feature-local display primitive. It is mounted only by the field, preset,
 * and post-edit renderers, so the image cannot leak into generation, export, or analytics. */
export class BackgroundImageLayer {
  private readonly container: Container;
  private readonly frameContainer: Container;
  private readonly frame: Graphics;
  private sprite: Sprite | null = null;
  private dataUrl: string | null = null;
  private loadingDataUrl: string | null = null;
  private loadingImage: BackgroundImage | null = null;
  private loadingInteractive = false;
  private loadToken = 0;

  constructor(
    container: Container,
    private readonly floorContainer: Container | null = null,
    private readonly gridContainer: Container | null = null,
    private readonly aboveFloorContainer: Container | null = null,
  ) {
    this.container = container;
    this.frameContainer = new Container();
    this.frame = new Graphics();
    this.frameContainer.addChild(this.frame);
    this.frameContainer.visible = false;
    this.frameContainer.eventMode = "none";
    (container.parent ?? container).addChild(this.frameContainer);
  }

  render(image: BackgroundImage | null, visible: boolean, interactive = false): void {
    this.applyLayerOrder(image?.layer ?? "below_grid");
    if (!image || !visible) {
      this.loadToken++;
      this.loadingDataUrl = null;
      this.loadingImage = null;
      if (this.sprite) this.sprite.visible = false;
      this.frameContainer.visible = false;
      return;
    }

    if (this.dataUrl !== image.dataUrl) {
      this.sprite?.destroy();
      this.sprite = null;
      this.dataUrl = null;
      this.loadingImage = image;
      this.loadingInteractive = interactive;
      this.frameContainer.visible = false;
      if (this.loadingDataUrl !== image.dataUrl) {
        this.loadingDataUrl = image.dataUrl;
        void this.loadSprite(image, ++this.loadToken);
      }
      return;
    }

    if (!this.sprite) return;
    this.sprite.visible = true;
    this.applyLayout(this.sprite, image, interactive);
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
      this.applyLayout(sprite, latestImage, this.loadingInteractive);
      this.loadingInteractive = false;
    } catch {
      if (token === this.loadToken) this.loadingDataUrl = null;
    }
  }

  private applyLayout(sprite: Sprite, image: BackgroundImage, interactive: boolean): void {
    sprite.position.set(image.centerX, image.centerY);
    sprite.alpha = Number.isFinite(image.opacity)
      ? Math.min(1, Math.max(0, image.opacity))
      : BACKGROUND_IMAGE_ALPHA;
    sprite.scale.set(
      image.displayWidth / image.naturalWidth,
      image.displayHeight / image.naturalHeight,
    );
    this.drawFrame(image, interactive);
  }

  private drawFrame(image: BackgroundImage, interactive: boolean): void {
    this.frame.clear();
    if (!interactive) {
      this.frameContainer.visible = false;
      return;
    }
    const halfWidth = image.displayWidth / 2;
    const halfHeight = image.displayHeight / 2;
    const handleRadius = Math.max(4, Math.min(10, Math.min(halfWidth, halfHeight) * 0.12));
    this.frame
      .rect(-halfWidth, -halfHeight, image.displayWidth, image.displayHeight)
      .stroke({ color: 0xffffff, alpha: 0.95, width: Math.max(1.5, handleRadius * 0.18) });
    for (const [x, y] of [
      [-halfWidth, -halfHeight], [halfWidth, -halfHeight],
      [-halfWidth, halfHeight], [halfWidth, halfHeight],
    ]) {
      this.frame.circle(x, y, handleRadius).fill({ color: 0x202020, alpha: 0.9 });
      this.frame.circle(x, y, handleRadius * 0.55).fill(0xffffff);
    }
    this.frame.circle(0, 0, handleRadius * 0.7).fill({ color: 0x202020, alpha: 0.9 });
    this.frame.circle(0, 0, handleRadius * 0.3).fill(0xffffff);
    this.frameContainer.visible = true;
    this.frameContainer.x = image.centerX;
    this.frameContainer.y = image.centerY;
    // Keep the frame above the image even though both are siblings in the renderer root.
    this.frameContainer.parent?.setChildIndex(this.frameContainer, this.frameContainer.parent.children.length - 1);
  }

  private applyLayerOrder(layer: BackgroundImageLayerMode): void {
    const parent = this.container.parent;
    if (!parent) return;
    if (!this.gridContainer || !this.floorContainer) return;
    if (parent.getChildIndex(this.frameContainer) !== parent.children.length - 1) {
      parent.setChildIndex(this.frameContainer, parent.children.length - 1);
    }
    const currentIndex = parent.getChildIndex(this.container);
    const targetIndex = layer === "below_grid"
      ? indexBefore(parent, this.container, this.gridContainer)
      : layer === "above_grid"
        ? indexBefore(parent, this.container, this.floorContainer)
        : layer === "above_floor"
          ? indexBefore(parent, this.container, this.aboveFloorContainer ?? this.frameContainer)
        : indexBefore(parent, this.container, this.frameContainer);
    if (currentIndex !== targetIndex) parent.setChildIndex(this.container, targetIndex);
  }

  destroy(): void {
    this.sprite?.destroy();
    this.sprite = null;
    this.dataUrl = null;
    this.loadingDataUrl = null;
    this.loadingImage = null;
    this.loadingInteractive = false;
    this.loadToken++;
    this.frameContainer.destroy?.({ children: true });
  }
}

function indexBefore(parent: Container, moving: Container, anchor: Container): number {
  const anchorIndex = parent.getChildIndex(anchor);
  return parent.getChildIndex(moving) < anchorIndex ? anchorIndex - 1 : anchorIndex;
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load underlay"));
    image.src = dataUrl;
  });
}
