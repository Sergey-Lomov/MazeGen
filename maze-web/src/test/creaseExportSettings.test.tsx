import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as m from "~/paraglide/messages";
import { creaseDisplayPoint } from "../pixi/creaseGeometry";
import { creaseStyleOf, selectExportCreases } from "../pixi/imageExport/creaseExport";
import { DEFAULT_CREASE_STYLE, DEFAULT_GLUE_TAB_STYLE } from "../store/slices/imageExportDefaults";
import { validateVectorByCorridorsSettings, validateVectorByWallsSettings } from "../store/projectExport/validateImageExport";
import { CREASE_LINE_WIDTH_RANGE, CREASE_MARK_SIZE_RANGE, CREASE_MARK_TIP_LENGTH_RANGE } from "../pixi/renderConstants";
import { fieldOf } from "./fieldConfigFixtures";
import type { CreaseExportStyle } from "../store/imageExportTypes";

const { useMazeStore } = await import("../store/mazeStore");
const { baseStoreState, TEST_FLOOR_ID } = await import("./storeTestHelpers");
const { TopologySettingsSection } = await import("../components/features/TopologySettingsSection");
const { CreaseSettingsSubsection } = await import("../components/features/CreaseSettingsSubsection");

// Export crease style (GitHub issue #900): selection, store actions, validation and the settings UI.

const field = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const crease = { id: 0, a: [0, 0] as const, b: [2, 0] as const };
const shown: CreaseExportStyle = { ...DEFAULT_CREASE_STYLE, showCreases: true };

function setCreases(list: (typeof crease)[]) {
  useMazeStore.setState({
    ...baseStoreState(),
    floorFields: { [TEST_FLOOR_ID]: { ...baseStoreState().floorFields[TEST_FLOOR_ID], fieldConfig: field } },
    floorCreases: list.length > 0 ? { [TEST_FLOOR_ID]: list } : {},
  } as never);
}

describe("selectExportCreases / creaseStyleOf", () => {
  beforeEach(() => setCreases([crease]));

  it("maps the active floor's creases into display space", () => {
    expect(selectExportCreases(useMazeStore.getState(), shown)).toEqual([
      { from: creaseDisplayPoint(crease.a, field), to: creaseDisplayPoint(crease.b, field) },
    ]);
  });

  it("returns nothing for a floor without creases", () => {
    setCreases([]);
    expect(selectExportCreases(useMazeStore.getState(), shown)).toEqual([]);
  });

  it("reads the style of the given render mode", () => {
    const state = useMazeStore.getState();
    const walls = { ...state.vectorByWallsSettings, creases: { ...shown, color: 0x111111 } };
    const corridors = { ...state.vectorByCorridorsSettings, creases: { ...shown, color: 0x222222 } };
    expect(creaseStyleOf({ vectorByWallsSettings: walls, vectorByCorridorsSettings: corridors }, "vector_by_walls").color).toBe(0x111111);
    expect(creaseStyleOf({ vectorByWallsSettings: walls, vectorByCorridorsSettings: corridors }, "vector_by_corridors").color).toBe(0x222222);
  });
});

describe("setVectorBy*Creases", () => {
  beforeEach(() => setCreases([]));

  it("merges a patch into the mode's style and leaves the other mode alone", () => {
    useMazeStore.getState().setVectorByWallsCreases({ showCreases: true, mode: "marks" });
    useMazeStore.getState().setVectorByWallsCreases({ markSize: 7 });
    const { vectorByWallsSettings: walls, vectorByCorridorsSettings: corridors } = useMazeStore.getState();
    expect(walls.creases).toEqual({ ...DEFAULT_CREASE_STYLE, showCreases: true, mode: "marks", markSize: 7 });
    expect(corridors.creases).toEqual(DEFAULT_CREASE_STYLE);
    useMazeStore.getState().setVectorByCorridorsCreases({ color: 0x123456 });
    expect(useMazeStore.getState().vectorByCorridorsSettings.creases.color).toBe(0x123456);
  });
});

describe("crease style validation ranges", () => {
  it.each([
    ["walls", validateVectorByWallsSettings],
    ["corridors", validateVectorByCorridorsSettings],
  ] as const)("clamps sizes into the slider ranges (%s)", (_name, validate) => {
    const high = (validate as (v: unknown, p: string, l: never[]) => { creases: CreaseExportStyle })({ creases: { lineWidth: 999, markSize: 999, markTipLength: 999 } }, "x", []).creases;
    const low = (validate as (v: unknown, p: string, l: never[]) => { creases: CreaseExportStyle })({ creases: { lineWidth: -5, markSize: 0, markTipLength: -1 } }, "x", []).creases;
    expect([high.lineWidth, high.markSize, high.markTipLength]).toEqual([CREASE_LINE_WIDTH_RANGE.max, CREASE_MARK_SIZE_RANGE.max, CREASE_MARK_TIP_LENGTH_RANGE.max]);
    expect([low.lineWidth, low.markSize, low.markTipLength]).toEqual([CREASE_LINE_WIDTH_RANGE.min, CREASE_MARK_SIZE_RANGE.min, CREASE_MARK_TIP_LENGTH_RANGE.min]);
  });
});

describe("CreaseSettingsSubsection", () => {
  const renderSubsection = (style: CreaseExportStyle, expanded = true) => {
    const patches: Partial<CreaseExportStyle>[] = [];
    render(<CreaseSettingsSubsection expanded={expanded} onToggle={() => {}} style={style} defaultColor={0} priorityColors={[]} onChange={(p) => patches.push(p)} />);
    return patches;
  };

  it("shows only the header while collapsed", () => {
    renderSubsection(shown, false);
    expect(screen.getByText(m["image_export.creases.title"]())).toBeTruthy();
    expect(screen.queryByText(m["image_export.creases.show"]())).toBeNull();
  });

  it("shows just the toggle while creases are hidden", () => {
    renderSubsection({ ...shown, showCreases: false });
    expect(screen.getByText(m["image_export.creases.show"]())).toBeTruthy();
    expect(screen.queryByText(m["image_export.creases.mode"]())).toBeNull();
  });

  it("lines mode offers line rows and the line colour, not the mark rows", () => {
    renderSubsection({ ...shown, mode: "lines" });
    for (const key of ["line_style", "line_width", "color"] as const) expect(screen.getByText(m[`image_export.creases.${key}`]())).toBeTruthy();
    for (const key of ["mark_size", "mark_tip_length", "mark_color"] as const) expect(screen.queryByText(m[`image_export.creases.${key}`]())).toBeNull();
  });

  it("marks mode offers mark rows and the mark colour, not the line colour", () => {
    renderSubsection({ ...shown, mode: "marks" });
    for (const key of ["mark_size", "mark_tip_length", "mark_color"] as const) expect(screen.getByText(m[`image_export.creases.${key}`]())).toBeTruthy();
    for (const key of ["line_style", "line_width", "color"] as const) expect(screen.queryByText(m[`image_export.creases.${key}`]())).toBeNull();
  });

  it("reports a patch for a changed toggle", () => {
    const patches = renderSubsection({ ...shown, showCreases: false });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(patches).toEqual([{ showCreases: true }]);
  });
});

describe("TopologySettingsSection with creases", () => {
  const props = {
    expanded: true, onToggle: () => {}, style: { showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0 }, defaultColor: 0, priorityColors: [],
    onShow: () => {}, onGlueColor: () => {}, onColor: () => {},
    creasesExpanded: true, onToggleCreases: () => {}, creaseStyle: shown, creaseDefaultColor: 0, creasePriorityColors: [], onCreasesChange: () => {},
    glueTabsExpanded: true, onToggleGlueTabs: () => {}, glueTabStyle: DEFAULT_GLUE_TAB_STYLE, glueTabDefaults: DEFAULT_GLUE_TAB_STYLE, glueTabPriorityColors: [], onGlueTabsChange: () => {},
  };

  it("renders nothing for a floor with neither glues nor creases", () => {
    setCreases([]);
    const { container } = render(<TopologySettingsSection {...props} />);
    expect(container.textContent).toBe("");
  });

  it("shows the creases subsection but no cut-line rows for a floor with creases only", () => {
    setCreases([crease]);
    render(<TopologySettingsSection {...props} />);
    expect(screen.getByText(m["image_export.creases.title"]())).toBeTruthy();
    expect(screen.queryByText(m["image_export.topology.show_cut_lines"]())).toBeNull();
  });
});
