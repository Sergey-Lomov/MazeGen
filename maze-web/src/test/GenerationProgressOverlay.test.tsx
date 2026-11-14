import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GenerationProgressOverlay } from "../components/GenerationProgressOverlay";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  useMazeStore.setState({ generationProgress: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("GenerationProgressOverlay", () => {
  it("delays display, shows the current phase and stays visible for the minimum duration", () => {
    render(<GenerationProgressOverlay />);
    act(() => { useMazeStore.setState({ generationProgress: 70 }); });

    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(m["generation.progress_quality_control"]());

    act(() => { useMazeStore.setState({ generationProgress: null }); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(749); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
