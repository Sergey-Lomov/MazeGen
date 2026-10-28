import { describe, it, expect, vi } from "vitest";
import type { Container } from "pixi.js";
import { canvasToGrid, DefaultHoverProvider } from "../pixi/hoverProviders";
import { makeProjection } from "../pixi/tessellationProjection";
import type { TessellationProjection } from "../pixi/tessellationProjection";
import { TILE_SIZE } from "../pixi/constants";
import { MazeScene, shouldCancelFieldEditGesture, TESSELLATION_CONFIG_BY_CARD } from "../pixi/MazeScene";
import { SceneInteraction } from "../pixi/SceneInteraction";
import { useMazeStore } from "../store/mazeStore";
import { fieldOf } from "./fieldConfigFixtures";

function fakeViewport(x: number, y: number, scale = 1): Container {
  return { x, y, scale: { x: scale, y: scale } } as unknown as Container;
}

const squareProjection = makeProjection(fieldOf("square", { shape: "rect", cols: 10, rows: 10 }));

describe("canvasToGrid", () => {
  it("maps canvas origin through viewport offset to grid coords", () => {
    const vp = fakeViewport(0, 0);
    expect(canvasToGrid(TILE_SIZE / 2, -TILE_SIZE / 2, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });

  it("accounts for viewport pan offset", () => {
    const vp = fakeViewport(100, 100);
    expect(canvasToGrid(100 + TILE_SIZE / 2, 100 - TILE_SIZE / 2, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });

  it("accounts for viewport zoom scale", () => {
    const vp = fakeViewport(0, 0, 2);
    expect(canvasToGrid(TILE_SIZE, -TILE_SIZE, vp, squareProjection)).toEqual({ x: 0, y: 0 });
  });
});

describe("DefaultHoverProvider", () => {
  it("returns null when no projection is available", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => null);
    expect(provider.getHoverInfo(0, 0)).toBeNull();
  });

  it("returns grid coords when projection is available", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => squareProjection);
    expect(provider.getHoverInfo(TILE_SIZE / 2, -TILE_SIZE / 2)).toEqual({ x: 0, y: 0 });
  });

  it("returns coords even far outside typical field bounds", () => {
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => squareProjection);
    const far = provider.getHoverInfo(TILE_SIZE * 1000.5, -TILE_SIZE * 1000.5);
    expect(far).toEqual({ x: 1000, y: 1000 });
  });

  it("re-queries the projection getter on every call", () => {
    let current: TessellationProjection | null = null;
    const provider = new DefaultHoverProvider(() => fakeViewport(0, 0), () => current);
    expect(provider.getHoverInfo(0, 0)).toBeNull();
    current = squareProjection;
    expect(provider.getHoverInfo(TILE_SIZE / 2, -TILE_SIZE / 2)).toEqual({ x: 0, y: 0 });
  });
});

describe("field edit gesture cancellation", () => {
  it("keeps a point brush gesture alive when adding a cell rebuilds the config", () => {
    const pointUpdate = {
      openChanged: false,
      floorChanged: false,
      modeChanged: false,
      primitiveChanged: false,
      operationChanged: false,
      configChanged: true,
      fieldPointsChanged: true,
      fieldEditMode: "custom",
      fieldPrimitive: "point",
    } as const;
    expect(shouldCancelFieldEditGesture(pointUpdate)).toBe(false);
    expect(shouldCancelFieldEditGesture({ ...pointUpdate, operationChanged: true }), "operation update").toBe(true);

    for (const change of ["openChanged", "floorChanged", "modeChanged", "primitiveChanged"] as const) {
      expect(shouldCancelFieldEditGesture({ ...pointUpdate, [change]: true }), change).toBe(true);
    }
    expect(shouldCancelFieldEditGesture({ ...pointUpdate, fieldPointsChanged: false }), "config-only change").toBe(true);
    expect(shouldCancelFieldEditGesture({ ...pointUpdate, fieldPrimitive: "rectangle" }), "shape primitive update").toBe(true);
    expect(shouldCancelFieldEditGesture({ ...pointUpdate, fieldEditMode: "default" }), "default-mode update").toBe(true);
    expect(shouldCancelFieldEditGesture({
      ...pointUpdate,
      configChanged: false,
      fieldPointsChanged: false,
    }), "unrelated state update").toBe(false);
  });
});

describe("zoom reset controls", () => {

  it("resolves the tessellation config for every feature card", () => {
    const state = useMazeStore.getState();
    const floorConfig = state.floorFields[state.activeFloorId].fieldConfig;

    expect(TESSELLATION_CONFIG_BY_CARD.basic_config(state)).toBe(state.previewFieldConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.floors(state)).toBe(floorConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.field_setup(state)).toBe(floorConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.preset_connections(state)).toBe(floorConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.quality(state)).toBe(floorConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.generation(state)).toBe(state.activeFieldConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.post_edit(state)).toBe(state.activeFieldConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.analytics(state)).toBe(state.activeFieldConfig);
    expect(TESSELLATION_CONFIG_BY_CARD.image_export(state)).toBe(state.activeFieldConfig);
  });

  it("syncs layer transforms, viewport listeners, and the scale listener", () => {
    const layer = { x: 0, y: 0, scale: { x: 1, y: 1 } };
    const viewportListener = { onViewportChanged: vi.fn() };
    const viewportScaleListener = vi.fn();
    const scene = {
      viewport: { x: 12, y: -7, scale: { x: 2.5, y: 2.5 } },
      syncedLayers: [layer],
      viewportListeners: [viewportListener],
      viewportScaleCallback: viewportScaleListener,
      app: { screen: { width: 800, height: 600 } },
      renderScheduler: { requestRender: vi.fn() },
    } as unknown as MazeScene;

    (MazeScene.prototype as any).syncLayersToViewport.call(scene);

    expect(layer).toEqual({ x: 12, y: -7, scale: { x: 2.5, y: 2.5 } });
    expect(viewportListener.onViewportChanged).toHaveBeenCalledWith(12, -7, 800, 600, 2.5);
    expect(viewportScaleListener).toHaveBeenCalledWith(2.5);
    expect((scene as any).renderScheduler.requestRender).toHaveBeenCalled();
  });

  it("resizes the renderer to a new device pixel ratio and skips an unchanged one", () => {
    const resize = vi.fn();
    const requestRender = vi.fn();
    const scene = {
      app: { screen: { width: 800, height: 600 }, renderer: { resolution: 1, resize } },
      renderScheduler: { requestRender },
    } as unknown as MazeScene;
    const apply = (dpr: number) => (MazeScene.prototype as any).applyDevicePixelRatio.call(scene, dpr);

    apply(1);
    expect(resize).not.toHaveBeenCalled();
    apply(2);
    expect(resize).toHaveBeenCalledWith(800, 600, 2);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("keeps only one hover and viewport-scale listener and notifies replacements", () => {
    const oldHover = vi.fn();
    const newHover = vi.fn();
    const oldScale = vi.fn();
    const newScale = vi.fn();
    const scene = {
      hoverCallback: oldHover,
      viewportScaleCallback: null,
      viewport: { scale: { x: 1.75 } },
    } as unknown as MazeScene;

    MazeScene.prototype.setHoverListener.call(scene, oldHover);
    expect(oldHover).not.toHaveBeenCalled();
    MazeScene.prototype.setHoverListener.call(scene, newHover);
    expect(oldHover).toHaveBeenCalledWith(null);
    MazeScene.prototype.setHoverListener.call(scene, newHover);
    expect(oldHover).toHaveBeenCalledTimes(1);

    MazeScene.prototype.setViewportScaleListener.call(scene, oldScale);
    expect(oldScale).toHaveBeenCalledWith(1.75);
    MazeScene.prototype.setViewportScaleListener.call(scene, newScale);
    expect(newScale).toHaveBeenCalledWith(1.75);
    MazeScene.prototype.setViewportScaleListener.call(scene, newScale);
    expect(newScale).toHaveBeenCalledTimes(1);
  });

  it("clears a replaced field-size listener and ignores re-registration", () => {
    const oldSize = vi.fn();
    const newSize = vi.fn();
    const current = { selection: { width: 2, height: 1, count: 2 }, shape: null };
    const scene = { fieldSizeCallback: null, fieldSizeReadout: current } as unknown as MazeScene;

    MazeScene.prototype.setFieldSizeListener.call(scene, oldSize);
    expect(oldSize).toHaveBeenCalledWith(current);
    MazeScene.prototype.setFieldSizeListener.call(scene, newSize);
    expect(oldSize).toHaveBeenLastCalledWith({ selection: null, shape: null });
    expect(newSize).toHaveBeenCalledWith(current);
    MazeScene.prototype.setFieldSizeListener.call(scene, newSize);
    expect(newSize).toHaveBeenCalledTimes(1);
  });

  it("sets the viewport transform and exposes its current scale", () => {
    const syncLayersToViewport = vi.fn();
    const viewport = {
      x: 0,
      y: 0,
      scale: { x: 1, y: 1, set: vi.fn(function (this: { x: number; y: number }, value: number) { this.x = value; this.y = value; }) },
    };
    const scene = { viewport, syncLayersToViewport } as unknown as MazeScene;

    MazeScene.prototype.setViewportTransform.call(scene, 30, 40, 1.25);

    expect(viewport.x).toBe(30);
    expect(viewport.y).toBe(40);
    expect(viewport.scale.set).toHaveBeenCalledWith(1.25);
    expect(MazeScene.prototype.getViewportScale.call(scene)).toBe(1.25);
    expect(syncLayersToViewport).toHaveBeenCalledOnce();
  });

  it("routes each interactive card to its controller and falls back to default pan", () => {
    const state = useMazeStore.getState();
    const controllers = {
      field: {},
      preset: {},
      post: {},
    };
    const scene = {
      fieldEditController: controllers.field,
      presetConnectionsController: controllers.preset,
      postEditController: controllers.post,
    } as unknown as MazeScene;
    const customFieldState = {
      ...state,
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...state.floorFields[state.activeFloorId], fieldEditMode: "custom" },
      },
    };

    expect((MazeScene.prototype as any).getController.call(scene, { ...customFieldState, openCard: "field_setup" } as never)).toBe(controllers.field);
    expect((MazeScene.prototype as any).getController.call(scene, { ...state, openCard: "preset_connections" } as never)).toBe(controllers.preset);
    expect((MazeScene.prototype as any).getController.call(scene, { ...state, openCard: "post_edit" } as never)).toBe(controllers.post);
    expect((MazeScene.prototype as any).getController.call(scene, { ...state, openCard: "generation" } as never)).toBeNull();
    expect((MazeScene.prototype as any).getController.call(scene, {
      ...state,
      openCard: "field_setup",
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...state.floorFields[state.activeFloorId], fieldEditMode: "default" },
      },
    } as never)).toBeNull();
  });

  it("samples rendered pixels in physical canvas coordinates and rejects outside points", () => {
    const pixels = new Uint8Array([1, 2, 3, 255]);
    const extract = {
      pixels: vi.fn(({ frame }: { frame: { width: number } }) => ({
        pixels,
        width: frame.width > 1 ? 5 : 1,
        height: frame.width > 1 ? 5 : 1,
      })),
    };
    const canvas = {
      width: 200,
      height: 100,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    };
    const scene = {
      app: { canvas, renderer: { resolution: 2, extract }, stage: {} },
      clientToCanvasPx: (MazeScene.prototype as any).clientToCanvasPx,
    } as unknown as MazeScene;

    expect(MazeScene.prototype.sampleColorAt.call(scene, 5, 25)).toBeNull();
    expect(MazeScene.prototype.sampleColorAt.call(scene, 35, 45)).toBe(0x010203);
    expect(extract.pixels).toHaveBeenCalledWith(expect.objectContaining({ frame: expect.anything() }));

    const region = MazeScene.prototype.sampleRegionAt.call(scene, 35, 45, 2);
    expect(region).toEqual({ pixels, width: 5, height: 5, centerX: 2, centerY: 2 });
    expect(MazeScene.prototype.sampleRegionAt.call(scene, 5, 25, 2)).toBeNull();
  });

  it("handles no-op zoom resets and forwards print zoom and resize notifications", () => {
    const syncLayersToViewport = vi.fn();
    const resize = vi.fn();
    const notifyExternalResize = vi.fn();
    const applyViewportScaleAroundFrameCentre = vi.fn();
    const viewport = {
      x: 20,
      y: 30,
      scale: { x: 1, y: 1, set: vi.fn() },
    };
    const scene = {
      app: { screen: { width: 100, height: 100 }, resize },
      viewport,
      syncLayersToViewport,
      exportFrameOverlay: { notifyExternalResize, applyViewportScaleAroundFrameCentre },
    } as unknown as MazeScene;

    MazeScene.prototype.resetZoomToOne.call(scene);
    expect(syncLayersToViewport).not.toHaveBeenCalled();
    MazeScene.prototype.applyPrintPhysicalZoom.call(scene, 1.5);
    expect(applyViewportScaleAroundFrameCentre).toHaveBeenCalledWith(1.5);
    MazeScene.prototype.notifyScreenResized.call(scene);
    expect(resize).toHaveBeenCalledOnce();
    expect(syncLayersToViewport).toHaveBeenCalledOnce();
    expect(notifyExternalResize).toHaveBeenCalledOnce();
  });

  it("caches projections, exposes the canvas, and forwards PNG export", async () => {
    const canvas = {} as HTMLCanvasElement;
    const pngExporter = { export: vi.fn().mockResolvedValue(new Blob(["png"])) };
    const scene = { cachedProjection: null, pngExporter, app: { canvas } } as unknown as MazeScene;
    const cfg = fieldOf("square", { shape: "rect", cols: 2, rows: 2 });

    const first = (MazeScene.prototype as any).getProjectionFor.call(scene, cfg);
    expect((MazeScene.prototype as any).getProjectionFor.call(scene, cfg)).toBe(first);
    expect((MazeScene.prototype as any).getProjectionFor.call(scene, { ...cfg, width: 3 })).not.toBe(first);
    expect(Object.getOwnPropertyDescriptor(MazeScene.prototype, "canvas")?.get?.call(scene)).toBe(canvas);
    await expect(MazeScene.prototype.exportPng.call(scene, { } as never)).resolves.toBeInstanceOf(Blob);
    expect(pngExporter.export).toHaveBeenCalledOnce();
  });

  it("does not highlight a hover cell for the polygon field tool", () => {
    const stageHandlers: Record<string, (event?: any) => void> = {};
    const state = useMazeStore.getState();
    const activeField = state.floorFields[state.activeFloorId];
    useMazeStore.setState({
      openCard: "field_setup",
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...activeField, fieldEditMode: "custom", fieldPrimitive: "polygon" },
      },
    });

    const updateHover = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: (event?: any) => void) => { stageHandlers[event] = handler; }),
        },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({
        onPointerMove: vi.fn(),
        getHoverCell: vi.fn(() => [2, 3]),
        isGestureActive: vi.fn(() => false),
        hasSelectionPreview: vi.fn(() => false),
      }) as any,
      fieldEditorOverlay: { updateHover } as any,
      getController: () => null,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointermove?.({ globalX: 10, globalY: 10, buttons: 0 });

    expect(updateHover).toHaveBeenCalledWith(null, activeField.fieldConfig, expect.any(Number), undefined);
    useMazeStore.setState({
      openCard: state.openCard,
      floorFields: { ...useMazeStore.getState().floorFields, [state.activeFloorId]: activeField },
    });
    interaction.destroy();
  });

  it("highlights the connected area for the magic-wand field tool", () => {
    const stageHandlers: Record<string, (event?: any) => void> = {};
    const state = useMazeStore.getState();
    const activeField = state.floorFields[state.activeFloorId];
    const getMagicWandPreview = vi.fn(() => [[1, 1], [2, 1]] as [number, number][]);
    const updateHover = vi.fn();
    useMazeStore.setState({
      openCard: "field_setup",
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...activeField, fieldEditMode: "custom", fieldPrimitive: "magic_wand" },
      },
    });

    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: (event?: any) => void) => { stageHandlers[event] = handler; }),
        },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({
        onPointerMove: vi.fn(),
        getMagicWandPreview,
        isGestureActive: vi.fn(() => false),
        hasSelectionPreview: vi.fn(() => false),
      }) as any,
      fieldEditorOverlay: { updateHover } as any,
      getController: () => null,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointermove?.({ globalX: 10, globalY: 10, buttons: 0 });

    expect(getMagicWandPreview).toHaveBeenCalledWith(10, 10);
    expect(updateHover).toHaveBeenCalledWith(
      [[1, 1], [2, 1]], activeField.fieldConfig, expect.any(Number), 0.5,
    );
    useMazeStore.setState({
      openCard: state.openCard,
      floorFields: { ...useMazeStore.getState().floorFields, [state.activeFloorId]: activeField },
    });
    interaction.destroy();
  });

  it("forwards polygon double-taps to the field editor controller", () => {
    const stageHandlers: Record<string, (event?: any) => void> = {};
    const state = useMazeStore.getState();
    const activeField = state.floorFields[state.activeFloorId];
    useMazeStore.setState({
      openCard: "field_setup",
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...activeField, fieldEditMode: "custom", fieldPrimitive: "polygon" },
      },
    });

    const onDoubleClick = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: (event?: any) => void) => { stageHandlers[event] = handler; }),
        },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({ onDoubleClick }) as any,
      fieldEditorOverlay: { updateHover: vi.fn() } as any,
      getController: () => null,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointertap?.({ detail: 2, globalX: 10, globalY: 20, button: 0 });

    expect(onDoubleClick).toHaveBeenCalledWith(10, 20, 0);
    useMazeStore.setState({
      openCard: state.openCard,
      floorFields: { ...useMazeStore.getState().floorFields, [state.activeFloorId]: activeField },
    });
    interaction.destroy();
  });

  it("resets viewport scale and keeps the center anchored", () => {
    const viewport = {
      x: 150,
      y: 80,
      scale: {
        x: 2,
        y: 2,
        set(value: number) {
          this.x = value;
          this.y = value;
        },
      },
    };
    const scene = {
      app: { screen: { width: 200, height: 100 } },
      viewport,
      syncLayersToViewport: vi.fn(),
    } as unknown as MazeScene;

    MazeScene.prototype.resetZoomToOne.call(scene);

    expect(viewport.x).toBe(125);
    expect(viewport.y).toBe(65);
    expect(viewport.scale.x).toBe(1);
    expect(viewport.scale.y).toBe(1);
  });

  it("triggers the reset callback for Shift+1 outside text inputs", () => {
    const onResetZoom = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: { interactive: false, hitArea: null, on: vi.fn() },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: { x: 0, y: 0, scale: { x: 1, y: 1 } } as any,
      getFieldEditController: () => ({ hasSelectionPreview: vi.fn(() => false) }) as any,
      fieldEditorOverlay: {} as any,
      getController: () => null,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom,
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", shiftKey: true, bubbles: true }));
    expect(onResetZoom).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", shiftKey: true, bubbles: true }));
    expect(onResetZoom).toHaveBeenCalledTimes(1);
    input.remove();

    interaction.destroy();
  });

  it("exits background positioning when a pointer is pressed outside the canvas", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const state = useMazeStore.getState();
    const previous = {
      openCard: state.openCard,
      showBackgroundImage: state.showBackgroundImage,
      backgroundImage: state.backgroundImage,
      backgroundImageManualPositioning: state.backgroundImageManualPositioning,
    };
    const cancelPointerGesture = vi.fn();
    useMazeStore.setState({
      openCard: "preset_connections",
      showBackgroundImage: true,
      backgroundImage: state.backgroundImage ?? {
        dataUrl: "data:image/png;base64,test",
        naturalWidth: 100,
        naturalHeight: 100,
        displayWidth: 100,
        displayHeight: 100,
        centerX: 0,
        centerY: 0,
        layer: "below_grid",
        opacity: 0.5,
      },
      backgroundImageManualPositioning: true,
    });
    const interaction = new SceneInteraction({
      app: {
        stage: { interactive: false, hitArea: null, on: vi.fn() },
        canvas,
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({}) as any,
      fieldEditorOverlay: {} as any,
      getController: () => ({ cancelPointerGesture } as any),
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(false);
    expect(cancelPointerGesture).toHaveBeenCalledTimes(1);
    interaction.destroy();
    canvas.remove();
    useMazeStore.setState(previous);
  });

  it("pans the canvas with the middle button during background positioning", () => {
    const stageHandlers: Record<string, (event: any) => void> = {};
    const state = useMazeStore.getState();
    const previous = {
      openCard: state.openCard,
      showBackgroundImage: state.showBackgroundImage,
      backgroundImage: state.backgroundImage,
      backgroundImageManualPositioning: state.backgroundImageManualPositioning,
    };
    const viewport = fakeViewport(10, 20);
    useMazeStore.setState({
      openCard: "preset_connections",
      showBackgroundImage: true,
      backgroundImage: state.backgroundImage ?? {
        dataUrl: "data:image/png;base64,test",
        naturalWidth: 100,
        naturalHeight: 100,
        displayWidth: 100,
        displayHeight: 100,
        centerX: 0,
        centerY: 0,
        layer: "below_grid",
        opacity: 0.5,
      },
      backgroundImageManualPositioning: true,
    });
    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: (event: any) => void) => { stageHandlers[event] = handler; }),
        },
        canvas: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        screen: { width: 100, height: 100 },
      } as any,
      viewport,
      getFieldEditController: () => ({}) as any,
      fieldEditorOverlay: {} as any,
      getController: () => ({
        onPointerDown: vi.fn(),
        onPointerMove: vi.fn(),
        onPointerUp: vi.fn(),
        cancelPointerGesture: vi.fn(),
      }),
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointerdown({ button: 1, globalX: 5, globalY: 6 });
    stageHandlers.pointermove({ buttons: 4, globalX: 15, globalY: 26 });
    stageHandlers.pointerup({ button: 1 });

    expect(viewport.x).toBe(20);
    expect(viewport.y).toBe(40);
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(true);
    interaction.destroy();
    useMazeStore.setState(previous);
  });

  it("cancels the active pointer gesture outside the canvas and on window blur", () => {
    const stageHandlers: Record<string, () => void> = {};
    const cancelPointerGesture = vi.fn();
    const onPointerUp = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: () => void) => { stageHandlers[event] = handler; }),
        },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: { x: 0, y: 0, scale: { x: 1, y: 1 } } as any,
      getFieldEditController: () => ({}) as any,
      fieldEditorOverlay: {} as any,
      getController: () => ({
        onPointerDown: vi.fn(),
        onPointerMove: vi.fn(),
        onPointerUp,
        cancelPointerGesture,
      }),
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointerupoutside();
    window.dispatchEvent(new Event("blur"));

    expect(cancelPointerGesture).toHaveBeenCalledTimes(2);
    expect(onPointerUp).not.toHaveBeenCalled();
    interaction.destroy();
  });

  it("clears editor hover when the pointer moves from the canvas to a side panel", () => {
    const canvas = document.createElement("canvas");
    const clearHover = vi.fn();
    const onHoverChanged = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: { interactive: false, hitArea: null, on: vi.fn() },
        canvas,
        screen: { width: 100, height: 100 },
      } as any,
      viewport: { x: 0, y: 0, scale: { x: 1, y: 1 } } as any,
      getFieldEditController: () => ({}) as any,
      fieldEditorOverlay: {} as any,
      getController: () => ({
        onPointerDown: vi.fn(),
        onPointerMove: vi.fn(),
        onPointerUp: vi.fn(),
        cancelPointerGesture: vi.fn(),
        clearHover,
      }),
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged,
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    canvas.dispatchEvent(new Event("pointerleave"));

    expect(clearHover).toHaveBeenCalledOnce();
    expect(onHoverChanged).toHaveBeenCalledWith(null);
    interaction.destroy();
  });

  it("confirms a persistent field selection when the pointer is released outside the canvas", () => {
    const stageHandlers: Record<string, () => void> = {};
    const state = useMazeStore.getState();
    const previousOpenCard = state.openCard;
    const previousFloorFields = state.floorFields;
    const previousMazeDirty = state.mazeDirty;
    const previousPostEditDirty = state.postEditDirty;
    const previousFieldEditConfirmation = state.fieldEditConfirmation;
    const activeField = state.floorFields[state.activeFloorId];
    const commitPendingSelectionMove = vi.fn(() => true);
    const cancelPointerGesture = vi.fn();
    const fieldController = {
      hasSelectionPreview: vi.fn(() => true),
      commitPendingSelectionMove,
      cancelPointerGesture,
      clearHover: vi.fn(),
    };
    useMazeStore.setState({
      openCard: "field_setup",
      mazeDirty: false,
      postEditDirty: false,
      fieldEditConfirmation: null,
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...activeField, fieldEditMode: "custom", isEditingField: true, fieldOperation: "select" },
      },
    });

    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: () => void) => { stageHandlers[event] = handler; }),
        },
        canvas: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        },
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => fieldController as any,
      fieldEditorOverlay: { updateHover: vi.fn() } as any,
      getController: () => fieldController as any,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });

    stageHandlers.pointerupoutside();

    expect(commitPendingSelectionMove).toHaveBeenCalledTimes(1);
    expect(cancelPointerGesture).not.toHaveBeenCalled();
    interaction.destroy();
    useMazeStore.setState({
      openCard: previousOpenCard,
      floorFields: previousFloorFields,
      mazeDirty: previousMazeDirty,
      postEditDirty: previousPostEditDirty,
      fieldEditConfirmation: previousFieldEditConfirmation,
    });
  });

  it("commits a persistent selection before a field tool or mode change is cancelled", () => {
    const state = useMazeStore.getState();
    const previousOpenCard = state.openCard;
    const previousFloorFields = state.floorFields;
    const previousMazeDirty = state.mazeDirty;
    const previousPostEditDirty = state.postEditDirty;
    const previousFieldEditConfirmation = state.fieldEditConfirmation;
    const activeField = state.floorFields[state.activeFloorId];
    const commitPendingSelectionMove = vi.fn(() => true);
    const cancelPointerGesture = vi.fn();
    const scene = {
      fieldEditController: {
        hasSelectionPreview: vi.fn(() => true),
        commitPendingSelectionMove,
        cancelPointerGesture,
      },
      primitivePreviewOverlay: {
        setFrameVisible: vi.fn(),
        clear: vi.fn(),
      },
      fieldEditorOverlay: { updateHover: vi.fn() },
    } as unknown as MazeScene;
    useMazeStore.setState({
      openCard: "field_setup",
      mazeDirty: false,
      postEditDirty: false,
      fieldEditConfirmation: null,
      floorFields: {
        ...state.floorFields,
        [state.activeFloorId]: { ...activeField, fieldEditMode: "custom", isEditingField: true, fieldOperation: "select" },
      },
    });

    (MazeScene.prototype as any).subscribeToEditField.call(scene as any);
    useMazeStore.getState().setFieldPrimitive("triangle");
    useMazeStore.getState().setFieldOperation("remove");
    useMazeStore.getState().setFieldEditMode("default");

    expect(commitPendingSelectionMove).toHaveBeenCalledTimes(3);
    expect(cancelPointerGesture).not.toHaveBeenCalled();
    (scene as any).unsubscribeEditField?.();
    useMazeStore.setState({
      openCard: previousOpenCard,
      floorFields: previousFloorFields,
      mazeDirty: previousMazeDirty,
      postEditDirty: previousPostEditDirty,
      fieldEditConfirmation: previousFieldEditConfirmation,
    });
  });

  it("does not exit Transform or Crop when their side-panel buttons receive pointerdown", () => {
    const previous = useMazeStore.getState();
    const stageHandlers: Record<string, (event?: any) => void> = {};
    const canvas = document.createElement("canvas");
    const interaction = new SceneInteraction({
      app: {
        stage: {
          interactive: false,
          hitArea: null,
          on: vi.fn((event: string, handler: (event?: any) => void) => { stageHandlers[event] = handler; }),
        },
        canvas,
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({ cancelPointerGesture: vi.fn() }) as any,
      fieldEditorOverlay: { updateHover: vi.fn() } as any,
      getController: () => null,
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });
    const button = document.createElement("button");
    button.setAttribute("data-background-image-mode-control", "true");
    document.body.appendChild(button);

    for (const mode of ["transform", "crop"] as const) {
      useMazeStore.setState({
        showBackgroundImage: true,
        backgroundImage: {
          dataUrl: "data:image/png;base64,test",
          naturalWidth: 100,
          naturalHeight: 100,
          displayWidth: 100,
          displayHeight: 100,
          centerX: 0,
          centerY: 0,
          layer: "below_grid",
          opacity: 0.5,
        },
        backgroundImageManualPositioning: mode === "transform",
        backgroundImageCropping: mode === "crop",
      });
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(mode === "transform");
      expect(useMazeStore.getState().backgroundImageCropping).toBe(mode === "crop");
    }

    button.remove();
    interaction.destroy();
    useMazeStore.setState(previous);
    expect(stageHandlers.pointerdown).toBeDefined();
  });

  it("commits or restores floor-label dragging at its keyboard and outside-canvas boundaries", () => {
    const previous = useMazeStore.getState();
    const canvas = document.createElement("canvas");
    const cancelPointerGesture = vi.fn();
    const interaction = new SceneInteraction({
      app: {
        stage: { interactive: false, hitArea: null, on: vi.fn() },
        canvas,
        screen: { width: 100, height: 100 },
      } as any,
      viewport: fakeViewport(0, 0),
      getFieldEditController: () => ({ cancelPointerGesture: vi.fn() }) as any,
      fieldEditorOverlay: { updateHover: vi.fn() } as any,
      getController: () => ({ onPointerDown: vi.fn(), onPointerMove: vi.fn(), onPointerUp: vi.fn(), cancelPointerGesture }),
      getHoverProvider: () => ({ getHoverInfo: () => null }),
      onHoverChanged: vi.fn(),
      onViewportChanged: vi.fn(),
      onResetZoom: vi.fn(),
    });
    useMazeStore.setState({
      activeRenderMode: "vector_by_walls",
      vectorByWallsSettings: {
        ...previous.vectorByWallsSettings,
        floorLabel: {
          ...previous.vectorByWallsSettings.floorLabel,
          positionsByFloorId: { [previous.activeFloorId]: { mode: "free", x: 1, y: 2 } },
        },
      },
    });

    useMazeStore.getState().startFloorLabelDrag("vector_by_walls");
    useMazeStore.getState().updateFloorLabelDragPosition({ mode: "free", x: 9, y: 10 });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }));
    expect(useMazeStore.getState().floorLabelDrag).toBeNull();
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId[previous.activeFloorId]).toEqual({ mode: "free", x: 1, y: 2 });

    for (const [code, x, y] of [["Enter", 3, 4], ["Space", 4, 5]] as const) {
      useMazeStore.getState().startFloorLabelDrag("vector_by_walls");
      useMazeStore.getState().updateFloorLabelDragPosition({ mode: "free", x, y });
      window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
      expect(useMazeStore.getState().floorLabelDrag).toBeNull();
      expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId[previous.activeFloorId]).toEqual({ mode: "free", x, y });
    }

    useMazeStore.getState().startFloorLabelDrag("vector_by_walls");
    useMazeStore.getState().updateFloorLabelDragPosition({ mode: "free", x: 5, y: 6 });
    const dragButton = document.createElement("button");
    dragButton.setAttribute("data-floor-label-drag-control", "true");
    document.body.appendChild(dragButton);
    dragButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(useMazeStore.getState().floorLabelDrag).not.toBeNull();
    dragButton.remove();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(useMazeStore.getState().floorLabelDrag).toBeNull();
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId[previous.activeFloorId]).toEqual({ mode: "free", x: 5, y: 6 });

    interaction.destroy();
    useMazeStore.setState(previous);
  });
});
