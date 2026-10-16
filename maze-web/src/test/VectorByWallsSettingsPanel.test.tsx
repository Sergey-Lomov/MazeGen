import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { pickColor, pickColorForLabel } from "./colorTestHelpers";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import { distributeOklchHues } from "../store/colorMath";
import * as m from "~/paraglide/messages";
import { fakeCellCenters } from "./cellCentersFake";

// getCellCenter (via squareGeometry's getCartesian, used by buildTeleportEdges for the Teleports
// section's group list) delegates to wasm, unavailable in this unit-test environment — mocked with
// the canonical square formula (see `maze-core/src/space/square.rs`'s `cartesian`), same as
// `issueHighlightSelectors.test.ts`.
vi.mock("../wasm/mazeService", () => ({
  generateMaze: vi.fn(),
  computeAnalytics: vi.fn(),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
  getCellCenters: vi.fn((config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config)),
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
    // Start/Finish became their own collapsible sections, each split into "Marker"/"Symbol"
    // sub-sections (GitHub issue #697 follow-up) — expanded here too so the marker-field
    // interaction tests below don't each need their own expand steps.
    vectorByWallsSectionsExpanded: {
      background: true, tiles: true, markers: true, one_ways: true,
      markers_start: true, markers_finish: true,
      markers_start_marker: true, markers_finish_marker: true,
    },
    vectorByWallsSettings: {
      background: 0x1a1a1a,
      showGrid: true,
      gridColor: 0xffffff,
      showInnerGrid: false,
      innerGridColor: 0xffffff,
      floorColor: 0x2a2a2a,
      wallColor: 0x0a0a0a,
      randomWallColorMode: "off",
      wallJoin: "round",
      wallThickness: 3,
      oneWayPattern: "triangle",
      oneWayColor: 0xff0000,
      oneWayGapWidth: 0,
      oneWaySize: 0.18,
      oneWayThickness: 4,
      oneWayJoin: "round",
      startMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0x00ff00, borderColor: 0x00ff00, borderWidth: 0, gapWidth: 0, size: 0.225, text: "S" },
      finishMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 0, gapWidth: 0, size: 0.225, text: "F" },
      teleportMarker: { cornerStyle: "miter", shape: "square", size: 0.3, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 0 },
      teleportConnectorColor: 0,
      teleportConnectorWidth: 3,
      teleportConnectorStyle: "straight",
      teleportAvoidFieldExit: false,
      teleportArrowMode: "center",
      teleportArrowPeriod: 5,
      teleportArrowSize: 6,
      teleportConnectorGapWidth: 0,
      teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
      teleportGroupCustomization: false,
      teleportGroupOverrides: {},
      ...DEFAULT_VERTICAL_SETTINGS,
      ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
      ...DEFAULT_VERTICAL_SHARED_STYLE,
      verticalDecorativeLineColor: 0x123456,
      verticalDecorativeLineWidth: 2,
      verticalDecorativeSize: 0.22,
      verticalDecorativeArrowSize: 0.75,
      splitNodeColors: [],
      splitSpecialShapes: false,
      markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
      floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
      ...DEFAULT_SHARED_STYLE_SOURCE,
      links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    },
  });
});

/** Teleports subsections are collapsed by default (GitHub issue #727) — open every one that is rendered. */
function expandTeleportSubsections() {
  const labels = [
    m["image_export.vector_by_walls.teleport_subsection_edges"](),
    m["image_export.vector_by_walls.teleport_subsection_connector"](),
    m["image_export.vector_by_walls.teleport_subsection_floor_badges"](),
    m["image_export.vector_by_walls.teleport_group_customization"](),
  ];
  for (const label of labels) {
    const header = screen.queryByText(label);
    if (header) fireEvent.click(header);
  }
}

describe("VectorByWallsSettingsPanel", () => {
  it("toggles persisted color-warning visibility from the Problems section", () => {
    useMazeStore.setState({ vectorByWallsSectionsExpanded: { warnings: true }, showColorWarnings: true });
    render(<VectorByWallsSettingsPanel />);

    const label = screen.getByText(m["image_export.warning.show_color_warnings"]());
    const checkbox = label.parentElement!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(useMazeStore.getState().showColorWarnings).toBe(false);
    expect(useMazeStore.getState().hoveredExportWarningKey).toBeNull();
  });

  it("renders elevator simplification under the elevator marker sub-section", () => {
    useMazeStore.setState({
      floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }],
      edges: [{ from: 0, to: 1, kind: "elevator" }],
      vectorByWallsSectionsExpanded: { vertical: true, vertical_elevator: true },
    });
    render(<VectorByWallsSettingsPanel />);

    const toggle = screen.getByText(m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"]());
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle.parentElement!.parentElement!.querySelector('input[type="checkbox"]')!);
    expect(useMazeStore.getState().vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs).toBe(false);
  });

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
    expect(screen.getByText(m["image_export.vector_by_walls.show_inner_grid"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.inner_grid_color"]())).toBeInTheDocument();
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

  it("toggling 'show inner grid' updates only the inner-grid setting", () => {
    render(<VectorByWallsSettingsPanel />);
    const label = screen.getByText(m["image_export.vector_by_walls.show_inner_grid"]());
    const checkbox = label.parentElement!.parentElement!.querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);
    expect(useMazeStore.getState().vectorByWallsSettings.showInnerGrid).toBe(true);
    expect(useMazeStore.getState().vectorByWallsSettings.showGrid).toBe(true);
  });

  it("grid color swatch is disabled (aria-disabled) when showGrid is off", () => {
    useMazeStore.setState({
      vectorByWallsSettings: {
        background: 0, showGrid: false, gridColor: 0, showInnerGrid: false, innerGridColor: 0, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 3,
        oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 0, oneWaySize: 0.18, oneWayThickness: 4, oneWayJoin: "round",
        startMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225, text: "S" },
        finishMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.225, text: "F" },
        teleportMarker: { cornerStyle: "miter", shape: "square", size: 0.3, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 0 },
        teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "straight", teleportAvoidFieldExit: false,
        teleportArrowMode: "center", teleportArrowPeriod: 5, teleportArrowSize: 6, teleportConnectorGapWidth: 0,
        teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
        teleportGroupCustomization: false, teleportGroupOverrides: {},
        ...DEFAULT_VERTICAL_SETTINGS,
        ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
        ...DEFAULT_VERTICAL_SHARED_STYLE,
        verticalDecorativeLineColor: 0,
        verticalDecorativeLineWidth: 2,
        verticalDecorativeSize: 0.22,
        verticalDecorativeArrowSize: 0.75,
        splitNodeColors: [], splitSpecialShapes: false,
        markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
        floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
        ...DEFAULT_SHARED_STYLE_SOURCE,
        links: DEFAULT_VECTOR_BY_WALLS_LINKS,
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
    pickColorForLabel(screen.getByText(m["image_export.vector_by_walls.floor_color"]()), "#ff00aa");
    expect(useMazeStore.getState().vectorByWallsSettings.floorColor).toBe(0xff00aa);
  });

  it("changing the wall color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    pickColorForLabel(screen.getByText(m["image_export.vector_by_walls.wall_color"]()), "#00ff00");
    expect(useMazeStore.getState().vectorByWallsSettings.wallColor).toBe(0x00ff00);
  });

  it("toggles random wall colors and maps the displayed modes to their requested behavior", () => {
    render(<VectorByWallsSettingsPanel />);
    const toggle = screen.getByText(m["image_export.vector_by_walls.random_wall_colors"]());
    fireEvent.click(toggle.parentElement!.parentElement!.querySelector('input[type="checkbox"]')!);
    expect(screen.queryByText(m["image_export.vector_by_walls.wall_color"]())).not.toBeInTheDocument();
    expect(screen.getByText(m["image_export.vector_by_walls.random_wall_color_mode"]())).toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSettings.randomWallColorMode).toBe("per_pass");

    const modeSelect = screen.getByDisplayValue(m["image_export.vector_by_walls.random_wall_colors_per_segment"]());
    expect(modeSelect).toHaveValue("per_pass");
    fireEvent.change(modeSelect, { target: { value: "per_segment" } });
    expect(useMazeStore.getState().vectorByWallsSettings.randomWallColorMode).toBe("per_segment");
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
    // Fill/Border color labels: [0] start marker, [1] finish marker.
    pickColorForLabel(screen.getAllByText(m["image_export.vector_by_walls.marker_fill_color"]())[0], "#123456");
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.fillColor).toBe(0x123456);
  });

  it("changing the start marker border color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    pickColorForLabel(screen.getAllByText(m["image_export.vector_by_walls.marker_border_color"]())[0], "#abcdef");
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
    pickColorForLabel(screen.getAllByText(m["image_export.vector_by_walls.marker_fill_color"]())[1], "#654321");
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.fillColor).toBe(0x654321);
  });

  it("changing the finish marker border color updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    pickColorForLabel(screen.getAllByText(m["image_export.vector_by_walls.marker_border_color"]())[1], "#fedcba");
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.borderColor).toBe(0xfedcba);
  });

  it("changing the start marker corner style updates the store (GitHub issue #302)", () => {
    render(<VectorByWallsSettingsPanel />);
    const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.corner_style_sharp"]());
    fireEvent.change(selects[0], { target: { value: "round" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.cornerStyle).toBe("round");
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.cornerStyle).toBe("miter");
  });

  it("changing the finish marker corner style updates only the finish marker", () => {
    render(<VectorByWallsSettingsPanel />);
    const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.corner_style_sharp"]());
    fireEvent.change(selects[1], { target: { value: "round" } });
    expect(useMazeStore.getState().vectorByWallsSettings.finishMarker.cornerStyle).toBe("round");
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.cornerStyle).toBe("miter");
  });

  it("changing the start marker size updates the store", () => {
    render(<VectorByWallsSettingsPanel />);
    const slider = screen.getAllByText(m["image_export.vector_by_walls.marker_size"]())[0]
      .parentElement!.querySelector('input[type="range"]')!;
    fireEvent.change(slider, { target: { value: "20" } });
    expect(useMazeStore.getState().vectorByWallsSettings.startMarker.size).toBe(20);
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
    pickColorForLabel(screen.getByText(m["image_export.vector_by_walls.one_way_color"]()), "#112233");
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
    fireEvent.change(slider, { target: { value: "12" } });
    expect(useMazeStore.getState().vectorByWallsSettings.oneWaySize).toBe(12);
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
      expandTeleportSubsections();
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_arrow_mode"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.teleport_group_customization"]())).toBeInTheDocument();
    });

    it("changing the corner style updates the store", () => {
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      const select = screen.getByDisplayValue(m["image_export.vector_by_walls.corner_style_sharp"]());
      fireEvent.change(select, { target: { value: "round" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportMarker.cornerStyle).toBe("round");
    });

    it("changing the marker size updates the store", () => {
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      // `teleport_size` (marker size) and `teleport_arrow_size` (GitHub issue #293 follow-up: the
      // arrow subsection's own labels dropped the redundant "arrow" word since the subsection
      // heading already says it) both render as the same "Size" text — this is the first (and
      // only marker-size) match, `teleport_arrow_size`'s own field appears later in the DOM.
      const slider = screen.getAllByText(m["image_export.vector_by_walls.teleport_size"]())[0]
        .parentElement!.querySelector('input[type="range"]')!;
      fireEvent.change(slider, { target: { value: "24" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportMarker.size).toBe(24);
    });

    it("changing the edge gap width updates the store (GitHub issue #302)", () => {
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      const slider = screen.getAllByText(m["image_export.vector_by_walls.teleport_edge_gap_width"]())[0]
        .parentElement!.querySelector('input[type="range"]')!;
      fireEvent.change(slider, { target: { value: "7" } });
      expect(useMazeStore.getState().vectorByWallsSettings.teleportMarker.gapWidth).toBe(7);
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
      expandTeleportSubsections();
      const toggle = screen.getByText(m["image_export.vector_by_walls.teleport_group_customization_enable"]())
        .parentElement!.parentElement!.querySelector('input[type="checkbox"]')!;
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
      expandTeleportSubsections();

      // The group row's fill-color swatch is wrapped in a `<span title=...>` (no visible label).
      const fillWrap = document.querySelector(
        `[title="${m["image_export.vector_by_walls.teleport_group_override_color"]()}"]`,
      )!;
      pickColor(fillWrap.querySelector('[role="button"]')!, "#abcdef");
      const groupKey = Object.keys(useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides)[0];
      expect(useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides[groupKey].fillColor).toBe(0xabcdef);
    });

    it("auto fills / auto borders distribute the base marker colors over the groups, each touching only its own role (GitHub issue #728)", () => {
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
      expandTeleportSubsections();
      const { fillColor, borderColor } = useMazeStore.getState().vectorByWallsSettings.teleportMarker;

      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.teleport_group_auto_fill"]()));
      let overrides = useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides;
      const [key] = Object.keys(overrides);
      expect(overrides[key].fillColor).toBe(distributeOklchHues(fillColor, 1)[0]);
      expect(overrides[key].borderColor).toBeUndefined();

      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.teleport_group_auto_border"]()));
      overrides = useMazeStore.getState().vectorByWallsSettings.teleportGroupOverrides;
      expect(overrides[key].borderColor).toBe(distributeOklchHues(borderColor, 1)[0]);
      expect(overrides[key].fillColor).toBe(distributeOklchHues(fillColor, 1)[0]);
    });

    it("disables the common connector color row with an explanatory tooltip while group customization is on", () => {
      const hint = m["image_export.vector_by_walls.teleport_group_secondary_color_hint"]();
      const base = {
        nodes: [
          { id: 0, x: 0, y: 0, i: 0 },
          { id: 1, x: 5, y: 5, i: 0 },
        ],
        edges: [
          { from: 0, to: 1, kind: "teleport" as const },
          { from: 1, to: 0, kind: "teleport" as const },
        ],
      };
      const settings = { ...useMazeStore.getState().vectorByWallsSettings, teleportConnectorStyle: "straight" as const };
      useMazeStore.setState({ ...base, vectorByWallsSettings: { ...settings, teleportGroupCustomization: true } });
      const { unmount } = render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      expect(document.querySelectorAll(`[title="${hint}"]`).length).toBeGreaterThan(0);
      unmount();

      useMazeStore.setState({ ...base, vectorByWallsSettings: { ...settings, teleportGroupCustomization: false } });
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      expect(document.querySelectorAll(`[title="${hint}"]`)).toHaveLength(0);
    });

    it("hides the auto buttons while group customization is off", () => {
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
      expandTeleportSubsections();
      expect(screen.queryByText(m["image_export.vector_by_walls.teleport_group_auto_fill"]())).toBeNull();
    });

    const twoWayTeleportState = () => useMazeStore.setState({
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

    it("renders a group cell with a title and one bubble pair per teleport", () => {
      twoWayTeleportState();
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.getByText("0:0")).toBeTruthy();
      expect(screen.getByText("5:5")).toBeTruthy();
      expect(screen.getByText("<->")).toBeTruthy();
    });

    it("hovering the card highlights every teleport cell, a bubble only its own cell, the arrow its teleport's two cells", () => {
      twoWayTeleportState();
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      const hovered = () => useMazeStore.getState().hoveredTeleportNodeIds;
      fireEvent.mouseEnter(screen.getByText("#1"));
      expect(hovered()).toEqual([0, 1]);
      fireEvent.mouseEnter(screen.getByText("0:0"));
      expect(hovered()).toEqual([0]);
      fireEvent.mouseEnter(screen.getByText("5:5"));
      expect(hovered()).toEqual([1]);
      fireEvent.mouseEnter(screen.getByText("<->"));
      expect(hovered()).toEqual([0, 1]);
      fireEvent.mouseLeave(screen.getByText("#1"));
      expect(hovered()).toBeNull();
    });

    it("Teleports subsections are collapsed by default", () => {
      twoWayTeleportState();
      render(<VectorByWallsSettingsPanel />);
      expect(screen.queryByText(m["image_export.vector_by_walls.teleport_arrow_mode"]())).toBeNull();
      expect(screen.queryByText("#1")).toBeNull();
    });

    it("collapsing the Group customization subsection hides the group cells and clears the hover", () => {
      twoWayTeleportState();
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      fireEvent.mouseEnter(screen.getByText("0:0"));
      expect(useMazeStore.getState().hoveredTeleportNodeIds).not.toBeNull();
      fireEvent.click(screen.getByText(m["image_export.vector_by_walls.teleport_group_customization"]()));
      expect(screen.queryByText("#1")).toBeNull();
      expect(useMazeStore.getState().hoveredTeleportNodeIds).toBeNull();
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
      expandTeleportSubsections();
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

  describe("Vertical connections section", () => {
    it("shows the two-way passage sub-group when the maze has a forward+reverse edge pair (GitHub issue #347 follow-up)", () => {
      // A bidirectional VerticalPassage is stored as two directed edges (a->b, b->a) — the presence
      // check must run against unscoped `edges`, not per-floor-scoped data, or the reverse-pair
      // match can never succeed (see `VectorByWallsSettingsPanel.tsx`'s own doc comment on
      // `hasTwoWayPassages`).
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [
          { from: 0, to: 1, kind: "vertical_passage" as const },
          { from: 1, to: 0, kind: "vertical_passage" as const },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, vertical: true },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.two_way_passage_marker"]())).toBeInTheDocument();
    });

    it("shows the two-way passage sub-group disabled when only a one-way edge exists", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [{ from: 0, to: 1, kind: "vertical_passage" as const }],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, vertical: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const twoWayHeader = screen.getByText(m["image_export.vector_by_walls.two_way_passage_marker"]());
      expect(twoWayHeader.parentElement).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(twoWayHeader);
      expect(useMazeStore.getState().vectorByWallsSectionsExpanded.vertical_two_way).toBeUndefined();
      expect(screen.getByText(m["image_export.vector_by_walls.one_way_passage_marker"]())).toBeInTheDocument();
    });

    it("shows the decorative-style sub-groups (line color/width/size) instead of the marker-shaped ones when verticalStyle is 'decorative'", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [
          { from: 0, to: 1, kind: "vertical_passage" as const },
          { from: 1, to: 0, kind: "vertical_passage" as const },
        ],
        vectorByWallsSectionsExpanded: {
          ...useMazeStore.getState().vectorByWallsSectionsExpanded,
          vertical: true,
          vertical_two_way: true,
        },
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, verticalStyle: "decorative" },
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.two_way_passage_marker"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.decorative_line_color"]())).toBeInTheDocument();
      expect(screen.getByText(m["image_export.vector_by_walls.decorative_line_width"]())).toBeInTheDocument();
    });

    it("the two-way passage sub-group starts collapsed and expands on header click", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [
          { from: 0, to: 1, kind: "vertical_passage" as const },
          { from: 1, to: 0, kind: "vertical_passage" as const },
        ],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, vertical: true },
      });
      render(<VectorByWallsSettingsPanel />);
      const header = screen.getByText(m["image_export.vector_by_walls.two_way_passage_marker"]());
      // The "Marker"/"Arrows" sub-subsections are plain indented labels, not collapsible — only
      // the outer sub-group's own header click toggles visibility of everything under it.
      // `vertical_arrow_style`'s own label ("Style") isn't unique on the page (shared with other
      // style pickers), and `vertical_subsection_arrows`'s own label
      // ("Arrow") collides with the arrow-style `<select>`'s own "Arrow" pattern `<option>` — assert
      // on the arrow-style select's own default display value instead, same as the "changing the
      // two-way arrow style" test below.
      expect(screen.queryByDisplayValue(m["image_export.vector_by_walls.one_way_pattern_triangle"]())).not.toBeInTheDocument();
      fireEvent.click(header);
      expect(screen.getByDisplayValue(m["image_export.vector_by_walls.one_way_pattern_triangle"]())).toBeInTheDocument();
      expect(useMazeStore.getState().vectorByWallsSectionsExpanded.vertical_two_way).toBe(true);
      fireEvent.click(header);
      expect(screen.queryByDisplayValue(m["image_export.vector_by_walls.one_way_pattern_triangle"]())).not.toBeInTheDocument();
    });

    it("changing the two-way arrow style updates the store", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [
          { from: 0, to: 1, kind: "vertical_passage" as const },
          { from: 1, to: 0, kind: "vertical_passage" as const },
        ],
        vectorByWallsSectionsExpanded: {
          ...useMazeStore.getState().vectorByWallsSectionsExpanded,
          vertical: true,
          vertical_two_way: true,
          vertical_two_way_arrows: true,
        },
      });
      render(<VectorByWallsSettingsPanel />);
      const select = screen.getByDisplayValue(m["image_export.vector_by_walls.one_way_pattern_triangle"]());
      fireEvent.change(select, { target: { value: "chevron" } });
      expect(useMazeStore.getState().vectorByWallsSettings.twoWayArrowStyle).toBe("chevron");
    });

    it("one-way sub-group shows the marker's own border color, same as the two-way marker (GitHub issue #693)", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [{ from: 0, to: 1, kind: "vertical_passage" as const }],
        vectorByWallsSectionsExpanded: {
          ...useMazeStore.getState().vectorByWallsSectionsExpanded,
          vertical: true,
          vertical_one_way: true,
          vertical_one_way_marker: true,
        },
      });
      render(<VectorByWallsSettingsPanel />);
      // "Border color" appears for Start/Finish markers, the "Vertical connections" shared-style
      // marker row, and the one-way sub-group's own marker.
      expect(screen.getAllByText(m["image_export.vector_by_walls.marker_border_color"]())).toHaveLength(3);
    });

    it("changing the one-way marker's border color updates the store", () => {
      useMazeStore.setState({
        nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
        edges: [{ from: 0, to: 1, kind: "vertical_passage" as const }],
        vectorByWallsSectionsExpanded: {
          ...useMazeStore.getState().vectorByWallsSectionsExpanded,
          vertical: true,
          vertical_one_way: true,
          vertical_one_way_marker: true,
        },
      });
      render(<VectorByWallsSettingsPanel />);
      const borderRows = screen.getAllByText(m["image_export.vector_by_walls.marker_border_color"]());
      pickColorForLabel(borderRows[borderRows.length - 1], "#112233");
      expect(useMazeStore.getState().vectorByWallsSettings.oneWayPassageMarker.borderColor).toBe(0x112233);
    });

    describe("Elevator badges subsection (GitHub issue #430)", () => {
      function setElevatorState(overrides?: { elevatorBadgesEnabled?: boolean }) {
        useMazeStore.setState({
          nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 1 }],
          edges: [{ from: 0, to: 1, kind: "elevator" as const }],
          vectorByWallsSectionsExpanded: {
            ...useMazeStore.getState().vectorByWallsSectionsExpanded,
            vertical: true,
            vertical_elevator: true,
          },
          vectorByWallsSettings: {
            ...useMazeStore.getState().vectorByWallsSettings,
            elevatorBadges: {
              ...useMazeStore.getState().vectorByWallsSettings.elevatorBadges,
              ...(overrides?.elevatorBadgesEnabled !== undefined ? { enabled: overrides.elevatorBadgesEnabled } : {}),
            },
          },
        });
      }

      it("renders the elevator badges toggle when the elevator sub-group is expanded", () => {
        setElevatorState();
        render(<VectorByWallsSettingsPanel />);
        expect(screen.getByText(m["image_export.vector_by_walls.elevator_badges_enabled"]())).toBeInTheDocument();
      });

      it("hides the rest of the elevator badges fields when disabled", () => {
        setElevatorState({ elevatorBadgesEnabled: false });
        render(<VectorByWallsSettingsPanel />);
        expect(screen.queryByText(m["image_export.vector_by_walls.elevator_badges_label_type"]())).not.toBeInTheDocument();
      });

      it("toggling elevator badges on shows the rest of the fields and updates the store", () => {
        setElevatorState({ elevatorBadgesEnabled: false });
        render(<VectorByWallsSettingsPanel />);
        const toggle = screen.getByText(m["image_export.vector_by_walls.elevator_badges_enabled"]())
          .closest("div")!.querySelector('input[type="checkbox"]') as HTMLInputElement;
        fireEvent.click(toggle);
        expect(useMazeStore.getState().vectorByWallsSettings.elevatorBadges.enabled).toBe(true);
        expect(screen.getByText(m["image_export.vector_by_walls.elevator_badges_label_type"]())).toBeInTheDocument();
      });

      it("changing the label type updates the store", () => {
        setElevatorState({ elevatorBadgesEnabled: true });
        render(<VectorByWallsSettingsPanel />);
        const select = screen.getByDisplayValue(m["image_export.vector_by_walls.elevator_badges_label_type_letters"]());
        fireEvent.change(select, { target: { value: "roman" } });
        expect(useMazeStore.getState().vectorByWallsSettings.elevatorBadges.labelType).toBe("roman");
      });

      it("changing the font weight updates the store", () => {
        setElevatorState({ elevatorBadgesEnabled: true });
        render(<VectorByWallsSettingsPanel />);
        // GitHub issue #697 follow-up added two other "bold" font-weight selects (start/finish
        // marker text) rendered earlier in the panel — the elevator badges one is last.
        const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]());
        const select = selects[selects.length - 1];
        fireEvent.change(select, { target: { value: "regular" } });
        expect(useMazeStore.getState().vectorByWallsSettings.elevatorBadges.textFontWeight).toBe("regular");
      });

      it("changing the corner style updates the store and disables its shared-style link (GitHub issue #322 follow-up)", () => {
        setElevatorState({ elevatorBadgesEnabled: true });
        render(<VectorByWallsSettingsPanel />);
        // `elevatorMarker`'s own "Corner style" row (`MarkerSettingsGroup`) and `elevatorBadges`'
        // own row (`ElevatorBadgesSubsection`) share the same label text — the badges row is the
        // one rendered second (badges sit under the elevator marker's own sub-group).
        const selects = screen.getAllByDisplayValue(m["image_export.vector_by_walls.corner_style_round"]());
        fireEvent.change(selects[selects.length - 1], { target: { value: "miter" } });
        expect(useMazeStore.getState().vectorByWallsSettings.elevatorBadges.cornerStyle).toBe("miter");
        const links = useMazeStore.getState().vectorByWallsSettings.links;
        expect(links.find((l) => l.target === "elevatorBadges.cornerStyle")?.enabled).toBe(false);
      });

      it("changing the fill color updates the store", () => {
        setElevatorState({ elevatorBadgesEnabled: true });
        render(<VectorByWallsSettingsPanel />);
        // "Fill color" text also matches `elevatorMarker`'s own row (`MarkerSettingsGroup`) — the
        // badges row is the one rendered second.
        const labels = screen.getAllByText(m["image_export.vector_by_walls.elevator_badges_fill_color"]());
        pickColorForLabel(labels[labels.length - 1], "#112233");
        expect(useMazeStore.getState().vectorByWallsSettings.elevatorBadges.fillColor).toBe(0x112233);
      });
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
      pickColorForLabel(screen.getByText(m["image_export.vector_by_walls.split_node_color"]({ index: "2" })), "#123456");
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
        .parentElement!.parentElement!.querySelector('input[type="checkbox"]')!;
      fireEvent.click(checkbox);
      expect(useMazeStore.getState().vectorByWallsSettings.splitSpecialShapes).toBe(true);
    });
  });

  describe("Section visibility is project-wide, not per-floor (GitHub issue #484)", () => {
    // A component sitting only on a non-active floor still keeps its section visible, so switching
    // floors never adds or removes a section (which flickered the panel).
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
      render(<VectorByWallsSettingsPanel />);
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
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_one_ways"]())).toBeInTheDocument();
    });

    it("keeps the Teleports section visible when the only teleport is on another floor", () => {
      useMazeStore.setState({
        floors: twoFloors,
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 1, y: 0, i: 0, level: 1 }, { id: 2, x: 3, y: 3, i: 0, level: 1 },
        ],
        edges: [{ from: 1, to: 2, kind: "teleport" as const }, { from: 2, to: 1, kind: "teleport" as const }],
      });
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_teleports"]())).toBeInTheDocument();
    });

    it("lists a teleport group whose pair lives entirely on another floor", () => {
      useMazeStore.setState({
        floors: twoFloors,
        activeFloorId: "f1",
        nodes: [
          { id: 0, x: 0, y: 0, i: 0, level: 0 },
          { id: 1, x: 1, y: 0, i: 0, level: 1 }, { id: 2, x: 3, y: 3, i: 0, level: 1 },
        ],
        edges: [{ from: 1, to: 2, kind: "teleport" as const }, { from: 2, to: 1, kind: "teleport" as const }],
        vectorByWallsSectionsExpanded: { ...useMazeStore.getState().vectorByWallsSectionsExpanded, teleports: true },
        vectorByWallsSettings: { ...useMazeStore.getState().vectorByWallsSettings, teleportGroupCustomization: true },
      });
      render(<VectorByWallsSettingsPanel />);
      expandTeleportSubsections();
      // One `TeleportGroupRow` — its shape dropdown carries the "override shape" title.
      expect(screen.getAllByTitle(m["image_export.vector_by_walls.teleport_group_override_shape"]())).toHaveLength(1);
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
          teleportMarker: { ...useMazeStore.getState().vectorByWallsSettings.teleportMarker, borderWidth: 0, fillColor: 0xffffff },
          teleportConnectorColor: 0xffffff,
        },
      });

    it("shows the section with a zero count when there are no warnings", () => {
      render(<VectorByWallsSettingsPanel />);
      expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "0" }))).toBeInTheDocument();
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

describe("VectorByWallsSettingsPanel start/finish caption (GitHub issue #723)", () => {
  const withCaption = (textEnabled: boolean) => {
    const st = useMazeStore.getState();
    const { startMarker, finishMarker } = st.vectorByWallsSettings;
    useMazeStore.setState({
      vectorByWallsSettings: {
        ...st.vectorByWallsSettings,
        startMarker: { ...startMarker, textEnabled, textColor: 0x112233 },
        finishMarker: { ...finishMarker, textEnabled, textColor: 0x112233 },
      },
      vectorByWallsSectionsExpanded: { ...st.vectorByWallsSectionsExpanded, markers_start_text: true, markers_finish_text: true },
    });
  };

  it("hides caption text and style rows when the caption is off, keeping the toggle", () => {
    withCaption(false);
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_text_show"]())).toHaveLength(2);
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text"]())).toBeNull();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text_color"]())).toBeNull();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text_size"]())).toBeNull();
    expect(screen.queryByText(m["image_export.vector_by_walls.marker_text_font_weight"]())).toBeNull();
  });

  it("shows caption text and style rows when the caption is on", () => {
    withCaption(true);
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_text_color"]())).toHaveLength(2);
    expect(screen.getAllByText(m["image_export.vector_by_walls.marker_text_size"]())).toHaveLength(2);
  });
});
