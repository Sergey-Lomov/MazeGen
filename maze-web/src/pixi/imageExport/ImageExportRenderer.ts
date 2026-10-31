import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { createModeRenderer, type ModeRenderer } from "./modeRendererFactory";
import type { RenderModeId } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import { SeamArrowLayer } from "../seamArrowSync";
import { seamArrowsShown } from "../SeamHoverTracker";
import { NO_MARGIN, resolveActiveCutPlan } from "./exportContent";

type CopyLayer = "content" | "overlay" | "highlight";
const COPY_LAYERS: readonly CopyLayer[] = ["content", "overlay", "highlight"];

/** One shifted copy of the mode's picture on the cut sheet: a renderer building the geometry once, whose content and
 *  overlay layers sit in the sheet's shared layers, each inside its own holder that carries the copy's offset. */
interface SheetCopy {
  /** Detached: only holds the copy's backdrop, which is never shown. */
  root: Container;
  renderer: ModeRenderer;
  holders: Container[];
}

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** What the cut sheet is built from: when none of these changed, the plan is the same. */
function cutInputs(state: MazeState): unknown[] {
  return [
    state.openCard, state.activeRenderMode, state.nodes, state.floors, state.activeFloorId,
    state.activeFieldConfig, state.floorTopology, state.pngExportSettings.cuts,
    // The mode's margin, which the sheet's region keeps around the field, follows its settings.
    state.vectorByWallsSettings, state.vectorByCorridorsSettings,
  ];
}

/** Owns the Image Export feature's rendering modes (GitHub issue #287). Exactly one mode
 * renderer is active at a time, matching `activeRenderMode` — each mode gets its own container
 * and its own renderer instance (never shared across modes, following the same feature-renderer
 * ownership rule this ownership boundary itself exists to enforce, just one level down: one
 * renderer per mode instead of one renderer per feature). Adding a new mode means adding one
 * entry to `createModeRenderer` and one `RenderModeId` variant — no other change here.
 *
 * With cut lines (GitHub issue #859) the canvas shows the sheet as it will be exported: the active
 * mode's own renderer draws only the backdrop (background and grid) over the whole canvas, and its
 * content and then its overlay are drawn once per `CutPlan` offset by further instances of the same mode
 * renderer, shifted and clipped to the plan's region, all contents below all overlays (GitHub issue #888).
 * It also owns the seam arrow layer, above everything: the glues of the active floor, shown only
 * while the export topology panel is open and never part of an exported image. */
export class ImageExportRenderer implements ViewportListener {
  private readonly container: Container;
  /** The copies of the cut sheet, masked by the cut region. */
  private readonly sheet = new Container();
  /** One layer per kind, stacked in order, each holding that layer of every copy: all contents below all overlays (GitHub issue #888). */
  private readonly layers: Record<CopyLayer, Container> = { content: new Container(), overlay: new Container(), highlight: new Container() };
  private readonly mask = new Graphics();
  private readonly modeContainers = new Map<RenderModeId, Container>();
  private readonly modeRenderers = new Map<RenderModeId, ModeRenderer>();
  private copies: SheetCopy[] = [];
  private copiesMode: RenderModeId | null = null;
  /** The mode whose own renderer is currently reduced to the backdrop. */
  private cutMode: RenderModeId | null = null;
  private lastCutInputs: unknown[] = [];
  private readonly seamArrowContainer = new Container();
  private readonly seamLayer: SeamArrowLayer;
  private unsubscribe: (() => void) | null = null;
  private lastViewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

  constructor(container: Container) {
    this.container = container;
    this.container.addChild(this.sheet);
    for (const layer of COPY_LAYERS) this.sheet.addChild(this.layers[layer]);
    this.container.addChild(this.mask);
    this.container.addChild(this.seamArrowContainer);
    this.seamLayer = new SeamArrowLayer(this.seamArrowContainer);
    this.seamArrowContainer.visible = seamArrowsShown(useMazeStore.getState());
    const initialMode = useMazeStore.getState().activeRenderMode;
    if (initialMode) this.ensureMode(initialMode);
    this.syncVisibility(initialMode);
    this.syncCutSheet(useMazeStore.getState());
    this.subscribe();
  }

  private ensureMode(mode: RenderModeId): void {
    if (this.modeRenderers.has(mode)) return;
    const modeContainer = new Container();
    this.container.addChildAt(modeContainer, this.container.getChildIndex(this.sheet));
    this.modeContainers.set(mode, modeContainer);
    this.modeRenderers.set(mode, createModeRenderer(mode, modeContainer));
  }

  /** The live mode-renderer instance for `mode`, if one has ever been constructed (`ensureMode`
   *  builds one the first time a mode becomes active — never eagerly for every registered mode).
   *  Lets a caller outside this class (`ExportFrameOverlay`, GitHub issue #324 follow-up) read a
   *  pixel-accurate margin (`ModeRenderer.getRequiredExportMargin()`) off the same already-
   *  rendered instance the on-screen canvas itself uses, instead of re-deriving an approximation of
   *  it via a Pixi-free pure function. */
  getModeRenderer(mode: RenderModeId): ModeRenderer | undefined {
    return this.modeRenderers.get(mode);
  }

  private syncVisibility(activeMode: RenderModeId | null): void {
    for (const [mode, modeContainer] of this.modeContainers) {
      modeContainer.visible = mode === activeMode;
    }
  }

  private destroyCopies(): void {
    for (const copy of this.copies) {
      copy.renderer.destroy();
      for (const holder of copy.holders) holder.destroy({ children: true });
      copy.root.destroy({ children: true });
    }
    this.copies = [];
    this.copiesMode = null;
  }

  /** Back to the whole picture; the backdrop skipped drawing while it was a content copy, so redraw for the viewport. */
  private restoreFullPass(mode: RenderModeId): void {
    const renderer = this.modeRenderers.get(mode);
    if (!renderer) return;
    renderer.setRenderPass("full");
    const { x, y, w, h, scale } = this.lastViewport;
    renderer.onViewportChanged(x, y, w, h, scale);
  }

  /** A copy of `mode`'s picture without its backdrop, whose content and overlay are moved into the sheet's shared layers. */
  private createCopy(mode: RenderModeId): SheetCopy {
    const root = new Container();
    const renderer = createModeRenderer(mode, root);
    renderer.setRenderPass("foreground");
    const { x, y, w, h, scale } = this.lastViewport;
    renderer.onViewportChanged(x, y, w, h, scale);
    const holders = COPY_LAYERS.map((layer) => {
      const holder = new Container();
      holder.addChild(renderer.layers[layer]);
      this.layers[layer].addChild(holder);
      return holder;
    });
    return { root, renderer, holders };
  }

  /** Brings the canvas in line with the cut plan: the region mask and the shifted content copies of the
   *  active mode, while the mode's own renderer keeps only the backdrop. */
  private syncCutSheet(state: MazeState): void {
    const inputs = cutInputs(state);
    const unchanged = inputs.every((value, i) => value === this.lastCutInputs[i]);
    this.lastCutInputs = inputs;
    if (unchanged) return;
    const mode = state.activeRenderMode;
    const plan = resolveActiveCutPlan(state, () => (mode ? this.modeRenderers.get(mode)?.getRequiredExportMargin() : undefined) ?? NO_MARGIN);
    if (this.cutMode !== mode) {
      if (this.cutMode) this.restoreFullPass(this.cutMode);
      this.cutMode = null;
    }
    if (!plan || mode === null) {
      this.sheet.mask = null;
      this.mask.clear();
      this.destroyCopies();
      if (mode) this.restoreFullPass(mode);
      return;
    }

    this.mask.clear();
    this.mask.poly(plan.region.flat()).fill(0xffffff);
    this.sheet.mask = this.mask;
    this.modeRenderers.get(mode)?.setRenderPass("backdrop");
    this.cutMode = mode;

    if (this.copiesMode !== mode || this.copies.length !== plan.offsets.length) {
      this.destroyCopies();
      for (let i = 0; i < plan.offsets.length; i++) this.copies.push(this.createCopy(mode));
      this.copiesMode = mode;
    }
    this.copies.forEach((copy, i) => copy.holders.forEach((holder) => holder.position.set(...plan.offsets[i])));
  }

  private subscribe(): void {
    let prevMode = useMazeStore.getState().activeRenderMode;
    this.unsubscribe = useMazeStore.subscribe((state) => {
      this.seamArrowContainer.visible = seamArrowsShown(state);
      if (state.activeRenderMode !== prevMode) {
        prevMode = state.activeRenderMode;
        if (prevMode) this.ensureMode(prevMode);
        this.syncVisibility(prevMode);
        if (prevMode) {
          this.modeRenderers.get(prevMode)?.onViewportChanged(
            this.lastViewport.x, this.lastViewport.y, this.lastViewport.w, this.lastViewport.h, this.lastViewport.scale,
          );
        }
      }
      this.syncCutSheet(state);
    });
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.lastViewport = { x, y, w, h, scale };
    const activeMode = useMazeStore.getState().activeRenderMode;
    if (activeMode) this.modeRenderers.get(activeMode)?.onViewportChanged(x, y, w, h, scale);
    for (const copy of this.copies) copy.renderer.onViewportChanged(x, y, w, h, scale);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.seamLayer.destroy();
    this.seamArrowContainer.destroy();
    this.destroyCopies();
    for (const renderer of this.modeRenderers.values()) renderer.destroy();
    for (const modeContainer of this.modeContainers.values()) modeContainer.destroy();
    this.sheet.mask = null;
    this.mask.destroy();
    this.sheet.destroy({ children: true });
  }
}
