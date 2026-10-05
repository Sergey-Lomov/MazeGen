import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VectorByCorridorsSettingsPanel } from "../components/features/VectorByCorridorsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { pickColorForLabel } from "./colorTestHelpers";
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
    vectorByCorridorsSettings: {
      ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      background: 0x1a1a1a,
      showGrid: true,
      gridColor: 0x333333,
      color: 0x0a0a0a,
      thickness: 6,
      join: "round",
    },
    // "Cells"/"Background" start collapsed by default (mirrors VectorByWallsSettingsPanel's
    // sections) — expanded here so the field-interaction tests below don't each need their own
    // expand step.
    vectorByCorridorsSectionsExpanded: { background: true, cells: true, waypoints: true },
  });
});

describe("VectorByCorridorsSettingsPanel", () => {
  it("shows all vertical subsections disabled when a multi-floor maze has no vertical edges", () => {
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
      vectorByCorridorsSectionsExpanded: { vertical: true },
    });

    render(<VectorByCorridorsSettingsPanel />);

    for (const label of [
      m["image_export.vector_by_walls.two_way_passage_marker"](),
      m["image_export.vector_by_walls.one_way_passage_marker"](),
      m["image_export.vector_by_walls.elevator_marker"](),
    ]) {
      const header = screen.getByText(label);
      expect(header.parentElement).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(header);
    }
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded.vertical_two_way).toBeUndefined();
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded.vertical_one_way).toBeUndefined();
    expect(useMazeStore.getState().vectorByCorridorsSectionsExpanded.vertical_elevator).toBeUndefined();
  });

  it("enables the two-way passage settings for elevators when replacement is enabled", () => {
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
      edges: [{ from: 1, to: 2, kind: "elevator" }],
      vectorByCorridorsSettings: {
        ...useMazeStore.getState().vectorByCorridorsSettings,
        replaceTwoFloorElevatorsWithStairs: true,
      },
      vectorByCorridorsSectionsExpanded: { vertical: true },
    });
    render(<VectorByCorridorsSettingsPanel />);

    const header = screen.getByText(m["image_export.vector_by_walls.two_way_passage_marker"]());
    expect(header.parentElement).not.toHaveAttribute("aria-disabled", "true");
  });

  it("the 'Cells' section starts collapsed by default", () => {
    useMazeStore.setState({ vectorByCorridorsSectionsExpanded: {} });
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_corridors.color"]())).not.toBeInTheDocument();
  });

  it("the 'Background' section starts collapsed by default", () => {
    useMazeStore.setState({ vectorByCorridorsSectionsExpanded: {} });
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_walls.background_color"]())).not.toBeInTheDocument();
  });

  it("renders the background section's fields when expanded (GitHub issue #309)", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.background_color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.show_grid"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.grid_color"]())).toBeInTheDocument();
  });

  it("toggling 'show grid' off updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    const checkbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);
    expect(useMazeStore.getState().vectorByCorridorsSettings.showGrid).toBe(false);
  });

  it("changing the background color updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    pickColorForLabel(screen.getByText(m["image_export.vector_by_walls.background_color"]()), "#ff00aa");
    expect(useMazeStore.getState().vectorByCorridorsSettings.background).toBe(0xff00aa);
  });

  it("renders the corridor color/join/thickness controls once expanded", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_corridors.color"]())).toBeInTheDocument();
    // "Corner style" is shared wording across several join/corner-style pickers on this same
    // panel (GitHub issue #678: unified terminology) — assert it's present, not that the text
    // is unique.
    expect(screen.getAllByText(m["image_export.vector_by_corridors.join"]()).length).toBeGreaterThan(0);
    expect(screen.getByText(m["image_export.vector_by_corridors.thickness"]())).toBeInTheDocument();
  });

  it("changing the join select updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    // The "Cells" section's own join select is the first `<select>` in document order (GitHub
    // issue #322 follow-up: `startMarker.cornerStyle`'s default is "round", so
    // `getByDisplayValue("Round")` is ambiguous with the "Waypoints" section's own marker
    // corner-style select).
    const select = document.querySelectorAll("select")[0];
    fireEvent.change(select, { target: { value: "miter" } });
    expect(useMazeStore.getState().vectorByCorridorsSettings.join).toBe("miter");
  });

  it("disables the Bow slider for miter corridor style", () => {
    useMazeStore.setState((state) => ({
      nodes: [{ id: 1, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }],
      vectorByCorridorsSettings: { ...state.vectorByCorridorsSettings, join: "miter", splitSpecialShapes: true },
      vectorByCorridorsSectionsExpanded: { ...state.vectorByCorridorsSectionsExpanded, splits: true },
    }));
    render(<VectorByCorridorsSettingsPanel />);

    const label = screen.getByText(m["image_export.vector_by_corridors.split_diagonal_bow_amount"]());
    const slider = label.parentElement?.querySelector('input[type="range"]');
    expect(slider).toBeDisabled();
  });

  it("changing the thickness slider updates the store", () => {
    render(<VectorByCorridorsSettingsPanel />);
    const slider = screen.getByDisplayValue("6");
    fireEvent.change(slider, { target: { value: "10" } });
    expect(useMazeStore.getState().vectorByCorridorsSettings.thickness).toBe(10);
  });

  it("limits the split gap width slider to 10px", () => {
    useMazeStore.setState({
      nodes: [{ id: 1, x: 0, y: 0, i: 0 }, { id: 2, x: 0, y: 0, i: 1 }],
      vectorByCorridorsSectionsExpanded: { splits: true },
    });
    render(<VectorByCorridorsSettingsPanel />);
    const label = screen.getByText(m["image_export.vector_by_corridors.split_gap_width"]());
    expect(label.parentElement?.querySelector('input[type="range"]')).toHaveAttribute("max", "10");
  });

  it("the marker widen padding/shape controls live in the 'Cells' section, not Waypoints (GitHub issue #313 follow-up)", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_corridors.marker_widen_padding"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_corridors.marker_widen_shape"]())).toBeInTheDocument();

    fireEvent.click(screen.getByText(m["image_export.vector_by_corridors.section_cells"]()));
    expect(screen.queryByText(m["image_export.vector_by_corridors.marker_widen_padding"]())).not.toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.markers_start"]())).toBeInTheDocument();
  });

  it("changing the widen patch shape select updates the store, defaulting to 'match_marker'", () => {
    render(<VectorByCorridorsSettingsPanel />);
    expect(useMazeStore.getState().vectorByCorridorsSettings.markerWidenShape).toBe("match_marker");
    const select = screen.getByDisplayValue(m["image_export.vector_by_corridors.marker_widen_shape_match_marker"]());
    fireEvent.change(select, { target: { value: "square" } });
    expect(useMazeStore.getState().vectorByCorridorsSettings.markerWidenShape).toBe("square");
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

  it("shows a warning bubble when a waypoint sits on a specially-rendered (bridge) split point", () => {
    // Point (0,0) split into node 0 (east+west) and node 4 (north+south) — a recognized "bridge"
    // topology, same fixture shape as `exportWarnings.test.ts`'s own `bridgeSplitNodes`.
    useMazeStore.setState({
      nodes: [
        { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }, { id: 2, x: -1, y: 0, i: 0 },
        { id: 3, x: 0, y: 1, i: 0 }, { id: 4, x: 0, y: 0, i: 0 }, { id: 5, x: 0, y: -1, i: 0 },
      ],
      edges: [
        { from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" },
        { from: 0, to: 2, kind: "basic" }, { from: 2, to: 0, kind: "basic" },
        { from: 4, to: 3, kind: "basic" }, { from: 3, to: 4, kind: "basic" },
        { from: 4, to: 5, kind: "basic" }, { from: 5, to: 4, kind: "basic" },
      ],
      start: 0,
      finish: null,
      vectorByCorridorsSettings: { ...useMazeStore.getState().vectorByCorridorsSettings, splitSpecialShapes: true },
      vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true, warnings: true },
    });
    render(<VectorByCorridorsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.warning_waypoint_on_split"]())).toBeInTheDocument();
  });

  describe("Teleports section (GitHub issue #313)", () => {
    beforeEach(() => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 3, y: 3, i: 0 }],
        edges: [{ from: 0, to: 1, kind: "teleport" }],
      });
    });

    it("is hidden when the maze has no teleport edges", () => {
      useMazeStore.setState({ edges: [] });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.queryByText(m["image_export.vector_by_walls.section_teleports"]())).not.toBeInTheDocument();
    });

    it("appears once the maze has a teleport edge, and renders its fields once expanded", () => {
      useMazeStore.setState({ vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true, teleports: true } });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_teleports"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_subsection_edges"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_subsection_connector"]())).toBeInTheDocument();
    });

    it("changing the teleport size slider patches vectorByCorridorsSettings, same reuse convention as MarkerSettingsGroup", () => {
      useMazeStore.setState({ vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true, teleports: true } });
      render(<VectorByCorridorsSettingsPanel />);
      // GitHub issue #322 follow-up: `teleportLineSize` now shares its default (0.16) with
      // `startMarker`/`finishMarker.size`, so `getByDisplayValue` alone is ambiguous with the
      // "Waypoints" section's own size sliders also expanded — the Teleports section's slider is
      // the last of the three "0.16" sliders in document order.
      const sliders = screen.getAllByDisplayValue(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.teleportLineSize.toFixed(2));
      fireEvent.change(sliders[sliders.length - 1], { target: { value: "0.5" } });
      expect(useMazeStore.getState().vectorByCorridorsSettings.teleportLineSize).toBe(0.5);
    });

    it("stays visible when the only teleport is on another floor (GitHub issue #484)", () => {
      useMazeStore.setState({
        floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 1, y: 0, i: 0, level: 1 }, { id: 2, x: 3, y: 3, i: 0, level: 1 },
        ],
        edges: [{ from: 1, to: 2, kind: "teleport" }, { from: 2, to: 1, kind: "teleport" }],
      });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_teleports"]())).toBeInTheDocument();
    });

    it("lists a teleport group whose pair lives entirely on another floor (GitHub issue #484)", () => {
      useMazeStore.setState({
        floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 1, y: 0, i: 0, level: 1 }, { id: 2, x: 3, y: 3, i: 0, level: 1 },
        ],
        edges: [{ from: 1, to: 2, kind: "teleport" }, { from: 2, to: 1, kind: "teleport" }],
        vectorByCorridorsSectionsExpanded: { cells: true, waypoints: true, teleports: true },
        vectorByCorridorsSettings: { ...useMazeStore.getState().vectorByCorridorsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.getAllByTitle(m["image_export.vector_by_walls.teleport_group_override_shape"]())).toHaveLength(1);
    });
  });

  describe("Section visibility is project-wide, not per-floor (GitHub issue #484)", () => {
    const twoFloors = [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }];

    it("keeps the Splits section visible when the only split point is on another floor", () => {
      useMazeStore.setState({
        floors: twoFloors,
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 5, y: 5, i: 0, level: 1 }, { id: 2, x: 5, y: 5, i: 0, level: 1 },
        ],
      });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_splits"]())).toBeInTheDocument();
    });

    it("keeps the One-ways section visible when the only one-way edge is on another floor", () => {
      useMazeStore.setState({
        floors: twoFloors,
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 1, y: 0, i: 0, level: 1 }, { id: 2, x: 2, y: 0, i: 0, level: 1 },
        ],
        edges: [{ from: 1, to: 2, kind: "basic" as const }],
      });
      render(<VectorByCorridorsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_one_ways"]())).toBeInTheDocument();
    });
  });
});
