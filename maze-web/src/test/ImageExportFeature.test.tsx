import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImageExportFeature } from "../components/features/ImageExportFeature";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import * as m from "~/paraglide/messages";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState({ ...baseStoreState(), activeRenderMode: null, openRenderModeSettings: null });
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

  it("clicking the PNG format's gear opens its settings panel and closes the render-mode one", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByTitle(m["image_export.format.settings_tooltip"]({ format: m["image_export.format.png.label"]() })));
    expect(useMazeStore.getState().openExportFormatSettings).toBe("png");
    expect(useMazeStore.getState().openRenderModeSettings).toBeNull();
    expect(screen.getByText(m["image_export.format.png.digital.scale"]())).toBeInTheDocument();
  });

  it("clicking a render mode's switcher item closes an open format settings panel", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openExportFormatSettings: "png" });
    render(<ImageExportFeature onExportPng={() => Promise.resolve(null)} />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openExportFormatSettings).toBeNull();
  });
});
