import { beforeEach, describe, expect, it, vi } from "vitest";
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
});

describe("BackgroundImageToggle", () => {
  it("keeps the switch off when the picker is cancelled", () => {
    render(<BackgroundImageToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Show underlay" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Upload underlay"), { target: { files: [] } });

    expect(useMazeStore.getState().showBackgroundImage).toBe(false);
  });

  it("loads a selected image, calculates its layout, and can hide it again", async () => {
    render(<BackgroundImageToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Show underlay" });
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

    fireEvent.click(screen.getByRole("checkbox", { name: "Show underlay" }));
    expect(useMazeStore.getState().showBackgroundImage).toBe(false);
  });
});
