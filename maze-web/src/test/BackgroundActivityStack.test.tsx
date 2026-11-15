import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BackgroundActivityStack, INDICATOR_DELAY_MS, INDICATOR_MIN_VISIBLE_MS } from "../components/BackgroundActivityStack";

import { beginActivity, endActivity, trackActivity } from "../activity/backgroundActivity";
import { beginRasterWork, endRasterWork } from "../pixi/renderers/rasterFont/rasterFontStore";

afterEach(() => { vi.useRealTimers(); });

const fonts = () => screen.queryByTestId("background-activity-fonts");
const analytics = () => screen.queryByTestId("background-activity-analytics");

describe("BackgroundActivityStack (GitHub issue #1004)", () => {
  it("stays hidden for a quick process and appears only after a noticeable delay", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginRasterWork(); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS - 50); });
    expect(fonts()).toBeNull();
    act(() => { vi.advanceTimersByTime(100); });
    expect(fonts()).toBeTruthy();
    act(() => { endRasterWork(); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
    expect(fonts()).toBeNull();
  });

  it("never shows a process that ends before the delay", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(100); endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS * 2); });
    expect(analytics()).toBeNull();
  });

  it("keeps a shown card for the minimum time", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    expect(analytics()).toBeTruthy();
    act(() => { endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS - 100); });
    expect(analytics()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    expect(analytics()).toBeNull();
  });

  it("names the fonts being converted", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginRasterWork("Comic Sans MS"); beginRasterWork("Arial"); beginRasterWork("Arial"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 50); });
    expect(fonts()!.textContent).toContain("Arial, Comic Sans MS");
    act(() => { endRasterWork("Arial"); });
    expect(fonts()!.textContent).toContain("Arial, Comic Sans MS");
    act(() => { endRasterWork("Arial"); });
    expect(fonts()!.textContent).not.toContain("Arial");
    act(() => { endRasterWork("Comic Sans MS"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
    expect(fonts()).toBeNull();
  });

  it("shows one card per running process and opens its description", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginRasterWork("Arial"); beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    expect(fonts()).toBeTruthy();
    expect(analytics()).toBeTruthy();
    fireEvent.click(screen.getByTestId("background-activity-info-analytics"));
    expect(screen.getByTestId("background-activity-info-text").textContent).toBeTruthy();
    act(() => { endRasterWork("Arial"); endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
  });

  it("folds several cards into one counting card and unfolds it", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginRasterWork("Arial"); beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    fireEvent.click(screen.getByTestId("background-activity-collapse"));
    expect(fonts()).toBeNull();
    expect(analytics()).toBeNull();
    expect(screen.getByTestId("background-activity-folded").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("background-activity-folded"));
    expect(fonts()).toBeTruthy();
    expect(analytics()).toBeTruthy();
    act(() => { endRasterWork("Arial"); endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
  });

  it("offers no folding for a single card", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    expect(screen.queryByTestId("background-activity-collapse")).toBeNull();
    act(() => { endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
  });

  it("trackActivity keeps a kind active until its promise settles, even on failure", async () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    let fail!: (error: Error) => void;
    let tracked!: Promise<void>;
    act(() => { tracked = trackActivity("analytics", new Promise<void>((_, reject) => { fail = reject; })).catch(() => {}); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    expect(analytics()).toBeTruthy();
    fail(new Error("boom"));
    await act(async () => { await tracked; });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
    expect(analytics()).toBeNull();
  });

  it("keeps the description open after its process ends", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    fireEvent.click(screen.getByTestId("background-activity-info-analytics"));
    act(() => { endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
    expect(analytics()).toBeNull();
    expect(screen.getByTestId("background-activity-info-text")).toBeTruthy();
  });

  it("unfolds from the keyboard and closes the description dialog", () => {
    vi.useFakeTimers();
    render(<BackgroundActivityStack />);
    act(() => { beginRasterWork("Arial"); beginActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    fireEvent.click(screen.getByTestId("background-activity-collapse"));
    fireEvent.keyDown(screen.getByTestId("background-activity-folded"), { key: "Enter" });
    expect(fonts()).toBeTruthy();
    fireEvent.click(screen.getByTestId("background-activity-info-fonts"));
    expect(screen.getByTestId("background-activity-info-text")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("background-activity-info-text")).toBeNull();
    act(() => { endRasterWork("Arial"); endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
  });

  it("shows and hides a card under StrictMode's mount-cleanup-mount cycle", () => {
    vi.useFakeTimers();
    act(() => { beginActivity("analytics"); });
    render(<StrictMode><BackgroundActivityStack /></StrictMode>);
    act(() => { vi.advanceTimersByTime(INDICATOR_DELAY_MS + 10); });
    expect(analytics()).toBeTruthy();
    act(() => { endActivity("analytics"); });
    act(() => { vi.advanceTimersByTime(INDICATOR_MIN_VISIBLE_MS + 10); });
    expect(analytics()).toBeNull();
  });
});
