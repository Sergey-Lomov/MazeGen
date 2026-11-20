import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueSelectDialog } from "../components/features/IssueSelectDialog";
import { useMazeStore } from "../store/mazeStore";

vi.mock("../wasm/mazeService", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/mazeService")>()),
  getTessellationTraits: vi.fn((config: { kind: string }) => ({ irregular: config.kind === "voronoi", maxCellSides: 4 })),
}));

const availableChecks = [
  { id: "min_loops_count", label: "Minimum loop count", description: "Fires if too few loops.", issue_kinds: ["missing_loops"], params: [] },
  { id: "min_loop_length", label: "Minimum loop length", description: "Fires if a loop is too short.", issue_kinds: ["invalid_loop"], params: [] },
  { id: "max_loop_length", label: "Maximum loop length", description: "Fires if a loop is too long.", issue_kinds: ["invalid_loop"], params: [] },
];

beforeEach(() => {
  useMazeStore.setState({ availableChecks });
});

describe("IssueSelectDialog", () => {
  it("lists distinct issue kinds, not one per check, under section headers", () => {
    render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Loops")).toBeInTheDocument();
    expect(screen.getAllByText("Add")).toHaveLength(1);
    expect(screen.getAllByText("Validate")).toHaveLength(1);
  });

  it("calls onSelect with the chosen kind, not the store", () => {
    const onSelect = vi.fn();
    render(<IssueSelectDialog onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Validate"));
    fireEvent.click(screen.getByText("Select"));
    expect(onSelect).toHaveBeenCalledWith("invalid_loop");
  });

  it("Cancel closes without calling onSelect", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<IssueSelectDialog onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("tessellation-restricted kinds", () => {
    const withRestrictedKind = [
      ...availableChecks,
      { id: "node_shape_limits", label: "Node shape limits", description: "", issue_kinds: ["violated_node_shape_limits"], params: [], requires: [{ type: "regular_cells" as const }] },
    ];

    it("lists the kind enabled on a regular tessellation", () => {
      useMazeStore.setState({ availableChecks: withRestrictedKind, tessellationKind: "square", tessellationParams: {} });
      render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
      const [row] = screen.getAllByRole("option").filter((o) => /limit/i.test(o.textContent ?? ""));
      expect(row).not.toHaveAttribute("aria-disabled");
    });

    it("keeps the kind listed but disabled on an irregular tessellation", () => {
      useMazeStore.setState({ availableChecks: withRestrictedKind, tessellationKind: "voronoi", tessellationParams: {} });
      render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
      const [row] = screen.getAllByRole("option").filter((o) => /limit/i.test(o.textContent ?? ""));
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText(/irregular cells/i)).toBeInTheDocument();
    });
  });

  describe("multi-floor-only kinds", () => {
    const withFloorOnlyKind = [
      ...availableChecks,
      { id: "min_vertical_passage_count", label: "Minimum vertical passage count", description: "", issue_kinds: ["missing_vertical_passages"], params: [], visibility: { type: "multi_floor_only" as const } },
    ];

    it("hides a kind whose every check is multi-floor-only on a single floor", () => {
      useMazeStore.setState({ availableChecks: withFloorOnlyKind, floors: [{ id: "f1", title: "Floor 1" }] });
      render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
      expect(screen.queryByText("Vertical passages")).not.toBeInTheDocument();
    });

    it("shows the kind again with 2+ floors", () => {
      useMazeStore.setState({ availableChecks: withFloorOnlyKind, floors: [{ id: "f1", title: "Floor 1" }, { id: "f2", title: "Floor 2" }] });
      render(<IssueSelectDialog onSelect={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByText("Vertical passages")).toBeInTheDocument();
    });
  });
});
