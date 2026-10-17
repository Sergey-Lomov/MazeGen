import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { ParamizedDetail } from "../components/features/quality/ParamizedDetail";
import type { ParamDescriptor } from "../wasm/types";

const params: ParamDescriptor[] = [
  { id: "p1", label: "P1", kind: { type: "float", default: 1, min: 0, max: 10 } },
];

function Harness({ id, onCommit }: { id: string; onCommit: (paramId: string, value: string) => void }) {
  const flushRef = useRef<() => void>(() => {});
  return (
    <ParamizedDetail
      id={id}
      label="Detail Title"
      description="Detail description"
      params={params}
      storeValues={{ p1: "1" }}
      onCommit={onCommit}
      flushRef={flushRef}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ParamizedDetail", () => {
  it("renders label, description and param fields", () => {
    render(<Harness id="e1" onCommit={vi.fn()} />);
    expect(screen.getByText("Detail Title")).toBeInTheDocument();
    expect(screen.getByText("Detail description")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue("1");
  });

  it("debounces onCommit after a field change", () => {
    const onCommit = vi.fn();
    render(<Harness id="e1" onCommit={onCommit} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    expect(onCommit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onCommit).toHaveBeenCalledWith("p1", "5");
  });

  it("flushing via flushRef commits immediately, used on selection switch", () => {
    const onCommit = vi.fn();
    function Wrapper() {
      const flushRef = useRef<() => void>(() => {});
      return (
        <>
          <ParamizedDetail
            id="e1"
            label="Detail Title"
            params={params}
            storeValues={{ p1: "1" }}
            onCommit={onCommit}
            flushRef={flushRef}
          />
          <button onClick={() => flushRef.current()}>flush</button>
        </>
      );
    }
    render(<Wrapper />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "8" } });
    fireEvent.click(screen.getByText("flush"));
    expect(onCommit).toHaveBeenCalledWith("p1", "8");
  });
});
