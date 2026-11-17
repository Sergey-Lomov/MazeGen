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

const initial = useMazeStore.getState();

afterEach(() => {
  cleanup();
  act(() => useMazeStore.setState({
    openCard: "basic_config",
    openExportFormatSettings: initial.openExportFormatSettings,
    exportFormatSettingsCovered: initial.exportFormatSettingsCovered,
    pngExportSettings: initial.pngExportSettings,
  }));
});

function setExport(outputMode: "print" | "digital", over: Record<string, unknown> = {}) {
  act(() => useMazeStore.setState({
    openCard: "image_export",
    openExportFormatSettings: "png",
    exportFormatSettingsCovered: false,
    pngExportSettings: { ...initial.pngExportSettings, outputMode },
    ...over,
  }));
}

describe("HoverInfoPanel", () => {
  it("hides the viewport zoom indicator while the print sheet is shown", () => {
    setExport("print");
    render(<HoverInfoPanel scene={scene()} />);
    expect(screen.queryByLabelText("Reset zoom to 100%")).toBeNull();
    expect(screen.queryByText("150%")).toBeNull();
  });

  it("shows the indicator in digital export mode", () => {
    setExport("digital");
    render(<HoverInfoPanel scene={scene()} />);
    expect(screen.getByLabelText("Reset zoom to 100%")).toHaveTextContent("150%");
  });

  it("shows the indicator in print mode when the format list is shown", () => {
    setExport("print", { openExportFormatSettings: null });
    render(<HoverInfoPanel scene={scene()} />);
    expect(screen.getByLabelText("Reset zoom to 100%")).toHaveTextContent("150%");
  });

  it("shows the indicator in print mode when the settings panel is covered", () => {
    setExport("print", { exportFormatSettingsCovered: true });
    render(<HoverInfoPanel scene={scene()} />);
    expect(screen.getByLabelText("Reset zoom to 100%")).toHaveTextContent("150%");
  });

  it("shows the viewport zoom indicator outside image export mode", () => {
    act(() => useMazeStore.setState({ openCard: "generation" }));
    render(<HoverInfoPanel scene={scene()} />);
    expect(screen.getByLabelText("Reset zoom to 100%")).toHaveTextContent("150%");
  });
});
