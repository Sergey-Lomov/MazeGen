import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebugPanel } from "../components/DebugPanel";
import { useMazeStore } from "../store/mazeStore";

vi.mock("../store/mazeStore", () => {
  const state = {
    showNodeIds: false,
    showCoords: false,
    showGraphOverlay: true,
    nodes: [] as { id: number; x: number; y: number }[],
    selectedNode: null as number | null,
    setDebugFlag: vi.fn(),
  };
  const selector = vi.fn((fn: (s: typeof state) => unknown) => fn(state));
  return { useMazeStore: Object.assign(selector, { __state: state }) };
});

function getState() {
  return (useMazeStore as unknown as { __state: Record<string, unknown> }).__state;
}

beforeEach(() => {
  const s = getState();
  s.showNodeIds = false;
  s.showCoords = false;
  s.showGraphOverlay = true;
  s.nodes = [];
  s.selectedNode = null;
  vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(s));
  (s.setDebugFlag as ReturnType<typeof vi.fn>).mockReset();
});

describe("DebugPanel", () => {
  it("renders three checkboxes", () => {
    render(<DebugPanel />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
  });

  it("Node IDs checkbox reflects showNodeIds", () => {
    getState().showNodeIds = true;
    vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
    render(<DebugPanel />);
    expect(screen.getByLabelText("Node IDs")).toBeChecked();
  });

  it("Coordinates checkbox reflects showCoords", () => {
    getState().showCoords = true;
    vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
    render(<DebugPanel />);
    expect(screen.getByLabelText("Coordinates")).toBeChecked();
  });

  it("Graph overlay checkbox reflects showGraphOverlay", () => {
    render(<DebugPanel />);
    expect(screen.getByLabelText("Graph overlay")).toBeChecked();
  });

  it("calls setDebugFlag('showNodeIds') on checkbox toggle", () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByLabelText("Node IDs"));
    expect(getState().setDebugFlag).toHaveBeenCalledWith("showNodeIds", true);
  });

  it("calls setDebugFlag('showCoords') on checkbox toggle", () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByLabelText("Coordinates"));
    expect(getState().setDebugFlag).toHaveBeenCalledWith("showCoords", true);
  });

  it("calls setDebugFlag('showGraphOverlay') on checkbox toggle", () => {
    render(<DebugPanel />);
    fireEvent.click(screen.getByLabelText("Graph overlay"));
    expect(getState().setDebugFlag).toHaveBeenCalledWith("showGraphOverlay", false);
  });

  it("shows selected node info when selectedNode set", () => {
    getState().nodes = [{ id: 3, x: 2, y: 5 }];
    getState().selectedNode = 3;
    vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
    render(<DebugPanel />);
    expect(screen.getByText("ID: 3")).toBeInTheDocument();
    expect(screen.getByText("x: 2, y: 5")).toBeInTheDocument();
  });

  it("hides node info when selectedNode is null", () => {
    render(<DebugPanel />);
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();
  });

  it("hides node info when selected id not in nodes", () => {
    getState().nodes = [{ id: 1, x: 0, y: 0 }];
    getState().selectedNode = 99;
    vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
    render(<DebugPanel />);
    expect(screen.queryByText(/ID:/)).not.toBeInTheDocument();
  });
});
