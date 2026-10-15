import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
import { VectorByCorridorsSettingsPanel } from "../components/features/VectorByCorridorsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { floorLabelCenter, floorLabelText } from "../pixi/renderers/FloorLabelRenderer";
import { requiredTextPlateDimensions, textOverflows } from "../pixi/textFit";
import { maxFittingFontSize } from "../pixi/textFit";
import { FLOOR_LABEL_TEXT_SIZE_RANGE } from "../pixi/renderConstants";
import { computeTextFitItemsAcrossFloors, computeVectorByWallsWarningsAcrossFloors } from "../pixi/selectors/exportWarnings";
import * as m from "~/paraglide/messages";

vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]: [number, number]) => [x, y]),
  getAvailableChecks: vi.fn(() => []),
  getAvailableStrategies: vi.fn(() => []),
}));

beforeEach(() => {
  useMazeStore.setState({
    ...baseStoreState(),
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  });
});

describe("export floor labels", () => {
  it("combines the configured prefix with the selected floor-number style", () => {
    expect(floorLabelText({ ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, prefix: "Level ", labelType: "letters" }, 1)).toBe("Level B");
    expect(floorLabelText({ ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, prefix: "F", labelType: "roman" }, 3)).toBe("FIV");
  });

  it("centers the label on the active floor independently of the viewport", () => {
    expect(floorLabelCenter({ minX: -30, minY: 10, maxX: 90, maxY: 70 })).toEqual({ x: 30, y: 40 });
  });

  it.each([
    ["walls", VectorByWallsSettingsPanel],
    ["corridors", VectorByCorridorsSettingsPanel],
  ] as const)("hides the Floors section for a single-floor %s export", (_mode, Panel) => {
    render(<Panel />);
    expect(screen.queryByText(m["image_export.floors.section"]())).not.toBeInTheDocument();
  });

  it.each([
    ["walls", VectorByWallsSettingsPanel, "tiles"],
    ["corridors", VectorByCorridorsSettingsPanel, "cells"],
  ] as const)("shows the Floors section immediately after the maze section for %s exports", (_mode, Panel, preceding) => {
    useMazeStore.setState({ floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }] });
    render(<Panel />);
    const floorHeader = screen.getByText(m["image_export.floors.section"]());
    const precedingHeader = screen.getByText(preceding === "tiles" ? m["image_export.vector_by_walls.section_tiles"]() : m["image_export.vector_by_corridors.section_cells"]());
    const nextHeader = screen.getByText(m["image_export.vector_by_walls.section_markers"]());
    expect(precedingHeader.compareDocumentPosition(floorHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(floorHeader.compareDocumentPosition(nextHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("places the prefix inside the Label subsection", () => {
    useMazeStore.setState({ floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }], vectorByWallsSectionsExpanded: { floors: true } });
    render(<VectorByWallsSettingsPanel />);
    const labelHeader = screen.getAllByText(m["image_export.floors.label_subsection"]())[0];
    const prefix = screen.getByText(m["image_export.floors.prefix"]());
    expect(labelHeader.compareDocumentPosition(prefix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides every dependent floor setting when Show floors is disabled", () => {
    useMazeStore.setState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      vectorByWallsSectionsExpanded: { floors: true },
    });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.floors.prefix"]())).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: m["image_export.floors.show"]() }));
    expect(screen.queryByText(m["image_export.floors.prefix"]())).not.toBeInTheDocument();
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.enabled).toBe(false);
  });

  it("links floor, elevator and teleport label styles to the letter default", () => {
    const settings = DEFAULT_VECTOR_BY_WALLS_SETTINGS;
    expect(settings.floorLabelType).toBe("letters");
    expect(settings.floorLabel.labelType).toBe("letters");
    expect(settings.elevatorBadges.labelType).toBe("letters");
    expect(settings.teleportFloorBadge.labelType).toBe("letters");
    expect(settings.links.filter((link) => link.source === "floorLabelType").map((link) => link.target)).toEqual([
      "teleportFloorBadge.labelType", "elevatorBadges.labelType", "floorLabel.labelType",
    ]);
  });

  it("keeps floor-label text size independent from shared style links", () => {
    expect(DEFAULT_VECTOR_BY_WALLS_LINKS.some((link) => link.target === "floorLabel.textSize")).toBe(false);
    expect(DEFAULT_VECTOR_BY_CORRIDORS_LINKS.some((link) => link.target === "floorLabel.textSize")).toBe(false);
  });

  it("reports contrast problems for the floor label's associated colors", () => {
    const settings = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      background: 0x111111,
      floorColor: 0x111111,
      floorLabel: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
        fillColor: 0x111111,
        borderColor: 0x111111,
        textColor: 0x111111,
      },
    };
    const warnings = computeVectorByWallsWarningsAcrossFloors(
      [], [], [{ id: "floor_1" }, { id: "floor_2" }],
      { type: "square", width: 4, height: 4 }, settings, null, null,
    );
    expect(warnings.map((warning) => warning.id)).toEqual(expect.arrayContaining([
      "floor_label_fill_low_contrast_floor",
      "floor_label_border_low_contrast_floor",
      "floor_label_text_low_contrast",
    ]));
  });

  it("reports when the floor label text exceeds its backplate", () => {
    const settings = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      floorLabel: {
        ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
        prefix: "A very long floor prefix ",
        width: 20,
        height: 10,
        textSize: 40,
      },
    };
    const warnings = computeVectorByWallsWarningsAcrossFloors(
      [{ id: 0, x: 0, y: 0, i: 0 }], [], [{ id: "floor_1" }, { id: "floor_2" }],
      { type: "square", width: 4, height: 4 }, settings, null, null,
    );
    expect(warnings.map((warning) => warning.id)).toContain("floor_label_text_overflow");
  });

  it("uses the widest and tallest floor label when fitting the backplate", () => {
    const dimensions = requiredTextPlateDimensions([
      { text: "VIII", fontWeight: "regular", shape: "square", plateSize: 0, margin: 4 },
      { text: "X", fontWeight: "regular", shape: "square", plateSize: 0, margin: 4 },
    ], 24);
    const wideOnly = requiredTextPlateDimensions([
      { text: "X", fontWeight: "regular", shape: "square", plateSize: 0, margin: 4 },
    ], 24);
    expect(dimensions).not.toBeNull();
    expect(wideOnly).not.toBeNull();
    expect(dimensions!.width).toBeGreaterThan(wideOnly!.width);
    expect(dimensions!.height).toBe(wideOnly!.height);
  });

  it("accounts for slanted parallelogram edges when fitting floor-label text", () => {
    const rectangle = { text: "XXXXX", fontWeight: "regular" as const, shape: "square" as const, plateSize: 0, plateWidth: 80, plateHeight: 36, plateShape: "rectangle" as const, margin: 4 };
    const parallelogram = { ...rectangle, plateShape: "parallelogram" as const };
    expect(textOverflows(rectangle, 24)).toBe(false);
    expect(textOverflows(parallelogram, 24)).toBe(true);
    expect(requiredTextPlateDimensions([parallelogram], 24)!.width).toBeGreaterThan(requiredTextPlateDimensions([rectangle], 24)!.width);
  });

  it("keeps the floor-label shape in auto-fit entries", () => {
    const settings = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      floorLabel: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, backgroundShape: "parallelogram" as const },
    };
    const items = computeTextFitItemsAcrossFloors(
      [{ id: 0, x: 0, y: 0, i: 0 }], [], [{ id: "floor_1" }, { id: "floor_2" }],
      { type: "square", width: 4, height: 4 }, settings, null, null,
    );
    expect(items.floorLabel).toHaveLength(2);
    expect(items.floorLabel.every((item) => item.plateShape === "parallelogram")).toBe(true);
  });

  it("allows floor-label auto-fit to use the larger font-size range", () => {
    expect(maxFittingFontSize([{ text: "I", fontWeight: "regular", shape: "square", plateSize: 5000 }], FLOOR_LABEL_TEXT_SIZE_RANGE)).toBe(72);
  });
});
