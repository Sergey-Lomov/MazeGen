import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColorSwatch } from "../components/ColorSwatch";

describe("ColorSwatch", () => {
  it("renders the color as its background", () => {
    render(<ColorSwatch color={0x336699} onChange={() => {}} />);
    const swatch = screen.getByRole("button");
    expect(swatch.style.background).toContain("rgb(51, 102, 153)");
  });

  it("clicking the swatch opens the underlying native color input", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    const swatch = screen.getByRole("button");
    const input = document.querySelector('input[type="color"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(swatch);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("Enter/Space on a focused swatch also opens the picker (keyboard accessible)", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} />);
    const swatch = screen.getByRole("button");
    const input = document.querySelector('input[type="color"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.keyDown(swatch, { key: "Enter" });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(swatch, { key: " " });
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("changing the native input calls onChange with the parsed numeric color", () => {
    const onChange = vi.fn();
    render(<ColorSwatch color={0x000000} onChange={onChange} />);
    const input = document.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "#ff00aa" } });
    expect(onChange).toHaveBeenCalledWith(0xff00aa);
  });

  it("disabled swatch is not focusable and clicking/keydown do not open the picker", () => {
    render(<ColorSwatch color={0x000000} onChange={() => {}} disabled />);
    const swatch = screen.getByRole("button");
    expect(swatch).toHaveAttribute("tabIndex", "-1");
    expect(swatch).toHaveAttribute("aria-disabled", "true");
    const input = document.querySelector('input[type="color"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(swatch);
    fireEvent.keyDown(swatch, { key: "Enter" });
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
