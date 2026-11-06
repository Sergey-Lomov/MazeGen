import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { Tooltip, TOOLTIP_HOVER_DELAY_MS, setTooltipsSuppressed } from "../components/Tooltip";

afterEach(() => setTooltipsSuppressed(false));

describe("Tooltip global suppression (drag-and-drop)", () => {
  it("shows no bubble while suppressed and hides one that is already open", async () => {
    render(<Tooltip content="hint"><button>b</button></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    fireEvent.pointerEnter(anchor);
    await act(() => new Promise((r) => setTimeout(r, TOOLTIP_HOVER_DELAY_MS + 50)));
    expect(screen.queryByTestId("tooltip")).not.toBeNull();

    act(() => setTooltipsSuppressed(true));
    expect(screen.queryByTestId("tooltip")).toBeNull();

    fireEvent.pointerLeave(anchor);
    fireEvent.pointerEnter(anchor);
    await act(() => new Promise((r) => setTimeout(r, TOOLTIP_HOVER_DELAY_MS + 50)));
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });
});
