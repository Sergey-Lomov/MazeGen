import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VectorByCorridorsSettingsPanel } from "../components/features/VectorByCorridorsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";
import * as m from "~/paraglide/messages";

vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]: [number, number]) => [x, y]),
}));
vi.mock("../wasm/wasmLoader", () => ({
  initWasm: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    vectorByCorridorsSettings: { ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, color: 0x0a0a0a, thickness: 6, join: "round" },
    // "Cells" starts collapsed by default (mirrors VectorByWallsSettingsPanel's sections) —
    // expanded here so the field-interaction tests below don't each need their own expand step.
    vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true },
  });
});

describe("VectorByCorridorsSettingsPanel", () => {
  it("the 'Cells' section starts collapsed by default", () => {
    useMazeStore.setState({ vectorByCorridorsSectionsExpanded: {} });
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_corridors.color"]())).not.toBeInTheDocument();
  });

  it("renders the corridor color/join/thickness controls once expanded", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_corridors.color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_corridors.join"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_corridors.thickness"]())).toBeInTheDocument();
  });

  it("changing the join select updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.vector_by_walls.wall_join_round"]());
    fireEvent.change(select, { target: { value: "miter" } });
    expect(useMazeStore.getState().vectorByCorridorsSettings.join).toBe("miter");
  });

  it("changing the thickness slider updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    const slider = screen.getByDisplayValue("6");
    fireEvent.change(slider, { target: { value: "10" } });
    expect(useMazeStore.getState().vectorByCorridorsSettings.thickness).toBe(10);
  });

  it("clicking the section header toggles expand/collapse", () => {
    useMazeStore.setState({ vectorByCorridorsSectionsExpanded: {} });
    render(<VectorByCorridorsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_corridors.section_cells"]()));
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded.cells).toBe(true);
  });

  it("renders the waypoints section's Start and Finish sub-groups when expanded", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.markers_start"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.markers_finish"]())).toBeInTheDocument();
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_shape"]())).toHaveLength(2);
  });

  it("collapsing the waypoints section hides its fields", () => {
    render(<VectorByCorridorsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_markers"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.markers_start"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded.waypoints).toBe(false);
  });

  it("changing the start marker fill color updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(useMazeStore.getState().vectorByCorridorsSettings.startMarker.fillColor).not.toBe(0x654321);
    useMazeStore.getState().setVectorByCorridorsStartMarkerFillColor(0x654321);
    expect(useMazeStore.getState().vectorByCorridorsSettings.startMarker.fillColor).toBe(0x654321);
  });

  it("shows a warning bubble when a waypoint sits on a split point", () => {
    useMazeStore.setState({
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 0, y: 0, i: 0 }],
      start: 0,
      finish: null,
      vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true, warnings: true },
    });
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_corridors.warning_waypoint_on_split"]())).toBeInTheDocument();
  });
});
