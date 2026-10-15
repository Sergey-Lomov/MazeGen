import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackgroundImageToggle } from "../components/BackgroundImageToggle";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import { fieldOf } from "./fieldConfigFixtures";

const autoFillStub = vi.hoisted(() => ({
  delayed: false,
  nextPoints: new Set([0x00010001]),
  resolve: null as (() => void) | null,
  topLeftColor: vi.fn(() => Promise.resolve(0x123456)),
  rejectPreview: false,
}));

const backgroundLayoutStub = vi.hoisted(() => ({
  fieldBounds: vi.fn<() => { minX: number; minY: number; maxX: number; maxY: number } | null>(() => ({ minX: -10, minY: -10, maxX: 10, maxY: 10 })),
  bounds: [] as unknown[],
}));

vi.mock("../pixi/backgroundFieldAutofill", () => ({
  getBackgroundImageTopLeftColor: autoFillStub.topLeftColor,
  buildBackgroundFieldPreviewFromImage: vi.fn(() => {
    if (autoFillStub.rejectPreview) return Promise.reject(new Error("preview failed"));
    if (!autoFillStub.delayed) return Promise.resolve(new Set(autoFillStub.nextPoints));
    return new Promise<Set<number>>((resolve) => {
      autoFillStub.resolve = () => resolve(new Set(autoFillStub.nextPoints));
    });
  }),
}));

vi.mock("../pixi/fieldEditUtils", () => ({
  resolveCells: () => [[0, 0]],
}));

vi.mock("../pixi/BackgroundImageLayer", () => ({
  backgroundImageCrop: (image: { cropX?: number; cropY?: number; cropWidth?: number; cropHeight?: number; naturalWidth: number; naturalHeight: number }) => ({
    x: image.cropX ?? 0,
    y: image.cropY ?? 0,
    width: image.cropWidth ?? image.naturalWidth,
    height: image.cropHeight ?? image.naturalHeight,
  }),
  fieldBounds: () => backgroundLayoutStub.fieldBounds(),
  calculateBackgroundImageLayout: (
    dataUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    bounds: unknown,
  ) => {
    backgroundLayoutStub.bounds.push(bounds);
    return {
      dataUrl,
      naturalWidth,
      naturalHeight,
      displayWidth: 200,
      displayHeight: 100,
      centerX: 0,
      centerY: 0,
    };
  },
  calculateBackgroundImagePageLayout: (
    dataUrl: string,
    naturalWidth: number,
    naturalHeight: number,
  ) => ({
    dataUrl,
    naturalWidth,
    naturalHeight,
    displayWidth: 300,
    displayHeight: 150,
    centerX: 0,
    centerY: 0,
  }),
}));

class FakeFileReader {
  result = "data:image/png;base64,test";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(): void {
    this.onload?.();
  }
}

class FakeImage {
  naturalWidth = 200;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    this.onload?.();
  }
}

beforeEach(() => {
  autoFillStub.delayed = false;
  autoFillStub.nextPoints = new Set([0x00010001]);
  autoFillStub.resolve = null;
  autoFillStub.topLeftColor.mockClear();
  autoFillStub.rejectPreview = false;
  backgroundLayoutStub.fieldBounds.mockReset();
  backgroundLayoutStub.fieldBounds.mockReturnValue({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  backgroundLayoutStub.bounds.length = 0;
  useMazeStore.setState({
    ...baseStoreState(),
    showBackgroundImage: false,
    backgroundImage: null,
  });
  vi.stubGlobal("FileReader", FakeFileReader);
  vi.stubGlobal("Image", FakeImage);
  const slot = document.createElement("div");
  slot.id = "side-panel-slot";
  document.body.appendChild(slot);
});

afterEach(() => {
  document.getElementById("side-panel-slot")?.remove();
});

describe("BackgroundImageToggle", () => {
  it("keeps the switch off when the picker is cancelled", () => {
    render(<BackgroundImageToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Underlay" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Upload underlay"), { target: { files: [] } });

    expect(useMazeStore.getState().showBackgroundImage).toBe(false);
  });

  it("loads a selected image, calculates its layout, and can hide it again", async () => {
    render(<BackgroundImageToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Underlay" });
    const input = screen.getByLabelText("Upload underlay");

    fireEvent.click(toggle);
    fireEvent.change(input, {
      target: { files: [new File(["image"], "underlay.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(useMazeStore.getState().showBackgroundImage).toBe(true));
    expect(useMazeStore.getState().backgroundImage).toMatchObject({
      dataUrl: "data:image/png;base64,test",
      naturalWidth: 200,
      naturalHeight: 100,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Underlay" }));
    expect(useMazeStore.getState().showBackgroundImage).toBe(false);
  });

  it("uses default fitting bounds for empty and very small fields", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      floorFields: {
        [fieldId]: {
          ...field,
          fieldEditMode: "custom",
          fieldPoints: new Set(),
          fieldConfig: fieldOf("square", { shape: "custom", points: [] }),
        },
      },
    });
    backgroundLayoutStub.fieldBounds
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ minX: 10, minY: 20, maxX: 10.5, maxY: 21 });
    render(<BackgroundImageToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Underlay" });
    const input = screen.getByLabelText("Upload underlay");

    fireEvent.click(toggle);
    fireEvent.change(input, {
      target: { files: [new File(["empty"], "empty.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(useMazeStore.getState().showBackgroundImage).toBe(true));

    fireEvent.change(input, {
      target: { files: [new File(["small"], "small.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(backgroundLayoutStub.bounds).toHaveLength(2));

    expect(backgroundLayoutStub.bounds).toEqual([
      { minX: -200, minY: -200, maxX: 200, maxY: 200 },
      { minX: -189.75, minY: -179.5, maxX: 210.25, maxY: 220.5 },
    ]);
  });

  it("preserves field bounds that are already large enough for fitting", async () => {
    backgroundLayoutStub.fieldBounds.mockReturnValue({ minX: -300, minY: -250, maxX: 300, maxY: 250 });
    render(<BackgroundImageToggle />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Underlay" }));
    fireEvent.change(screen.getByLabelText("Upload underlay"), {
      target: { files: [new File(["large"], "large.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(backgroundLayoutStub.bounds).toHaveLength(1));
    expect(backgroundLayoutStub.bounds[0]).toEqual({ minX: -300, minY: -250, maxX: 300, maxY: 250 });
  });

  it("restores the saved transform instead of recalculating it when shown again", () => {
    const savedImage = {
      dataUrl: "data:image/png;base64:saved",
      naturalWidth: 800,
      naturalHeight: 600,
      displayWidth: 731,
      displayHeight: 419,
      centerX: 37,
      centerY: -24,
      layer: "below_grid" as const,
      opacity: 0.4,
    };
    useMazeStore.setState({ showBackgroundImage: false, backgroundImage: savedImage });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Underlay" }));

    expect(useMazeStore.getState().showBackgroundImage).toBe(true);
    expect(useMazeStore.getState().backgroundImage).toEqual(savedImage);
  });

  it("updates underlay settings from the settings panel", () => {
    useMazeStore.setState({
      showBackgroundImage: true,
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    expect(screen.getByRole("button", { name: "Transform" })).toHaveClass("btn-secondary");
    expect(screen.getByRole("button", { name: "Transform to field" })).toHaveClass("btn-secondary");
    expect(screen.getByRole("button", { name: "Transform for print" })).toHaveClass("btn-secondary");
    expect(screen.getByRole("button", { name: "Replace underlay" })).toHaveClass("btn-secondary");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "above_floor" } });
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));

    fireEvent.click(screen.getByRole("button", { name: "Transform to field" }));
    expect(useMazeStore.getState().backgroundImage).toMatchObject({ displayWidth: 200, displayHeight: 100, centerX: 0, centerY: 0 });

    expect(useMazeStore.getState().backgroundImage).toMatchObject({ layer: "above_floor", opacity: 0.75 });
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(useMazeStore.getState().backgroundImageCropping).toBe(true);
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(useMazeStore.getState().backgroundImageCropping).toBe(false);
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(useMazeStore.getState().backgroundImageCropping).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    expect(useMazeStore.getState().backgroundImageCropping).toBe(false);
  });

  it("closes the settings panel when the underlay is hidden", () => {
    useMazeStore.setState({
      showBackgroundImage: true,
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    expect(screen.getByText("Underlay settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Underlay" }));

    expect(useMazeStore.getState().showBackgroundImage).toBe(false);
    expect(screen.queryByText("Underlay settings")).not.toBeInTheDocument();
  });

  it("offers auto-fill only for a custom field and keeps preview separate until confirmation", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: {
        [fieldId]: {
          ...field,
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: new Set([0x00050005]),
        },
      },
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    expect(screen.getByText("Auto-fill field")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).not.toBeNull());
    expect(useMazeStore.getState().floorFields[fieldId].fieldPoints).toEqual(new Set([0x00050005]));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useMazeStore.getState().backgroundAutoFillPreview).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText("The new field shape will completely replace the existing field. Continue?")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Ok" }));
    expect(useMazeStore.getState().floorFields[fieldId].fieldPoints).toEqual(new Set([0x00010001]));
  });

  it("locks editing immediately while the first preview calculation is pending", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    const originalPoints = new Set([0x00050005]);
    autoFillStub.delayed = true;
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: {
        [fieldId]: {
          ...field,
          fieldEditMode: "custom",
          isEditingField: true,
          fieldPoints: originalPoints,
        },
      },
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(originalPoints);
    expect(useMazeStore.getState().floorFields[fieldId].fieldPoints).toEqual(originalPoints);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();

    useMazeStore.getState().addFieldPoints([[2, 0]]);
    expect(useMazeStore.getState().floorFields[fieldId].fieldPoints).toEqual(originalPoints);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useMazeStore.getState().backgroundAutoFillPreview).toBeNull();
    autoFillStub.resolve?.();
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toBeNull());
  });

  it("keeps the previous preview while recalculating after a setting change", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: { [fieldId]: { ...field, fieldEditMode: "custom", isEditingField: true } },
    });
    render(<BackgroundImageToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00010001])));

    autoFillStub.delayed = true;
    autoFillStub.nextPoints = new Set([0x00020002]);
    fireEvent.change(screen.getAllByRole("slider")[1], { target: { value: "0.6" } });

    expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00010001]));
    await waitFor(() => expect(autoFillStub.resolve).toEqual(expect.any(Function)));
    autoFillStub.resolve?.();
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00020002])));
  });

  it("recalculates preview when the field grid configuration changes", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: { [fieldId]: { ...field, fieldEditMode: "custom", isEditingField: true } },
    });
    render(<BackgroundImageToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00010001])));

    autoFillStub.delayed = true;
    autoFillStub.nextPoints = new Set([0x00030003]);
    useMazeStore.setState({
      floorFields: {
        [fieldId]: {
          ...useMazeStore.getState().floorFields[fieldId],
          fieldConfig: fieldOf("square", { shape: "rect", cols: 7, rows: 7 }),
        },
      },
    });

    expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00010001]));
    await waitFor(() => expect(autoFillStub.resolve).not.toBeNull());
    autoFillStub.resolve?.();
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(new Set([0x00030003])));
  });

  it("infers the selected background color only when the detection mode changes", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: { [fieldId]: { ...field, fieldEditMode: "custom", isEditingField: true } },
    });
    render(<BackgroundImageToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));

    const modeSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(modeSelect, { target: { value: "color" } });
    await waitFor(() => expect(autoFillStub.topLeftColor).toHaveBeenCalledWith("data:image/png;base64:saved"));
    expect(autoFillStub.topLeftColor).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getAllByRole("slider")[1], { target: { value: "0.7" } });
    expect(autoFillStub.topLeftColor).toHaveBeenCalledTimes(1);
  });

  it("does not confirm the stale preview after a recalculation error", async () => {
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      openCard: "field_setup",
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      floorFields: { [fieldId]: { ...field, fieldEditMode: "custom", isEditingField: true } },
    });
    render(<BackgroundImageToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    autoFillStub.rejectPreview = true;
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(screen.getByText("The underlay could not be read for field detection.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("opens the page-layout dialog when the paper layout is not visible", () => {
    useMazeStore.setState({
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      showPaperLayout: false,
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform for print" }));

    expect(screen.getByText("Fit underlay to page")).toBeInTheDocument();
    expect(screen.queryByText("Cell size")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Landscape"));
    fireEvent.change(document.querySelector('input[name="background-print-margin-horizontal"]')!, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(useMazeStore.getState().showPaperLayout).toBe(false);
    expect(useMazeStore.getState().pngExportSettings.print).toMatchObject({ orientation: "landscape", marginHMm: 7, marginVMm: 5 });
  });

  it("fits immediately to the displayed page layout", () => {
    const savedImage = {
      dataUrl: "data:image/png;base64:saved",
      naturalWidth: 800,
      naturalHeight: 600,
      displayWidth: 731,
      displayHeight: 419,
      centerX: 37,
      centerY: -24,
      layer: "below_grid" as const,
      opacity: 0.4,
    };
    const fieldId = useMazeStore.getState().activeFloorId;
    const field = useMazeStore.getState().floorFields[fieldId];
    useMazeStore.setState({
      backgroundImage: savedImage,
      showPaperLayout: true,
      openCard: "field_setup",
      floorFields: { [fieldId]: { ...field, fieldEditMode: "custom" } },
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform for print" }));

    expect(useMazeStore.getState().backgroundImage).toMatchObject({ displayWidth: 300, displayHeight: 150, centerX: 0, centerY: 0 });
    expect(useMazeStore.getState().showPaperLayout).toBe(true);
    expect(screen.queryByText("Fit underlay to page")).not.toBeInTheDocument();
  });

  it("does not reuse the field paper layout from another editor", () => {
    useMazeStore.setState({
      backgroundImage: {
        dataUrl: "data:image/png;base64:saved",
        naturalWidth: 800,
        naturalHeight: 600,
        displayWidth: 731,
        displayHeight: 419,
        centerX: 37,
        centerY: -24,
        layer: "below_grid",
        opacity: 0.4,
      },
      showPaperLayout: true,
      openCard: "preset_connections",
    });
    render(<BackgroundImageToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Configure underlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform for print" }));

    expect(screen.getByText("Fit underlay to page")).toBeInTheDocument();
  });
});
