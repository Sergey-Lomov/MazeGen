import { describe, it, expect, afterEach, vi } from "vitest";
import { focusCell, getCurrentViewportScale, setCellFocusApplier, setViewportScaleGetter } from "../pixi/viewportScaleBridge";

afterEach(() => {
  setViewportScaleGetter(null);
  setCellFocusApplier(null);
});

describe("viewportScaleBridge", () => {
  it("returns 1 when no getter has been registered", () => {
    expect(getCurrentViewportScale()).toBe(1);
  });

  it("returns the registered getter's live value", () => {
    setViewportScaleGetter(() => 2.5);
    expect(getCurrentViewportScale()).toBe(2.5);
  });

  it("falls back to 1 again after the getter is cleared", () => {
    setViewportScaleGetter(() => 2.5);
    setViewportScaleGetter(null);
    expect(getCurrentViewportScale()).toBe(1);
  });

  it("forwards a cell focus request only while an applier is registered", () => {
    const apply = vi.fn();

    focusCell([1, 2]);
    expect(apply).not.toHaveBeenCalled();

    setCellFocusApplier(apply);
    focusCell([1, 2]);
    expect(apply).toHaveBeenCalledWith([1, 2]);
  });
});
