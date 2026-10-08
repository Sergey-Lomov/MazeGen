import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackgroundImageAutoFillControls } from "../components/BackgroundImageAutoFillControls";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

const autoFillStub = vi.hoisted(() => ({
  nextPoints: new Set([0x00010001]),
  buildPreview: vi.fn(() => Promise.resolve(new Set<number>(autoFillStub.nextPoints))),
}));

vi.mock("../pixi/backgroundFieldAutofill", () => ({
  getBackgroundImageTopLeftColor: vi.fn(() => Promise.resolve(0x123456)),
  buildBackgroundFieldPreviewFromImage: autoFillStub.buildPreview,
}));

beforeEach(() => {
  autoFillStub.buildPreview.mockClear();
  useMazeStore.setState(baseStoreState());
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
      [fieldId]: { ...field, fieldEditMode: "custom", isEditingField: true },
    },
    backgroundAutoFillPreview: null,
  });
});

afterEach(() => {
  useMazeStore.setState({ backgroundAutoFillPreview: null });
});

describe("BackgroundImageAutoFillControls", () => {
  it("starts a preview and clears it when the controls are disabled", async () => {
    const { rerender } = render(<BackgroundImageAutoFillControls enabled />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toEqual(autoFillStub.nextPoints));

    rerender(<BackgroundImageAutoFillControls enabled={false} />);
    await waitFor(() => expect(useMazeStore.getState().backgroundAutoFillPreview).toBeNull());
    expect(screen.queryByText("Auto-fill field")).not.toBeInTheDocument();
  });

  it("debounces recalculation while the threshold slider is moving", async () => {
    render(<BackgroundImageAutoFillControls enabled />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(autoFillStub.buildPreview).toHaveBeenCalledTimes(1));

    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "0.4" } });
    fireEvent.change(slider, { target: { value: "0.3" } });
    fireEvent.change(slider, { target: { value: "0.2" } });

    expect(autoFillStub.buildPreview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(autoFillStub.buildPreview).toHaveBeenCalledTimes(2));
  });

  it("keeps confirm disabled during an active threshold drag", async () => {
    render(<BackgroundImageAutoFillControls enabled />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(autoFillStub.buildPreview).toHaveBeenCalledTimes(1));

    const slider = screen.getByRole("slider");
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "0.4" } });

    expect(confirm).toBeDisabled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(confirm).not.toBeDisabled());

    fireEvent.pointerDown(slider);
    expect(confirm).toBeDisabled();
    fireEvent.pointerCancel(slider);
    expect(confirm).not.toBeDisabled();

    fireEvent.pointerDown(slider);
    expect(confirm).toBeDisabled();
    fireEvent.blur(slider);
    expect(confirm).not.toBeDisabled();
  });
});
