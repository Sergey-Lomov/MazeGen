import { useMazeStore } from "../store/mazeStore";
import { resolveCells } from "./fieldEditUtils";
import { encodePoint } from "./tessellationProjection";
import type { FieldConfig } from "../fieldConfig";
import type { Viewport } from "./renderers/types";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/**
 * Shared subscribe/cache/destroy skeleton for feature-renderers that draw over a tessellated
 * field (PostEditRenderer, PresetConnectionsRenderer). See maze-web/CLAUDE.md's Feature-Renderer
 * ownership rule — this is the base class those two renderers share; they never share instances.
 *
 * Constructors of subclasses MUST call `this.subscribeToStore()` as their last statement, after
 * every child Container/renderer field is constructed and attached to `root`. `redrawAll`,
 * `clearAll`, and `onStoreChange` must never construct new render objects (`new Container()`,
 * `new XxxRenderer(...)`, `container.addChild(...)`) — only call `.render(...)` on objects that
 * already exist. This keeps the very first subscribe callback safe to run against fully-built
 * children, since the subscription cannot fire before the constructor that creates it returns.
 *
 * `subscribeToStore()` throws if called more than once (catches an accidental double-call), but
 * calling it too early — before child fields are constructed — is not runtime-checked; that part
 * of the contract still relies on the constructor discipline described above.
 */
export abstract class BaseFieldRenderer {
  protected viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  protected cfg: FieldConfig | null = null;
  protected cachedCells: [number, number][] = [];
  protected cachedCellSet: Set<number> = new Set();

  private unsubscribeStore: (() => void) | null = null;
  private subscribed = false;

  protected abstract isCardOpen(state: MazeState): boolean;
  protected abstract getActiveConfig(state: MazeState): FieldConfig;
  protected abstract setRootVisible(visible: boolean): void;
  protected abstract redrawAll(state: MazeState): void;
  protected abstract clearAll(): void;
  /**
   * Called only when neither `openChanged` nor an active-config change occurred this tick — those
   * two cases are handled by the base (via redrawAll/clearAll) before this hook is reached. Callers
   * may assume redrawAll was NOT already called by the base this tick; if a full redraw is needed,
   * call `this.redrawAll(state)` explicitly, or update individual layers directly.
   */
  protected abstract onStoreChange(state: MazeState, prev: MazeState): void;
  protected abstract destroyChildren(): void;

  getCachedCells(): [number, number][] {
    return this.cachedCells;
  }

  getCachedCellSet(): Set<number> {
    return this.cachedCellSet;
  }

  protected updateViewport(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
  }

  protected subscribeToStore(): void {
    if (this.subscribed) {
      throw new Error("BaseFieldRenderer.subscribeToStore() called more than once — subclass constructor must call it exactly once, as its last statement.");
    }
    this.subscribed = true;
    this.unsubscribeStore = useMazeStore.subscribe((state, prev) => {
      const isOpen = this.isCardOpen(state);
      const wasOpen = this.isCardOpen(prev);
      const openChanged = isOpen !== wasOpen;

      if (openChanged) {
        this.setRootVisible(isOpen);
        if (isOpen) {
          this.cfg = this.getActiveConfig(state);
          this.rebuildCellCache(state);
          this.redrawAll(state);
        } else {
          this.clearAll();
        }
      }
      if (!isOpen) return;

      const activeConfig = this.getActiveConfig(state);
      if (activeConfig !== this.getActiveConfig(prev)) {
        this.cfg = activeConfig;
        this.rebuildCellCache(state);
        this.redrawAll(state);
        return;
      }

      this.onStoreChange(state, prev);
    });
  }

  protected rebuildCellCache(state: MazeState): void {
    if (!this.cfg) return;
    const field = state.floorFields[state.activeFloorId];
    const customPts = field.fieldEditMode === "custom" && field.fieldPoints.size > 0
      ? field.fieldPoints : undefined;
    this.cachedCells = resolveCells(this.cfg, customPts);
    this.cachedCellSet = new Set(this.cachedCells.map(([x, y]) => encodePoint(x, y)));
  }

  destroy(): void {
    this.unsubscribeStore?.();
    this.destroyChildren();
  }
}
