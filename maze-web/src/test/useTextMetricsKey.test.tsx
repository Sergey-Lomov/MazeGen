import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

let key = "a";
vi.mock("../pixi/textFit", () => ({ textMetricsKey: () => key }));

const { useTextMetricsKey } = await import("../components/features/useTextMetricsKey");
const { LABEL_FONT_LOADED_EVENT } = await import("../pixi/renderers/fontChoice");

describe("useTextMetricsKey", () => {
  it("returns a new key after a label font finishes loading", () => {
    const { result } = renderHook(() => useTextMetricsKey());
    expect(result.current).toBe("a");
    act(() => {
      key = "b";
      window.dispatchEvent(new Event(LABEL_FONT_LOADED_EVENT));
    });
    expect(result.current).toBe("b");
  });

  it("stays put when no font event arrives", () => {
    key = "c";
    const { result, rerender } = renderHook(() => useTextMetricsKey());
    rerender();
    expect(result.current).toBe("c");
  });
});
