import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BackgroundImageTransformControls } from "../components/BackgroundImageTransformControls";

const image = {
  dataUrl: "data:image/png;base64:test",
  naturalWidth: 800,
  naturalHeight: 600,
  displayWidth: 400,
  displayHeight: 300,
  centerX: 0,
  centerY: 0,
  layer: "below_grid" as const,
  opacity: 0.5,
};

function renderControls(overrides: Partial<React.ComponentProps<typeof BackgroundImageTransformControls>> = {}) {
  const props: React.ComponentProps<typeof BackgroundImageTransformControls> = {
    backgroundImage: image,
    backgroundImageCropping: false,
    backgroundImageManualPositioning: false,
    hasDisplayedPaperLayout: false,
    onLayerChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onCroppingChange: vi.fn(),
    onManualPositioningChange: vi.fn(),
    onPositionToField: vi.fn(),
    onPositionToPage: vi.fn(),
    onOpenPrintDialog: vi.fn(),
    onReplace: vi.fn(),
    ...overrides,
  };
  render(<BackgroundImageTransformControls {...props} />);
  return props;
}

describe("BackgroundImageTransformControls", () => {
  it("delegates transform and crop controls to its callbacks", () => {
    const props = renderControls();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "above_floor" } });
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Crop" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform to field" }));
    fireEvent.click(screen.getByRole("button", { name: "Transform for print" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace underlay" }));

    expect(props.onLayerChange).toHaveBeenCalledWith("above_floor");
    expect(props.onOpacityChange).toHaveBeenCalledWith(0.75);
    expect(props.onCroppingChange).toHaveBeenCalledWith(true);
    expect(props.onManualPositioningChange).toHaveBeenCalledWith(true);
    expect(props.onPositionToField).toHaveBeenCalledOnce();
    expect(props.onOpenPrintDialog).toHaveBeenCalledOnce();
    expect(props.onReplace).toHaveBeenCalledOnce();
  });

  it("uses the page positioning callback when the paper layout is visible", () => {
    const props = renderControls({ hasDisplayedPaperLayout: true });

    fireEvent.click(screen.getByRole("button", { name: "Transform for print" }));

    expect(props.onPositionToPage).toHaveBeenCalledOnce();
    expect(props.onOpenPrintDialog).not.toHaveBeenCalled();
  });
});
