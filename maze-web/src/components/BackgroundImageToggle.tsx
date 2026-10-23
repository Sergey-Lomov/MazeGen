import { useMazeStore } from "../store/mazeStore";
import { resolveCells } from "../pixi/fieldEditUtils";
import { TILE_SIZE } from "../pixi/constants";
import {
  backgroundImageCrop,
  calculateBackgroundImageLayout,
  calculateBackgroundImagePageLayout,
  fieldBounds,
  type FieldBounds,
} from "../pixi/BackgroundImageLayer";
import { BackgroundImageControls } from "./BackgroundImageControls";
import { readImageFile } from "./backgroundImageFile";
import type { PageLayoutInput } from "./dialogs/BackgroundImagePrintDialog";

const DEFAULT_BACKGROUND_FIELD_SIZE = TILE_SIZE * 10;

/** Underlay fitting needs a meaningful rectangle even before a custom field has any cells. */
function backgroundFieldBounds(bounds: FieldBounds | null): FieldBounds {
  const validBounds = bounds !== null
    && Object.values(bounds).every(Number.isFinite)
    && bounds.maxX >= bounds.minX
    && bounds.maxY >= bounds.minY;
  const centerX = validBounds ? (bounds.minX + bounds.maxX) / 2 : 0;
  const centerY = validBounds ? (bounds.minY + bounds.maxY) / 2 : 0;
  const width = validBounds ? bounds.maxX - bounds.minX : 0;
  const height = validBounds ? bounds.maxY - bounds.minY : 0;
  const usableWidth = Math.max(width, DEFAULT_BACKGROUND_FIELD_SIZE);
  const usableHeight = Math.max(height, DEFAULT_BACKGROUND_FIELD_SIZE);
  return {
    minX: centerX - usableWidth / 2,
    minY: centerY - usableHeight / 2,
    maxX: centerX + usableWidth / 2,
    maxY: centerY + usableHeight / 2,
  };
}

function currentFieldLayout() {
  const state = useMazeStore.getState();
  const field = state.floorFields[state.activeFloorId];
  const customPoints = field.fieldEditMode === "custom" && field.fieldPoints.size > 0
    ? field.fieldPoints
    : undefined;
  const cells = resolveCells(field.fieldConfig, customPoints);
  return { bounds: backgroundFieldBounds(fieldBounds(cells, field.fieldConfig)) };
}

export function BackgroundImageToggle() {
  const backgroundImage = useMazeStore((s) => s.backgroundImage);
  const setBackgroundImage = useMazeStore((s) => s.setBackgroundImage);
  const setPrintPaperSize = useMazeStore((s) => s.setPrintPaperSize);
  const setPrintCustomSize = useMazeStore((s) => s.setPrintCustomSize);
  const setPrintOrientation = useMazeStore((s) => s.setPrintOrientation);
  const setPrintMargins = useMazeStore((s) => s.setPrintMargins);

  async function handleFile(file: File): Promise<boolean> {
    try {
      const loaded = await readImageFile(file);
      const { bounds } = currentFieldLayout();
      const layout = calculateBackgroundImageLayout(
        loaded.dataUrl,
        loaded.width,
        loaded.height,
        bounds,
      );
      setBackgroundImage({
        ...layout,
        layer: backgroundImage?.layer ?? "below_grid",
        opacity: backgroundImage?.opacity ?? 0.5,
      });
      return true;
    } catch {
      return false;
    }
  }

  function positionToField() {
    if (!backgroundImage) return;
    const { bounds } = currentFieldLayout();
    const layout = calculateBackgroundImageLayout(
      backgroundImage.dataUrl,
      backgroundImage.naturalWidth,
      backgroundImage.naturalHeight,
      bounds,
      backgroundImageCrop(backgroundImage),
    );
    setBackgroundImage({
      ...layout,
      layer: backgroundImage.layer,
      opacity: backgroundImage.opacity,
    });
  }

  function positionToPage() {
    if (!backgroundImage) return;
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    try {
      const layout = calculateBackgroundImagePageLayout(
        backgroundImage.dataUrl,
        backgroundImage.naturalWidth,
        backgroundImage.naturalHeight,
        field.fieldConfig,
        state.pngExportSettings.print,
        backgroundImageCrop(backgroundImage),
      );
      state.setBackgroundImage({
        ...layout,
        layer: backgroundImage.layer,
        opacity: backgroundImage.opacity,
      });
    } catch {
      // Invalid persisted print settings are ignored; the existing image transform remains intact.
    }
  }

  function applyPageLayout(input: PageLayoutInput) {
    setPrintPaperSize(input.paperSize);
    setPrintCustomSize(input.customWidthMm, input.customHeightMm);
    setPrintOrientation(input.orientation);
    setPrintMargins(input.marginHMm, input.marginVMm);
    positionToPage();
  }

  return (
    <BackgroundImageControls
      onFileSelected={handleFile}
      onPositionToField={positionToField}
      onPositionToPage={positionToPage}
      onApplyPageLayout={applyPageLayout}
    />
  );
}
