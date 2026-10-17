import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImageExportFeature } from "../components/features/ImageExportFeature";
import { SidePanel } from "../components/SidePanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { serializeProject, serializeVisualPreset, serializeQualityPreset } from "../store/projectExport";
import * as m from "~/paraglide/messages";
import { resetNotifications } from "../notifications/notificationStore";
import { errorCards, errorDetails } from "./notificationTestHelpers";
import { getTooltipControl } from "./tooltipTestUtils";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/wasmLoader")>()),
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  resetNotifications();
  // `openExportFormatSettings` reset alongside the render-mode fields (GitHub issue #629's tests
  // added a case that sets it and never explicitly clears it — without resetting it here too, a
  // later test would inherit that leftover "png" and misread its own gear click as a close-toggle
  // instead of an open).
  useMazeStore.setState({
    ...baseStoreState(), activeRenderMode: null, openRenderModeSettings: null, openExportFormatSettings: null,
    // Same leftover-state hazard as `openExportFormatSettings` above (GitHub issue #629 follow-up).
    exportFormatSettingsCovered: false,
  });
});

describe("ImageExportFeature", () => {
  it("first click on an inactive mode both activates it AND opens its settings panel", () => {
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
    // Panel content itself renders (Vector by walls's settings panel).
    expect(screen.getByText(m["image_export.vector_by_walls.section_background"]())).toBeInTheDocument();
  });

  it("clicking the active mode's switcher item toggles its settings panel closed", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openRenderModeSettings).toBeNull();
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
  });

  it("clicking the active mode's switcher item again reopens its settings panel", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: null });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
  });

  it("export format's button is disabled when no render mode is active", () => {
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    const btn = screen.getByRole("button", { name: m["image_export.format.png.label"]() });
    expect(btn).toBeDisabled();
  });

  it("clicking the PNG button calls onExportPng with the current settings", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls" });
    const onExportPng = vi.fn(() => Promise.resolve(null));
    render(<ImageExportFeature onExportPng={onExportPng} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.format.png.label"]() }));
    expect(onExportPng).toHaveBeenCalledWith(useMazeStore.getState().pngExportSettings);
  });

  // GitHub issue #629: opening one settings panel no longer clears the other — both may stay open
  // at once, and `SidePanel`'s own mount-order stack decides which is shown. Closing the top one
  // (PNG format settings here) must reveal the render-mode panel underneath, not leave it cleared.
  it("clicking the PNG format's gear opens its settings panel without clearing the render-mode one", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(getTooltipControl(m["image_export.format.settings_tooltip"]({ format: m["image_export.format.png.label"]() })));
    expect(useMazeStore.getState().openExportFormatSettings).toBe("png");
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
    expect(screen.getByText(m["image_export.format.png.digital.scale"]())).toBeInTheDocument();
  });

  it("clicking a render mode's switcher item does not clear an open format settings panel", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openExportFormatSettings: "png" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openExportFormatSettings).toBe("png");
  });

  // GitHub issue #629 end-to-end: with both panels mounted, the PNG format settings panel (opened
  // later) sits on top; closing it via its own header ✕ must reveal the render-mode panel
  // underneath again, not leave the slot empty. Exercises `SidePanel`'s mount-order stack through
  // a real DOM close-button click, not just store-state assertions.
  it("closing the PNG format panel reveals the render-mode panel underneath", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);

    fireEvent.click(getTooltipControl(m["image_export.format.settings_tooltip"]({ format: m["image_export.format.png.label"]() })));
    const wallsBackground = screen.getByText(m["image_export.vector_by_walls.section_background"]());
    expect(screen.getByText(m["image_export.format.png.digital.scale"]())).toBeVisible();
    expect(wallsBackground).not.toBeVisible();

    // Close via the PNG panel's own header ✕ button, same as a real user closing the top panel —
    // not by calling `setOpenExportFormatSettings` directly. Both `SidePanel`s share the same
    // portal slot and render in mount order, so the PNG panel (opened after the render-mode one)
    // is the last one in the DOM; its close button is the last "✕"-labelled button rendered.
    const closeButtons = screen.getAllByRole("button", { name: "" }).filter((btn) => btn.querySelector("svg.lucide-x"));
    fireEvent.click(closeButtons[closeButtons.length - 1]);

    expect(screen.queryByText(m["image_export.format.png.digital.scale"]())).not.toBeInTheDocument();
    expect(wallsBackground).toBeVisible();
  });

  // GitHub issue #629 follow-up: the PNG format panel's on-canvas frame overlay must know when
  // it's covered by another SidePanel (e.g. the color picker), not just when it's closed — driven
  // by `SidePanel.onTopChange` into `exportFormatSettingsCovered`.
  it("marks exportFormatSettingsCovered while another SidePanel opens on top of the PNG panel", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openExportFormatSettings: "png" });
    const { rerender } = render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    expect(useMazeStore.getState().exportFormatSettingsCovered).toBe(false);

    rerender(
      <>
        <ImageExportFeature onExportPng={() => Promise.resolve(null)} />
        <SidePanel title="Overlay" onClose={() => {}} overlay>overlay content</SidePanel>
      </>,
    );
    expect(useMazeStore.getState().exportFormatSettingsCovered).toBe(true);

    rerender(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    expect(useMazeStore.getState().exportFormatSettingsCovered).toBe(false);
  });

  describe("style preset load (GitHub issue #750)", () => {
    function pickPresetFile(content: unknown, container: HTMLElement) {
      const input = container.querySelector('input[name="visual-preset-file"]') as HTMLInputElement;
      const file = new File([JSON.stringify(content)], "style.mazestyle");
      fireEvent.change(input, { target: { files: [file] } });
    }

    it("applies a picked style preset", async () => {
      const preset = serializeVisualPreset({ ...useMazeStore.getState(), showColorWarnings: false });
      useMazeStore.setState({ showColorWarnings: true });
      const { container } = render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
      pickPresetFile(preset, container);
      await waitFor(() => expect(useMazeStore.getState().showColorWarnings).toBe(false));
      expect(errorCards()).toEqual([]);
    });

    it("raises a dedicated error toast and changes nothing when a project file is picked", async () => {
      useMazeStore.setState({ showColorWarnings: true });
      const { container } = render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
      pickPresetFile(serializeProject({ ...useMazeStore.getState(), showColorWarnings: false }), container);
      await waitFor(() => expect(errorCards()).toEqual(["visual_preset_load/image_export.visual_preset.load_error_project_file"]));
      expect(useMazeStore.getState().showColorWarnings).toBe(true);
    });

    it("raises a dedicated error toast when a quality preset is picked", async () => {
      const { container } = render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
      pickPresetFile(serializeQualityPreset(useMazeStore.getState()), container);
      await waitFor(() => expect(errorCards()).toEqual(["visual_preset_load/image_export.visual_preset.load_error_quality_preset"]));
    });

    it("raises an error toast with details and changes nothing for a malformed style preset", async () => {
      const preset = serializeVisualPreset({ ...useMazeStore.getState(), showColorWarnings: false });
      useMazeStore.setState({ showColorWarnings: true });
      const { container } = render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
      pickPresetFile({ ...preset, version: 999 }, container);
      await waitFor(() => expect(errorCards()).toEqual(["visual_preset_load/image_export.visual_preset.load_error"]));
      expect(errorDetails("image_export.visual_preset.load_error")).toBeTruthy();
      expect(useMazeStore.getState().showColorWarnings).toBe(true);
    });
  });
});
