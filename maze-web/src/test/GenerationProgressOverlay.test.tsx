import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GenerationProgressOverlay } from "../components/GenerationProgressOverlay";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  useMazeStore.setState({ generationProgress: null, projectLoadInProgress: false });
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

  it("keeps project loading and its analytics pass in the same non-cancellable dialog", () => {
    render(<GenerationProgressOverlay />);
    act(() => { useMazeStore.setState({ projectLoadInProgress: true, generationProgress: null }); });

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole("dialog")).toHaveAccessibleName(m["project.load_progress_title"]());
    expect(screen.getByRole("status")).toHaveTextContent(m["project.load_progress_analytics"]());
    expect(screen.queryByRole("button", { name: m["common.cancel"]() })).toBeNull();

    act(() => { useMazeStore.setState({ generationProgress: 70 }); });
    expect(screen.queryByRole("button", { name: m["common.cancel"]() })).toBeNull();
  });
});
