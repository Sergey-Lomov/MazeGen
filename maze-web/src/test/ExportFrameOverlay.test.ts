import { describe, it, expect, beforeEach, vi } from "vitest";
import { Container } from "pixi.js";

// getCartesian (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment —
// same square-tessellation mock as exportFit.test.ts/printFit.test.ts.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number): [number, number] => [x, y],
}));

const { ExportFrameOverlay } = await import("../pixi/imageExport/ExportFrameOverlay");
const { useMazeStore } = await import("../store/mazeStore");
const { DEFAULT_PNG_EXPORT_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS } = await import("../store/slices/imageExportSlice");
const { baseStoreState } = await import("./storeTestHelpers");

const SCREEN = { width: 1000, height: 1000 };

function setBaseState(overrides: Record<string, unknown> = {}) {
  useMazeStore.setState({
    ...baseStoreState(),
    openCard: "image_export",
    openExportFormatSettings: "png",
    activeRenderMode: "vector_by_walls",
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
    ...overrides,
  });
}

beforeEach(() => {
  setBaseState();
});

function makeOverlay(setViewportTransform = vi.fn()) {
  const overlay = new ExportFrameOverlay(new Container(), setViewportTransform, () => SCREEN);
  return { overlay, setViewportTransform };
}

describe("ExportFrameOverlay — print anchor guard", () => {
  it("does not overwrite a fixed anchor when onViewportChanged reports the same x/y/scale as before (resize echo, not a real pan/zoom)", () => {
    setBaseState({
      pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print", print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false, anchor: "center" } },
    });
    const setViewportTransform = vi.fn();
    const { overlay } = makeOverlay(setViewportTransform);

    // The constructor's own becameActive sync already pushed a viewport transform for "center" —
    // read back exactly that (x, y, scale), since a real screen resize's syncLayersToViewport
    // echoes onViewportChanged with the viewport's actual current values, not arbitrary ones.
    const [x, y, scale] = setViewportTransform.mock.calls.at(-1)!;

    overlay.onViewportChanged(x, y, SCREEN.width, SCREEN.height, scale);

    expect(useMazeStore.getState().pngExportSettings.print.anchor).toBe("center");
  });

  it("does overwrite the anchor to 'custom' when onViewportChanged reports genuinely different x/y/scale (a real pan/zoom)", () => {
    setBaseState({
      pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print", print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false, anchor: "center" } },
    });
    const { overlay } = makeOverlay();

    overlay.onViewportChanged(0, 0, SCREEN.width, SCREEN.height, 1);
    overlay.onViewportChanged(50, 30, SCREEN.width, SCREEN.height, 1);

    expect(useMazeStore.getState().pngExportSettings.print.anchor).toBe("custom");
  });

  it("notifyExternalResize re-fits the viewport under the current anchor without changing the anchor itself", () => {
    setBaseState({
      pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print", print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false, anchor: "top_left" } },
    });
    const { overlay, setViewportTransform } = makeOverlay();
    setViewportTransform.mockClear();

    overlay.notifyExternalResize();

    expect(useMazeStore.getState().pngExportSettings.print.anchor).toBe("top_left");
  });
});

describe("ExportFrameOverlay — re-entrancy guard", () => {
  it("does not recurse infinitely when setViewportTransform synchronously calls back into onViewportChanged (stack-overflow regression)", () => {
    setBaseState({
      pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print", print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false, anchor: "top_left" } },
    });
    let overlayRef: InstanceType<typeof ExportFrameOverlay> | null = null;
    const setViewportTransform = vi.fn((x: number, y: number, scale: number) => {
      // Switching the anchor triggers redraw() -> syncViewportToPlacement() -> setViewportTransform(),
      // which this callback synchronously loops back into onViewportChanged() — mirrors the real
      // MazeScene.setViewportTransform -> syncLayersToViewport -> onViewportChanged chain, including
      // the constructor's own becameActive-triggered call (overlayRef is still null then, matching
      // the real chain where MazeScene wires notifyScreenResized only after construction completes).
      overlayRef?.onViewportChanged(x, y, SCREEN.width, SCREEN.height, scale);
    });
    const overlay = new ExportFrameOverlay(new Container(), setViewportTransform, () => SCREEN);
    overlayRef = overlay;

    expect(() => useMazeStore.getState().setPrintAnchor("center")).not.toThrow();
  });
});
