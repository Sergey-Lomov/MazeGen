import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDelayedIndicator, useDelayedKeys } from "../components/useDelayedIndicator";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const opts = { showDelay: 200, minVisible: 750 };

function setup(initial: boolean) {
  return renderHook(({ active }) => useDelayedIndicator(active, opts), { initialProps: { active: initial } });
}

describe("useDelayedIndicator", () => {
  it("stays hidden when the work ends before the delay", () => {
    const { result, rerender } = setup(true);
    act(() => { vi.advanceTimersByTime(199); });
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBe(false);
  });

  it("shows after the delay and holds for the minimum duration", () => {
    const { result, rerender } = setup(true);
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ active: false });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(649); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(false);
  });

  it("hides at once when the work ends after the minimum duration", () => {
    const { result, rerender } = setup(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it("stays shown when the work restarts during the hold", () => {
    const { result, rerender } = setup(true);
    act(() => { vi.advanceTimersByTime(200); });
    rerender({ active: false });
    rerender({ active: true });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});

describe("useDelayedKeys", () => {
  const keysHook = (initial: string[]) => renderHook(({ active }) => useDelayedKeys(active, opts), { initialProps: { active: initial } });

  it("times every key on its own and lists keys in the order they appeared", () => {
    const { result, rerender } = keysHook(["a"]);
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ active: ["a", "b"] });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toEqual(["a"]);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toEqual(["a", "b"]);
    rerender({ active: ["b"] });
    act(() => { vi.advanceTimersByTime(750); });
    expect(result.current).toEqual(["b"]);
  });
});

