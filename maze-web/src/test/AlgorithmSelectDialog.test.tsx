import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmSelectDialog } from "../components/dialogs/AlgorithmSelectDialog";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

beforeEach(() => {
  useMazeStore.setState({
    initialConfig: { method: "recursive_backtracker" },
    setGenerationMethod: vi.fn(),
  });
});

describe("AlgorithmSelectDialog — canonical elements info bubble", () => {
  it("shows the info bubble for a canonical algorithm", () => {
    render(<AlgorithmSelectDialog onClose={() => {}} />);
    expect(screen.getByText(m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() }))).toBeInTheDocument();
  });

  it("hides the info bubble for custom_vertex_based", () => {
    useMazeStore.setState({ initialConfig: { method: "custom_vertex_based" } });
    render(<AlgorithmSelectDialog onClose={() => {}} />);
    expect(screen.queryByText(m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() }))).not.toBeInTheDocument();
  });

  it("toggles the bubble when switching selection between canonical and custom", () => {
    render(<AlgorithmSelectDialog onClose={() => {}} />);
    expect(screen.getByText(m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() }))).toBeInTheDocument();

    fireEvent.click(screen.getByText(m["algorithm.custom_vertex_based"]()));
    expect(screen.queryByText(m["generation.canonical_elements_warning"]({ qualityTitle: m["quality.title"]() }))).not.toBeInTheDocument();
  });
});

describe("AlgorithmSelectDialog — selection", () => {
  it("calls setGenerationMethod with the newly selected algorithm on confirm", () => {
    const setGenerationMethod = vi.fn();
    useMazeStore.setState({ setGenerationMethod });
    render(<AlgorithmSelectDialog onClose={() => {}} />);

    fireEvent.click(screen.getByText(m["algorithm.wilson_algorithm"]()));
    fireEvent.click(screen.getByText(m["common.select"]()));

    expect(setGenerationMethod).toHaveBeenCalledWith("wilson_algorithm");
  });

  it("does not call setGenerationMethod when the selection is unchanged", () => {
    const setGenerationMethod = vi.fn();
    useMazeStore.setState({ setGenerationMethod });
    render(<AlgorithmSelectDialog onClose={() => {}} />);

    fireEvent.click(screen.getByText(m["common.select"]()));

    expect(setGenerationMethod).not.toHaveBeenCalled();
  });

  it("calls onClose on cancel", () => {
    const onClose = vi.fn();
    render(<AlgorithmSelectDialog onClose={onClose} />);

    fireEvent.click(screen.getByText(m["common.cancel"]()));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
