import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FontPreparingIndicator, INDICATOR_DELAY_MS } from "../components/FontPreparingIndicator";
import { beginRasterWork, endRasterWork } from "../pixi/renderers/rasterFont/rasterFontStore";

afterEach(() => { vi.useRealTimers(); });

describe("FontPreparingIndicator (GitHub issue #966)", () => {
  it("stays hidden for a quick conversion and appears only after a noticeable delay", () => {
    vi.useFakeTimers();
    render(<FontPreparingIndicator />);
    act(() => { beginRasterWork(); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS - 50); });
    expect(screen.queryByTestId("font-preparing-indicator")).toBeNull();
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByTestId("font-preparing-indicator")).toBeTruthy();
    act(() => { endRasterWork(); });
    expect(screen.queryByTestId("font-preparing-indicator")).toBeNull();
  });

  it("never shows for work that ends before the delay", () => {
    vi.useFakeTimers();
    render(<FontPreparingIndicator />);
    act(() => { beginRasterWork(); });
    act(() => { vi.advanceTimersByTime(100); endRasterWork(); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS * 2); });
    expect(screen.queryByTestId("font-preparing-indicator")).toBeNull();
  });

  it("names the fonts being converted (GitHub issue #974)", () => {
    vi.useFakeTimers();
    render(<FontPreparingIndicator />);
    act(() => { beginRasterWork("Comic Sans MS"); beginRasterWork("Arial"); beginRasterWork("Arial"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 50); });
    expect(screen.getByTestId("font-preparing-indicator").textContent).toContain("Arial, Comic Sans MS");
    act(() => { endRasterWork("Arial"); });
    expect(screen.getByTestId("font-preparing-indicator").textContent).toContain("Arial, Comic Sans MS");
    act(() => { endRasterWork("Arial"); });
    expect(screen.getByTestId("font-preparing-indicator").textContent).not.toContain("Arial");
    act(() => { endRasterWork("Comic Sans MS"); });
    expect(screen.queryByTestId("font-preparing-indicator")).toBeNull();
  });
});
