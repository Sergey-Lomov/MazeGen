import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColorPickerPanel } from "../components/ColorPickerPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { PC } from "../pixi/selectors/projectColorsSelector";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS } from "../store/slices/parameterLinksDefaults";
import type { VectorByWallsSettings } from "../store/storeTypes";
import { bridgeSplitNodes, bridgeSplitEdges } from "./splitTopologyFixtures";
import * as m from "~/paraglide/messages";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenters } from "./cellCentersFake";

// GitHub issue #584: ColorPickerPanel had no test file at all. Covers the colorWarnings memo's full
// pipeline (field key -> overrideActiveProfileColor -> warnings attached to that field, GitHub issue
// #717) and buildProjectColorGroups' de-dup/priority logic.

vi.mock("../wasm/mazeService", () => ({
  getCellCenters: vi.fn((config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config)),
}));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

function baseWallsSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0x000000, showGrid: true, gridColor: 0x000000, showInnerGrid: false, innerGridColor: 0x000000, floorColor: 0x2a2a2a, wallColor: 0x0a0a0a,
    randomWallColorMode: "off", wallJoin: "round", wallThickness: 3,
    oneWayPattern: "triangle", oneWayColor: 0xff0000, oneWayGapWidth: 0, oneWaySize: 0.18, oneWayThickness: 4, oneWayJoin: "round",
    startMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0x00ff00, borderColor: 0x00ff00, borderWidth: 0, gapWidth: 0, size: 0.225, text: "S" },
    finishMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 0, gapWidth: 0, size: 0.225, text: "F" },
    teleportMarker: { cornerStyle: "miter", shape: "square", size: 0.3, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 0 },
    teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "straight",
    teleportAvoidFieldExit: false, teleportArrowMode: "center", teleportArrowPeriod: 5, teleportArrowSize: 6,
    teleportConnectorGapWidth: 0,
    teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
    teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    verticalDecorativeLineColor: 0x123456,
    verticalDecorativeLineWidth: 2,
    verticalDecorativeSize: 0.22,
    verticalDecorativeArrowSize: 0.75,
    splitNodeColors: [], splitSpecialShapes: false,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
    floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
    ...DEFAULT_SHARED_STYLE_SOURCE,
    links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    ...overrides,
  };
}

const noop = () => {};

describe("ColorPickerPanel export warnings (GitHub issue #584)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      showColorWarnings: true,
      openRenderModeSettings: "vector_by_walls",
      activeFieldConfig: fieldOf("square", { shape: "rect", cols: 6, rows: 6 }),
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" as const }],
      // Grid color equal to background -> zero contrast distance -> grid_low_contrast_background
      // fires (fields ["bgGrid", "bgFill"], see exportWarnings.ts's pushContrastWarningEntries).
      vectorByWallsSettings: baseWallsSettings({ background: 0x000000, gridColor: 0x000000 }),
    });
  });

  it("renders an ExportWarningBubble when a warning is attached to the edited field (warning attached to PC.bgGrid)", () => {
    render(
      <ColorPickerPanel
        color={0x000000}
        onApply={noop}
        onClose={noop}
        field={PC.bgGrid}
      />,
    );
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
    expect(screen.getByText(m["image_export.warning.grid_low_contrast_background"]())).toBeInTheDocument();
  });

  it("attaches the inner-grid floor-contrast warning to the inner-grid field", () => {
    useMazeStore.setState({
      vectorByWallsSettings: baseWallsSettings({ showGrid: false, showInnerGrid: true, innerGridColor: 0x000000, floorColor: 0x000000, wallColor: 0xffffff }),
    });
    render(
      <ColorPickerPanel
        color={0x000000}
        onApply={noop}
        onClose={noop}
        field={PC.innerGrid}
      />,
    );
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
    expect(screen.getByText(m["image_export.warning.inner_grid_low_contrast_floor"]())).toBeInTheDocument();
  });

  it("shows no warning for a field the fired warning is not attached to", () => {
    // Editing the floor color: the fired warning is attached to the grid/background fields, not the floor -- must not surface.
    render(
      <ColorPickerPanel
        color={0x2a2a2a}
        onApply={noop}
        onClose={noop}
        field={PC.tilesFloor}
      />,
    );
    expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "0" }))).toBeInTheDocument();
  });

  it("clears the warning once the working color no longer triggers it (hex edit re-runs the pipeline live)", () => {
    render(
      <ColorPickerPanel
        color={0x000000}
        onApply={noop}
        onClose={noop}
        field={PC.bgGrid}
      />,
    );
    expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" }))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(m["color_picker.hex_label"]()), { target: { value: "#ffffff" } });
    expect(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "0" }))).toBeInTheDocument();
  });

  it("shows no warnings section content when showColorWarnings is off", () => {
    useMazeStore.setState({ showColorWarnings: false });
    render(
      <ColorPickerPanel
        color={0x000000}
        onApply={noop}
        onClose={noop}
        field={PC.bgGrid}
      />,
    );
    expect(screen.queryByTestId("color-picker-export-warnings")).toBeNull();
  });

  it("attaches a split warning to its slot's split-node field", () => {
    // A split point whose slot-0 color equals the floor color -> split_low_contrast_floor fires
    // (fields [splitNode:0, tilesFloor]); the slot's own field must carry it.
    // Bridge topology is required -- a plain pair of co-located nodes with no edges produces no
    // split passages/colors at all (see splitTopologyFixtures.ts).
    useMazeStore.setState({
      nodes: bridgeSplitNodes,
      edges: bridgeSplitEdges,
      vectorByWallsSettings: baseWallsSettings({
        background: 0xffffff, gridColor: 0xaaaaaa,
        floorColor: 0x123456, splitNodeColors: [0x123456, 0xffffff],
      }),
    });
    const splitField = PC.splitNode(0);
    render(
      <ColorPickerPanel
        color={0x123456}
        onApply={noop}
        onClose={noop}
        field={splitField}
      />,
    );
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
    expect(screen.getByText(m["image_export.warning.split_low_contrast_floor"]())).toBeInTheDocument();
  });
});

describe("ColorPickerPanel label contrast warnings (GitHub issue #707 follow-up)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      showColorWarnings: true,
      openRenderModeSettings: "vector_by_walls",
      activeFieldConfig: fieldOf("square", { shape: "rect", cols: 6, rows: 6 }),
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" as const }],
      start: 0,
      finish: null,
      // Start caption color equals the start marker fill -> label_low_contrast.
      vectorByWallsSettings: baseWallsSettings({
        gridColor: 0x808080, background: 0xffffff,
        startMarker: { shape: "circle", cornerStyle: "miter", fillColor: 0x00ff00, borderColor: 0x00ff00, borderWidth: 0, gapWidth: 0, size: 20, text: "S", textColor: 0x00ff00 },
      }),
    });
  });

  it.each([
    ["start caption color", () => PC.startText],
    ["start marker fill (the caption's background)", () => PC.startFill],
  ])("shows the label contrast warning in the picker of the %s", (_label, field) => {
    render(<ColorPickerPanel color={0x00ff00} onApply={noop} onClose={noop} field={field()} />);
    fireEvent.click(screen.getByText(m["image_export.vector_by_walls.section_warnings"]({ count: "1" })));
    expect(screen.getByText(m["image_export.warning.label_low_contrast"]())).toBeInTheDocument();
  });
});

describe("ColorPickerPanel Project colors list (GitHub issue #584)", () => {
  beforeEach(() => {
    useMazeStore.setState({
      ...baseStoreState(),
      showColorWarnings: false,
      openRenderModeSettings: "vector_by_walls",
      nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
      edges: [{ from: 0, to: 1, kind: "basic" as const }],
      vectorByWallsSettings: baseWallsSettings({ floorColor: 0x2a2a2a, wallColor: 0x0a0a0a }),
    });
  });

  function openList() {
    render(
      <ColorPickerPanel
        color={0xffffff}
        onApply={noop}
        onClose={noop}
        field={PC.bgFill}
      />,
    );
    fireEvent.click(screen.getByText(m["color_picker.project_colors"]({ count: String(10) })));
    fireEvent.click(screen.getByText(m["color_picker.project_colors_show_all"]()));
  }

  it("de-dupes a priorityColors entry against the active profile's own row (same name + color)", () => {
    // tilesFloor's own row (0x2a2a2a) also appears in priorityColors -- must render once, in the
    // top group, not twice.
    render(
      <ColorPickerPanel
        color={0xffffff}
        onApply={noop}
        onClose={noop}
        field={PC.bgFill}
        priorityColors={[PC.tilesFloor.at(0x2a2a2a)]}
      />,
    );
    // bgFill is self-excluded; grid/floor/wall/one-way marker/start fill+border/finish fill+border
    // = 8 active rows. priority duplicates the floor row, so total still reflects de-dup, not a
    // double-count.
    const header = screen.getByText(m["color_picker.project_colors"]({ count: "10" }));
    fireEvent.click(header);
    expect(screen.getAllByText(PC.tilesFloor.name())).toHaveLength(1);
  });

  it("keeps a priorityColors entry with a color that differs from the profile's own row (no false de-dup by color alone)", () => {
    render(
      <ColorPickerPanel
        color={0xffffff}
        onApply={noop}
        onClose={noop}
        field={PC.bgFill}
        priorityColors={[PC.tilesFloor.at(0xabcdef)]}
      />,
    );
    fireEvent.click(screen.getByText(m["color_picker.project_colors"]({ count: "11" })));
    fireEvent.click(screen.getByText(m["color_picker.project_colors_show_all"]()));
    expect(screen.getAllByText(PC.tilesFloor.name())).toHaveLength(2);
  });

  it("drops a priorityColors entry whose field is inactive in the current profile (not in the active-name set)", () => {
    // Reverse the maze's own edge to a bidirectional pair -- the one-way indicator field becomes
    // inactive (hasDirectionalBasicEdge false), so a priority entry naming it must not leak into
    // the list even though it's explicitly passed.
    useMazeStore.setState({ edges: [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 0, kind: "basic" }] });
    render(
      <ColorPickerPanel
        color={0xffffff}
        onApply={noop}
        onClose={noop}
        field={PC.bgFill}
        priorityColors={[PC.oneWaysMarker.at(0xff0000)]}
      />,
    );
    fireEvent.click(screen.getByText(m["color_picker.project_colors"]({ count: "9" })));
    expect(screen.queryByText(PC.oneWaysMarker.name())).not.toBeInTheDocument();
  });

  it("prepends a unique 'Default' row ahead of priorityColors when defaultColor is set, even if its color matches a profile row", () => {
    render(
      <ColorPickerPanel
        color={0xffffff}
        onApply={noop}
        onClose={noop}
        field={PC.bgFill}
        defaultColor={0x2a2a2a}
      />,
    );
    fireEvent.click(screen.getByText(m["color_picker.project_colors"]({ count: "11" })));
    fireEvent.click(screen.getByText(m["color_picker.project_colors_show_all"]()));
    expect(screen.getByText(m["color_picker.project_colors_default"]())).toBeInTheDocument();
    // The profile's own floor row survives too -- the generic "Default" label never collides with it.
    expect(screen.getByText(PC.tilesFloor.name())).toBeInTheDocument();
  });

  it("excludes the edited field's own row from the list (self-row exclusion)", () => {
    render(
      <ColorPickerPanel
        color={0x2a2a2a}
        onApply={noop}
        onClose={noop}
        field={PC.tilesFloor}
      />,
    );
    fireEvent.click(screen.getByText(m["color_picker.project_colors"]({ count: "10" })));
    // The SidePanel header also shows field name as its title -- only that one occurrence
    // may exist; the list itself must contain none.
    expect(screen.getAllByText(PC.tilesFloor.name())).toHaveLength(1);
    expect(document.querySelector(".project-color-row")).toBeNull();
  });

  it("clicking a project-color row sets the working color without committing", () => {
    openList();
    fireEvent.click(screen.getByText(PC.tilesWall.name()));
    expect((screen.getByLabelText(m["color_picker.hex_label"]()) as HTMLInputElement).value).toBe("#0a0a0a");
  });

  it("activating a project-color row via keyboard (Enter/Space) sets the working color same as a click", () => {
    openList();
    fireEvent.keyDown(screen.getByText(PC.tilesWall.name()).closest('[role="button"]')!, { key: "Enter" });
    expect((screen.getByLabelText(m["color_picker.hex_label"]()) as HTMLInputElement).value).toBe("#0a0a0a");
  });

  it("'Hide unrelated colors' collapses the bottom group back after 'Show all'", () => {
    openList();
    expect(screen.getByText(PC.tilesWall.name())).toBeInTheDocument();
    fireEvent.click(screen.getByText(m["color_picker.project_colors_hide_unrelated"]()));
    expect(screen.queryByText(PC.tilesWall.name())).not.toBeInTheDocument();
    expect(screen.getByText(m["color_picker.project_colors_show_all"]())).toBeInTheDocument();
  });
});
