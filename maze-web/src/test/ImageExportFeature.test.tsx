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
    render(<ImageExportFeature />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
    // Panel content itself renders (Vector by walls's settings panel).
    expect(screen.getByText(m["image_export.vector_by_walls.section_background"]())).toBeInTheDocument();
  });

  it("clicking the active mode's switcher item toggles its settings panel closed", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: "vector_by_walls" });
    render(<ImageExportFeature />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openRenderModeSettings).toBeNull();
    expect(useMazeStore.getState().activeRenderMode).toBe("vector_by_walls");
  });

  it("clicking the active mode's switcher item again reopens its settings panel", () => {
    useMazeStore.setState({ activeRenderMode: "vector_by_walls", openRenderModeSettings: null });
    render(<ImageExportFeature />);
    fireEvent.click(screen.getByRole("button", { name: m["image_export.mode.vector_by_walls.label"]() }));
    expect(useMazeStore.getState().openRenderModeSettings).toBe("vector_by_walls");
  });
});
