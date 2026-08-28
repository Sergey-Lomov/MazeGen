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

describe("ExportFrameOverlay — physical 1:1 viewport command", () => {
  function printState(overrides: Record<string, unknown> = {}) {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false, anchor: "center", scale: 1.7 },
      },
      ...overrides,
    });
  }

  it("is a pure scale about the print frame's screen centre", async () => {
    const { computeSheetScreenLayout } = await import("../pixi/imageExport/printFit");
    const { computePrintExportFit } = await import("../pixi/imageExport/printFit");
    const { resolveContentBoundsBasis } = await import("../pixi/imageExport/exportMargins");

    printState();
    const { overlay, setViewportTransform } = makeOverlay();

    // The constructor's becameActive sync already placed the viewport for "center" — that's our
    // "old" transform (read it back), no pan/zoom needed.
    const [oldX, oldY, oldS] = setViewportTransform.mock.calls.at(-1)!;
    setViewportTransform.mockClear();

    const target = 2.5;
    overlay.applyViewportScaleAroundFrameCentre(target);

    const [nx, ny, ns] = setViewportTransform.mock.calls.at(-1)!;
    expect(ns).toBe(target);

    // The frame's own screen centre (computeSheetScreenLayout of the current print fit).
    const s = useMazeStore.getState();
    const fit = computePrintExportFit(s.activeTessellationConfig, s.nodes, { left: 0, right: 0, top: 0, bottom: 0 }, s.pngExportSettings.print, resolveContentBoundsBasis("vector_by_walls"));
    const layout = computeSheetScreenLayout(fit.sheetWidthPx, fit.sheetHeightPx, SCREEN.width, SCREEN.height);
    const cx = layout.x + layout.w / 2;
    const cy = layout.y + layout.h / 2;

    const k = target / oldS;
    expect(nx).toBeCloseTo(cx - (cx - oldX) * k);
    expect(ny).toBeCloseTo(cy - (cy - oldY) * k);
  });

  it("does not touch print placement (scale / anchor / offset)", () => {
    printState();
    const { overlay } = makeOverlay();

    overlay.applyViewportScaleAroundFrameCentre(0.32);

    const p = useMazeStore.getState().pngExportSettings.print;
    expect(p.scale).toBe(1.7);
    expect(p.anchor).toBe("center");
    expect(p.offsetXMm).toBe(DEFAULT_PNG_EXPORT_SETTINGS.print.offsetXMm);
    expect(p.offsetYMm).toBe(DEFAULT_PNG_EXPORT_SETTINGS.print.offsetYMm);
  });

  it("ignores a non-positive target scale (no viewport write)", () => {
    printState();
    const { overlay, setViewportTransform } = makeOverlay();
    setViewportTransform.mockClear();

    overlay.applyViewportScaleAroundFrameCentre(0);
    overlay.applyViewportScaleAroundFrameCentre(-1.5);

    expect(setViewportTransform).not.toHaveBeenCalled();
  });

  it("is a no-op when the print frame is not active (export panel closed)", () => {
    printState({ openCard: null });
    const { overlay, setViewportTransform } = makeOverlay();
    setViewportTransform.mockClear();

    overlay.applyViewportScaleAroundFrameCentre(2.0);

    expect(setViewportTransform).not.toHaveBeenCalled();
  });

  it("a genuine pan/zoom afterwards still switches the anchor to custom (placement contract intact)", () => {
    printState();
    const { overlay, setViewportTransform } = makeOverlay();

    overlay.applyViewportScaleAroundFrameCentre(0.5);
    expect(useMazeStore.getState().pngExportSettings.print.anchor).toBe("center");

    const [x, y] = setViewportTransform.mock.calls.at(-1)!;
    // A genuine pan away from the 1:1 transform.
    overlay.onViewportChanged(x + 77, y + 33, SCREEN.width, SCREEN.height, 0.5);
    expect(useMazeStore.getState().pngExportSettings.print.anchor).toBe("custom");
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
