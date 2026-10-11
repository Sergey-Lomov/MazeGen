import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExportWarningBubble, resolveWarningFloorLevels } from "../components/features/ExportWarningBubble";
import { useMazeStore } from "../store/mazeStore";
import { baseStoreState } from "./storeTestHelpers";
import type { ExportWarning } from "../pixi/selectors/exportWarnings";

// GitHub issue #733: a warning that only carries highlighted `cells` (no node ids / cross-floor
// targets, e.g. marker index text overflow) must still show floor bubbles on multi-floor mazes.

function cellWarning(): ExportWarning {
  return {
    id: "marker_index_text_overflow",
    key: "k",
    nodes: [],
    edges: [],
    cells: [
      { x: 0, y: 0, floorIndex: 0 },
      { x: 1, y: 1, floorIndex: 2 },
    ],
  };
}

describe("resolveWarningFloorLevels (GitHub issue #733)", () => {
  it("merges cross-floor targets and cell floors, deduplicated and ascending", () => {
    expect(resolveWarningFloorLevels({
      crossFloorTargets: [{ nodeId: 0, targetFloorIndex: 3 }, { nodeId: 1, targetFloorIndex: 1 }],
      cells: [{ x: 0, y: 0, floorIndex: 1 }, { x: 0, y: 0, floorIndex: 0 }],
    })).toEqual([0, 1, 3]);
  });

  it("returns an empty list when the warning carries neither source", () => {
    expect(resolveWarningFloorLevels({})).toEqual([]);
  });
});

describe("ExportWarningBubble floor badges (GitHub issue #733)", () => {
  beforeEach(() => {
    useMazeStore.setState({ ...baseStoreState() });
  });

  it("shows a badge per floor of highlighted cells on a multi-floor maze", () => {
    useMazeStore.setState({
      floors: [{ id: "a" }, { id: "b" }, { id: "c" }] as never,
    });
    render(<ExportWarningBubble warning={cellWarning()} />);
    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText("L3")).toBeInTheDocument();
    expect(screen.queryByText("L2")).toBeNull();
  });

  it("shows no badges on a single-floor maze", () => {
    useMazeStore.setState({ floors: [{ id: "a" }] as never });
    render(<ExportWarningBubble warning={cellWarning()} />);
    expect(screen.queryByText("L1")).toBeNull();
  });
});
