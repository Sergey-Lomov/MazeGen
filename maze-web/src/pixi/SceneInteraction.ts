import type { Application } from "pixi.js";
import type { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { FieldEditController } from "./FieldEditController";
import type { FieldEditorOverlay } from "./FieldEditorOverlay";
import type { PointerHandler } from "./sceneTypes";
import { PanState } from "./sceneTypes";
import type { HoverInfo, HoverProvider } from "./hoverTypes";

interface SceneInteractionDeps {
  app: Application;
  viewport: Container;
  getFieldEditController: () => FieldEditController;
  fieldEditorOverlay: FieldEditorOverlay;
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

/** Wires pointer/wheel DOM events to the active feature controller, or to default viewport pan when none is active. */
export class SceneInteraction {
  private deps: SceneInteractionDeps;
  defaultPan: PanState;
  private onWheel: (e: WheelEvent) => void = () => {};
  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
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
    this.deps.onHoverChanged(null);
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
      if (st.openCard === "field_setup" && st.floorFields[st.activeFloorId].fieldEditMode === "custom") {
        const fieldEditController = getFieldEditController();
        fieldEditController.onPointerMove(e.globalX, e.globalY, e.buttons);
        const hoverCell = (st.floorFields[st.activeFloorId].fieldPrimitive === "polygon"
          || st.floorFields[st.activeFloorId].fieldPrimitive === "symmetry")
          ? null
          : fieldEditController.getHoverCell(e.globalX, e.globalY);
        fieldEditorOverlay.updateHover(fieldEditController.isGestureActive() ? null : hoverCell, st.floorFields[st.activeFloorId].tessellationConfig);
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
      controller?.cancelPointerGesture();
      controller?.clearHover?.();
      onHoverChanged(null);
      if (st.openCard === "field_setup") {
        fieldEditorOverlay.updateHover(null, st.floorFields[st.activeFloorId].tessellationConfig);
      }
      this.defaultPan.end();
    });

    stage.on("pointerleave", () => {
      const st = useMazeStore.getState();
      onHoverChanged(null);
      if (st.openCard === "field_setup") {
        fieldEditorOverlay.updateHover(null, st.floorFields[st.activeFloorId].tessellationConfig);
      }
    });

    window.addEventListener("blur", this.onBlur);
    window.addEventListener("keydown", this.onKeyDown);

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
    this.deps.app.canvas.removeEventListener("wheel", this.onWheel);
  }
}
