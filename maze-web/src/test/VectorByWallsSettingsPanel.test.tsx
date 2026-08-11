import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE } from "../store/slices/imageExportSlice";
import * as m from "~/paraglide/messages";

// getCellCenter (via squareGeometry's getCartesian, used by buildTeleportEdges for the Teleports
// section's group list) delegates to wasm, unavailable in this unit-test environment — mocked with
// the canonical square formula (see `maze-core/src/space/square.rs`'s `cartesian`), same as
// `issueHighlightSelectors.test.ts`.
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
    // One-ways/Teleports sections only render when the maze actually has that kind of edge
    // (GitHub issue #298 follow-up, mirrors the pre-existing Splits section gating) — a one-way
    // edge here so the top-level One-ways tests below don't need their own maze setup; the
    // "Teleports section" describe block below adds its own teleport edges.
    nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
    edges: [{ from: 0, to: 1, kind: "basic" as const }],
    // All sections start collapsed (GitHub issue #292 follow-up) — expanded here so the
    // field-interaction tests below don't each need their own expand step. Collapsed-by-default
    // itself is covered by the dedicated "all sections start collapsed" test.
    vectorByWallsSectionsExpanded: { background: true, tiles: true, markers: true, one_ways: true },
    vectorByWallsSettings: {
      background: 0x1a1a1a,
      showGrid: true,
      gridColor: 0x333333,
      floorColor: 0x2a2a2a,
      wallColor: 0x0a0a0a,
      wallJoin: "round",
      wallThickness: 3,
      oneWayPattern: "triangle",
      oneWayColor: 0xff0000,
      oneWayGapWidth: 0,
      oneWaySize: 0.18,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0x00ff00, borderColor: 0x00ff00, borderWidth: 0, gapWidth: 0, size: 0.225 },
      finishMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 0, gapWidth: 0, size: 0.225 },
      teleportLineCornerStyle: "sharp",
      teleportLineShape: "square",
      teleportLineSize: 0.3,
      teleportEdgeColor: 0,
      teleportEdgeBorderColor: 0,
      teleportEdgeBorderWidth: 3,
      teleportEdgeGapWidth: 0,
      teleportConnectorColor: 0,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportAvoidFieldExit: false,
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorGapWidth: 0,
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      splitNodeColors: [],
      splitSpecialShapes: false,
      sharedStyle: DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
    },
  });
});

describe("VectorByWallsSettingsPanel", () => {
  it("all sections start collapsed (no stored expand state yet)", () => {
    useMazeStore.setState({ vectorByWallsSectionsExpanded: {} });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_walls.background_color"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.floor_color"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.markers_start"]())).not.toBeInTheDocument();
    expect(screen.queryByText(m["image_export.vector_by_walls.one_way_pattern"]())).not.toBeInTheDocument();
  });

  it("renders the background section's fields when expanded", () => {
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
    const checkbox = screen.getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);
    expect(useMazeStore.getState().vectorByWallsSettings.showGrid).toBe(false);
  });

  it("grid color swatch is disabled (aria-disabled) when showGrid is off", () => {
    useMazeStore.setState({
      vectorByWallsSettings: {
        background: 0, showGrid: false, gridColor: 0, floorColor: 0, wallColor: 0, wallJoin: "round", wallThickness: 3,
        oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 0, oneWaySize: 0.18, oneWayThickness: 4, oneWayJoin: "round",
        startMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225 },
        finishMarker: { shape: "circle", cornerStyle: "sharp", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225 },
        teleportLineCornerStyle: "sharp",
        teleportLineShape: "square", teleportLineSize: 0.3,
        teleportEdgeColor: 0, teleportEdgeBorderColor: 0, teleportEdgeBorderWidth: 3, teleportEdgeGapWidth: 0,
        teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "straight", teleportAvoidFieldExit: false,
        teleportArrowMode: "center", teleportArrowPeriod: 5, teleportArrowSize: 6, teleportConnectorGapWidth: 0,
        teleportGroupCustomization: false, teleportGroupOverrides: {},
        splitNodeColors: [], splitSpecialShapes: false,
        sharedStyle: DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
      },
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

  it("renders the tiles section's floor color, wall color, join and thickness fields when expanded", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.floor_color"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.wall_color"]())).toBeInTheDocument();
    expect(screen.getAllByText(m["image_export.vector_by_walls.wall_join"]())[0]).toBeInTheDocument();
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
    const select = screen.getAllByDisplayValue(m["image_export.vector_by_walls.wall_join_round"]())[0];
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

  it("renders the markers section's Start and Finish sub-groups when expanded", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.markers_start"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.markers_finish"]())).toBeInTheDocument();
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_shape"]())).toHaveLength(2);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_fill_color"]())).toHaveLength(2);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_border_color"]())).toHaveLength(2);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_border_width"]())).toHaveLength(2);
  });

  it("collapsing the markers section hides its fields", () => {
    render(<VectorByWallsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_markers"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.markers_start"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded.markers).toBe(false);
  });

  it("changing the start marker shape updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const select = screen.getAllByDisplayValue(m["image_export.vector_by_walls.marker_shape_circle"]())[0];
    fireEvent.change(select, { target: { value: "diamond" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.shape).toBe("diamond");
  });

  it("changing the finish marker border width updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getAllByText(m["image_export.vector_by_walls.marker_border_width"]())[1]
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "4" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.borderWidth).toBe(4);
  });

  it("changing the start marker fill color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    // Swatch order: background, grid, floor, wall, start fill, start border, finish fill, finish border, one-way.
    fireEvent.change(inputs[4], { target: { value: "#123456" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.fillColor).toBe(0x123456);
  });

  it("changing the start marker border color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    fireEvent.change(inputs[5], { target: { value: "#abcdef" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.borderColor).toBe(0xabcdef);
  });

  it("changing the finish marker shape updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const select = screen.getAllByDisplayValue(m["image_export.vector_by_walls.marker_shape_circle"]())[1];
    fireEvent.change(select, { target: { value: "star" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.shape).toBe("star");
  });

  it("changing the finish marker fill color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    fireEvent.change(inputs[6], { target: { value: "#654321" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.fillColor).toBe(0x654321);
  });

  it("changing the finish marker border color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    fireEvent.change(inputs[7], { target: { value: "#fedcba" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.borderColor).toBe(0xfedcba);
  });

  it("changing the start marker corner style updates the store (GitHub issue #302)", () => {
    render(<VectorByWallsSettingsPanel />);
    const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.teleport_corner_style_sharp"]());
    fireEvent.change(selects[0], { target: { value: "round" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.cornerStyle).toBe("round");
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.cornerStyle).toBe("sharp");
  });

  it("changing the finish marker corner style updates only the finish marker", () => {
    render(<VectorByWallsSettingsPanel />);
    const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.teleport_corner_style_sharp"]());
    fireEvent.change(selects[1], { target: { value: "round" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.cornerStyle).toBe("round");
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.cornerStyle).toBe("sharp");
  });

  it("changing the start marker size updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getAllByText(m["image_export.vector_by_walls.marker_size"]())[0]
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.size).toBe(0.5);
  });

  it("changing the finish marker gap width updates only the finish marker", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getAllByText(m["image_export.vector_by_walls.marker_gap_width"]())[1]
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "4" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.gapWidth).toBe(4);
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.gapWidth).toBe(0);
  });

  it("renders the one-ways section's pattern, color, gap width, join, size and thickness fields when expanded", () => {
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.vector_by_walls.one_way_pattern"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.one_way_color"]())).toBeInTheDocument();
    expect(screen.getAllByText(m["image_export.vector_by_walls.one_way_gap_width"]()).length).toBeGreaterThan(0);
    expect(screen.getAllByText(m["image_export.vector_by_walls.one_way_join"]()).length).toBeGreaterThan(0);
    expect(screen.getAllByText(m["image_export.vector_by_walls.one_way_size"]()).length).toBeGreaterThan(0);
    expect(screen.getByText(m["image_export.vector_by_walls.one_way_thickness"]())).toBeInTheDocument();
  });

  it("collapsing the one-ways section hides its fields", () => {
    render(<VectorByWallsSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_one_ways"]()));
    expect(screen.queryByText(m["image_export.vector_by_walls.one_way_pattern"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSectionsExpanded.one_ways).toBe(false);
  });

  it("hides the one-ways section entirely when the maze has no one-way edges (GitHub issue #298)", () => {
    useMazeStore.setState({ edges: [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }] });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_walls.section_one_ways"]())).not.toBeInTheDocument();
  });

  it("hides the teleports section entirely when the maze has no teleport edges (GitHub issue #298)", () => {
    useMazeStore.setState({ edges: [{ from: 0, to: 1, kind: "basic" }] });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.queryByText(m["image_export.vector_by_walls.section_teleports"]())).not.toBeInTheDocument();
  });

  it("changing the one-way pattern updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.vector_by_walls.one_way_pattern_triangle"]());
    fireEvent.change(select, { target: { value: "chevron" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWayPattern).toBe("chevron");
  });

  it("changing the one-way color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const inputs = document.querySelectorAll('input[type="color"]');
    // Last swatch: one-way color.
    fireEvent.change(inputs[8], { target: { value: "#112233" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWayColor).toBe(0x112233);
  });

  it("changing the one-way gap width updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const labels = screen.getAllByText(m["image_export.vector_by_walls.one_way_gap_width"]());
    const slider = labels[labels.length - 1].parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "4" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWayGapWidth).toBe(4);
  });

  it("changing the one-way join updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const select = screen.getAllByDisplayValue(m["image_export.vector_by_walls.wall_join_round"]())[1];
    fireEvent.change(select, { target: { value: "miter" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWayJoin).toBe("miter");
  });

  it("changing the one-way size updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const labels = screen.getAllByText(m["image_export.vector_by_walls.one_way_size"]());
    const slider = labels[labels.length - 1].parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "0.3" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWaySize).toBe(0.3);
  });

  it("changing the one-way thickness updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getByText(m["image_export.vector_by_walls.one_way_thickness"]())
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "6" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWayThickness).toBe(6);
  });

  describe("Teleports section", () => {
    beforeEach(() => {
      useMazeStore.setState({
        vectorByWallsSectionsExpanded: { teleports: true },
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 3, y: 3, i: 0 }],
        edges: [{ from: 0, to: 1, kind: "teleport" as const }],
      });
    });

    it("shows the base connector fields, no group list, by default (group customization off)", () => {
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_arrow_mode"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_group_customization"]())).toBeInTheDocument();
    });

    it("changing the corner style updates the store", () => {
      render(<VectorByWallsSettingsPanel />);
      const select = screen.getByDisplayValue(m["image_export.vector_by_walls.teleport_corner_style_sharp"]());
      fireEvent.change(select, { target: { value: "round" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportLineCornerStyle).toBe("round");
    });

    it("changing the marker size updates the store", () => {
      render(<VectorByWallsSettingsPanel />);
      // `teleport_size` (marker size) and `teleport_arrow_size` (GitHub issue #293 follow-up: the
      // arrow subsection's own labels dropped the redundant "arrow" word since the subsection
      // heading already says it) both render as the same "Size" text — this is the first (and
      // only marker-size) match, `teleport_arrow_size`'s own field appears later in the DOM.
      const slider = screen.getAllByText(m["image_export.vector_by_walls.teleport_size"]())[0]
        .parentElement!.querySelector('input[type="range"]')!;
      fireEvent.change(slider, { target: { value: "0.6" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportLineSize).toBe(0.6);
    });

    it("changing the edge gap width updates the store (GitHub issue #302)", () => {
      render(<VectorByWallsSettingsPanel />);
      const slider = screen.getAllByText(m["image_export.vector_by_walls.teleport_edge_gap_width"]())[0]
        .parentElement!.querySelector('input[type="range"]')!;
      fireEvent.change(slider, { target: { value: "7" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportEdgeGapWidth).toBe(7);
    });

    it("toggling group customization on shows the group list once groups exist", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
      });
      render(<VectorByWallsSettingsPanel />);
      const toggle = screen.getByText(m["image_export.vector_by_walls.teleport_group_customization"]())
        .parentElement!.querySelector('input[type="checkbox"]')!;
      fireEvent.click(toggle);
      expect(useMazeStore.getState().vectorByWallsSettings.teleportGroupCustomization).toBe(true);
    });

    it("lets a group row's fill color be overridden once group customization is on", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);

      const inputs = document.querySelectorAll('input[type="color"]');
      // Last two color inputs on the group row are fill color then border color.
      const fillColorInput = inputs[inputs.length - 2];
      fireEvent.change(fillColorInput, { target: { value: "#abcdef" } });
      const groupKey = Object.keys(useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides)[0];
      expect(useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides[groupKey].fillColor).toBe(0xabcdef);
    });

    it("clicking a group row sets selectedTeleportGroupKey, clicking it again clears it", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const row = document.querySelector(".teleport-group-row")!;
      fireEvent.click(row);
      expect(useMazeStore.getState().selectedTeleportGroupKey).not.toBeNull();
      fireEvent.click(row);
      expect(useMazeStore.getState().selectedTeleportGroupKey).toBeNull();
    });

    it("Escape clears a selected group", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const row = document.querySelector(".teleport-group-row")!;
      fireEvent.click(row);
      expect(useMazeStore.getState().selectedTeleportGroupKey).not.toBeNull();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useMazeStore.getState().selectedTeleportGroupKey).toBeNull();
    });

    it("collapsing the Teleports section clears a selected group", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const row = document.querySelector(".teleport-group-row")!;
      fireEvent.click(row);
      expect(useMazeStore.getState().selectedTeleportGroupKey).not.toBeNull();
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_teleports"]()));
      expect(useMazeStore.getState().vectorByWallsSectionsExpanded.teleports).toBe(false);
      expect(useMazeStore.getState().selectedTeleportGroupKey).toBeNull();
    });

    it("turning group customization off clears a selected group", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 1, to: 0, kind: "teleport" },
        ],
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const row = document.querySelector(".teleport-group-row")!;
      fireEvent.click(row);
      expect(useMazeStore.getState().selectedTeleportGroupKey).not.toBeNull();
      // This describe block's own `beforeEach` sets `vectorByWallsSectionsExpanded` to just
      // `{ teleports: true }`, so the background section (and its "show grid" checkbox) isn't
      // rendered here — group customization's toggle is the only checkbox on screen.
      const customizationCheckbox = screen.getAllByRole("checkbox")[0];
      fireEvent.click(customizationCheckbox);
      expect(useMazeStore.getState().vectorByWallsSettings.teleportGroupCustomization).toBe(false);
      expect(useMazeStore.getState().selectedTeleportGroupKey).toBeNull();
    });

    it("shows a collision warning when two groups resolve to the same color+shape and the connector is \"none\"", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
          { id: 2, x: 9, y: 9, i: 0 },
          { id: 3, x: 3, y: 3, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 2, to: 3, kind: "teleport" },
        ],
        vectorByWallsSettings: {
          ...useMazeStore.getState().vectorByWallsSettings,
          teleportGroupCustomization: true,
          teleportConnectorStyle: "none",
        },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getAllByTitle(m["image_export.vector_by_walls.teleport_group_collision"]())).toHaveLength(2);
    });

    it("does not show a collision warning when a connector line is drawn (groups already distinguishable)", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
          { id: 2, x: 9, y: 9, i: 0 },
          { id: 3, x: 3, y: 3, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" },
          { from: 2, to: 3, kind: "teleport" },
        ],
        vectorByWallsSettings: {
          ...useMazeStore.getState().vectorByWallsSettings,
          teleportGroupCustomization: true,
          teleportConnectorStyle: "straight",
        },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.queryAllByTitle(m["image_export.vector_by_walls.teleport_group_collision"]())).toHaveLength(0);
    });
  });

  describe("Splits section", () => {
    it("is hidden entirely when the current maze has no split points", () => {
      render(<VectorByWallsSettingsPanel />);
      expect(screen.queryByText(m["image_export.vector_by_walls.section_splits"]())).not.toBeInTheDocument();
    });

    it("shows one color row per slot, sized to the maze's largest split point", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 },
          { id: 2, x: 5, y: 5, i: 0 }, { id: 3, x: 5, y: 5, i: 0 }, { id: 4, x: 5, y: 5, i: 0 },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, splits: true },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_splits"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.split_node_color"]({ index: "1" }))).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.split_node_color"]({ index: "2" }))).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.split_node_color"]({ index: "3" }))).toBeInTheDocument();
      expect(screen.queryByText(m["image_export.vector_by_walls.split_node_color"]({ index: "4" }))).not.toBeInTheDocument();
    });

    it("collapsing the splits section header hides its fields", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 5, y: 5, i: 0 }, { id: 1, x: 5, y: 5, i: 0 },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, splits: true },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.split_special_shapes"]())).toBeInTheDocument();
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_splits"]()));
      expect(screen.queryByText(m["image_export.vector_by_walls.split_special_shapes"]())).not.toBeInTheDocument();
      expect(useMazeStore.getState().vectorByWallsSectionsExpanded.splits).toBe(false);
    });

    it("changing a slot's color updates the store", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 5, y: 5, i: 0 }, { id: 1, x: 5, y: 5, i: 0 },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, splits: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const inputs = document.querySelectorAll('input[type="color"]');
      fireEvent.change(inputs[inputs.length - 1], { target: { value: "#123456" } });
      expect(useMazeStore.getState().vectorByWallsSettings.splitNodeColors[1]).toBe(0x123456);
    });

    it("toggling special shapes updates the store", () => {
      useMazeStore.setState({
        nodes: [
          { id: 0, x: 5, y: 5, i: 0 }, { id: 1, x: 5, y: 5, i: 0 },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, splits: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const checkbox = screen.getByText(m["image_export.vector_by_walls.split_special_shapes"]())
        .parentElement!.querySelector('input[type="checkbox"]')!;
      fireEvent.click(checkbox);
      expect(useMazeStore.getState().vectorByWallsSettings.splitSpecialShapes).toBe(true);
    });
  });

  describe("Warnings section", () => {
    // A one-way teleport with border width 0 -- its exit endpoint (node 1) draws with a
    // floor-colored fill (see `resolvePointFillState`), so it's invisible with no border.
    const teleportMaze = () =>
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 3, y: 3, i: 0 }],
        edges: [{ from: 0, to: 1, kind: "teleport" as const }],
        vectorByWallsSettings: {
          ...useMazeStore.getState().vectorByWallsSettings,
          teleportEdgeBorderWidth: 0,
        },
      });

    it("hides the section entirely when there are no warnings", () => {
      render(<VectorByWallsSettingsPanel />);
      expect(screen.queryByText(/Warnings/)).not.toBeInTheDocument();
    });

    it("shows the section header with a warning count, collapsed by default", () => {
      teleportMaze();
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" }))).toBeInTheDocument();
      expect(screen.queryByText(m["image_export.vector_by_walls.warning_teleport_marker_invisible"]())).not.toBeInTheDocument();
    });

    it("expands to show one bubble per warning", () => {
      teleportMaze();
      render(<VectorByWallsSettingsPanel />);
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
      expect(screen.getByText(m["image_export.vector_by_walls.warning_teleport_marker_invisible"]())).toBeInTheDocument();
    });

    it("clicking a warning bubble opens a modal with its description", () => {
      teleportMaze();
      render(<VectorByWallsSettingsPanel />);
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.warning_teleport_marker_invisible"]()));
      expect(screen.getByText(m["image_export.vector_by_walls.warning_teleport_marker_invisible_description"]())).toBeInTheDocument();
    });

    it("hovering a warning bubble sets the hovered export-warning key in the store", () => {
      teleportMaze();
      render(<VectorByWallsSettingsPanel />);
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
      const bubble = screen.getByText(m["image_export.vector_by_walls.warning_teleport_marker_invisible"]()).closest("div")!;
      fireEvent.mouseEnter(bubble);
      expect(useMazeStore.getState().hoveredExportWarningKey).toBe("teleport_marker_invisible");
      fireEvent.mouseLeave(bubble);
      expect(useMazeStore.getState().hoveredExportWarningKey).toBeNull();
    });
  });
});
