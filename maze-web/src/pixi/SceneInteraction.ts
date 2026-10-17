import type { Application } from "pixi.js";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { FieldEditController } from "./FieldEditController";
import type { FieldEditorOverlay } from "./FieldEditorOverlay";
import { backgroundImageEditMode, PanState } from "./sceneTypes";
import type { PointerHandler } from "./sceneTypes";
import type { HoverInfo, HoverProvider } from "./hoverTypes";
import { canvas } from "./colorTokens";

interface SceneInteractionDeps {
  app: Application;
  viewport: Container;
  getFieldEditController: () => FieldEditController;
  fieldEditorOverlay: FieldEditorOverlay;
  getBackgroundImageCursor?: (canvasX: number, canvasY: number) => string;
  getController: (st: ReturnType<typeof useMazeStore.getState>) => PointerHandler | null;
  getHoverProvider: (st: ReturnType<typeof useMazeStore.getState>) => HoverProvider;
  onHoverChanged: (info: HoverInfo | null) => void;
  onViewportChanged: () => void;
  onResetZoom: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function setCanvasCursor(canvas: HTMLCanvasElement, cursor: string): void {
  if (canvas.style) canvas.style.cursor = cursor;
}

/** Wires pointer/wheel DOM events to the active feature controller, or to default viewport pan when none is active. */
export class SceneInteraction {
  private deps: SceneInteractionDeps;
  defaultPan: PanState;
  private onWheel: (e: WheelEvent) => void = () => {};
  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const state = useMazeStore.getState();
    if (state.floorLabelDrag !== null
      && (e.code === "Escape" || e.code === "Enter" || e.code === "Space")) {
      e.preventDefault();
      if (e.code === "Escape") state.cancelFloorLabelDrag();
      else state.finishFloorLabelDrag();
      this.deps.getController(state)?.cancelPointerGesture();
      return;
    }
    if (backgroundImageEditMode(state) !== null
      && (e.code === "Escape" || e.code === "Enter" || e.code === "Space")) {
      e.preventDefault();
      exitBackgroundImageMode(state);
      this.deps.getController(state)?.cancelPointerGesture();
      return;
    }
    if (e.shiftKey && e.code === "Digit1" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.deps.onResetZoom();
    }
  };

  private onBlur = () => {
    const st = useMazeStore.getState();
    const controller = this.deps.getController(st);
    this.defaultPan.end();
    controller?.cancelPointerGesture();
    controller?.clearHover?.();
    setCanvasCursor(this.deps.app.canvas, "");
    this.deps.onHoverChanged(null);
  };

  /** DOM pointerleave is the reliable boundary when moving directly from canvas to a side panel. */
  private onPointerLeave = () => {
    const st = useMazeStore.getState();
    this.deps.getController(st)?.clearHover?.();
    this.deps.onHoverChanged(null);
    setCanvasCursor(this.deps.app.canvas, "");
    if (st.openCard === "field_setup") {
      this.deps.fieldEditorOverlay.updateHover(null, st.floorFields[st.activeFloorId].tessellationConfig);
    }
  };

  private onWindowPointerDown = (e: PointerEvent) => {
    const state = useMazeStore.getState();
    if (state.floorLabelDrag !== null && !this.isInsideCanvas(e.target)) {
      const target = e.target as Element | null;
      if (!target?.closest?.("[data-floor-label-drag-control]")) {
        const controller = this.deps.getController(state);
        state.finishFloorLabelDrag();
        controller?.cancelPointerGesture();
        setCanvasCursor(this.deps.app.canvas, "");
      }
      return;
    }
    if (backgroundImageEditMode(state) === null || this.isInsideCanvas(e.target)) return;
    // Mode buttons live in the side panel, outside the canvas. Let their click handlers
    // toggle the current mode; otherwise this capture listener would disable the mode on
    // pointerdown and the button's onClick would immediately enable it again.
    const target = e.target as Element | null;
    if (target?.closest?.("[data-background-image-mode-control]")) return;
    const controller = this.deps.getController(state);
    exitBackgroundImageMode(state);
    controller?.cancelPointerGesture();
    setCanvasCursor(this.deps.app.canvas, "");
  };

  constructor(deps: SceneInteractionDeps) {
    this.deps = deps;
    const { viewport, onViewportChanged } = deps;
    this.defaultPan = new PanState(
      () => ({ x: viewport.x, y: viewport.y }),
      (x, y) => {
        viewport.x = x;
        viewport.y = y;
        onViewportChanged();
      },
    );
    this.setup();
  }

  private setup(): void {
    const { app, viewport, getFieldEditController, fieldEditorOverlay, getController, getHoverProvider, onHoverChanged, onViewportChanged } = this.deps;
    const stage = app.stage;
    stage.interactive = true;
    stage.hitArea = app.screen;

    stage.on("pointerdown", (e) => {
      const st = useMazeStore.getState();
      const controller = getController(st);
      const backgroundEditActive = backgroundImageEditMode(st) !== null;
      if (backgroundEditActive && e.button === 1) {
        this.defaultPan.begin(e.globalX, e.globalY);
        return;
      }
      if (controller) {
        controller.onPointerDown(e.globalX, e.globalY, e.button, e.shiftKey, e.detail);
        if (st.openCard === "field_setup" && st.floorFields[st.activeFloorId].fieldEditMode === "custom") {
          fieldEditorOverlay.updateHover(null, st.floorFields[st.activeFloorId].tessellationConfig);
        }
        return;
      }
      this.defaultPan.begin(e.globalX, e.globalY);
    });

    stage.on("pointermove", (e) => {
      const st = useMazeStore.getState();
      onHoverChanged(getHoverProvider(st).getHoverInfo(e.globalX, e.globalY));
      const backgroundEditActive = backgroundImageEditMode(st) !== null;
      if (backgroundEditActive && (e.buttons & 4) !== 0) {
        setCanvasCursor(app.canvas, "grabbing");
        this.defaultPan.move(e.globalX, e.globalY);
        return;
      }
      // Manual underlay positioning owns pointer movement even on the custom-field card, whose
      // normal pointer path otherwise takes precedence for cell editing.
      if (backgroundImageEditMode(st) !== null) {
        setCanvasCursor(app.canvas, this.deps.getBackgroundImageCursor?.(e.globalX, e.globalY) ?? "move");
        getController(st)?.onPointerMove(e.globalX, e.globalY, e.buttons, e.shiftKey);
        return;
      }
      setCanvasCursor(app.canvas, "");
      if (st.openCard === "field_setup" && st.floorFields[st.activeFloorId].fieldEditMode === "custom") {
        const fieldEditController = getFieldEditController();
        fieldEditController.onPointerMove(e.globalX, e.globalY, e.buttons);
        const field = st.floorFields[st.activeFloorId];
        const hoverCell = (field.fieldPrimitive === "polygon"
          || field.fieldPrimitive === "symmetry")
          ? null
          : field.fieldPrimitive === "magic_wand"
            ? fieldEditController.getMagicWandPreview(e.globalX, e.globalY)
            : fieldEditController.getHoverCell(e.globalX, e.globalY);
        const hoverColor = field.fieldOperation === "remove"
          ? canvas.fieldEditor.previewRemove
          : field.fieldOperation === "select" ? canvas.fieldEditor.previewSelect : canvas.fieldEditor.previewAdd;
        fieldEditorOverlay.updateHover(
          fieldEditController.isGestureActive() || fieldEditController.hasSelectionPreview?.() ? null : hoverCell,
          field.tessellationConfig,
          hoverColor,
          field.fieldPrimitive === "magic_wand" ? 0.5 : undefined,
        );
        return;
      }
      const controller = getController(st);
      if (controller) {
        controller.onPointerMove(e.globalX, e.globalY);
        return;
      }
      this.defaultPan.move(e.globalX, e.globalY);
    });

    stage.on("pointertap", (e) => {
      if (e.detail < 2) return;
      const st = useMazeStore.getState();
      const field = st.floorFields[st.activeFloorId];
      if (!(st.openCard === "field_setup"
        && field.fieldEditMode === "custom"
        && (field.fieldPrimitive === "polygon"
          || (field.fieldPrimitive === "symmetry" && st.symmetryAxisPoints.length === 2 && st.symmetryScope === "polygon")))) return;
      getFieldEditController().onDoubleClick(e.globalX, e.globalY, e.button);
    });

    stage.on("pointerup", (e) => {
      const st = useMazeStore.getState();
      const backgroundEditActive = backgroundImageEditMode(st) !== null;
      if (backgroundEditActive && e.button === 1) {
        this.defaultPan.end();
        return;
      }
      const controller = getController(st);
      if (controller) {
        controller.onPointerUp(e.button);
        return;
      }
      this.defaultPan.end();
    });
    stage.on("pointerupoutside", () => {
      const st = useMazeStore.getState();
      const controller = getController(st);
      const fieldEditController = getFieldEditController();
      const field = st.floorFields[st.activeFloorId];
      if (st.openCard === "field_setup"
        && field.fieldEditMode === "custom"
        && fieldEditController.hasSelectionPreview()) {
        // Releasing the mouse outside the canvas is a confirmation boundary for a
        // persistent selection, not a cancellation of its pending move.
        fieldEditController.commitPendingSelectionMove();
      } else {
        controller?.cancelPointerGesture();
      }
      controller?.clearHover?.();
      onHoverChanged(null);
      setCanvasCursor(app.canvas, "");
      if (st.openCard === "field_setup") {
        fieldEditorOverlay.updateHover(null, st.floorFields[st.activeFloorId].tessellationConfig);
      }
      this.defaultPan.end();
    });

    window.addEventListener("blur", this.onBlur);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("pointerdown", this.onWindowPointerDown, true);
    app.canvas.addEventListener("pointerleave", this.onPointerLeave);

    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = app.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      viewport.x = mouseX + (viewport.x - mouseX) * factor;
      viewport.y = mouseY + (viewport.y - mouseY) * factor;
      viewport.scale.x *= factor;
      viewport.scale.y *= factor;
      onViewportChanged();
    };
    app.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  destroy(): void {
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    this.deps.app.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.deps.app.canvas.removeEventListener("wheel", this.onWheel);
    setCanvasCursor(this.deps.app.canvas, "");
  }

  private isInsideCanvas(target: EventTarget | null): boolean {
    if (target === this.deps.app.canvas) return true;
    const contains = (this.deps.app.canvas as unknown as { contains?: (node: Node) => boolean }).contains;
    return typeof contains === "function" && target instanceof Node && contains.call(this.deps.app.canvas, target);
  }
}

function exitBackgroundImageMode(state: ReturnType<typeof useMazeStore.getState>): void {
  if (state.backgroundImageCropping) state.setBackgroundImageCropping(false);
  else state.setBackgroundImageManualPositioning(false);
}
