import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VectorByWallsSettingsPanel } from "../components/features/VectorByWallsSettingsPanel";
import { VectorByCorridorsSettingsPanel } from "../components/features/VectorByCorridorsSettingsPanel";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { convertFloorLabelPosition, floorLabelCenter, floorLabelPosition, floorLabelText, floorLabelTextX } from "../pixi/renderers/FloorLabelRenderer";
import { FloorLabelDragController } from "../pixi/imageExport/FloorLabelDragController";
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
    floorLabelDrag: null,
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

  it("aligns text inside the frame without moving the frame center", () => {
    const base = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, width: 100, height: 40, textMargin: 5 };
    expect(floorLabelTextX({ ...base, textAlignment: "left" }, 200, { left: -15, right: 15 })).toBe(170);
    expect(floorLabelTextX({ ...base, textAlignment: "center" }, 200, { left: -15, right: 15 })).toBe(200);
    expect(floorLabelTextX({ ...base, textAlignment: "right" }, 200, { left: -15, right: 15 })).toBe(230);
    expect(floorLabelTextX({ ...base, textAlignment: "left" }, 200, { left: -60, right: 60 })).toBe(215);
    expect(floorLabelTextX({ ...base, textAlignment: "right" }, 200, { left: -60, right: 60 })).toBe(185);
    expect(floorLabelTextX({ ...base, textAlignment: "left" }, 200, { left: -12, right: 18 })).toBe(167);
    expect(floorLabelTextX({ ...base, textAlignment: "right" }, 200, { left: -12, right: 18 })).toBe(227);
  });

  it("keeps aligned text inside the narrow part of a parallelogram", () => {
    const settings = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, backgroundShape: "parallelogram" as const, textAlignment: "left" as const, width: 100, height: 40, textMargin: 5 };
    expect(floorLabelTextX(settings, 200, { left: -15, right: 15 })).toBe(183.5);
  });

  it("resolves all three per-floor positioning modes", () => {
    const bounds = { minX: -30, minY: 10, maxX: 90, maxY: 70 };
    const cfg = { type: "square", width: 4, height: 4 } as const;
    const settings = DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel;

    expect(floorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "anchored", anchor: "top_right" } } }, "f1", bounds, cfg)).toEqual({ x: 54, y: 24 });
    expect(floorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "anchored", anchor: "bottom_left" } } }, "f1", bounds, cfg)).toEqual({ x: 6, y: 56 });
    expect(floorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "anchored", anchor: "center" } } }, "f1", bounds, cfg)).toEqual({ x: 30, y: 40 });
    expect(floorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "cell", cell: [2, 3] } } }, "f1", bounds, cfg)).toEqual({ x: 100, y: -140 });
    expect(floorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "free", x: -12.5, y: 98 } } }, "f1", bounds, cfg)).toEqual({ x: -12.5, y: 98 });
  });

  it("positions against a grid cell even when that cell is outside the field", () => {
    const settings = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel,
      positionsByFloorId: { f1: { mode: "cell" as const, cell: [8, 9] as [number, number] } },
    };
    expect(floorLabelPosition(settings, "f1", { minX: 0, minY: 0, maxX: 100, maxY: 60 }, { type: "square", width: 4, height: 4 })).toEqual({ x: 340, y: -380 });
  });

  it("preserves the closest possible rendered position when changing placement modes", () => {
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 120 };
    const cfg = { type: "square", width: 10, height: 10 } as const;
    const settings = { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.floorLabel, width: 40, height: 20 };

    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "free", x: 101, y: -59 } } }, "f1", "cell", bounds, cfg))
      .toEqual({ mode: "cell", cell: [2, 1] });
    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "cell", cell: [2, 1] } } }, "f1", "free", bounds, cfg))
      .toEqual({ mode: "free", x: 100, y: -60 });
    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "free", x: 184, y: 8 } } }, "f1", "anchored", bounds, cfg))
      .toEqual({ mode: "anchored", anchor: "top_right" });
    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "anchored", anchor: "bottom_left" } } }, "f1", "free", bounds, cfg))
      .toEqual({ mode: "free", x: 20, y: 110 });
    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "anchored", anchor: "top_left" } } }, "f1", "cell", bounds, cfg))
      .toEqual({ mode: "cell", cell: [0, -1] });
    expect(convertFloorLabelPosition({ ...settings, positionsByFloorId: { f1: { mode: "cell", cell: [4, -2] } } }, "f1", "anchored", bounds, cfg))
      .toEqual({ mode: "anchored", anchor: "center_right" });
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

  it("edits horizontal alignment in the Label subsection", () => {
    useMazeStore.setState({ floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }], vectorByWallsSectionsExpanded: { floors: true } });
    render(<VectorByWallsSettingsPanel />);
    const select = document.querySelector(`select[name="${m["image_export.floors.alignment"]()}"]`)!;
    fireEvent.change(select, { target: { value: "right" } });
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.textAlignment).toBe("right");
  });

  it("edits the active floor's placement without changing shared label style", () => {
    useMazeStore.setState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_1",
      vectorByWallsSectionsExpanded: { floors: true },
    });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByText(m["image_export.floors.position_subsection"]({ floor: "Floor 1" }))).toBeInTheDocument();
    const mode = document.querySelector(`select[name="${m["image_export.floors.position_mode"]()}"]`);
    expect(mode).toBeInstanceOf(HTMLSelectElement);
    fireEvent.change(mode!, { target: { value: "cell" } });
    const x = screen.getByRole("textbox", { name: "X" });
    const y = screen.getByRole("textbox", { name: "Y" });
    expect(screen.getByText(m["image_export.floors.coordinates"]())).toBeInTheDocument();
    expect(x.parentElement).toBe(y.parentElement);
    fireEvent.change(x, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: m["image_export.floors.copy_position_to_all"]() }));

    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "cell", cell: [4, 0] });
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_2).toEqual({ mode: "cell", cell: [4, 0] });
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.prefix).toBe("Floor ");
  });

  it("offers canvas dragging only for cell and free placement", () => {
    useMazeStore.setState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_1",
      vectorByWallsSectionsExpanded: { floors: true },
    });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.queryByRole("button", { name: m["image_export.floors.drag_position"]() })).not.toBeInTheDocument();
    const mode = document.querySelector(`select[name="${m["image_export.floors.position_mode"]()}"]`)!;
    fireEvent.change(mode, { target: { value: "free" } });
    fireEvent.click(screen.getByRole("button", { name: m["image_export.floors.drag_position"]() }));
    expect(useMazeStore.getState().floorLabelDrag).toMatchObject({ renderMode: "vector_by_walls", floorId: "floor_1" });
    expect(screen.getByRole("button", { name: m["image_export.floors.finish_drag"]() })).toBeInTheDocument();
  });

  it("shows only integer coordinate parts without rounding the stored free position", () => {
    const base = useMazeStore.getState();
    useMazeStore.setState({
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      activeFloorId: "floor_1",
      vectorByWallsSectionsExpanded: { floors: true },
      vectorByWallsSettings: {
        ...base.vectorByWallsSettings,
        floorLabel: {
          ...base.vectorByWallsSettings.floorLabel,
          positionsByFloorId: { floor_1: { mode: "free", x: 12.9, y: -8.7 } },
        },
      },
    });
    render(<VectorByWallsSettingsPanel />);
    expect(screen.getByRole("textbox", { name: "X" })).toHaveValue("12");
    expect(screen.getByRole("textbox", { name: "Y" })).toHaveValue("-8");
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 12.9, y: -8.7 });
    fireEvent.change(screen.getByRole("textbox", { name: "X" }), { target: { value: "7.9" } });
    expect(screen.getByRole("textbox", { name: "X" })).toHaveValue("7");
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 7, y: -8.7 });
  });

  it("drags free positions directly and cell positions on the infinite grid", () => {
    const viewport = { x: 0, y: 0, scale: { x: 1, y: 1 } } as any;
    const controller = new FloorLabelDragController(() => viewport);
    const base = useMazeStore.getState();
    useMazeStore.setState({
      openCard: "image_export",
      activeRenderMode: "vector_by_walls",
      nodes: [{ id: 1, x: 0, y: 0, i: 0 }],
      floors: [{ id: "floor_1", title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      vectorByWallsSettings: {
        ...base.vectorByWallsSettings,
        floorLabel: { ...base.vectorByWallsSettings.floorLabel, positionsByFloorId: { floor_1: { mode: "free", x: 20, y: -20 } } },
      },
    });
    useMazeStore.getState().startFloorLabelDrag("vector_by_walls");
    controller.onPointerDown(25, -15, 0);
    controller.onPointerMove(105, -95);
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 100, y: -100 });
    controller.onPointerUp(0);
    controller.onPointerMove(200, -200);
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 100, y: -100 });
    controller.onPointerDown(500, 500, 0);
    controller.onPointerMove(200, -200);
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 100, y: -100 });
    controller.onPointerDown(100, -100, 0);
    controller.cancelPointerGesture();
    controller.onPointerMove(200, -200);
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 100, y: -100 });

    useMazeStore.getState().finishFloorLabelDrag();
    useMazeStore.getState().patchVectorByWallsFloorLabelSettings({ positionsByFloorId: { floor_1: { mode: "cell", cell: [0, 0] } } });
    useMazeStore.getState().startFloorLabelDrag("vector_by_walls");
    controller.onPointerDown(20, -20, 0);
    controller.onPointerMove(340, -380);
    expect(useMazeStore.getState().vectorByWallsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "cell", cell: [8, 9] });
  });

  it("updates, cancels, and commits corridor floor-label drag state", () => {
    const base = useMazeStore.getState();
    useMazeStore.setState({
      vectorByCorridorsSettings: {
        ...base.vectorByCorridorsSettings,
        floorLabel: {
          ...base.vectorByCorridorsSettings.floorLabel,
          positionsByFloorId: { floor_1: { mode: "free", x: 1, y: 2 } },
        },
      },
    });
    useMazeStore.getState().startFloorLabelDrag("vector_by_corridors");
    useMazeStore.getState().updateFloorLabelDragPosition({ mode: "free", x: 8, y: 9 });
    useMazeStore.getState().cancelFloorLabelDrag();
    expect(useMazeStore.getState().vectorByCorridorsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 1, y: 2 });

    useMazeStore.getState().startFloorLabelDrag("vector_by_corridors");
    useMazeStore.getState().updateFloorLabelDragPosition({ mode: "free", x: 3, y: 4 });
    useMazeStore.getState().finishFloorLabelDrag();
    expect(useMazeStore.getState().vectorByCorridorsSettings.floorLabel.positionsByFloorId.floor_1).toEqual({ mode: "free", x: 3, y: 4 });
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
