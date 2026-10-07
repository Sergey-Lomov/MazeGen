import { useMazeStore } from "../store/mazeStore";
import { resolveCells } from "../pixi/fieldEditUtils";
import {
  backgroundImageCrop,
  calculateBackgroundImageLayout,
  calculateBackgroundImagePageLayout,
  fieldBounds,
} from "../pixi/BackgroundImageLayer";
import { BackgroundImageControls } from "./BackgroundImageControls";
import { readImageFile } from "./backgroundImageFile";
import type { PageLayoutInput } from "./dialogs/BackgroundImagePrintDialog";

function currentFieldLayout() {
  const state = useMazeStore.getState();
  const field = state.floorFields[state.activeFloorId];
  const customPoints = field.fieldEditMode === "custom" && field.fieldPoints.size > 0
    ? field.fieldPoints
    : undefined;
  const cells = resolveCells(field.tessellationConfig, customPoints);
  return { bounds: fieldBounds(cells, field.tessellationConfig) };
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
      if (!bounds) return false;
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
    if (!bounds) return;
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
        field.tessellationConfig,
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
