import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ControlPanel } from "../components/ControlPanel";
import { useMazeStore } from "../store/mazeStore";

vi.mock("../store/mazeStore", () => {
  const state = {
    seed: 42,
    width: 10,
    height: 10,
    warnings: [] as string[],
    error: null as string | null,
    setSeed: vi.fn(),
    setWidth: vi.fn(),
    setHeight: vi.fn(),
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
  s.width = 10;
  s.height = 10;
  s.warnings = [];
  s.error = null;
  vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(s));
  (s.setSeed as ReturnType<typeof vi.fn>).mockReset();
  (s.setWidth as ReturnType<typeof vi.fn>).mockReset();
  (s.setHeight as ReturnType<typeof vi.fn>).mockReset();
  (s.generate as ReturnType<typeof vi.fn>).mockReset();
  (s.reset as ReturnType<typeof vi.fn>).mockReset();
});

describe("ControlPanel", () => {
  it("renders seed/width/height inputs with values", () => {
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

  it("calls setWidth when width input changes", () => {
    render(<ControlPanel />);
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "5" } });
    expect(getState().setWidth).toHaveBeenCalledWith(5);
  });

  it("calls setHeight when height input changes", () => {
    render(<ControlPanel />);
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "7" } });
    expect(getState().setHeight).toHaveBeenCalledWith(7);
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
    vi.mocked(useMazeStore).mockImplementation((fn: (s: unknown) => unknown) => fn(getState()));
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
