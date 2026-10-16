import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../wasm/wasmLoader", () => ({
  getWasm: () => ({
    // Square tessellation's cartesian projection is the identity — see squareGeometry.ts's doc
    // comment on squareCenter.
    cell_centers: (config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config),
  }),
}));
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitSettingsDialog } from "../components/dialogs/SplitSettingsDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import type { SplitPattern } from "../wasm/types";
import { fakeCellCenters } from "./cellCentersFake";

function pattern(weight: number): SplitPattern {
  return { shape: "regular:4", node_count: 2, faces: [[], []], weight };
}

beforeEach(() => {
  useMazeStore.setState(baseStoreState());
  useMazeStore.setState({
    splitPatternMode: true,
    splitMaxNodes: 2,
    splitPatterns: [pattern(1), pattern(2), pattern(3)],
  });
});

describe("SplitSettingsDialog", () => {
  it("removing a pattern before the one being edited re-targets the editor to the shifted index", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    // Open the editor for pattern index 1 (weight 2).
    fireEvent.click(screen.getAllByTitle("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    // Remove pattern index 0 — pattern 1 (still being edited) shifts down to index 0.
    fireEvent.click(screen.getAllByTitle("Remove pattern")[0]);

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    // The editor must still be open, now pointing at the shifted pattern (still weight 2) —
    // not silently closed, and not left pointing at whatever pattern ended up at the old index.
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();
  });

  it("removing the pattern currently being edited closes its editor", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle("Remove pattern")[1]);

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });

  it("removing a pattern after the one being edited leaves the editor's index untouched", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("Edit pattern")[0]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle("Remove pattern")[2]);

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();
  });

  // Closing the pattern editor's own Modal (its `X` close button, not the outer SplitSettingsDialog's
  // — both portal into `document.body`; the pattern editor's is the second `.lucide-x` icon once
  // it's open) drives `handleCloseEditor`.
  function closePatternEditor() {
    const closeIcons = document.body.querySelectorAll("svg.lucide-x");
    fireEvent.click(closeIcons[closeIcons.length - 1].closest("button")!);
  }

  it("closing the editor on a pattern left with no faces on any node drops it from the list", () => {
    useMazeStore.setState({ splitPatterns: [pattern(1), { shape: "regular:4", node_count: 2, faces: [[], []], weight: 5 }] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns).toHaveLength(1);
    expect(useMazeStore.getState().splitPatterns[0].weight).toBe(1);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });

  it("closing the editor on a pattern with at least one face defined keeps it in the list", () => {
    const withFace: SplitPattern = {
      shape: "regular:4",
      node_count: 2,
      faces: [[{ face_index: 0, requirement: { kind: "passage" } }], []],
      weight: 1,
    };
    useMazeStore.setState({ splitPatterns: [withFace] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTitle("Edit pattern")[0]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns).toHaveLength(1);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });
});
