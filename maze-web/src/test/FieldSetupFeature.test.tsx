import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FieldSetupFeature, fieldSetupSubtitle } from "../components/features/FieldSetupFeature";
import { configSizeDescription } from "../components/dialogs/FieldPrintSizingDialog";
import type { FieldConfig } from "../fieldConfig";
import { useMazeStore } from "../store/mazeStore";
import { DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";
import { mmToPx } from "../pixi/imageExport/printFit";
import { decodePoint, encodePoint } from "../pixi/tessellationProjection";
import { getCartesian } from "../pixi/cartesianCache";
import { baseStoreState, baseFloorFieldConfig, emptyFreePoints, TEST_FLOOR_ID } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";
import { getTooltipAnchor, getTooltipAnchors, getTooltipControlWithin } from "./tooltipTestUtils";
import * as m from "~/paraglide/messages";

vi.mock("../components/BackgroundImageToggle", () => ({
  BackgroundImageToggle: () => null,
}));

beforeEach(() => {
  useMazeStore.setState({ ...baseStoreState(), backgroundAutoFillPreview: null });
});

describe("FieldSetupFeature — Copy floor button", () => {
  it("applies the current field to every other floor after confirmation", () => {
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Floor 1" },
        { id: "floor_2", title: "Floor 2" },
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }) }),
        floor_2: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 9 }) }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: m["floors.from_current"]() }));
    expect(screen.getByText(m["floors.confirm_from_current"]())).toBeInTheDocument();
    expect(useMazeStore.getState().floorFields.floor_2.fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 7, rows: 9 }));

    fireEvent.click(screen.getByRole("button", { name: m["common.ok"]() }));
    expect(useMazeStore.getState().floorFields.floor_2.fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 3, rows: 4 }));
  });

  it("keeps other floors unchanged when the confirmation is cancelled", () => {
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Floor 1" },
        { id: "floor_2", title: "Floor 2" },
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 4 }) }),
        floor_2: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 9 }) }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: m["floors.from_current"]() }));
    fireEvent.click(screen.getByRole("button", { name: m["common.cancel"]() }));

    expect(useMazeStore.getState().floorFields.floor_2.fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 7, rows: 9 }));
  });

  it("explains an out-of-range field size on blur, even when it restores the stored value", () => {
    render(<FieldSetupFeature />);
    const width = screen.getByRole("spinbutton", { name: m["field.width"]() });
    fireEvent.change(width, { target: { value: "999" } });
    fireEvent.blur(width);
    expect(width).toHaveValue(10);
    expect(screen.getByTestId("field-hint")).toHaveTextContent(
      m["input_hint.range_reverted"]({ min: "1", max: "200" }),
    );
  });

  it("disables field editing controls while an auto-fill preview is active", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
      backgroundAutoFillPreview: new Set([0]),
    });
    render(<FieldSetupFeature />);

    expect(screen.getByRole("button", { name: "Standard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Custom" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("centers a custom field's bounding box around the origin", () => {
    const points = new Set([encodePoint(10, 5), encodePoint(11, 5), encodePoint(12, 5)]);
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldConfig: fieldOf("square", { shape: "custom", points: [[10, 5], [11, 5], [12, 5]] }),
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: points,
          freeFieldPoints: { ...emptyFreePoints(), square: points },
        }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Center field" }));

    const moved = [...useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints].map(decodePoint);
    const cfg = useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldConfig;
    const centers = moved.map(([x, y]) => getCartesian(x, y, cfg));
    const centerX = (Math.min(...centers.map(([x]) => x)) + Math.max(...centers.map(([x]) => x))) / 2;
    const centerY = (Math.min(...centers.map(([, y]) => y)) + Math.max(...centers.map(([, y]) => y))) / 2;
    expect([centerX, centerY]).toEqual(getCartesian(0, 0, cfg));
  });

  it("does not move an already centered 11 by 11 square field", () => {
    const cells = Array.from({ length: 11 }, (_, row) => Array.from(
      { length: 11 },
      (_, col) => [col - 5, row - 5] as [number, number],
    )).flat();
    const points = new Set(cells.map(([x, y]) => encodePoint(x, y)));
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldConfig: fieldOf("square", { shape: "custom", points: cells }),
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: points,
          freeFieldPoints: { ...emptyFreePoints(), square: points },
        }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Center field" }));

    expect([...useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldPoints]).toEqual([...points]);
  });

  it("disables centering for an empty custom field", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
    });
    render(<FieldSetupFeature />);

    expect(screen.getByRole("button", { name: "Center field" })).toBeDisabled();
  });

  const descriptionCases: [FieldConfig, string][] = [
    [fieldOf("square", { shape: "rect", cols: 20, rows: 28 }), "Field size: 20 × 28 cells"],
    [fieldOf("square", { shape: "circle", radius: 5 }), "Field radius: 5 cells"],
    [fieldOf("hex", { shape: "rect", cols: 10, rows: 8 }, "flat_top"), "Field size: 10 × 8 cells"],
    [fieldOf("hex", { shape: "circle", radius: 5 }, "flat_top"), "Field radius: 5 cells"],
    [fieldOf("hex", { shape: "triangle", side: 6 }, "flat_top"), "Field side: 6 cells"],
    [fieldOf("tri", { shape: "circle", radius: 4 }, "r0"), "Field radius: 4 cells"],
    [fieldOf("hex", { shape: "hexagon", radius: 5 }, "flat_top"), "Field radius: 5 cells"],
    [fieldOf("tri", { shape: "triangle", side: 5 }, "r0"), "Field side: 5 cells"],
    [fieldOf("cairo", { shape: "circle", radius: 12 }), "Field radius: 12 cells"],
    [fieldOf("cairo", { shape: "triangle", side: 20 }), "Field side: 20 cells"],
    [fieldOf("cairo", { shape: "hexagon", radius: 12 }), "Field radius: 12 cells"],
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
    fireEvent.change(inputs[4], { target: { value: "10" } });
    fireEvent.click(getTooltipControlWithin(dialog!, "Portrait"));
    fireEvent.click(dialogQueries.getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 20, rows: 28 }));
    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({
      paperSize: "a4",
      orientation: "portrait",
      marginHMm: 5,
      marginVMm: 5,
      scaleAutoFit: false,
    });
    expect(useMazeStore.getState().pngExportSettings.print.scale).toBeCloseTo(mmToPx(10, 300) / 40);
  });

  it("keeps the print cell-size input compact", () => {
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const cellInput = within(dialog!).getAllByRole("spinbutton")[4] as HTMLInputElement;

    expect(cellInput).toHaveStyle({ width: "56px", boxSizing: "border-box" });
  });

  it("shows only the field size in the single-floor result", () => {
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));

    expect(screen.getByText("Field size: 20 × 28 cells")).toBeInTheDocument();
    expect(screen.getByText("Cell count: 560")).toBeInTheDocument();
    expect(screen.queryByText(/Field footprint:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Usable area:/)).not.toBeInTheDocument();
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
    expect(inputs[2].value).toBe("7");
    expect(inputs[3].value).toBe("9");
    expect(inputs[4].value).toBe("12");
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
    expect((within(dialog!).getAllByRole("spinbutton")[4] as HTMLInputElement).value).toBe("10");
  });

  it("allows the last numeric character to be cleared", () => {
    render(<FieldSetupFeature />);
    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const cellInput = within(dialog!).getAllByRole("spinbutton")[4] as HTMLInputElement;

    fireEvent.change(cellInput, { target: { value: "" } });

    expect(cellInput.value).toBe("");
  });

  it("shows a confirmation before changing a field with generation results", () => {
    useMazeStore.setState({
      tessellationKind: "hex",
      mazeDirty: true,
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ selectedShape: "parallelogram", fieldConfig: fieldOf("hex", { shape: "parallelogram", cols: 8, rows: 6 }, "flat_top") }) },
    });
    render(<FieldSetupFeature />);
    fireEvent.change(screen.getByDisplayValue("Parallelogram"), { target: { value: "hexagon" } });
    expect(screen.getByText("Changing the field resets the current generation and post-edit results. Continue?")).toBeInTheDocument();
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].selectedShape).toBe("parallelogram");
  });

  it("shows only the generation-loss dialog when switching from custom to default", () => {
    const base = baseFloorFieldConfig();
    useMazeStore.setState({
      mazeDirty: true,
      floorFields: { [TEST_FLOOR_ID]: { ...base, fieldEditMode: "custom", fieldPoints: new Set([1, 2]) } },
    });
    render(<FieldSetupFeature />);
    fireEvent.click(screen.getByText(m["field.default"]()));
    expect(screen.getByText(m["field.reset_generation_warning"]())).toBeInTheDocument();
    expect(screen.queryByText(m["field.confirm_switch_to_default"]())).not.toBeInTheDocument();
  });

  it("is hidden with a single floor", () => {
    render(<FieldSetupFeature />);
    expect(screen.queryByText("Copy floor")).not.toBeInTheDocument();
    expect(screen.queryByText(m["floors.from_current"]())).not.toBeInTheDocument();
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
    expect(screen.getByText(m["floors.from_current"]())).toBeInTheDocument();
  });

  it("describes smoothing", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
    });
    render(<FieldSetupFeature />);

    expect(screen.getAllByText("Smoothing").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByText(/removes cells that touch the rest of the selected shape by only one side/)).toBeInTheDocument();
  });

  it("shows and updates primitive smoothing for a standard field", () => {
    render(<FieldSetupFeature />);

    expect(screen.getAllByText("Smoothing").length).toBeGreaterThan(0);
    const smoothing = screen.getByRole("checkbox");
    expect(smoothing).toBeChecked();
    fireEvent.click(smoothing);
    expect(useMazeStore.getState().smoothPrimitives).toBe(false);
  });

  it("mentions the hold hotkey in the tooltip only for the custom editor", () => {
    const hint = m["field.smooth_hold_hint"]();
    const { unmount } = render(<FieldSetupFeature />);
    expect(screen.queryAllByText(hint)).toHaveLength(0);
    unmount();
    useMazeStore.setState({
      floorFields: { [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }) },
    });
    render(<FieldSetupFeature />);
    expect(screen.queryAllByText(hint).length).toBeGreaterThan(0);
  });

  it("shows the inverted smoothing state while the hotkey is held", () => {
    useMazeStore.setState({ smoothPrimitives: true, smoothInverted: false });
    render(<FieldSetupFeature />);
    const smoothing = screen.getByRole("checkbox");
    expect(smoothing).toBeChecked();
    act(() => useMazeStore.getState().setSmoothInverted(true));
    expect(smoothing).not.toBeChecked();
    expect(useMazeStore.getState().smoothPrimitives).toBe(true);
  });

  it("offers one polygon tool whose operation follows the active mode", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
    });
    render(<FieldSetupFeature />);

    const polygonTool = screen.getByRole("button", { name: /Polygon/ });
    const description = document.getElementById(polygonTool.parentElement?.getAttribute("aria-describedby")!);
    expect(description).toHaveTextContent("Polygon8Move vertices freely.");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldOperation).toBe("remove");
    fireEvent.click(screen.getByRole("button", { name: /Select/ }));
    const mirrorTool = screen.getByRole("button", { name: /Mirror/ });
    expect(mirrorTool).toBeDisabled();
    const mirrorDescription = document.getElementById(mirrorTool.parentElement?.getAttribute("aria-describedby")!);
    expect(mirrorDescription).toHaveTextContent("MirrorMUnavailable in Select mode.");
  });

  it("keeps the mirror tool visible but disabled where core offers no reflection", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldConfig: fieldOf("snub_hexagonal", { shape: "rect", cols: 3, rows: 3 }),
        }),
      },
    });
    render(<FieldSetupFeature />);

    const mirrorTool = screen.getByRole("button", { name: /Mirror/ });
    expect(mirrorTool).toBeDisabled();
    const description = document.getElementById(mirrorTool.parentElement?.getAttribute("aria-describedby")!);
    expect(description).toHaveTextContent("Unavailable in this tessellation.");
  });

  it("disables Copy without a selection and Paste without a clipboard, with explanations", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
      fieldClipboard: null,
      fieldHasSelection: false,
    });
    render(<FieldSetupFeature />);

    expect(screen.getByRole("button", { name: m["field.copy.tool"]() })).toBeDisabled();
    expect(screen.getByRole("button", { name: m["field.paste.tool"]() })).toBeDisabled();
    expect(getTooltipAnchor(m["field.copy.empty_selection"]())).toBeInTheDocument();
    expect(getTooltipAnchor(m["field.paste.empty_clipboard"]())).toBeInTheDocument();
  });

  it("enables Copy with a selection and Paste with a clipboard", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
      fieldClipboard: [[0, 0]],
      fieldHasSelection: true,
    });
    render(<FieldSetupFeature />);

    expect(screen.getByRole("button", { name: m["field.copy.tool"]() })).toBeEnabled();
    expect(screen.getByRole("button", { name: m["field.paste.tool"]() })).toBeEnabled();
  });

  it("shows only the tessellation reason when the tessellation has no translation symmetry", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldConfig: fieldOf("radial", { shape: "custom", points: [] }),
        }),
      },
      fieldClipboard: null,
      fieldHasSelection: false,
    });
    render(<FieldSetupFeature />);

    expect(screen.getByRole("button", { name: m["field.copy.tool"]() })).toBeDisabled();
    expect(screen.getByRole("button", { name: m["field.paste.tool"]() })).toBeDisabled();
    expect(getTooltipAnchors(m["field.clipboard.tessellation_disabled"]())).toHaveLength(2);
    expect(screen.queryAllByTestId("tooltip-anchor").filter((a) => document.getElementById(a.getAttribute("aria-describedby") ?? "")?.textContent?.includes(m["field.paste.empty_clipboard"]()))).toHaveLength(0);
  });

  it("offers the parallelogram tool for a square field", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
    });
    render(<FieldSetupFeature />);

    const tool = screen.getByRole("button", { name: /Parallelogram/ });
    const description = document.getElementById(tool.parentElement?.getAttribute("aria-describedby")!);
    expect(description).toHaveTextContent("Parallelogram7");
  });

  it("labels the connected-area tool and explains its effect", () => {
    useMazeStore.setState({
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldEditMode: "custom", isEditingField: true }),
      },
    });
    render(<FieldSetupFeature />);

    const tool = screen.getByRole("button", { name: /Connected Area/ });
    const description = document.getElementById(tool.parentElement?.getAttribute("aria-describedby")!);
    expect(description).toHaveTextContent("Connected AreaAAffects all connected cells.");
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
        floor_2: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "triangle", side: 4 }) }),
        floor_3: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: new Set([0]),
          fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0]] }),
        }),
      },
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "a4", orientation: "portrait", marginHMm: 5, marginVMm: 5 },
      },
      activeFieldConfig: fieldOf("square", { shape: "rect", cols: 10, rows: 10 }),
      mazeDirty: false,
      postEditDirty: false,
      fieldEditConfirmation: null,
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));
    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const dialogQueries = within(dialog!);
    const cellInput = dialogQueries.getAllByRole("spinbutton")[4] as HTMLInputElement;
    fireEvent.change(cellInput, { target: { value: "10" } });
    expect(cellInput.value).toBe("10");
    fireEvent.click(getTooltipControlWithin(dialog!, "Portrait"));
    expect(dialogQueries.getByRole("checkbox")).toBeChecked();
    expect(dialogQueries.getByRole("button", { name: "Confirm" })).not.toBeDisabled();
    fireEvent.click(dialogQueries.getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().floorFields[TEST_FLOOR_ID].fieldConfig).toEqual(fieldOf("square", { shape: "rect", cols: 20, rows: 28 }));
    expect(useMazeStore.getState().floorFields.floor_2.fieldConfig.shape.shape).toBe("triangle");
    expect((useMazeStore.getState().floorFields.floor_2.fieldConfig.shape as { side: number }).side).toBeGreaterThan(0);
    expect(useMazeStore.getState().floorFields.floor_3.fieldConfig).toEqual(fieldOf("square", { shape: "custom", points: [[0, 0]] }));
  });

  it("recalculates every standard floor when print parameters change", async () => {
    useMazeStore.setState({
      floors: [
        { id: TEST_FLOOR_ID, title: "Ground floor" },
        { id: "floor_2", title: "Upper floor" },
        { id: "floor_3", title: "Custom floor" },
      ],
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 11, rows: 11 }) }),
        floor_2: baseFloorFieldConfig({
          fieldConfig: fieldOf("square", { shape: "triangle", side: 5 }),
        }),
        floor_3: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: new Set([0]),
          fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0]] }),
        }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate for print" }));

    expect(screen.getByText("Floors")).toBeInTheDocument();
    const groundRow = screen.getByText("1: Ground floor").parentElement!;
    const upperRow = screen.getByText("2: Upper floor").parentElement!;
    const customRow = screen.getByText("3: Custom floor").parentElement!;
    expect(upperRow.compareDocumentPosition(groundRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(groundRow).getByText("Rectangle")).toBeInTheDocument();
    expect(within(groundRow).getByText("20 × 28")).toBeInTheDocument();
    expect(within(groundRow).getByText("560 cells")).toBeInTheDocument();
    expect(within(upperRow).getByText("Triangle")).toBeInTheDocument();
    expect(within(customRow).getByText("Non-standard shape")).toBeInTheDocument();
    expect(within(customRow).getByText("—")).toBeInTheDocument();
    expect(within(customRow).getByText("1 cell")).toBeInTheDocument();
    expect(screen.getByText(/^Total:/)).toBeInTheDocument();
    expect(screen.getByText("Apply to all floors with standard shape")).toBeInTheDocument();

    const dialog = screen.getByText("Calculate field for print").parentElement?.parentElement;
    const cellInput = within(dialog!).getAllByRole("spinbutton")[4] as HTMLInputElement;
    fireEvent.change(cellInput, { target: { value: "5" } });

    await waitFor(() => {
      expect(within(groundRow).getByText("40 × 57")).toBeInTheDocument();
      expect(within(groundRow).getByText("2280 cells")).toBeInTheDocument();
      expect(within(upperRow).getByText("Triangle")).toBeInTheDocument();
    });
  });

  it("shows and configures the shared paper layout in custom mode", () => {
    useMazeStore.setState({
      showPaperLayout: false,
      floorFields: {
        [TEST_FLOOR_ID]: baseFloorFieldConfig({
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: new Set([0]),
          fieldConfig: fieldOf("square", { shape: "custom", points: [[0, 0]] }),
        }),
      },
    });
    render(<FieldSetupFeature />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Paper layout" }));
    expect(useMazeStore.getState().showPaperLayout).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Configure paper layout" }));
    const dialogTitle = screen.getAllByText("Paper layout")[1];
    const dialog = dialogTitle.parentElement?.parentElement;
    expect(dialog).toBeTruthy();
    const inputs = within(dialog!).getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(inputs[4], { target: { value: "12" } });
    fireEvent.click(within(dialog!).getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({
      scaleAutoFit: false,
      marginHMm: 5,
      marginVMm: 5,
    });
    expect(useMazeStore.getState().pngExportSettings.print.scale).toBeCloseTo(mmToPx(12, 300) / 40);
  });
});

describe("fieldSetupSubtitle — multi-floor aggregation (GitHub issue #383)", () => {
  it("sums cell counts across floors, not just the first floor's", () => {
    const floors = [
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) }),
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 2, rows: 2 }) }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("13");
  });

  it("shows the shared shape label when all floors match", () => {
    const floors = [
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) }),
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Rect");
  });

  it("labels a Cairo rectangle with its fundamental-square dimensions", () => {
    const floors = [
      baseFloorFieldConfig({ selectedShape: "rect", fieldConfig: fieldOf("cairo", { shape: "rect", cols: 2, rows: 3 }) }),
    ];
    expect(fieldSetupSubtitle("cairo", floors)).toContain("2×3");
  });

  it("shows 'Different floor shapes' when floors' shapes/sizes differ", () => {
    const floors = [
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) }),
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 5, rows: 5 }) }),
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
      baseFloorFieldConfig({ fieldConfig: fieldOf("square", { shape: "rect", cols: 3, rows: 3 }) }),
    ];
    expect(fieldSetupSubtitle("square", floors)).toContain("Different floor shapes");
  });
});
