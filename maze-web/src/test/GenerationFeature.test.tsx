import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GenerationFeature } from "../components/features/GenerationFeature";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  useMazeStore.setState({
    seed: 42,
    randomSeed: false,
    lastUsedSeed: null,
    generationStatus: "idle",
    debugMode: false,
    error: null,
    initialConfig: { method: "recursive_backtracker" },
    elementsConfig: { one_way_chance: 0.04, teleport_chance: 0, teleport_one_way_chance: 0 },
    postEditDirty: false,
  });
});

describe("GenerationFeature — QC experiment button", () => {
  it("calls generateQcExperiment directly when post-edit is not dirty", () => {
    const generateQcExperiment = vi.fn();
    useMazeStore.setState({ generateQcExperiment });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.qc_experiment"]()));

    expect(generateQcExperiment).toHaveBeenCalledTimes(1);
  });

  it("is disabled when canGenerate is false", () => {
    render(<GenerationFeature canGenerate={false} />);
    const button = screen.getByText(m["generation.qc_experiment"]()).closest("button");
    expect(button).toBeDisabled();
  });

  it("shows a confirm modal instead of calling generateQcExperiment when post-edit is dirty", () => {
    const generateQcExperiment = vi.fn();
    useMazeStore.setState({ generateQcExperiment, postEditDirty: true });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.qc_experiment"]()));

    expect(generateQcExperiment).not.toHaveBeenCalled();
    expect(screen.getByText(m["post_edit.confirm_regenerate"]())).toBeInTheDocument();
  });

  it("calls generateQcExperiment after confirming the pending post-edit dialog", () => {
    const generateQcExperiment = vi.fn();
    useMazeStore.setState({ generateQcExperiment, postEditDirty: true });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.qc_experiment"]()));
    fireEvent.click(screen.getByText(m["common.ok"]()));

    expect(generateQcExperiment).toHaveBeenCalledTimes(1);
  });

  it("does not call generateQcExperiment when the pending post-edit dialog is cancelled", () => {
    const generateQcExperiment = vi.fn();
    useMazeStore.setState({ generateQcExperiment, postEditDirty: true });
    render(<GenerationFeature canGenerate={true} />);

    fireEvent.click(screen.getByText(m["generation.qc_experiment"]()));
    fireEvent.click(screen.getByText(m["common.cancel"]()));

    expect(generateQcExperiment).not.toHaveBeenCalled();
    expect(screen.queryByText(m["post_edit.confirm_regenerate"]())).not.toBeInTheDocument();
  });
});
