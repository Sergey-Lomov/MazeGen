import { describe, expect, it, vi } from "vitest";
import { lazyOverlay } from "../store/lazyOverlay";
import { resetTrackedMemo, trackedMemo } from "../pixi/selectors/trackedMemo";

// GitHub issue #928 — a copy of the settings whose derived fields are computed only when read.

type S = { a: number; b: number; derived: number; extra?: string };
const base = (): S => ({ a: 1, b: 2, derived: 0 });

describe("lazyOverlay", () => {
  it("computes a replaced field on first read only, once", () => {
    const derive = vi.fn(() => 42);
    const overlay = lazyOverlay(base(), { derived: derive });
    expect(derive).not.toHaveBeenCalled();
    expect(overlay.a).toBe(1);
    expect(derive).not.toHaveBeenCalled();
    expect(overlay.derived).toBe(42);
    expect(overlay.derived).toBe(42);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("looks like the base through `in`, key listing, spread and descriptors, with the replaced value", () => {
    const overlay = lazyOverlay<S>({ a: 1, b: 2, derived: 0, extra: "x" }, { derived: () => 7 });
    expect("extra" in overlay).toBe(true);
    expect("missing" in overlay).toBe(false);
    expect(Object.keys(overlay)).toEqual(["a", "b", "derived", "extra"]);
    expect({ ...overlay }).toEqual({ a: 1, b: 2, derived: 7, extra: "x" });
    expect(Object.getOwnPropertyDescriptor(overlay, "derived")?.value).toBe(7);
    expect(Object.getOwnPropertyDescriptor(overlay, "missing")).toBeUndefined();
    expect(Object.getPrototypeOf(overlay)).toBe(Object.prototype);
  });

  it("is read-only", () => {
    const overlay = lazyOverlay(base(), { derived: () => 1 });
    expect(() => { overlay.a = 5; }).toThrow(TypeError);
    expect(() => { delete (overlay as Partial<S>).b; }).toThrow(TypeError);
    expect(() => Object.defineProperty(overlay, "c", { value: 1 })).toThrow(TypeError);
  });

  it("over tracked settings subscribes to what the reader touches and what the replacement reads, nothing else", () => {
    resetTrackedMemo();
    const settings = base();
    const compute = (tracked: S) => {
      const overlay = lazyOverlay(tracked, { derived: () => tracked.b * 10 });
      return overlay.a;
    };
    const first = trackedMemo("overlay", [], settings, compute);
    expect(trackedMemo("overlay", [], { ...settings, b: 99 }, compute)).toBe(first);
    expect(trackedMemo("overlay", [], { ...settings, a: 5 }, compute)).toBe(5);

    const readsDerived = (tracked: S) => lazyOverlay(tracked, { derived: () => tracked.b * 10 }).derived;
    expect(trackedMemo("overlay2", [], settings, readsDerived)).toBe(20);
    expect(trackedMemo("overlay2", [], { ...settings, a: 9 }, readsDerived)).toBe(20);
    expect(trackedMemo("overlay2", [], { ...settings, b: 3 }, readsDerived)).toBe(30);
  });
});
