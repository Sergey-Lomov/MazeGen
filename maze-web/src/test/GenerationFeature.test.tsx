import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GenerationFeature } from "../components/features/GenerationFeature";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  useMazeStore.setState({
    seed: 42,
    randomSeed: false,
    lastUsedSeed: null,
    seedHistory: [],
    seedHistoryIndex: 0,
    seedAttachedToHistory: false,
    qcExperiment: false,
    generationStatus: "idle",
    debugMode: false,
    error: null,
    initialConfig: { method: "recursive_backtracker" },
    elementsConfig: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
    postEditDirty: false,
    presetGenSource: null,
    generationSourceMode: "default",
  });
});

describe("GenerationFeature — QC Only toggle", () => {
  it("reflects the store's qcExperiment value", () => {
    useMazeStore.setState({ qcExperiment: true });
    render(<GenerationFeature canGenerate={true} />);

    const checkbox = screen.getByText(m["generation.qc_experiment"]())
      .closest("div")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("calls setQcExperiment when toggled", () => {
    const setQcExperiment = vi.fn();
    useMazeStore.setState({ setQcExperiment });
    render(<GenerationFeature canGenerate={true} />);

    const checkbox = screen.getByText(m["generation.qc_experiment"]())
      .closest("div")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(setQcExperiment).toHaveBeenCalledWith(true);
  });

  it("starts async generation directly when post-edit is not dirty", () => {
    const generateAsync = vi.fn(() => Promise.resolve());
    useMazeStore.setState({ generateAsync });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.generate"]()));

    expect(generateAsync).toHaveBeenCalledTimes(1);
  });

  it("shows a confirm modal instead of starting generation when post-edit is dirty", () => {
    const generateAsync = vi.fn(() => Promise.resolve());
    useMazeStore.setState({ generateAsync, postEditDirty: true });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.generate"]()));

    expect(generateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(m["post_edit.confirm_regenerate"]())).toBeInTheDocument();
  });
});

describe("GenerationFeature — delayed generation spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderWithPendingGeneration() {
    let resolveGeneration!: () => void;
    const generation = new Promise<void>((resolve) => { resolveGeneration = resolve; });
    const generateAsync = vi.fn(() => generation);
    useMazeStore.setState({ generateAsync });
    render(<GenerationFeature canGenerate={true} />);
    return { generateAsync, resolveGeneration };
  }

  it("does not show a spinner for a generation completed before the delay", async () => {
    const { resolveGeneration } = renderWithPendingGeneration();
    fireEvent.click(screen.getByText(m["generation.generate"]()));

    act(() => { vi.advanceTimersByTime(150); });
    await act(async () => { resolveGeneration(); await Promise.resolve(); });

    expect(document.querySelector(".generation-spinner")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(document.querySelector(".generation-spinner")).not.toBeInTheDocument();
  });

  it("shows the spinner after 200 ms and keeps it visible for 750 ms", async () => {
    const { resolveGeneration } = renderWithPendingGeneration();
    const button = screen.getByText(m["generation.generate"]());
    fireEvent.click(button);

    expect(button).toBeDisabled();
    act(() => { vi.advanceTimersByTime(199); });
    expect(document.querySelector(".generation-spinner")).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector(".generation-spinner")).toBeInTheDocument();
    expect(screen.queryByText(m["generation.generate"]())).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(400); });
    await act(async () => { resolveGeneration(); await Promise.resolve(); });
    expect(document.querySelector(".generation-spinner")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(349); });
    expect(document.querySelector(".generation-spinner")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(document.querySelector(".generation-spinner")).not.toBeInTheDocument();
  });

  it("ignores a repeated click while generation is running", () => {
    const { generateAsync } = renderWithPendingGeneration();
    const button = screen.getByText(m["generation.generate"]());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(generateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("GenerationFeature — random generation source toggle", () => {
  function toggle() {
    return screen.getByText(m["generation.random_source"]())
      .closest("div")!
      .querySelector("input[type=checkbox]") as HTMLInputElement;
  }

  it("reflects the store's generationSourceMode value", () => {
    useMazeStore.setState({ generationSourceMode: "random" });
    render(<GenerationFeature canGenerate={true} />);
    expect(toggle().checked).toBe(true);
  });

  it("calls setGenerationSourceMode when toggled", () => {
    const setGenerationSourceMode = vi.fn();
    useMazeStore.setState({ setGenerationSourceMode });
    render(<GenerationFeature canGenerate={true} />);
    fireEvent.click(toggle());
    expect(setGenerationSourceMode).toHaveBeenCalledWith("random");
  });

  it("is disabled when a preset generation-source pin is set", () => {
    useMazeStore.setState({ presetGenSource: { point: [1, 1] } });
    render(<GenerationFeature canGenerate={true} />);
    expect(toggle().disabled).toBe(true);
  });

  it("keeps showing the real generationSourceMode (not forced checked) while disabled by a pin (GitHub issue #640 regression)", () => {
    useMazeStore.setState({
      presetGenSource: { point: [1, 1] },
      generationSourceMode: "default",
    });
    render(<GenerationFeature canGenerate={true} />);
    const checkbox = toggle();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
  });
});

describe("GenerationFeature — vertex-based settings panel", () => {
  it("shows the gear icon only for custom_vertex_based and opens the settings panel on click", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 } });
    render(<GenerationFeature canGenerate={true} />);

    expect(screen.queryByText(m["generation.vertex_settings_title"]())).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(m["generation.vertex_settings"]()));
    expect(screen.getByText(m["generation.vertex_settings_title"]())).toBeInTheDocument();
  });

  it("does not show the gear icon for a non-vertex-based algorithm", () => {
    render(<GenerationFeature canGenerate={true} />);
    expect(screen.queryByTitle(m["generation.vertex_settings"]())).not.toBeInTheDocument();
  });

  it("closes the settings panel when the algorithm switches away from custom_vertex_based", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 } });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByTitle(m["generation.vertex_settings"]()));
    expect(screen.getByText(m["generation.vertex_settings_title"]())).toBeInTheDocument();

    act(() => { useMazeStore.setState({ initialConfig: { method: "recursive_backtracker" } }); });
    expect(screen.queryByText(m["generation.vertex_settings_title"]())).not.toBeInTheDocument();
  });
});
