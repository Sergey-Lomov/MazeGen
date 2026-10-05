import { beforeEach, describe, expect, it } from "vitest";
import { BackgroundImageController } from "../pixi/BackgroundImageController";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";

const image = {
  dataUrl: "data:image/png;base64,test",
  naturalWidth: 100,
  naturalHeight: 100,
  displayWidth: 100,
  displayHeight: 100,
  centerX: 0,
  centerY: 0,
  layer: "below_grid" as const,
  opacity: 0.5,
};

function resetStore() {
  useMazeStore.setState({
    ...baseStoreState(),
    showBackgroundImage: true,
    backgroundImageManualPositioning: true,
    backgroundImage: image,
  });
}

describe("BackgroundImageController", () => {
  beforeEach(resetStore);

  it("moves the image by dragging its body in world coordinates", () => {
    const viewport = { x: 100, y: 100, scale: { x: 2, y: 2 } };
    const controller = new BackgroundImageController(() => viewport);

    controller.onPointerDown(100, 100, 0);
    controller.onPointerMove(120, 140);
    controller.onPointerUp();

    expect(useMazeStore.getState().backgroundImage).toMatchObject({ centerX: 10, centerY: 20 });
  });

  it("resizes the image from a corner while preserving its aspect ratio", () => {
    const viewport = { x: 100, y: 100, scale: { x: 2, y: 2 } };
    const controller = new BackgroundImageController(() => viewport);

    controller.onPointerDown(200, 200, 0);
    controller.onPointerMove(240, 240);
    controller.onPointerUp();

    expect(useMazeStore.getState().backgroundImage).toMatchObject({ displayWidth: 140, displayHeight: 140 });
  });

  it("keeps the center fixed while resizing with Shift", () => {
    const controller = new BackgroundImageController(() => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }));

    controller.onPointerDown(50, 0, 0);
    controller.onPointerMove(70, 0, 1, true);
    controller.onPointerUp();

    expect(useMazeStore.getState().backgroundImage).toMatchObject({
      centerX: 0,
      centerY: 0,
      displayWidth: 140,
      displayHeight: 140,
    });
  });

  it("can enlarge freely past the field boundary", () => {
    useMazeStore.setState({
      backgroundImage: { ...image, displayWidth: 400, displayHeight: 400 },
    });
    const controller = new BackgroundImageController(() => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }));

    controller.onPointerDown(200, 0, 0);
    controller.onPointerMove(240, 0, 1);
    controller.onPointerUp();

    const resized = useMazeStore.getState().backgroundImage!;
    expect(resized.centerX).toBeCloseTo(40);
    expect(resized.displayWidth).toBeCloseTo(480);
    expect(resized.displayHeight).toBeCloseTo(480);
  });

  it("leaves manual positioning when clicking outside the image", () => {
    const controller = new BackgroundImageController(() => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }));

    controller.onPointerDown(200, 200, 0);

    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(false);
  });

  it("keeps the mode active when pressing the outer part of a resize handle", () => {
    const controller = new BackgroundImageController(() => ({ x: 0, y: 0, scale: { x: 1, y: 1 } }));

    controller.onPointerDown(57, 0, 0);

    expect(useMazeStore.getState().backgroundImageManualPositioning).toBe(true);
  });
});
