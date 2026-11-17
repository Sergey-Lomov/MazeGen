import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { Tooltip, TOOLTIP_HOVER_DELAY_MS, setTooltipsSuppressed } from "../components/Tooltip";

afterEach(() => setTooltipsSuppressed(false));

describe("Tooltip after a native dialog", () => {
  it("does not reopen on the focus restored with the window", () => {
    render(<Tooltip content="hint"><button>b</button></Tooltip>);
    const button = screen.getByRole("button");
    act(() => button.focus());
    expect(screen.queryByTestId("tooltip")).not.toBeNull();
    fireEvent.blur(button);
    fireEvent.blur(window);
    expect(screen.queryByTestId("tooltip")).toBeNull();

    fireEvent.focus(button);
    expect(screen.queryByTestId("tooltip")).toBeNull();

    fireEvent.blur(button);
    fireEvent.focus(button);
    expect(screen.queryByTestId("tooltip")).not.toBeNull();
  });

  it("stays hidden after a click-opened picker returns focus to the hovered anchor", async () => {
    render(<Tooltip content="hint"><button>b</button></Tooltip>);
    const anchor = screen.getByTestId("tooltip-anchor");
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(anchor);
    await act(() => new Promise((r) => setTimeout(r, TOOLTIP_HOVER_DELAY_MS + 50)));
    expect(screen.queryByTestId("tooltip")).not.toBeNull();

    fireEvent.pointerDown(anchor, { pointerType: "mouse" });
    act(() => button.focus());
    fireEvent.pointerUp(anchor, { pointerType: "mouse" });
    fireEvent.blur(button);
    fireEvent.blur(window);
    fireEvent.focus(button);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });
});

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
