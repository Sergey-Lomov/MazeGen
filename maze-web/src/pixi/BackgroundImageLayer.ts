import { Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { BackgroundImage, BackgroundImageLayerMode } from "../store/tessellationTypes";
import type { PrintExportSettings } from "../store/storeTypes";
import type { MazeState } from "../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { getCellVertices } from "./tessellationGeometry";
import { paperLayoutWorldGeometry } from "./paperLayoutGeometry";
import { backgroundImageEditMode } from "./sceneTypes";

export const BACKGROUND_IMAGE_ALPHA = 0.5;

export interface BackgroundImageHostContainers {
  image: Container;
  floor: Container;
  grid: Container;
  layerAnchor: Container;
}

export function backgroundImageChanged(state: MazeState, prev: MazeState): boolean {
  return state.showBackgroundImage !== prev.showBackgroundImage
    || state.backgroundImage !== prev.backgroundImage
    || state.backgroundImageManualPositioning !== prev.backgroundImageManualPositioning
    || state.backgroundImageCropping !== prev.backgroundImageCropping;
}

export type BackgroundImageEditMode = "transform" | "crop" | null;

export interface BackgroundImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** Returns a valid source-image crop, defaulting old in-memory/project values to the full image. */
export function backgroundImageCrop(image: BackgroundImage): BackgroundImageCrop {
  const x = Number.isFinite(image.cropX) ? image.cropX! : 0;
  const y = Number.isFinite(image.cropY) ? image.cropY! : 0;
  const width = Number.isFinite(image.cropWidth) ? image.cropWidth! : image.naturalWidth;
  const height = Number.isFinite(image.cropHeight) ? image.cropHeight! : image.naturalHeight;
  return {
    x: Math.max(0, Math.min(image.naturalWidth - 1, x)),
    y: Math.max(0, Math.min(image.naturalHeight - 1, y)),
    width: Math.max(1, Math.min(image.naturalWidth - Math.max(0, Math.min(image.naturalWidth - 1, x)), width)),
    height: Math.max(1, Math.min(image.naturalHeight - Math.max(0, Math.min(image.naturalHeight - 1, y)), height)),
  };
}

/** World-units-per-source-pixel scale for the already-cropped fragment. */
export function backgroundImageSourceScale(image: BackgroundImage): number {
  const crop = backgroundImageCrop(image);
  return image.displayWidth / crop.width;
}

/** World-space center of the complete source image under the current crop transform. */
export function backgroundImageFullCenter(image: BackgroundImage): { x: number; y: number } {
  const crop = backgroundImageCrop(image);
  const scale = backgroundImageSourceScale(image);
  return {
    x: image.centerX - (crop.x + crop.width / 2 - image.naturalWidth / 2) * scale,
    y: image.centerY - (crop.y + crop.height / 2 - image.naturalHeight / 2) * scale,
  };
}

/** Computes a centered contain transform once when the image is enabled. */
export function calculateBackgroundImageLayout(
  dataUrl: string,
  naturalWidth: number,
  naturalHeight: number,
  bounds: FieldBounds,
  crop: BackgroundImageCrop = { x: 0, y: 0, width: naturalWidth, height: naturalHeight },
): BackgroundImage {
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0 || !Number.isFinite(naturalHeight) || naturalHeight <= 0) {
    throw new Error("Underlay dimensions must be positive finite numbers");
  }
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y)
    || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > naturalWidth || crop.y + crop.height > naturalHeight) {
    throw new Error("Underlay crop must be inside the source image");
  }
  const fieldWidth = Math.max(1, bounds.maxX - bounds.minX);
  const fieldHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(fieldWidth / crop.width, fieldHeight / crop.height);
  return {
    dataUrl,
    naturalWidth,
    naturalHeight,
    cropX: crop.x,
    cropY: crop.y,
    cropWidth: crop.width,
    cropHeight: crop.height,
    displayWidth: crop.width * scale,
    displayHeight: crop.height * scale,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    layer: "below_grid",
    opacity: BACKGROUND_IMAGE_ALPHA,
  };
}

/** Fits an underlay to the shared paper layout used by the custom field editor. The page is
 * centered at the editor origin; the image keeps its aspect ratio and uses the same contain
 * semantics as the existing "position to field" action. Cell size is intentionally read from
 * the current print settings rather than calculated or changed by this feature. */
export function calculateBackgroundImagePageLayout(
  dataUrl: string,
  naturalWidth: number,
  naturalHeight: number,
  config: Pick<TessellationConfig, "type">,
  settings: PrintExportSettings,
  crop: BackgroundImageCrop = { x: 0, y: 0, width: naturalWidth, height: naturalHeight },
): BackgroundImage {
  const geometry = paperLayoutWorldGeometry(config, settings);
  if (!geometry) throw new Error("Paper layout has invalid dimensions");
  const pageWidth = geometry.sheetWidth - geometry.marginHorizontal * 2;
  const pageHeight = geometry.sheetHeight - geometry.marginVertical * 2;
  if (![pageWidth, pageHeight, geometry.marginHorizontal, geometry.marginVertical].every(Number.isFinite)
    || pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("Paper layout margins leave no printable area");
  }
  return calculateBackgroundImageLayout(dataUrl, naturalWidth, naturalHeight, {
    minX: -pageWidth / 2,
    minY: -pageHeight / 2,
    maxX: pageWidth / 2,
    maxY: pageHeight / 2,
  }, crop);
}

/** A deliberately feature-local display primitive. It is mounted only by the field, preset,
 * and post-edit renderers, so the image cannot leak into generation, export, or analytics. */
export class BackgroundImageLayer {
  private readonly container: Container;
  private readonly frameContainer: Container;
  private readonly frame: Graphics;
  private sprite: Sprite | null = null;
  private fullSprite: Sprite | null = null;
  private sourceTexture: Texture | null = null;
  private dataUrl: string | null = null;
  private loadingDataUrl: string | null = null;
  private loadingImage: BackgroundImage | null = null;
  private loadingInteractive: BackgroundImageEditMode = null;
  private renderedCropKey: string | null = null;
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

  render(image: BackgroundImage | null, visible: boolean, interactive: boolean | BackgroundImageEditMode = false): void {
    const editMode: BackgroundImageEditMode = interactive === true ? "transform" : interactive || null;
    this.applyLayerOrder(image?.layer ?? "below_grid");
    if (!image || !visible) {
      this.loadToken++;
      this.loadingDataUrl = null;
      this.loadingImage = null;
      if (this.sprite) this.sprite.visible = false;
      if (this.fullSprite) this.fullSprite.visible = false;
      this.frameContainer.visible = false;
      return;
    }

    if (this.dataUrl !== image.dataUrl) {
      this.destroySprite(this.sprite);
      this.destroySprite(this.fullSprite);
      this.sourceTexture?.destroy?.();
      this.sprite = null;
      this.fullSprite = null;
      this.sourceTexture = null;
      this.dataUrl = null;
      this.loadingImage = image;
      this.loadingInteractive = editMode;
      this.frameContainer.visible = false;
      if (this.loadingDataUrl !== image.dataUrl) {
        this.loadingDataUrl = image.dataUrl;
        void this.loadSprite(image, ++this.loadToken);
      }
      return;
    }

    if (!this.sprite || !this.sourceTexture) return;
    const crop = backgroundImageCrop(image);
    const cropKey = `${crop.x}:${crop.y}:${crop.width}:${crop.height}`;
    if (this.renderedCropKey !== cropKey) {
      this.destroySprite(this.sprite);
      this.sprite = this.createSprite(this.sourceTexture.source, image);
      this.container.addChild(this.sprite);
      this.renderedCropKey = cropKey;
    }
    this.sprite.visible = true;
    this.applyLayout(this.sprite, image, editMode);
    this.applyFullLayout(image, editMode);
  }

  private async loadSprite(image: BackgroundImage, token: number): Promise<void> {
    try {
      const resource = await loadImageElement(image.dataUrl);
      if (token !== this.loadToken || this.loadingDataUrl !== image.dataUrl) return;
       const latestImage = this.loadingImage ?? image;
       const sourceTexture = Texture.from(resource, true);
       const sprite = this.createSprite(sourceTexture.source, latestImage);
       const fullSprite = this.loadingInteractive === "crop"
         ? this.createFullSprite(sourceTexture.source, resource.naturalWidth, resource.naturalHeight)
         : null;
       if (fullSprite) this.container.addChild(fullSprite);
       this.container.addChild(sprite);
       this.sprite = sprite;
       this.fullSprite = fullSprite;
       this.sourceTexture = sourceTexture;
       this.dataUrl = image.dataUrl;
       this.renderedCropKey = this.cropKey(latestImage);
       this.loadingDataUrl = null;
       this.loadingImage = null;
       sprite.visible = true;
       this.applyLayout(sprite, latestImage, this.loadingInteractive);
       this.applyFullLayout(latestImage, this.loadingInteractive);
       this.loadingInteractive = null;
    } catch {
      if (token === this.loadToken) this.loadingDataUrl = null;
    }
  }

  private createSprite(source: Texture["source"], image: BackgroundImage): Sprite {
    const crop = backgroundImageCrop(image);
    const texture = new Texture({
      source,
      frame: new Rectangle(crop.x, crop.y, crop.width, crop.height),
      orig: new Rectangle(0, 0, crop.width, crop.height),
    });
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    return sprite;
  }

  private createFullSprite(source: Texture["source"], width: number, height: number): Sprite {
    const sprite = new Sprite(new Texture({
      source,
      frame: new Rectangle(0, 0, width, height),
      orig: new Rectangle(0, 0, width, height),
    }));
    sprite.anchor.set(0.5);
    return sprite;
  }

  private applyLayout(sprite: Sprite, image: BackgroundImage, editMode: BackgroundImageEditMode): void {
    const crop = backgroundImageCrop(image);
    sprite.position.set(image.centerX, image.centerY);
    sprite.alpha = Number.isFinite(image.opacity)
      ? Math.min(1, Math.max(0, image.opacity))
      : BACKGROUND_IMAGE_ALPHA;
    sprite.scale.set(
      image.displayWidth / crop.width,
      image.displayHeight / crop.height,
    );
    this.drawFrame(image, editMode);
  }

  private applyFullLayout(image: BackgroundImage, editMode: BackgroundImageEditMode): void {
    if (editMode !== "crop") {
      if (this.fullSprite) this.fullSprite.visible = false;
      return;
    }
    if (!this.fullSprite && this.sourceTexture) {
      this.fullSprite = this.createFullSprite(this.sourceTexture.source, image.naturalWidth, image.naturalHeight);
      this.container.addChild(this.fullSprite);
      this.container.setChildIndex(this.fullSprite, 0);
    }
    if (!this.fullSprite) return;
    const scale = backgroundImageSourceScale(image);
    const center = backgroundImageFullCenter(image);
    this.fullSprite.position.set(center.x, center.y);
    this.fullSprite.alpha = (Number.isFinite(image.opacity)
      ? Math.min(1, Math.max(0, image.opacity))
      : BACKGROUND_IMAGE_ALPHA) * 0.35;
    this.fullSprite.scale.set(scale, scale);
    this.fullSprite.visible = true;
  }

  private drawFrame(image: BackgroundImage, editMode: BackgroundImageEditMode): void {
    this.frame.clear();
    if (editMode === null) {
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

  private cropKey(image: BackgroundImage): string {
    const crop = backgroundImageCrop(image);
    return `${crop.x}:${crop.y}:${crop.width}:${crop.height}`;
  }

  private destroySprite(sprite: Sprite | null): void {
    if (!sprite) return;
    const texture = (sprite as unknown as { texture?: Texture & { destroy?: () => void } }).texture;
    if (texture) texture.destroy?.();
    sprite.destroy();
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
    this.destroySprite(this.sprite);
    this.destroySprite(this.fullSprite);
    this.sprite = null;
    this.fullSprite = null;
    this.sourceTexture?.destroy?.();
    this.sourceTexture = null;
    this.dataUrl = null;
    this.loadingDataUrl = null;
    this.loadingImage = null;
    this.loadingInteractive = null;
    this.renderedCropKey = null;
    this.loadToken++;
    this.frameContainer.destroy?.({ children: true });
  }
}

/** Owns the shared underlay layer's feature-renderer wiring. */
export class BackgroundImageHost {
  private readonly layer: BackgroundImageLayer;

  constructor(containers: BackgroundImageHostContainers) {
    this.layer = new BackgroundImageLayer(
      containers.image,
      containers.floor,
      containers.grid,
      containers.layerAnchor,
    );
  }

  render(state: MazeState, visible = state.showBackgroundImage): void {
    this.layer.render(state.backgroundImage, visible, backgroundImageEditMode(state));
  }

  destroy(): void {
    this.layer.destroy();
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
