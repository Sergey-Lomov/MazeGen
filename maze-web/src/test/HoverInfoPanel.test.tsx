import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { HoverInfoPanel } from "../components/HoverInfoPanel";
import type { MazeScene } from "../pixi/MazeScene";
import { useMazeStore } from "../store/mazeStore";

function scene(): MazeScene {
  return {
    setHoverListener: vi.fn(),
    setViewportScaleListener: vi.fn((listener: ((scale: number) => void) | null) => listener?.(1.5)),
    setFieldSizeListener: vi.fn(),
    resetZoomToOne: vi.fn(),
  } as unknown as MazeScene;
}

afterEach(() => {
  cleanup();
  act(() => useMazeStore.setState({ openCard: "basic_config" }));
});

describe("HoverInfoPanel", () => {
  it("hides the viewport zoom indicator in image export mode", () => {
    act(() => useMazeStore.setState({ openCard: "image_export" }));

    render(<HoverInfoPanel scene={scene()} />);

    expect(screen.queryByLabelText("Reset zoom to 100%")).toBeNull();
    expect(screen.queryByText("150%")).toBeNull();
  });

  it("shows the viewport zoom indicator outside image export mode", () => {
    act(() => useMazeStore.setState({ openCard: "generation" }));

    render(<HoverInfoPanel scene={scene()} />);

    expect(screen.getByLabelText("Reset zoom to 100%")).toHaveTextContent("150%");
  });
});
