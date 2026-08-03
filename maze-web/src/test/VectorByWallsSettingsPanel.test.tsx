import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
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
  useMazeStore.setState({
    ...baseStoreState(),
    vectorByWallsSectionsExpanded: {},
    vectorByWallsSettings: {
      background: 0x1a1a1a,
      showGrid: true,
      gridColor: 0x333333,
      floorColor: 0x2a2a2a,
    },
  });
});

describe("VectorByWallsSettingsPanel", () => {
  it("renders the background section expanded by default (no stored expand state yet)", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.background_color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.show_grid"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.grid_color"]())).toBeInTheDocument();
  });

  it("collapsing the section header hides its fields", () => {
    render(<VectorByWallsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_background"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.background_color"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded.background).toBe(false);
  });

  it("toggling 'show grid' off updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(useMazeStore.getState().vectorByWallsSettings.showGrid).toBe(false);
  });

  it("grid color swatch is disabled (aria-disabled) when showGrid is off", () => {
    useMazeStore.setState({
      vectorByWallsSettings: { background: 0, showGrid: false, gridColor: 0, floorColor: 0 },
    });
    render(<VectorByWallsSettingsPanel />);
    const swatches = screen.getAllByRole("button");
    // Second color row (grid color) is the one gated by showGrid.
    expect(swatches[1]).toHaveAttribute("aria-disabled", "true");
  });

  it("grid color swatch is enabled when showGrid is on", () => {
    render(<VectorByWallsSettingsPanel />);
    const swatches = screen.getAllByRole("button");
    expect(swatches[1]).toHaveAttribute("aria-disabled", "false");
  });

  it("renders the floor section expanded by default with the floor color field", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.floor_color"]())).toBeInTheDocument();
  });

  it("collapsing the floor section header hides its fields", () => {
    render(<VectorByWallsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_floor"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.floor_color"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded.floor).toBe(false);
  });

  it("changing the floor color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    // Swatch order: background, grid, floor.
    fireEvent.change(inputs[2], { target: { value: "#ff00aa" } });
    expect(useMazeStore.getState().vectorByWallsSettings.floorColor).toBe(0xff00aa);
  });
});
