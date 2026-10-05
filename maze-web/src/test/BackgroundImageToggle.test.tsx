import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackgroundImageToggle } from "../components/BackgroundImageToggle";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

vi.mock("../pixi/fieldEditUtils", () => ({
  resolveCells: () => [[0, 0]],
}));

vi.mock("../pixi/BackgroundImageLayer", () => ({
  fieldBounds: () => ({ minX: -10, minY: -10, maxX: 10, maxY: 10 }),
  calculateBackgroundImageLayout: (
    dataUrl: string,
    naturalWidth: number,
    naturalHeight: number,
    _bounds: unknown,
  ) => ({
    dataUrl,
    naturalWidth,
    naturalHeight,
    displayWidth: 200,
    displayHeight: 100,
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
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "above_floor" } });
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Manual positioning" }));

    expect(useMazeStore.getState().backgroundImage).toMatchObject({ layer: "above_floor", opacity: 0.75 });
    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(true);
  });
});
