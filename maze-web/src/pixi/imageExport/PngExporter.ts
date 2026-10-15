import { Container, RenderTexture } from "pixi.js";
import type { Application, ICanvas } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { createModeRenderer } from "./modeRendererFactory";
import { computeDigitalExportFit } from "./exportFit";
import { computePrintExportFit } from "./printFit";
import { resolveContentBoundsBasis } from "./exportMargins";
import type { PngExportSettings } from "../../store/storeTypes";

/** Renders the active image-export render mode to a PNG `Blob`, sized/positioned by
 * `settings.outputMode` (digital canvas fit or print sheet fit — see `exportFit.ts`/
 * `printFit.ts`). Never reads or mutates the live on-screen container/renderer — builds its own
 * temporary `Container` and its own temporary mode-renderer instance (via the same
 * `createModeRenderer` factory `ImageExportRenderer` uses), renders that into an offscreen
 * `RenderTexture`, then tears both down. The on-screen canvas is not touched at any point, even
 * transiently. */
export class PngExporter {
  private exportInProgress = false;

  constructor(private readonly app: Application) {}

  async export(settings: PngExportSettings): Promise<Blob | null> {
    if (this.exportInProgress) return null;
    this.exportInProgress = true;
    try {
      return await this.doExport(settings);
    } finally {
      this.exportInProgress = false;
    }
  }

  private async doExport(settings: PngExportSettings): Promise<Blob | null> {
    const state = useMazeStore.getState();
    const mode = state.activeRenderMode;
    if (mode === null || state.nodes.length === 0) return null;
    if (state.openCard !== "image_export") return null;

    const exportContainer = new Container();
    const modeRenderer = createModeRenderer(mode, exportContainer);
    let renderTexture: RenderTexture | null = null;
    try {
      const margin = modeRenderer.getRequiredExportMargin();
      const basis = resolveContentBoundsBasis(mode);
      const fit = settings.outputMode === "print"
        ? toDigitalShapedFit(computePrintExportFit(state.activeFieldConfig, state.nodes, margin, settings.print, basis))
        : computeDigitalExportFit(state.activeFieldConfig, state.nodes, margin, settings.digital, basis);

      if (fit.width <= 0 || fit.height <= 0) return null;

      // The actual screen transform, same as `MazeScene.syncLayersToViewport` applies to its live
      // layers, has to be set on the container itself — `onViewportChanged` only feeds the
      // mode-renderer's own internal world-rect math (background/grid), it does not move anything.
      exportContainer.position.set(fit.x, fit.y);
      exportContainer.scale.set(fit.scale);
      modeRenderer.onViewportChanged(fit.x, fit.y, fit.width, fit.height, fit.scale);

      renderTexture = RenderTexture.create({ width: fit.width, height: fit.height });
      this.app.renderer.render({ container: exportContainer, target: renderTexture, clearColor: 0x00000000 });

      const canvas = this.app.renderer.extract.canvas(renderTexture);
      return await canvasToBlob(canvas);
    } finally {
      renderTexture?.destroy(true);
      modeRenderer.destroy();
      exportContainer.destroy();
    }
  }
}

function toDigitalShapedFit(printFit: ReturnType<typeof computePrintExportFit>): { width: number; height: number; x: number; y: number; scale: number } {
  return { width: printFit.sheetWidthPx, height: printFit.sheetHeightPx, x: printFit.x, y: printFit.y, scale: printFit.scale };
}

function canvasToBlob(canvas: ICanvas): Promise<Blob | null> {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/png" });
  if (canvas.toBlob) return new Promise((resolve) => canvas.toBlob!(resolve, "image/png"));
  throw new Error("canvas does not support toBlob/convertToBlob");
}
