import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useParamEditor } from "../components/features/useParamEditor";
import type { ParamDescriptor } from "../wasm/types";

const params: ParamDescriptor[] = [
  { id: "p1", label: "P1", kind: { type: "float", default: 1, min: 0, max: 10 } },
  { id: "p2", label: "P2", kind: { type: "bool", default: false } },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("useParamEditor", () => {
  it("initializes values from storeValues, falling back to defaults", () => {
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: { p1: "5" }, onCommit: vi.fn() })
    );
    expect(result.current.values).toEqual({ p1: "5", p2: "false" });
  });

  it("updates local value immediately on change", () => {
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: {}, onCommit: vi.fn() })
    );
    act(() => {
      result.current.onChange("p1", "7");
    });
    expect(result.current.values.p1).toBe("7");
  });

  it("debounces onCommit by 300ms", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: {}, onCommit })
    );
    act(() => {
      result.current.onChange("p1", "7");
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onCommit).toHaveBeenCalledWith("p1", "7");
  });

  it("resets debounce timer on rapid successive changes (only last value committed)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: {}, onCommit })
    );
    act(() => {
      result.current.onChange("p1", "1");
    });
    act(() => {
      vi.advanceTimersByTime(200);
      result.current.onChange("p1", "2");
    });
    act(() => {
      vi.advanceTimersByTime(200);
      result.current.onChange("p1", "3");
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("p1", "3");
  });

  it("flush commits pending change immediately and cancels the timer", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: {}, onCommit })
    );
    act(() => {
      result.current.onChange("p1", "9");
    });
    act(() => {
      result.current.flushRef.current();
    });
    expect(onCommit).toHaveBeenCalledWith("p1", "9");
    onCommit.mockClear();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("flush with no pending changes does nothing", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useParamEditor({ entityId: "e1", params, storeValues: {}, onCommit })
    );
    act(() => {
      result.current.flushRef.current();
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("resets values and discards pending changes when entityId changes", () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(
      ({ entityId, storeValues }) =>
        useParamEditor({ entityId, params, storeValues, onCommit }),
      { initialProps: { entityId: "e1", storeValues: { p1: "1" } as Record<string, string> } }
    );
    act(() => {
      result.current.onChange("p1", "99");
    });
    expect(result.current.values.p1).toBe("99");

    rerender({ entityId: "e2", storeValues: { p1: "42" } });
    expect(result.current.values.p1).toBe("42");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
