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
      wallColor: 0x0a0a0a,
      wallJoin: "round",
      wallThickness: 3,
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
      vectorByWallsSettings: { background: 0, showGrid: false, gridColor: 0, floorColor: 0, wallColor: 0, wallJoin: "round", wallThickness: 3 },
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

  it("renders the tiles section expanded by default with floor color, wall color, join and thickness fields", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.floor_color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.wall_color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.wall_join"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.wall_thickness"]())).toBeInTheDocument();
  });

  it("collapsing the tiles section header hides its fields", () => {
    render(<VectorByWallsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_tiles"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.floor_color"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.wall_color"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded.tiles).toBe(false);
  });

  it("changing the floor color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    // Swatch order: background, grid, floor, wall.
    fireEvent.change(inputs[2], { target: { value: "#ff00aa" } });
    expect(useMazeStore.getState().vectorByWallsSettings.floorColor).toBe(0xff00aa);
  });

  it("changing the wall color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    fireEvent.change(inputs[3], { target: { value: "#00ff00" } });
    expect(useMazeStore.getState().vectorByWallsSettings.wallColor).toBe(0x00ff00);
  });

  it("changing the wall join updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.vector_by_walls.wall_join_round"]());
    fireEvent.change(select, { target: { value: "miter" } });
    expect(useMazeStore.getState().vectorByWallsSettings.wallJoin).toBe("miter");
  });

  it("changing the wall thickness updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getByText(m["image_export.vector_by_walls.wall_thickness"]())
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "7" } });
    expect(useMazeStore.getState().vectorByWallsSettings.wallThickness).toBe(7);
  });
});
