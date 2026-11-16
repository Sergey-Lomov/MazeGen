import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "../components/SearchInput";

describe("SearchInput", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces search changes but clears immediately and keeps input focus", () => {
    vi.useFakeTimers();
    const onValueChange = vi.fn();
    render(<SearchInput value="" onValueChange={onValueChange} placeholder="Search" />);

    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "maze" } });
    expect(onValueChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(149));
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onValueChange).toHaveBeenLastCalledWith("maze");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onValueChange).toHaveBeenLastCalledWith("");
    expect(input).toHaveFocus();
  });

  it("uses the compact 18 px flat-icon hit area without contributing to field height", () => {
    render(<SearchInput value="query" onValueChange={() => {}} placeholder="Search" />);
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass("btn-flat-icon", "btn-flat-icon-compact", "search-input-clear");
    expect(clear).toHaveStyle({ position: "absolute", right: "3px", top: "50%", margin: "0px" });
    expect(screen.getByPlaceholderText("Search")).toHaveStyle({ display: "block", height: "24px", lineHeight: "16px" });
  });

  it("hides the clear action when disabled", () => {
    render(<SearchInput value="query" onValueChange={() => {}} placeholder="Search" disabled />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("does not render a browser-native search control", () => {
    render(<SearchInput value="" onValueChange={() => {}} placeholder="Search" />);
    expect(screen.getByPlaceholderText("Search")).toHaveAttribute("type", "text");
  });
});
