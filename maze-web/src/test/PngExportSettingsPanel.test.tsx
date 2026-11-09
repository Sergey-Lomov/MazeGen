import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as m from "~/paraglide/messages";

const { PngExportSettingsPanel } = await import("../components/features/PngExportSettingsPanel");
const { useMazeStore } = await import("../store/mazeStore");
const { DEFAULT_PNG_EXPORT_SETTINGS, DEFAULT_VECTOR_BY_WALLS_SETTINGS } = await import("../store/slices/imageExportSlice");
const { baseStoreState } = await import("./storeTestHelpers");

function setBaseState(overrides: Record<string, unknown> = {}) {
  useMazeStore.setState({
    ...baseStoreState(),
    activeRenderMode: "vector_by_walls",
    vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    nodes: [{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }],
    ...overrides,
  });
}

beforeEach(() => {
  setBaseState();
});

function getPrintScaleAction(): HTMLButtonElement {
  const title = m["image_export.format.png.print.scale_auto_fit"]();
  return screen.getByRole("button", { name: title });
}

describe("PngExportSettingsPanel", () => {
  it("defaults to digital mode with a one-cell margin", () => {
    render(<PngExportSettingsPanel />);
    expect(screen.getByText(m["image_export.format.png.digital.scale"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.format.png.digital.margin"]())).toBeInTheDocument();
    expect(useMazeStore.getState().pngExportSettings.digital).toMatchObject({ canvasMode: "margin_cells", marginValue: 1 });
    expect(screen.queryByText(m["image_export.format.png.digital.width"]())).not.toBeInTheDocument();
  });

  it("switches to print mode and shows print fields", () => {
    render(<PngExportSettingsPanel />);
    fireEvent.click(screen.getByText(m["image_export.format.png.mode.print"]()));
    expect(useMazeStore.getState().pngExportSettings.outputMode).toBe("print");
    expect(screen.getByText(m["image_export.format.png.print.density"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.format.png.print.anchor"]())).toBeInTheDocument();
  });

  it("provides the shared bounded scale slider and click-to-edit print scale", () => {
    setBaseState({ pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print" } });
    render(<PngExportSettingsPanel />);

    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "1");
    expect(slider).toHaveAttribute("max", "8");
    expect(slider).toHaveAttribute("step", "0.1");
    fireEvent.click(screen.getByRole("button", { name: m["common.exact_input"]() }));
    const input = screen.getByRole("spinbutton", { name: m["image_export.format.png.digital.scale"]() });
    expect(input).toHaveAttribute("min", "0.11");
    expect(input).not.toHaveAttribute("max");
    expect(document.body).toHaveTextContent(m["image_export.format.png.print.canvas_navigation_hint"]());
  });

  it("places the print scale row after positioning", () => {
    setBaseState({ pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print" } });
    render(<PngExportSettingsPanel />);

    const positionRow = screen.getByText(m["image_export.format.png.print.anchor"]()).parentElement!;
    const scaleRow = screen.getByRole("slider").parentElement!.parentElement!;
    expect(positionRow.compareDocumentPosition(scaleRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clamps the exact scale input above 0.1", () => {
    setBaseState({ pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print" } });
    render(<PngExportSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: m["common.exact_input"]() }));
    const input = screen.getByRole("spinbutton", { name: m["image_export.format.png.digital.scale"]() });
    fireEvent.change(input, { target: { value: "0.1" } });
    fireEvent.blur(input);
    expect(useMazeStore.getState().pngExportSettings.print.scale).toBe(0.11);
  });

  it("keeps print scale edits manual", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scaleAutoFit: false },
      },
    });
    render(<PngExportSettingsPanel />);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({ scale: 2, scaleAutoFit: false });
  });

  it("performs print auto-fit once without enabling a persistent mode", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scale: 7, scaleAutoFit: false },
      },
    });
    render(<PngExportSettingsPanel />);

    const button = getPrintScaleAction();
    expect(button).toHaveStyle("aspect-ratio: 1 / 1");
    fireEvent.click(button);
    const fittedScale = useMazeStore.getState().pngExportSettings.print.scale;
    expect(fittedScale).not.toBe(7);
    expect(useMazeStore.getState().pngExportSettings.print.scaleAutoFit).toBe(false);

    useMazeStore.getState().setPrintPaperSize("a3");
    expect(useMazeStore.getState().pngExportSettings.print.scale).toBe(fittedScale);
  });

  it("shows margin input only for margin_px/margin_cells canvas modes, and sets default margin value on switch", () => {
    render(<PngExportSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.format.png.digital.canvas_margin_cells"]()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "margin_px" } });
    expect(useMazeStore.getState().pngExportSettings.digital.marginValue).toBe(20);
    expect(screen.getByText(m["image_export.format.png.digital.margin"]())).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "margin_cells" } });
    expect(useMazeStore.getState().pngExportSettings.digital.marginValue).toBe(1);
  });

  it("shows fixed width/height inputs only for fixed_size canvas mode", () => {
    render(<PngExportSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.format.png.digital.canvas_margin_cells"]()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "fixed_size" } });
    expect(screen.getByText(m["image_export.format.png.digital.width"]())).toBeInTheDocument();
    expect(screen.getByText(m["image_export.format.png.digital.height"]())).toBeInTheDocument();
  });

  it("keeps empty digital fields out of the store and clamps negative values on blur", () => {
    render(<PngExportSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.format.png.digital.canvas_margin_cells"]()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "margin_px" } });
    const input = screen.getByDisplayValue("20") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(useMazeStore.getState().pngExportSettings.digital.marginValue).toBe(20);
    fireEvent.change(input, { target: { value: "-5" } });
    fireEvent.blur(input);
    expect(useMazeStore.getState().pngExportSettings.digital.marginValue).toBe(0);
    expect(screen.getByTestId("field-hint")).toHaveTextContent(
      m["input_hint.clamped_min"]({ min: "0", max: "∞" }),
    );
  });

  it("shows a digital overflow warning bubble with a fill percentage when content exceeds a fixed canvas", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        digital: { scale: 100, canvasMode: "fixed_size", marginValue: 0, fixedWidth: 10, fixedHeight: 10 },
      },
    });
    render(<PngExportSettingsPanel />);
    const bubbleText = m["image_export.format.png.warning_overflows_canvas"]({ percent: "0" }).replace(/0%.*/, "");
    const matches = screen.getAllByText((_, el) => el?.tagName === "SPAN" && !!el.textContent?.startsWith(bubbleText));
    expect(matches.length).toBeGreaterThan(0);
  });

  it("does not show a digital overflow warning when content fits the fixed canvas", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        digital: { scale: 0.1, canvasMode: "fixed_size", marginValue: 0, fixedWidth: 5000, fixedHeight: 5000 },
      },
    });
    render(<PngExportSettingsPanel />);
    const bubbleText = m["image_export.format.png.warning_overflows_canvas"]({ percent: "0" }).replace(/0%.*/, "");
    expect(screen.queryByText((_, el) => !!el?.textContent?.startsWith(bubbleText))).not.toBeInTheDocument();
  });

  it("shows print margin-zone warning when scale is large", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scale: 1000, scaleAutoFit: false },
      },
    });
    render(<PngExportSettingsPanel />);
    const bubbleText = m["image_export.format.png.warning_in_margin_zone"]();
    const matches = screen.getAllByText((_, el) => el?.tagName === "SPAN" && !!el.textContent?.startsWith(bubbleText));
    expect(matches.length).toBeGreaterThan(0);
  });

  it("one-shot auto-fit never leaves a spurious margin-zone warning", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, scale: 1000, scaleAutoFit: false },
      },
    });
    render(<PngExportSettingsPanel />);
    fireEvent.click(getPrintScaleAction());
    const bubbleText = m["image_export.format.png.warning_in_margin_zone"]();
    expect(screen.queryByText((_, el) => !!el?.textContent?.startsWith(bubbleText))).not.toBeInTheDocument();
  });

  it("width/height mm inputs are disabled unless paper size is custom", () => {
    setBaseState({ pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print" } });
    render(<PngExportSettingsPanel />);
    const widthInput = screen.getByDisplayValue("210") as HTMLInputElement;
    expect(widthInput).toBeDisabled();
  });

  it("width/height mm inputs are editable when paper size is custom", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "custom" },
      },
    });
    render(<PngExportSettingsPanel />);
    const widthInput = screen.getByDisplayValue("210") as HTMLInputElement;
    expect(widthInput).not.toBeDisabled();
  });

  it("paper size select displays 'Custom' label, not a separator, once 'custom' is actually selected", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, paperSize: "custom" },
      },
    });
    render(<PngExportSettingsPanel />);
    const select = screen.getByDisplayValue(m["image_export.format.png.print.paper_custom"]()) as HTMLSelectElement;
    expect(select.value).toBe("custom");
  });

  it("keeps the current Custom print anchor readable while preventing it as a new choice", () => {
    setBaseState({
      pngExportSettings: {
        ...DEFAULT_PNG_EXPORT_SETTINGS,
        outputMode: "print",
        print: { ...DEFAULT_PNG_EXPORT_SETTINGS.print, anchor: "custom" },
      },
    });
    render(<PngExportSettingsPanel />);

    const select = screen.getByText(m["image_export.format.png.print.anchor"]()).parentElement!.querySelector("select") as HTMLSelectElement;
    const custom = Array.from(select.options).find((option) => option.value === "custom");
    expect(custom).toBeDefined();
    expect(custom).not.toBeDisabled();
  });

  it("shows a result-info section (image size + cell size) below a divider in digital mode", () => {
    render(<PngExportSettingsPanel />);
    const imageSizeMatch = screen.getAllByText((_, el) => !!el?.textContent?.includes("Image size"));
    expect(imageSizeMatch.length).toBeGreaterThan(0);
    const cellSizeMatch = screen.getAllByText((_, el) => !!el?.textContent?.includes("Cell size"));
    expect(cellSizeMatch.length).toBeGreaterThan(0);
  });

  it("shows a result-info section (image size + cell size in mm) in print mode", () => {
    setBaseState({ pngExportSettings: { ...DEFAULT_PNG_EXPORT_SETTINGS, outputMode: "print" } });
    render(<PngExportSettingsPanel />);
    const cellSizeMatch = screen.getAllByText((_, el) => !!el?.textContent?.includes("mm"));
    expect(cellSizeMatch.length).toBeGreaterThan(0);
  });
});
