import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackgroundImageAutoFillControls } from "../components/BackgroundImageAutoFillControls";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

const autoFillStub = vi.hoisted(() => ({
  nextPoints: new Set([0x00010001]),
}));

vi.mock("../pixi/backgroundFieldAutofill", () => ({
  getBackgroundImageTopLeftColor: vi.fn(() => Promise.resolve(0x123456)),
  buildBackgroundFieldPreviewFromImage: vi.fn(() => Promise.resolve(new Set(autoFillStub.nextPoints))),
}));

beforeEach(() => {
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
});
