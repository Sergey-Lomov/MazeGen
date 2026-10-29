import { Container, Graphics, RenderTexture } from "pixi.js";
import type { Application, ICanvas } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { selectFloorScopedMaze } from "../selectors/mazeSelectors";
import { createModeRenderer, type ModeRenderer } from "./modeRendererFactory";
import { computeDigitalExportFit } from "./exportFit";
import { computePrintExportFit } from "./printFit";
import { resolveContentBoundsBasis } from "./exportMargins";
import { resolveCutPlan, resolveExportContent } from "./exportContent";
import { cutLineColors, cutLineStyleOf } from "./cutLineStyle";
import type { CutPlan } from "./cutLines";
import type { PngExportSettings } from "../../store/storeTypes";

/** On-screen length of one dash of a drawn cut line, and of its gap, in export pixels. */
const GUIDE_DASH_PX = 8;
const GUIDE_WIDTH_PX = 1.5;

/** Renders the active image-export render mode to a PNG `Blob`, sized/positioned by
 * `settings.outputMode` (digital canvas fit or print sheet fit — see `exportFit.ts`/
 * `printFit.ts`). Never reads or mutates the live on-screen container/renderer — builds its own
 * temporary `Container` and its own temporary mode-renderer instance (via the same
 * `createModeRenderer` factory `ImageExportRenderer` uses), renders that into an offscreen
 * `RenderTexture`, then tears both down. The on-screen canvas is not touched at any point, even
 * transiently.
 *
 * With cut lines (GitHub issue #859) the sheet is a `CutPlan` region: the scene is drawn once per
 * plan offset, each pass clipped to the region, so a cell crossing a cut appears as two parts. */
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
    const sceneRoot = new Container();
    const guides = new Graphics();
    const modeRenderer = createModeRenderer(mode, exportContainer);
    let renderTexture: RenderTexture | null = null;
    try {
      const floorNodes = selectFloorScopedMaze(state.nodes, [], state.floors, state.activeFloorId).nodes;
      const modeMargin = modeRenderer.getRequiredExportMargin();
      const plan = resolveCutPlan({
        cfg: state.activeFieldConfig,
        floorId: state.activeFloorId,
        topology: state.floorTopology[state.activeFloorId],
        cuts: settings.cuts,
        floorNodes,
        margin: () => modeMargin,
      });
      const { margin, basis } = resolveExportContent(plan, modeMargin, resolveContentBoundsBasis(mode));
      const fit = settings.outputMode === "print"
        ? toDigitalShapedFit(computePrintExportFit(state.activeFieldConfig, floorNodes, margin, settings.print, basis))
        : computeDigitalExportFit(state.activeFieldConfig, floorNodes, margin, settings.digital, basis);

      if (fit.width <= 0 || fit.height <= 0) return null;

      // The actual screen transform, same as `MazeScene.syncLayersToViewport` applies to its live
      // layers, has to be set on the container itself — `onViewportChanged` only feeds the
      // mode-renderer's own internal world-rect math (background/grid), it does not move anything.
      sceneRoot.position.set(fit.x, fit.y);
      sceneRoot.scale.set(fit.scale);
      sceneRoot.addChild(exportContainer);
      modeRenderer.onViewportChanged(fit.x, fit.y, fit.width, fit.height, fit.scale);

      renderTexture = RenderTexture.create({ width: fit.width, height: fit.height });
      const style = cutLineStyleOf(state, mode);
      const showLines = style.showCutLines;
      if (plan) {
        this.renderCutSheet(sceneRoot, exportContainer, modeRenderer, renderTexture, plan, modeRenderer.getBackgroundColor(), showLines ? cutLineColors(style, state.activeFieldConfig, state.floorTopology[state.activeFloorId]) : null, guides, fit);
      } else {
        this.app.renderer.render({ container: sceneRoot, target: renderTexture, clearColor: 0x00000000 });
      }

      const canvas = this.app.renderer.extract.canvas(renderTexture);
      return await canvasToBlob(canvas);
    } finally {
      renderTexture?.destroy(true);
      modeRenderer.destroy();
      guides.destroy();
      sceneRoot.destroy({ children: true });
    }
  }

  /** The mode's backdrop (background and grid) over the whole frame, then its content once per plan
   * offset clipped to the region, then the cut lines when asked for. */
  private renderCutSheet(
    sceneRoot: Container,
    scene: Container,
    modeRenderer: ModeRenderer,
    target: RenderTexture,
    plan: CutPlan,
    background: number,
    lineColor: ((group: number) => number) | null,
    guides: Graphics,
    fit: { width: number; height: number; scale: number },
  ): void {
    const { renderer } = this.app;
    const fill = new Container();
    fill.addChild(new Graphics().rect(0, 0, fit.width, fit.height).fill(background));
    renderer.render({ container: fill, target, clearColor: 0x00000000 });
    fill.destroy({ children: true });

    modeRenderer.setRenderPass("backdrop");
    renderer.render({ container: sceneRoot, target, clear: false });

    const mask = new Graphics();
    mask.poly(plan.region.flat()).fill(0xffffff);
    sceneRoot.addChild(mask);
    scene.mask = mask;
    modeRenderer.setRenderPass("content");
    for (const [dx, dy] of plan.offsets) {
      scene.position.set(dx, dy);
      renderer.render({ container: sceneRoot, target, clear: false });
    }
    modeRenderer.setRenderPass("full");
    scene.mask = null;
    scene.position.set(0, 0);
    sceneRoot.removeChild(mask);
    mask.destroy();

    if (!lineColor) return;
    const width = GUIDE_WIDTH_PX / fit.scale;
    const dash = GUIDE_DASH_PX / fit.scale;
    // One stroke per glue, since each takes its own colour.
    const byGroup = new Map<number, typeof plan.guides>();
    for (const guide of plan.guides) byGroup.set(guide.group, [...(byGroup.get(guide.group) ?? []), guide]);
    for (const [group, groupGuides] of byGroup) {
      for (const { from, to } of groupGuides) drawDashes(guides, from, to, dash);
      guides.stroke({ width, color: lineColor(group) });
    }
    sceneRoot.addChild(guides);
    renderer.render({ container: sceneRoot, target, clear: false });
    sceneRoot.removeChild(guides);
  }
}

function drawDashes(g: Graphics, from: [number, number], to: [number, number], dash: number): void {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length === 0) return;
  const ux = (to[0] - from[0]) / length;
  const uy = (to[1] - from[1]) / length;
  for (let at = 0; at < length; at += dash * 2) {
    const end = Math.min(at + dash, length);
    g.moveTo(from[0] + ux * at, from[1] + uy * at).lineTo(from[0] + ux * end, from[1] + uy * end);
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
