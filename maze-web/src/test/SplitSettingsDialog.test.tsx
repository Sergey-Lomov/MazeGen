import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen, fireEvent } from "@testing-library/react";
import { SplitSettingsDialog } from "../components/dialogs/SplitSettingsDialog";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import type { SplitPattern } from "../wasm/types";
import { getTooltipAnchors, getTooltipControls } from "./tooltipTestUtils";

vi.mock("../components/features/ToolGlyph", () => ({
  ToolGlyph: ({ tool }: { tool: string }) => <span data-testid={`glyph-${tool}`} />,
}));

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
  const patternWithFace: SplitPattern = {
    shape: "regular:4",
    node_count: 2,
    faces: [[{ face_index: 0, requirement: { kind: "passage" } }], []],
    weight: 1,
  };

  it("discards an edited template when the editor closes", () => {
    useMazeStore.setState({ splitPatterns: [patternWithFace] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(useMazeStore.getState().splitPatterns[0].node_count).toBe(2);

    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns[0].node_count).toBe(2);
  });

  it("applies an edited template only when confirmed", () => {
    useMazeStore.setState({ splitPatterns: [patternWithFace] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(useMazeStore.getState().splitPatterns[0].node_count).toBe(3);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });

  it("shows node counts in standard list cells and disables removal of the last node", () => {
    useMazeStore.setState({
      splitPatterns: [{
        shape: "regular:4",
        node_count: 1,
        faces: [[
          { face_index: 0, requirement: { kind: "passage" } },
          { face_index: 1, requirement: { kind: "wall" } },
          { face_index: 2, requirement: { kind: "one_way", direction: "forward" } },
        ]],
        weight: 1,
      }],
    });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);

    expect(screen.getByText("Passage: 1 · Wall: 2 · One-way: 1")).toBeInTheDocument();
    expect(screen.getByTestId("list-cell-current")).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: /^Remove$/ });
    expect(remove).toBeDisabled();
    expect(getTooltipControls("last node cannot be removed")).toContain(remove);
  });

  it("confirms a template without connections", () => {
    useMazeStore.setState({ splitPatterns: [pattern(1)] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);

    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(useMazeStore.getState().splitPatterns).toHaveLength(1);
    expect(useMazeStore.getState().splitPatterns[0].faces).toEqual([[], []]);
  });

  it("discards a newly added pattern when its editor closes without confirmation", () => {
    useMazeStore.setState({ splitPatterns: [] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Add custom pattern")[0]);
    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns).toEqual([]);
  });

  it("shows each pattern warning on its node instead of a shared warnings section", () => {
    useMazeStore.setState({ splitPatterns: [pattern(1)] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);

    expect(screen.queryByTestId("split-pattern-warnings")).not.toBeInTheDocument();
    expect(getTooltipAnchors("All sides of this node are walls, so it will be unreachable.")).toHaveLength(2);
  });

  it("shows a dangling sibling warning on the node that owns the face", () => {
    useMazeStore.setState({
      splitPatterns: [{
        shape: "regular:4",
        node_count: 1,
        faces: [[{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 1 }]],
        weight: 1,
      }],
    });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);

    expect(getTooltipAnchors("The node linked to face 0 no longer exists.")).toHaveLength(1);
  });

  it("selects pattern tools through the same shortcuts shown in their tooltips", () => {
    useMazeStore.setState({ splitPatterns: [patternWithFace] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    fireEvent.keyDown(window, { code: "KeyW" });

    const wallTool = screen.getByRole("button", { name: "Wall" });
    expect(wallTool).toHaveClass("btn-tool-icon-selected");
    expect(getTooltipControls("Wall")).toContain(wallTool);
  });

  it("does not switch tools while the remove-node confirmation is open", () => {
    useMazeStore.setState({ splitPatterns: [patternWithFace] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove$/ })[0]);
    fireEvent.keyDown(window, { code: "KeyW" });

    expect(screen.getByRole("button", { name: "Passage" })).toHaveClass("btn-tool-icon-selected");
  });

  it("labels blueprint thumbnails with their template names", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);

    expect(getTooltipControls("Bridge")).toHaveLength(1);
    expect(getTooltipControls("Diagonal divider")).toHaveLength(1);
  });

  it("removing a pattern before the one being edited re-targets the editor to the shifted index", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    // Open the editor for pattern index 1 (weight 2).
    fireEvent.click(getTooltipControls("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    // Remove pattern index 0 — pattern 1 (still being edited) shifts down to index 0.
    fireEvent.click(getTooltipControls("Remove pattern")[0]);

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    // The editor must still be open, now pointing at the shifted pattern (still weight 2) —
    // not silently closed, and not left pointing at whatever pattern ended up at the old index.
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();
  });

  it("removing the pattern currently being edited closes its editor", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(getTooltipControls("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    fireEvent.click(getTooltipControls("Remove pattern")[1]);

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });

  it("removing a pattern after the one being edited leaves the editor's index untouched", () => {
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    fireEvent.click(getTooltipControls("Remove pattern")[2]);

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

  it("closing the editor keeps an existing pattern without connections", () => {
    useMazeStore.setState({ splitPatterns: [pattern(1), { shape: "regular:4", node_count: 2, faces: [[], []], weight: 5 }] });
    render(<SplitSettingsDialog onClose={vi.fn()} />);
    fireEvent.click(getTooltipControls("Edit pattern")[1]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns).toHaveLength(2);
    expect(useMazeStore.getState().splitPatterns[1].weight).toBe(5);
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
    fireEvent.click(getTooltipControls("Edit pattern")[0]);
    expect(screen.getByText("Edit split pattern")).toBeInTheDocument();

    closePatternEditor();

    expect(useMazeStore.getState().splitPatterns).toHaveLength(1);
    expect(screen.queryByText("Edit split pattern")).not.toBeInTheDocument();
  });
});
