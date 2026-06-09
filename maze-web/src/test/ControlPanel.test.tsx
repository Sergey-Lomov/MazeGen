import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ControlPanel } from "../components/ControlPanel";
import { useMazeStore } from "../store/mazeStore";

vi.mock("../store/mazeStore", () => {
  const state = {
    seed: 42,
    tessellationKind: "square" as "square" | "hex" | "triangle",
    hexShape: "parallelogram" as "parallelogram" | "hexagon",
    triangleShape: "rect" as "rect" | "triangle" | "hexagon",
    tessellationConfig: { type: "square", width: 10, height: 10 },
    warnings: [] as string[],
    error: null as string | null,
    nodeStats: null,
    setSeed: vi.fn(),
    setTessellationKind: vi.fn(),
    setHexShape: vi.fn(),
    setTriangleShape: vi.fn(),
    setTessellationConfig: vi.fn(),
    generate: vi.fn(),
    reset: vi.fn(),
  };
  const selector = vi.fn((fn: (s: typeof state) => unknown) => fn(state));
  return { useMazeStore: Object.assign(selector, { __state: state }) };
});

function getState() {
  return (useMazeStore as unknown as { __state: Record<string, unknown> }).__state;
}

beforeEach(() => {
  const s = getState();
  s.seed = 42;
  s.tessellationKind = "square";
  s.hexShape = "parallelogram";
  s.triangleShape = "rect";
  s.tessellationConfig = { type: "square", width: 10, height: 10 };
  s.warnings = [];
  s.error = null;
  s.nodeStats = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (useMazeStore as any).mockImplementation((fn: (s: unknown) => unknown) => fn(s));
  (s.setSeed as ReturnType<typeof vi.fn>).mockReset();
  (s.setTessellationKind as ReturnType<typeof vi.fn>).mockReset();
  (s.setHexShape as ReturnType<typeof vi.fn>).mockReset();
  (s.setTriangleShape as ReturnType<typeof vi.fn>).mockReset();
  (s.setTessellationConfig as ReturnType<typeof vi.fn>).mockReset();
  (s.generate as ReturnType<typeof vi.fn>).mockReset();
  (s.reset as ReturnType<typeof vi.fn>).mockReset();
});

describe("ControlPanel", () => {
  it("renders seed and square dimension inputs with values", () => {
    render(<ControlPanel />);
    expect(screen.getByLabelText("Seed")).toHaveValue(42);
    expect(screen.getByLabelText("Width")).toHaveValue(10);
    expect(screen.getByLabelText("Height")).toHaveValue(10);
  });

  it("calls setSeed when seed input changes", () => {
    render(<ControlPanel />);
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "99" } });
    expect(getState().setSeed).toHaveBeenCalledWith(99);
  });

  it("calls setTessellationConfig when width input changes", () => {
    render(<ControlPanel />);
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "5" } });
    expect(getState().setTessellationConfig).toHaveBeenCalledWith({ type: "square", width: 5, height: 10 });
  });

  it("calls setTessellationConfig when height input changes", () => {
    render(<ControlPanel />);
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "7" } });
    expect(getState().setTessellationConfig).toHaveBeenCalledWith({ type: "square", width: 10, height: 7 });
  });

  it("shows hex parallelogram fields when tessellation is hex/parallelogram", () => {
    const s = getState();
    s.tessellationKind = "hex";
    s.hexShape = "parallelogram";
    s.tessellationConfig = { type: "hex_parallelogram", cols: 8, rows: 6, orientation: "flat_top" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useMazeStore as any).mockImplementation((fn: (s: unknown) => unknown) => fn(s));
    render(<ControlPanel />);
    expect(screen.getByLabelText("Cols")).toHaveValue(8);
    expect(screen.getByLabelText("Rows")).toHaveValue(6);
    expect(screen.queryByLabelText("Width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Radius")).not.toBeInTheDocument();
  });

  it("shows hex hexagon fields when tessellation is hex/hexagon", () => {
    const s = getState();
    s.tessellationKind = "hex";
    s.hexShape = "hexagon";
    s.tessellationConfig = { type: "hex_hexagon", radius: 4, orientation: "pointy_top" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useMazeStore as any).mockImplementation((fn: (s: unknown) => unknown) => fn(s));
    render(<ControlPanel />);
    expect(screen.getByLabelText("Radius")).toHaveValue(4);
    expect(screen.queryByLabelText("Width")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cols")).not.toBeInTheDocument();
  });

  it("calls generate on Generate button click", () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(getState().generate).toHaveBeenCalled();
  });

  it("calls reset on Reset button click", () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(getState().reset).toHaveBeenCalled();
  });

  it("shows error message when error set", () => {
    getState().error = "WASM error";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useMazeStore as any).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
    render(<ControlPanel />);
    expect(screen.getByText("WASM error")).toBeInTheDocument();
  });

  it("hides error when error null", () => {
    render(<ControlPanel />);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it("disables buttons when disabled prop is true", () => {
    render(<ControlPanel disabled />);
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("enables buttons when disabled prop is false", () => {
    render(<ControlPanel disabled={false} />);
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });
});
