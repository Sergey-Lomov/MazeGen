import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FieldSetupFeature, fieldSetupSubtitle } from "../components/features/FieldSetupFeature";
import { configSizeDescription } from "../components/dialogs/FieldPrintSizingDialog";
import type { FieldConfig } from "../fieldConfig";
import { useMazeStore } from "../store/mazeStore";
import { DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";
import { mmToPx } from "../pixi/imageExport/printFit";
import { baseStoreState, baseFloorFieldConfig, TEST_FLOOR_ID } from "./storeTestHelpers";

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
});

describe("FieldSetupFeature — Copy floor button", () => {
  const descriptionCases: [FieldConfig, string][] = [
    [{ type: "square", width: 20, height: 28 }, "Field size: 20 × 28 cells"],
    [{ type: "hex_hexagon", radius: 5, orientation: "flat_top" }, "Field radius: 5 cells"],
    [{ type: "triangle_triangle", side: 5, orientation: "r0" }, "Field side: 5 cells"],
  ];

  it.each(descriptionCases)("describes calculated field dimensions clearly", (config, expected) => {
    expect(configSizeDescription(config)).toBe(expected);
  });

  it("calculates the current predefined shape for print", () => {
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    expect(dialog).toBeTruthy();
    const dialogQueries = within(dialog!);
    const inputs = dialogQueries.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(inputs[2], { target: { value: "10" } });
    fireEvent.click(dialogQueries.getByTitle("Portrait"));
    fireEvent.click(dialogQueries.getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].tessellationConfig).toEqual({
      type: "square",
      width: 20,
      height: 28,
    });
    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({
      paperSize: "a4",
      orientation: "portrait",
      marginHMm: 5,
      marginVMm: 5,
      scaleAutoFit: false,
    });
    expect(useMazeStore.getState().pngExportSettings.print.scale).toBeCloseTo(mmToPx(10, 300) / 40);
  });

  it("opens with the current print settings", () => {
    useMazeStore.setState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: {
          ...DEFAULT_PNG_EXPORT_SETTINGS.print,
          density: "draft_150",
          paperSize: "a3",
          orientation: "landscape",
          marginHMm: 7,
          marginVMm: 9,
          scale: mmToPx(12, 150) / 40,
          scaleAutoFit: false,
        },
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const dialogQueries = within(dialog!);
    const inputs = dialogQueries.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(dialogQueries.getByDisplayValue("A3")).toBeInTheDocument();
    expect(inputs[0].value).toBe("420");
    expect(inputs[1].value).toBe("297");
    expect(inputs[2].value).toBe("12");
    expect(inputs[3].value).toBe("7");
    expect(inputs[4].value).toBe("9");
  });

  it("opens with a 10 mm cell size before the user sets a print size", () => {
    useMazeStore.setState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scale: 2.5, scaleAutoFit: true },
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    expect((within(dialog!).getAllByRole("spinbutton")[2] as HTMLInputElement).value).toBe("10");
  });

  it("allows the last numeric character to be cleared", () => {
    render(<FieldSetupFeature />);
    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const cellInput = within(dialog!).getAllByRole("spinbutton")[2] as HTMLInputElement;

    fireEvent.change(cellInput, { target: { value: "" } });

    expect(cellInput.value).toBe("");
  });

  it("shows a confirmation before changing a field with generation results", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      mazeDirty: true,
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ hexShape: "parallelogram" }) },
    });
    render(<FieldSetupFeature />);
    fireEvent.change(screen.getByDisplayValue("Parallelogram"), { target: { value: "hexagon" } });
    expect(screen.getByText("Changing the field resets the current generation and post-edit results. Continue?")).toBeInTheDocument();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].hexShape).toBe("parallelogram");
  });

  it("is hidden with a single floor", () => {
    render(<FieldSetupFeature />);
    expect(screen.queryByText("Copy floor")).not.toBeInTheDocument();
  });

  it("is shown once more than one floor exists", () => {
    useMazeStore.setState({
      floors: [{ id: TEST_FLOOR_ID, title: "Floor 1" }, { id: "floor_2", title: "Floor 2" }],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig(),
        floor_2: baseFloorFieldConfig(),
      },
    });
    render(<FieldSetupFeature />);
    expect(screen.getByText("Copy floor")).toBeInTheDocument();
  });

  it("applies print sizing to standard floors but preserves custom floors", () => {
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Floor 1" },
        { id: "floor_2", title: "Floor 2" },
        { id: "floor_3", title: "Floor 3" },
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig(),
        floor_2: baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 4, height: 4 } }),
        floor_3: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: new Set([0]),
          tessellationConfig: { type: "square_custom", points: [[0, 0]] },
        }),
      },
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "a4", orientation: "portrait", marginHMm: 5, marginVMm: 5 },
      },
      activeTessellationConfig: { type: "square", width: 10, height: 10 },
      mazeDirty: false,
      postEditDirty: false,
      fieldEditConfirmation: null,
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const dialogQueries = within(dialog!);
    const cellInput = dialogQueries.getAllByRole("spinbutton")[2] as HTMLInputElement;
    fireEvent.change(cellInput, { target: { value: "10" } });
    expect(cellInput.value).toBe("10");
    fireEvent.click(dialogQueries.getByTitle("Portrait"));
    expect(dialogQueries.getByRole("checkbox")).toBeChecked();
    expect(dialogQueries.getByRole("button", { name: "Confirm" })).not.toBeDisabled();
    fireEvent.click(dialogQueries.getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].tessellationConfig).toEqual({ type: "square", width: 20, height: 28 });
    expect(useMazeStore.getState().floorFields.floor_2.tessellationConfig).toEqual({ type: "square", width: 20, height: 28 });
    expect(useMazeStore.getState().floorFields.floor_3.tessellationConfig).toEqual({ type: "square_custom", points: [[0, 0]] });
  });
});

describe("fieldSetupSubtitle — multi-floor aggregation (GitHub issue #383)", () => {
  it("sums cell counts across floors, not just the first floor's", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 2, height: 2 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("13");
  });

  it("shows the shared shape label when all floors match", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Rect");
  });

  it("shows 'Different floor shapes' when floors' shapes/sizes differ", () => {
    const floors = [
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 5, height: 5 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Different floor shapes");
  });

  it("sums custom-mode point counts across floors", () => {
    const floors = [
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([1, 2]) }),
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([3, 4, 5]) }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("5");
  });

  it("treats a custom floor and a default floor as different shapes", () => {
    const floors = [
      baseFloorFieldConfig({ fieldEditMode: "custom", fieldPoints: new Set([1]) }),
      baseFloorFieldConfig({ tessellationConfig: { type: "square", width: 3, height: 3 } }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Different floor shapes");
  });
});
