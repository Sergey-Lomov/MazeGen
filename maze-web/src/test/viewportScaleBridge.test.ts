import { describe, it, expect, afterEach } from "vitest";
import { setViewportScaleGetter, getCurrentViewportScale } from "../pixi/viewportScaleBridge";

afterEach(() => {
  setViewportScaleGetter(null);
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
});
